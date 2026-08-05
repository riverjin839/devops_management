"""K8s Job cleanup — delete finished Jobs that only consume resources.

완료(Complete)/실패(Failed) 상태로 남아 etcd 오브젝트·완료 Pod 를 차지하는
K8s Job 을 정리하는 클러스터 스코프 배치잡. SSH 를 쓰지 않고(`requires_ssh
= False`) 백엔드/워커에서 클러스터에 등록된 kubeconfig 로 kubectl 을 직접
실행한다 — deep checker 들과 같은 실행 모델.

안전장치:
  - `dry_run` 기본값 True — 삭제하지 않고 대상 목록만 stdout 으로 보여준다.
  - 아직 실행 중(active)인 Job 은 어떤 조합에서도 건드리지 않는다.
  - `older_than_hours` 로 최근에 끝난 Job 을 보호한다 (기본 24h).
  - `exclude_namespaces` 기본값에 kube-system 포함.

CronJob 소유 Job 도 대상에 포함된다 — successfulJobsHistoryLimit 이 커서
쌓이는 경우가 바로 이 잡의 정리 대상이기 때문. 삭제는 kubectl 기본
cascade(Background) 라 완료 Pod 도 함께 정리된다.
"""
from __future__ import annotations

import asyncio
import json
import shlex
import subprocess
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from app.services.batch_jobs.base import (
    BatchJobExecutor,
    ExecutionContext,
    ExecutionResult,
    register_executor,
)
from app.services.k8s_diagnose import classify_kubectl_failure


