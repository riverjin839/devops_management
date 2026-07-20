"""Pod-to-pod 연결성 점검.

전략: ``kubectl run`` 으로 일회용 busybox 파드를 띄워 무작위 워크로드 파드의
podIP:컨테이너포트 로 ``nc -z -w <timeout>`` TCP probe 를 돌린다. 결과는 stdout
한 줄당 "TARGET=ns/pod/ip:port RC=<0|1> MS=<latency>" 로 회수.

옵션:
- ``namespaces`` (list)   : 대상 namespace 화이트리스트. 비우면 전 namespace.
- ``targets_max`` (int)   : 샘플링할 타깃 pod 개수 (기본 8).
- ``per_probe_timeout``   : nc -w 값 (초, 기본 3).
- ``image``               : probe 컨테이너 이미지 (기본 busybox:1.36).
- ``skip_host_network``   : hostNetwork pod 제외 (기본 true).
- ``probe_namespace``     : 일회용 probe pod 가 생성될 namespace (기본 ``devops``).
                            해당 ns 가 대상 클러스터에 없거나 pods.create 권한이 없으면 pending.

임계:
- ``warning_failure_pct`` : 실패율 ≥ X 면 warning (기본 10).
- ``critical_failure_pct``: 실패율 ≥ X 면 critical (기본 30).

권한: 일회용 pod 생성용으로 ``pods.create`` 가 필요. 거부되면 pending.
"""
from __future__ import annotations

import random
import re
from typing import Any

from app.models import StatusEnum
from app.services.deep_checkers.base import (
    DeepCheckContext,
    DeepCheckOutcome,
    DeepCheckerBase,
)
from app.services.k8s_paging import iter_all

# 후보 pod 수집 상한 — 이 체커는 targets_max(기본 8)개만 무작위 샘플링하면 되므로,
# 5k+ pod 대형 클러스터에서 전량을 한 번에 메모리에 올릴 필요가 없다. 페이지
# 스트리밍(iter_all)으로 이 상한까지만 훑어 OOM 을 피한다.
_CANDIDATE_SCAN_CAP = 5000


# MS 는 선택 — busybox sh 에서 신뢰할 만한 밀리초 계측이 어려워 기본적으로 생략하고,
# 전체 소요시간은 safe_run 의 duration_ms(outcome 레벨)로 대신 본다.
_RESULT_RE = re.compile(
    r"TARGET=(?P<target>\S+)\s+RC=(?P<rc>\d+)(?:\s+MS=(?P<ms>\d+))?"
)