def _parse_k8s_time(value: Optional[str]) -> Optional[datetime]:
    """RFC3339 (`2026-07-23T14:05:00Z`) → aware datetime. 실패 시 None."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _job_state(item: dict[str, Any]) -> tuple[str, Optional[datetime]]:
    """Job 오브젝트의 종료 상태를 판정한다.

    반환: ("succeeded" | "failed" | "active", 종료 시각).
    Complete/Failed condition 이 없으면 active 취급 — 삭제 대상에서 제외.
    """
    status = item.get("status") or {}
    if status.get("active"):
        return "active", None
    for cond in status.get("conditions") or []:
        if cond.get("status") != "True":
            continue
        finished = _parse_k8s_time(cond.get("lastTransitionTime"))
        if cond.get("type") == "Complete":
            return "succeeded", _parse_k8s_time(status.get("completionTime")) or finished
        if cond.get("type") in ("Failed", "FailureTarget"):
            return "failed", finished
    return "active", None


def select_cleanup_targets(
    items: list[dict[str, Any]],
    *,
    delete_succeeded: bool,
    delete_failed: bool,
    older_than_hours: float,
    exclude_namespaces: set[str],
    now: Optional[datetime] = None,
) -> list[dict[str, Any]]:
    """삭제 대상 Job 을 고른다 — 순수 함수 (단위 테스트 대상).

    반환 항목: {namespace, name, state, finished_at, age_hours}
    """
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=max(older_than_hours, 0))
    targets: list[dict[str, Any]] = []
    for item in items:
        meta = item.get("metadata") or {}
        namespace = meta.get("namespace") or "default"
        name = meta.get("name")
        if not name or namespace in exclude_namespaces:
            continue
        state, finished_at = _job_state(item)
        if state == "succeeded" and not delete_succeeded:
            continue
        if state == "failed" and not delete_failed:
            continue
        if state == "active":
            continue
        # 종료 시각을 모르는 Job(오래된 조건 포맷 등)은 보수적으로 생성 시각 기준.
        anchor = finished_at or _parse_k8s_time(meta.get("creationTimestamp"))
        if anchor is None or anchor > cutoff:
            continue
        age_hours = (now - anchor).total_seconds() / 3600.0
        targets.append(
            {
                "namespace": namespace,
                "name": name,
                "state": state,
                "finished_at": anchor.isoformat(),
                "age_hours": round(age_hours, 1),
            }
        )
    return targets


def _run_kubectl(
    args: list[str], timeout: int, cancel_token: Optional[Any] = None
) -> subprocess.CompletedProcess:
    """kubectl 실행 — Popen 기반이라 실행 중에도 다른 스레드/코루틴에서
    `proc.terminate()` 로 중단할 수 있다(``cancel_token`` 이 attach 해두면
    "중지" 요청이 이 블로킹 호출을 즉시 풀어준다)."""
    proc = subprocess.Popen(
        ["kubectl", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )
    if cancel_token is not None:
        cancel_token.attach(proc)
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        raise
    return subprocess.CompletedProcess(proc.args, proc.returncode, stdout, stderr)


@register_executor
class K8sJobCleanupExecutor(BatchJobExecutor):
    job_type = "k8s_job_cleanup"
    label = "K8s Job 정리"
    requires_ssh = False
    description = (
        "완료/실패 상태로 남아 리소스만 차지하는 K8s Job 을 클러스터 kubeconfig 로 "
        "조회해 일괄 삭제합니다. SSH 불필요 — 백엔드/워커에서 kubectl 로 직접 실행. "
        "dry_run 기본값이 켜져 있어 먼저 삭제 대상만 확인할 수 있습니다."
    )

    param_schema = {
        "namespaces": {
            "type": "string",
            "label": "대상 네임스페이스 (콤마 구분, 빈 값 = 전체)",
            "default": "",
            "help": "예: batch,etl — 비우면 모든 네임스페이스(-A)를 스캔합니다.",
        },
        "exclude_namespaces": {
            "type": "string",
            "label": "제외 네임스페이스 (콤마 구분)",
            "default": "kube-system",
        },
        "delete_succeeded": {
            "type": "bool",
            "label": "완료(Complete) Job 삭제",
            "default": True,
        },
        "delete_failed": {
            "type": "bool",
            "label": "실패(Failed) Job 삭제",
            "default": False,
            "help": "실패 Job 은 원인 분석 전 지워질 수 있으니 기본은 끔.",
        },
        "older_than_hours": {
            "type": "int",
            "label": "종료 후 경과 시간 (시간)",
            "default": 24,
            "help": "이 시간보다 오래 전에 끝난 Job 만 삭제합니다.",
        },
        "label_selector": {
            "type": "string",
            "label": "라벨 셀렉터 (선택)",
            "default": "",
            "help": "예: app=nightly-etl — 지정하면 매칭되는 Job 만 대상.",
        },
        "dry_run": {
            "type": "bool",
            "label": "Dry run (삭제 없이 대상만 표시)",
            "default": True,
        },
    }
    default_params = {
        "namespaces": "",
        "exclude_namespaces": "kube-system",
        "delete_succeeded": True,
        "delete_failed": False,
        "older_than_hours": 24,
        "label_selector": "",
        "dry_run": True,
    }
    # 실행 전 UI 에 그려지는 정적 단계 계획 — 실행 후 같은 id 로 실측 상태가 오버레이됨.
    step_plan = [
        {"id": "resolve_kubeconfig", "label": "kubeconfig 해석"},
        {"id": "kubectl_query", "label": "kubectl 연결·Job 조회"},
        {"id": "select_targets", "label": "삭제 대상 선정"},
        {"id": "delete_jobs", "label": "Job 삭제"},
    ]

    def _list_args(self, params: dict[str, Any]) -> list[list[str]]:
        """네임스페이스 설정에 따른 `kubectl get jobs` 인자 목록(호출 단위)."""
        selector = (params.get("label_selector") or "").strip()
        base = ["get", "jobs", "-o", "json"]
        if selector:
            base += ["-l", selector]
        namespaces = [
            ns.strip() for ns in (params.get("namespaces") or "").split(",") if ns.strip()
        ]
        if not namespaces:
            return [base + ["-A"]]
        return [base + ["-n", ns] for ns in namespaces]

    async def _kubectl(
        self, ctx: ExecutionContext, kubeconfig: list[str], args: list[str]
    ) -> subprocess.CompletedProcess:
        """kubectl 1회 실행 + 실측 명령 기록. 예외도 기록 후 re-raise."""
        full = ["kubectl", *kubeconfig, *args]
        t0 = time.time()
        try:
            proc = await asyncio.to_thread(
                _run_kubectl, kubeconfig + args, ctx.timeout, ctx.cancel_token
            )
        except Exception as e:  # noqa: BLE001 — 기록 후 원래 흐름대로 처리
            self._record_command(full, t0, exit_code=None, stdout="", stderr=str(e)[:500])
            raise
        self._record_command(
            full, t0, exit_code=proc.returncode,
            stdout=proc.stdout or "", stderr=proc.stderr or "",
        )
        return proc

    async def run(self, ctx: ExecutionContext) -> ExecutionResult:
        params = self.merge_params(saved=None, override=ctx.params)
        start = time.monotonic()

        def _done(**kwargs: Any) -> ExecutionResult:
            kwargs.setdefault("duration_ms", int((time.monotonic() - start) * 1000))
            # 모든 리턴 경로(조기 실패 포함)에 단계/명령 trace 를 싣는다.
            kwargs.setdefault("steps", self._collected_steps())
            kwargs.setdefault("commands", self._collected_commands())
            return ExecutionResult(**kwargs)

        host_hint = ctx.cluster_name or "API 서버"

        # ── 1) kubeconfig 해석 ──────────────────────────────────────
        with self._step("resolve_kubeconfig", "kubeconfig 해석") as st:
            if not ctx.kubeconfig_path:
                st.status = "failed"
                st.detail = ctx.kubeconfig_note or "kubeconfig 미등록"
                return _done(
                    status="error",
                    error=ctx.kubeconfig_note or (
                        "클러스터에 kubeconfig 가 등록되어 있지 않습니다 — "
                        "/cluster-manage 에서 kubeconfig 를 먼저 등록하세요."
                    ),
                )
            st.detail = "kubeconfig 파일 확보됨"

        kubeconfig = ["--kubeconfig", ctx.kubeconfig_path]
        try:
            older_than = float(params.get("older_than_hours") or 0)
        except (TypeError, ValueError):
            return _done(status="error", error="older_than_hours 는 숫자여야 합니다.")
        exclude = {
            ns.strip()
            for ns in (params.get("exclude_namespaces") or "").split(",")
            if ns.strip()
        }
        dry_run = bool(params.get("dry_run", True))

        def _cancelled() -> bool:
            return bool(ctx.cancel_token and ctx.cancel_token.cancelled)

        # ── 2) kubectl 연결·Job 조회 ────────────────────────────────
        items: list[dict[str, Any]] = []
        executed: list[str] = []
        with self._step("kubectl_query", "kubectl 연결·Job 조회") as st:
            for args in self._list_args(params):
                if _cancelled():
                    st.status = "failed"
                    st.detail = "사용자에 의해 중지됨"
                    return _done(
                        status="cancelled", error="사용자에 의해 중지됨",
                        executed_command="\n".join(executed),
                    )
                executed.append("kubectl " + " ".join(args))
                try:
                    proc = await self._kubectl(ctx, kubeconfig, args)
                except subprocess.TimeoutExpired:
                    st.status = "failed"
                    st.detail = f"kubectl 조회 타임아웃 ({ctx.timeout}s)"
                    return _done(
                        status="timeout",
                        error=f"kubectl 조회 타임아웃 ({ctx.timeout}s)",
                        executed_command="\n".join(executed),
                    )
                except FileNotFoundError:
                    st.status = "failed"
                    st.detail = "kubectl 바이너리 없음"
                    return _done(
                        status="error",
                        error="kubectl 을 찾을 수 없습니다 — 백엔드/워커 이미지에 kubectl 이 필요합니다.",
                        executed_command="\n".join(executed),
                    )
                if _cancelled():
                    st.status = "failed"
                    st.detail = "사용자에 의해 중지됨"
                    return _done(
                        status="cancelled", error="사용자에 의해 중지됨",
                        executed_command="\n".join(executed),
                    )
                if proc.returncode != 0:
                    # stderr 를 읽어 연결/인증/기타로 분류 — "에러" 한 단어로 뭉개지 않는다.
                    fail_status, headline = classify_kubectl_failure(
                        proc.stderr or "", host=host_hint
                    )
                    st.status = "failed"
                    st.detail = headline[:200]
                    return _done(
                        status=fail_status,
                        exit_code=proc.returncode,
                        stderr=proc.stderr[-4000:],
                        error=headline[:1000] or "kubectl get jobs 실패",
                        executed_command="\n".join(executed),
                    )
                try:
                    items.extend(json.loads(proc.stdout).get("items") or [])
                except json.JSONDecodeError:
                    st.status = "failed"
                    st.detail = "kubectl 출력(JSON) 파싱 실패"
                    return _done(
                        status="error",
                        error="kubectl 출력(JSON) 파싱 실패",
                        executed_command="\n".join(executed),
                    )
            st.detail = f"Job {len(items)}개 조회"
            st.metrics = {"scanned": len(items)}

        # ── 3) 삭제 대상 선정 ───────────────────────────────────────
        with self._step("select_targets", "삭제 대상 선정") as st:
            targets = select_cleanup_targets(
                items,
                delete_succeeded=bool(params.get("delete_succeeded", True)),
                delete_failed=bool(params.get("delete_failed", False)),
                older_than_hours=older_than,
                exclude_namespaces=exclude,
            )
            st.detail = f"{len(items)}개 중 {len(targets)}개 선정"
            st.metrics = {"targets": len(targets)}

        state_label = {"succeeded": "완료", "failed": "실패"}
        lines = [
            f"스캔한 Job {len(items)}개 중 삭제 대상 {len(targets)}개"
            + (" (dry run — 실제 삭제 없음)" if dry_run else ""),
        ]
        for t in targets:
            lines.append(
                f"  - {t['namespace']}/{t['name']} "
                f"[{state_label.get(t['state'], t['state'])}, {t['age_hours']}h 경과]"
            )

        if dry_run or not targets:
            with self._step("delete_jobs", "Job 삭제") as st:
                st.status = "skipped"
                st.detail = "dry run — 삭제 생략" if dry_run else "삭제 대상 없음"
            return _done(
                status="ok",
                exit_code=0,
                stdout="\n".join(lines),
                executed_command="\n".join(executed),
            )

        # ── 4) 네임스페이스별로 묶어 삭제 (--wait=false: 종료 대기 없이 큐잉) ──
        with self._step("delete_jobs", "Job 삭제") as st:
            by_ns: dict[str, list[str]] = {}
            for t in targets:
                by_ns.setdefault(t["namespace"], []).append(t["name"])

            deleted = 0
            errors: list[str] = []
            for ns, names in by_ns.items():
                if _cancelled():
                    lines.append(f"중지됨 — {deleted}/{len(targets)}개 삭제 후 남은 네임스페이스 스킵")
                    st.status = "failed"
                    st.detail = f"중지됨 ({deleted}/{len(targets)} 삭제)"
                    return _done(
                        status="cancelled", error="사용자에 의해 중지됨",
                        stdout="\n".join(lines), executed_command="\n".join(executed),
                    )
                del_args = ["delete", "job", "-n", ns, *names, "--wait=false"]
                executed.append("kubectl " + " ".join(shlex.quote(a) for a in del_args))
                try:
                    proc = await self._kubectl(ctx, kubeconfig, del_args)
                except subprocess.TimeoutExpired:
                    errors.append(f"{ns}: 삭제 타임아웃")
                    continue
                if proc.returncode == 0:
                    deleted += len(names)
                    lines.append(proc.stdout.strip())
                else:
                    first = (proc.stderr or "").strip().splitlines()
                    errors.append(f"{ns}: {(first[0] if first else '')[:300]}")

            if _cancelled():
                lines.append(f"중지됨 — {deleted}/{len(targets)}개 삭제 완료")
                st.status = "failed"
                st.detail = f"중지됨 ({deleted}/{len(targets)} 삭제)"
                return _done(
                    status="cancelled", error="사용자에 의해 중지됨",
                    stdout="\n".join(lines), executed_command="\n".join(executed),
                )
            lines.append(f"삭제 완료 {deleted}/{len(targets)}개")
            st.detail = f"{deleted}/{len(targets)}개 삭제"
            st.metrics = {"deleted": deleted, "errors": len(errors)}
            if errors:
                st.status = "failed"
        return _done(
            status="ok" if not errors else "error",
            exit_code=0 if not errors else 1,
            stdout="\n".join(lines),
            stderr="\n".join(errors),
            error=None if not errors else f"{len(errors)}개 네임스페이스에서 삭제 실패",
            executed_command="\n".join(executed),
        )