class PodToPodChecker(DeepCheckerBase):
    check_type = "pod_to_pod"
    display_name = "Pod-to-pod 연결성"

    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        warning_pct = float(ctx.thresholds.get("warning_failure_pct", 10))
        critical_pct = float(ctx.thresholds.get("critical_failure_pct", 30))

        namespaces = ctx.params.get("namespaces") or []
        if isinstance(namespaces, str):
            namespaces = [namespaces]
        targets_max = int(ctx.params.get("targets_max", 8))
        per_probe_timeout = int(ctx.params.get("per_probe_timeout", 3))
        image = ctx.params.get("image", "busybox:1.36")
        skip_host_network = bool(ctx.params.get("skip_host_network", True))
        probe_namespace = ctx.params.get("probe_namespace", "devops")
        seed = ctx.params.get("seed")  # 재현용 옵션

        # 1) 타깃 pod 후보 수집 — 페이지 스트리밍(대형 클러스터 OOM 방지)
        v1 = self._v1(ctx)
        candidates: list[dict[str, Any]] = []
        for p in iter_all(v1.list_pod_for_all_namespaces, hard_cap=_CANDIDATE_SCAN_CAP):
            status = p.status
            spec = p.spec
            if not (status and spec and p.metadata):
                continue
            if status.phase != "Running":
                continue
            if skip_host_network and getattr(spec, "host_network", False):
                continue
            pod_ip = status.pod_ip
            if not pod_ip:
                continue
            if namespaces and p.metadata.namespace not in namespaces:
                continue
            # 컨테이너 포트 후보 — 첫 번째 TCP 포트
            port = _first_tcp_port(spec)
            if port is None:
                continue
            candidates.append({
                "namespace": p.metadata.namespace,
                "pod": p.metadata.name,
                "ip": pod_ip,
                "port": port,
            })

        if not candidates:
            return DeepCheckOutcome(
                status=StatusEnum.pending,
                message="probe 가능한 타깃 pod 가 없습니다.",
                details={"reason": "no_candidates", "filters": {"namespaces": namespaces}},
            )

        rng = random.Random(seed)
        targets = rng.sample(candidates, min(targets_max, len(candidates)))

        # 2) busybox 일회용 pod 로 nc probe
        target_list = " ".join(
            f"{t['namespace']}/{t['pod']}/{t['ip']}:{t['port']}" for t in targets
        )
        script = (
            "set +e\n"
            f"for tgt in {target_list}; do\n"
            "  ip_port=${tgt##*/}\n"
            "  ip=${ip_port%%:*}\n"
            "  port=${ip_port##*:}\n"
            f"  nc -z -w {per_probe_timeout} \"$ip\" \"$port\" >/dev/null 2>&1\n"
            "  rc=$?\n"
            "  echo \"TARGET=$tgt RC=$rc\"\n"
            "done\n"
        )

        probe_pod = f"pod2pod-probe-{rng.randrange(10**6):06d}"
        try:
            proc = self._kubectl(
                ctx,
                "run", probe_pod,
                "-n", probe_namespace,
                "--rm", "-i",
                "--restart=Never",
                "--image", image,
                "--quiet",
                "--", "sh", "-c", script,
                timeout=max(60, per_probe_timeout * len(targets) * 2 + 30),
            )
        finally:
            # ``--rm`` 은 attach 정상 종료에 의존하므로 timeout/오류 시 probe 파드가
            # 남을 수 있다. 항상 명시 삭제(성공 시엔 --ignore-not-found 로 무해).
            try:
                self._kubectl(
                    ctx, "delete", "pod", probe_pod,
                    "-n", probe_namespace,
                    "--ignore-not-found", "--wait=false",
                    timeout=15,
                )
            except Exception:  # noqa: BLE001
                pass

        if proc.returncode != 0 and not proc.stdout:
            return DeepCheckOutcome(
                status=StatusEnum.pending,
                message="probe pod 실행 실패 (pods.create 권한 또는 이미지 풀 실패)",
                details={
                    "returncode": proc.returncode,
                    "stderr": (proc.stderr or "")[:1000],
                    "probe_pod": probe_pod,
                    "namespace": probe_namespace,
                },
            )

        # 3) 결과 파싱
        results: list[dict[str, Any]] = []
        succ = 0
        fail = 0
        for raw in (proc.stdout or "").splitlines():
            m = _RESULT_RE.search(raw)
            if not m:
                continue
            rc = int(m.group("rc"))
            ok = rc == 0
            ms_raw = m.group("ms")
            results.append({
                "target": m.group("target"),
                "rc": rc,
                "latency_ms": int(ms_raw) if ms_raw is not None else None,
                "ok": ok,
            })
            if ok:
                succ += 1
            else:
                fail += 1

        total = succ + fail
        if total == 0:
            return DeepCheckOutcome(
                status=StatusEnum.pending,
                message="probe 결과 파싱 실패",
                details={
                    "stdout": (proc.stdout or "")[:2000],
                    "stderr": (proc.stderr or "")[:1000],
                },
            )

        fail_pct = round((fail / total) * 100, 2)

        status = StatusEnum.healthy
        if fail_pct >= critical_pct:
            status = StatusEnum.critical
        elif fail_pct >= warning_pct:
            status = StatusEnum.warning

        return DeepCheckOutcome(
            status=status,
            message=f"{total}개 타깃 중 성공 {succ} / 실패 {fail} (실패율 {fail_pct}%)",
            details={
                "total": total,
                "success": succ,
                "failure": fail,
                "failure_pct": fail_pct,
                "warning_pct": warning_pct,
                "critical_pct": critical_pct,
                "probe_pod": probe_pod,
                "probe_namespace": probe_namespace,
                "targets": targets,
                "results": results,
            },
        )


def _first_tcp_port(spec: Any) -> int | None:
    """Pod spec 의 첫 번째 TCP containerPort 추출. 없으면 None."""
    containers = getattr(spec, "containers", None) or []
    for c in containers:
        ports = getattr(c, "ports", None) or []
        for p in ports:
            proto = getattr(p, "protocol", "TCP") or "TCP"
            cport = getattr(p, "container_port", None)
            if proto.upper() == "TCP" and isinstance(cport, int) and cport > 0:
                return cport
    return None

