"""서비스 구성 — 적용(설정 버전을 노드·클러스터에 실제로 반영). 이번 단계는 LINUX(OS)·CILIUM.

실행은 요청 안 SSE 작업(`services/sse.py` `stream_async_job`)에서 돈다 — SSH 자격증명이 Celery 브로커·DB 에 남지 않게.
진행은 ``ServiceConfigApplyRun`` 행에 배치마다 커밋돼 화면을 다시 열어도 보이고, 클라이언트가 끊겨도 작업은 끝까지 돈다.

- LINUX : 노드마다 SSH 로 ① 적용 전 값 읽기 ② 관리 파일 백업 ③ 관리 파일 기록(PEP 소유, 노드 기대 값 전체) ④ ``sysctl -p``
          (영구 기록을 끄면 ``sysctl -w`` 만) ⑤ 다시 읽어 확인. 배치 크기·배치 사이 대기·실패 시 중단·중지 요청.
          끝나면(옵션) OS 파라미터 감시 규칙을 적용 값으로 갱신해 드리프트 감시가 새 값을 따라가게 한다.
- CILIUM: K8S API 로 ① cilium-config 읽기 ② 바뀐 키만 patch ③ (옵션) DaemonSet 롤링 재시작 + 롤아웃 대기 ④ 다시 읽어 확인
          ⑤ ``cilium_config`` 스냅샷 갱신(화면 현재 값 즉시 반영).
etcd·containerd 적용은 다음 단계 — 계획(미리보기)만 된다.
"""
from __future__ import annotations

import asyncio
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Optional
from uuid import UUID

from sqlalchemy.orm import Session

from app.models import ClusterConfigSnapshot
from app.models.cluster import Cluster
from app.models.node_param_watch import NodeParamWatchRule
from app.models.service_config import ServiceConfigApplyRun, ServiceConfigVersion
from app.services.service_config import current as C
from app.services.service_config import view as V
from app.services.ssh_runner import SSHTarget
from app.services import ssh_runner

APPLY_SUPPORTED = ("linux", "cilium")
SETTINGS_KEY = "service_config.settings"
SETTINGS_DEFAULTS: dict[str, Any] = {
    # PEP 가 소유하는 sysctl 파일 — 99-sysctl.conf(=/etc/sysctl.conf 링크)보다 뒤에 읽혀 부팅 때 덮이지 않는 이름.
    "sysctl_file": "/etc/sysctl.d/99-zz-pep.conf",
    "cilium_namespace": "kube-system",
    "cilium_configmap": "cilium-config",
    "cilium_daemonset": "cilium",
    "rollout_timeout_sec": 600,
}
RUN_ACTIVE = "running"
WATCH_RULE_OWNER = "service-config"

_KEY_RE = re.compile(r"^[A-Za-z0-9_.\-/]+$")
_VALUE_RE = re.compile(r"^[A-Za-z0-9 _.:,/+\-]*$")
_PATH_RE = re.compile(r"^/[A-Za-z0-9_./\-]+$")
_K8S_NAME_RE = re.compile(r"^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$")


class ApplyError(V.ServiceConfigError):
    pass


# ── 설정 ─────────────────────────────────────────────────────────────────────

def _normalize_settings(stored: Any) -> dict[str, Any]:
    out = {**SETTINGS_DEFAULTS, **(stored if isinstance(stored, dict) else {})}
    if not _PATH_RE.match(str(out["sysctl_file"])):
        out["sysctl_file"] = SETTINGS_DEFAULTS["sysctl_file"]
    for k in ("cilium_namespace", "cilium_configmap", "cilium_daemonset"):
        if not _K8S_NAME_RE.match(str(out[k] or "")):
            out[k] = SETTINGS_DEFAULTS[k]
    try:
        t = int(out["rollout_timeout_sec"])
    except (TypeError, ValueError):
        t = SETTINGS_DEFAULTS["rollout_timeout_sec"]
    out["rollout_timeout_sec"] = t if 30 <= t <= 3600 else SETTINGS_DEFAULTS["rollout_timeout_sec"]
    return {k: out[k] for k in SETTINGS_DEFAULTS}


def get_settings(db: Session) -> dict[str, Any]:
    from app.models.app_setting import AppSetting

    try:
        row = db.query(AppSetting).filter(AppSetting.key == SETTINGS_KEY).first()
    except Exception:  # noqa: BLE001
        db.rollback()
        return _normalize_settings(None)
    return _normalize_settings(row.value if row else None)


def set_settings(db: Session, patch: dict[str, Any]) -> dict[str, Any]:
    from app.models.app_setting import AppSetting

    for k, v in patch.items():
        if v is None:
            continue
        if k == "sysctl_file" and not _PATH_RE.match(str(v)):
            raise ApplyError(422, "sysctl 파일 경로는 / 로 시작하는 절대 경로여야 합니다(영문·숫자·_ . / - 만).")
        if k in ("cilium_namespace", "cilium_configmap", "cilium_daemonset") and not _K8S_NAME_RE.match(str(v)):
            raise ApplyError(422, f"{k}: 쿠버네티스 이름 형식이 아닙니다.")
    row = db.query(AppSetting).filter(AppSetting.key == SETTINGS_KEY).first()
    prev = row.value if row and isinstance(row.value, dict) else {}
    merged = _normalize_settings({**prev, **{k: v for k, v in patch.items() if v is not None}})
    if row:
        row.value = merged
    else:
        db.add(AppSetting(key=SETTINGS_KEY, value=merged))
    db.commit()
    return get_settings(db)


# ── 계획 ─────────────────────────────────────────────────────────────────────

def _node_hosts(db: Session, cluster: Cluster, nodes: list[str]) -> dict[str, str]:
    """노드 → SSH 접속 주소. 에이전트 스냅샷의 host_ip → (SSH 수집 노드는 이미 주소) → 노드 이름 그대로."""
    out: dict[str, str] = {}
    snaps = (
        db.query(ClusterConfigSnapshot)
        .filter(ClusterConfigSnapshot.cluster_id == cluster.id, ClusterConfigSnapshot.component.like("node_params:%"))
        .order_by(ClusterConfigSnapshot.component.asc(), ClusterConfigSnapshot.collected_at.desc())
        .distinct(ClusterConfigSnapshot.component)
        .all()
    )
    agent_ip = {s.component.split(":", 1)[1]: (s.data or {}).get("host_ip") for s in snaps}
    for n in nodes:
        out[n] = agent_ip.get(n) or n
    return out


def _scope_version(db: Session, cluster: Cluster, service: str, group_id: Optional[UUID],
                   version_no: Optional[int]) -> tuple[Any, ServiceConfigVersion, list[ServiceConfigVersion]]:
    group = V._get_group(db, cluster, service, group_id)  # noqa: SLF001 — 같은 패키지
    versions = V.list_versions(db, cluster.id, service, group.id if group else None)
    if not versions:
        raise ApplyError(422, "적용할 설정 버전이 없습니다.")
    target = next((v for v in versions if v.version_no == version_no), None) if version_no else versions[0]
    if target is None:
        raise ApplyError(404, f"V{version_no} 를 찾을 수 없습니다.")
    return group, target, versions


def plan_apply(db: Session, cluster: Cluster, service: str, version_no: Optional[int], group_id: Optional[UUID],
               target_mode: str = "scope", nodes: Optional[list[str]] = None) -> dict[str, Any]:
    """적용 미리보기 — 대상 노드·노드 접속 주소·적용할 값·기준(최신 가져옴/적용) 대비 변경."""
    meta = V.service_meta(service)
    group, target, versions = _scope_version(db, cluster, service, group_id, version_no)
    gid = group.id if group else None
    keys = {it.key for it in V.load_items(db, service)}
    base_default = V._default_latest_values(db, cluster.id, service)  # noqa: SLF001
    if gid is None:
        values = dict(target.values or {})
    else:
        values = {**base_default, **(target.values or {})}
    values = {k: v for k, v in values.items() if k in keys and C.norm(v) not in (None, "")}
    baseline = next((v for v in versions if v.status in V.BASELINE_STATUSES and v.version_no != target.version_no), None)
    if gid is None:
        before = dict(baseline.values or {}) if baseline else {}
    else:
        before = {**base_default, **((baseline.values or {}) if baseline else {})}
    changes = V.diff_values({k: v for k, v in before.items() if k in keys}, values)

    scope_nodes: list[str] = []
    if service in V.GROUPLESS_SERVICES:
        scope_nodes = [C.CLUSTER_NODE]
        target_mode = "scope"
    else:
        items = V.load_items(db, service)
        cur = C.current_values(service, V.latest_snapshots(db, cluster.id, service), items)
        all_nodes = sorted({s["node"] for s in cur["sources"]})
        membership = V.node_group_map(all_nodes, V.list_groups(db, cluster.id, service))
        scope_nodes = [n for n in all_nodes if membership.get(n) == (str(gid) if gid else None)]
    if target_mode == "nodes":
        chosen = [n for n in (nodes or []) if n in scope_nodes]
        unknown = sorted(set(nodes or []) - set(scope_nodes))
        if unknown:
            raise ApplyError(422, f"이 범위에 없는 노드: {', '.join(unknown[:10])}")
        targets = chosen
    else:
        targets = scope_nodes
    hosts = _node_hosts(db, cluster, targets) if service == "linux" else {n: n for n in targets}
    return {
        "service": meta, "supported": service in APPLY_SUPPORTED,
        "group": {"id": str(gid) if gid else None, "name": group.name if group else "기본"},
        "version_no": target.version_no, "version_status": target.status, "baseline_version_no": baseline.version_no if baseline else None,
        "target_mode": target_mode, "scope_nodes": scope_nodes,
        "targets": [{"node": n, "host": hosts.get(n, n)} for n in targets],
        "values": values, "changes": changes,
    }


# ── 렌더·검증 ────────────────────────────────────────────────────────────────

def validate_pairs(values: dict[str, Any]) -> dict[str, str]:
    """sysctl 키·값을 셸·파일에 넣기 전에 검증 — 줄바꿈·따옴표·$·` 등이 있으면 거부(명령 주입 방지)."""
    out: dict[str, str] = {}
    for k, v in values.items():
        val = C.norm(v) or ""
        if not _KEY_RE.match(k):
            raise ApplyError(422, f"적용할 수 없는 키 이름: {k}")
        if not _VALUE_RE.match(val):
            raise ApplyError(422, f"{k} 값에 쓸 수 없는 문자가 있습니다: {val!r}")
        out[k] = val
    return out


def render_sysctl_file(values: dict[str, str], *, cluster_name: str, version_no: int, group_name: str) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        "# PEP 서비스 구성이 관리하는 파일 — 직접 고치지 마세요(다음 적용 때 덮어씁니다).",
        f"# 클러스터 {cluster_name} · {group_name} · V{version_no} · {stamp}",
    ]
    lines += [f"{k} = {v}" for k, v in sorted(values.items())]
    return "\n".join(lines) + "\n"


def _parse_sysctl(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in (text or "").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = C.norm(v) or ""
    return out


# ── 실행 공용 ────────────────────────────────────────────────────────────────

class RunLog:
    """작업 스레드에서도 안전한 로그 수집 + SSE emit. DB 커밋은 이벤트 루프 쪽에서 배치마다 한다."""

    def __init__(self, emit: Callable[[dict], None]):
        self.emit = emit
        self.lines: list[list[str]] = []
        self._lock = threading.Lock()

    def log(self, level: str, message: str) -> None:
        ts = datetime.now(timezone.utc).isoformat()
        with self._lock:
            self.lines.append([ts, level, message])
        self.emit({"type": "log", "level": level, "ts": ts, "message": message})

    def step(self, name: str, label: str, status: str) -> None:
        self.emit({"type": "step", "name": name, "label": label, "status": status})


def start_run(db: Session, cluster: Cluster, service: str, plan: dict[str, Any], options: dict[str, Any],
              username: Optional[str]) -> ServiceConfigApplyRun:
    if service not in APPLY_SUPPORTED:
        raise ApplyError(422, f"{plan['service']['label']} 적용은 다음 단계에서 제공됩니다(지금은 LINUX·CILIUM).")
    if not plan["targets"]:
        raise ApplyError(422, "적용할 노드가 없습니다. 먼저 현재 값을 수집하거나 노드를 고르세요.")
    running = db.query(ServiceConfigApplyRun.id).filter(
        ServiceConfigApplyRun.cluster_id == cluster.id, ServiceConfigApplyRun.service == service,
        ServiceConfigApplyRun.status == RUN_ACTIVE).first()
    if running:
        raise ApplyError(409, "이 서비스에 진행 중인 적용이 있습니다. 끝나거나 중지된 뒤 다시 시도하세요.")
    run = ServiceConfigApplyRun(
        cluster_id=cluster.id, service=service, group_id=UUID(plan["group"]["id"]) if plan["group"]["id"] else None,
        version_no=plan["version_no"], status=RUN_ACTIVE, target_mode=plan["target_mode"], targets=plan["targets"],
        options=options, changes=plan["changes"], node_results=[], log_lines=[], started_by=username,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def _flush(db: Session, run: ServiceConfigApplyRun, log: RunLog, results: list[dict[str, Any]]) -> None:
    db.refresh(run)
    run.log_lines = list(log.lines)
    run.node_results = list(results)
    db.commit()


def _stop_requested(db: Session, run: ServiceConfigApplyRun) -> bool:
    db.refresh(run)
    return bool(run.stop_requested)


def _finish(db: Session, cluster: Cluster, run: ServiceConfigApplyRun, log: RunLog, results: list[dict[str, Any]],
            stopped: bool) -> dict[str, Any]:
    ok = sum(1 for r in results if r["status"] == "ok")
    failed = sum(1 for r in results if r["status"] == "failed")
    skipped = sum(1 for r in results if r["status"] == "skipped")
    if stopped:
        status = "stopped"
    elif ok and not failed and not skipped:
        status = "succeeded"
    elif ok:
        status = "partial"
    else:
        status = "failed"
    if status == "succeeded" and run.target_mode == "scope":
        q = db.query(ServiceConfigVersion).filter(
            ServiceConfigVersion.cluster_id == cluster.id, ServiceConfigVersion.service == run.service,
            ServiceConfigVersion.version_no == run.version_no)
        q = q.filter(ServiceConfigVersion.group_id.is_(None) if run.group_id is None
                     else ServiceConfigVersion.group_id == run.group_id)
        ver = q.first()
        if ver is not None:
            ver.status = "applied"
            ver.applied_at = datetime.utcnow()
            log.log("info", f"V{run.version_no} 을(를) 적용됨으로 표시")
    elif status == "succeeded":
        log.log("info", "고른 노드에만 적용했으므로 버전은 '저장됨·미적용' 으로 남깁니다(일부 적용).")
    label = {"succeeded": "성공", "partial": "일부 성공", "failed": "실패", "stopped": "중지됨"}[status]
    log.log("warn" if status != "succeeded" else "info",
            f"완료 — {label} · 성공 {ok} · 실패 {failed} · 건너뜀 {skipped}")
    db.refresh(run)
    run.status = status
    run.finished_at = datetime.utcnow()
    run.log_lines = list(log.lines)
    run.node_results = list(results)
    db.commit()
    return run_out(run)


def run_out(run: ServiceConfigApplyRun, with_logs: bool = True) -> dict[str, Any]:
    out = {
        "id": str(run.id), "service": run.service, "group_id": str(run.group_id) if run.group_id else None,
        "version_no": run.version_no, "status": run.status, "target_mode": run.target_mode,
        "targets": run.targets or [], "options": run.options or {}, "changes": run.changes or [],
        "node_results": run.node_results or [], "stop_requested": run.stop_requested,
        "started_by": run.started_by, "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
    }
    if with_logs:
        out["log_lines"] = run.log_lines or []
    return out


# ── LINUX(OS) ────────────────────────────────────────────────────────────────

def _os_node(node: str, host: str, values: dict[str, str], content: str, opts: dict[str, Any],
             creds: dict[str, Any], sysctl_file: str, backup: str, log: RunLog) -> dict[str, Any]:
    t0 = time.monotonic()
    sudo = "sudo -n " if creds.get("use_sudo") else ""
    target = SSHTarget(host=host, port=int(creds.get("port") or 22), username=creds.get("username") or "root",
                       password=creds.get("password"), private_key=creds.get("private_key"))
    timeout = int(creds.get("connect_timeout") or 8)
    keys = " ".join(sorted(values))
    res: dict[str, Any] = {"node": node, "host": host, "status": "failed", "before": {}, "after": {}, "error": None}

    def run(cmd: str, label: str, exec_timeout: int = 30):
        r = ssh_runner._exec_ssh(target, cmd, connect_timeout=timeout, exec_timeout=exec_timeout)  # noqa: SLF001
        if r.status != "ok":
            detail = (r.error or r.stderr or r.stdout or "").strip()[:300]
            raise RuntimeError(f"{label} 실패({r.status}{'' if r.exit_code is None else f', exit {r.exit_code}'}): {detail}")
        return r

    try:
        log.step(node, node, "running")
        log.log("info", f"[{node}] SSH 접속 {target.username}@{host}:{target.port} — 적용 전 값 읽기")
        before = _parse_sysctl(run(f"{sudo}sysctl -e {keys}", "적용 전 값 읽기").stdout)
        res["before"] = before
        diff = [k for k in sorted(values) if before.get(k) != values[k]]
        log.log("info", f"[{node}] 바뀔 값 {len(diff)}개" + (": " + ", ".join(f"{k} {before.get(k, '없음')}→{values[k]}" for k in diff[:8]) if diff else ""))
        if opts.get("persist", True):
            run(f"{sudo}sh -c 'test -f {sysctl_file} && cp -p {sysctl_file} {backup} || true'", "백업")
            log.log("info", f"[{node}] 백업 {sysctl_file} → {backup}(있을 때만)")
            run(f"{sudo}tee {sysctl_file} >/dev/null <<'PEP_SYSCTL_EOF'\n{content}PEP_SYSCTL_EOF", "관리 파일 기록")
            log.log("info", f"[{node}] 기록 {sysctl_file} ({len(values)}개 키)")
            out = run(f"{sudo}sysctl -p {sysctl_file}", "sysctl -p")
            log.log("info", f"[{node}] 실행 sysctl -p {sysctl_file} — {len((out.stdout or '').splitlines())}줄 반영")
        else:
            pairs = " ".join(f"{k}='{v}'" for k, v in sorted(values.items()))
            run(f"{sudo}sysctl -w {pairs}", "sysctl -w")
            log.log("info", f"[{node}] 실행 sysctl -w ({len(values)}개, 영구 파일 기록 안 함 — 재부팅 시 원복)")
        after = _parse_sysctl(run(f"{sudo}sysctl -e {keys}", "적용 후 값 읽기").stdout)
        res["after"] = after
        mismatch = [k for k in sorted(values) if after.get(k) != values[k]]
        if mismatch:
            raise RuntimeError("다시 읽은 값이 다릅니다: " + ", ".join(f"{k}={after.get(k, '없음')}(기대 {values[k]})" for k in mismatch[:8]))
        res["status"] = "ok"
        log.log("info", f"[{node}] 확인 {len(values)}/{len(values)} 일치 — 완료")
        log.step(node, node, "done")
    except Exception as exc:  # noqa: BLE001 — 노드 하나의 실패가 실행 전체를 죽이지 않는다
        res["error"] = str(exc)[:500]
        log.log("error", f"[{node}] {res['error']}")
        log.step(node, node, "failed")
    res["duration_ms"] = int((time.monotonic() - t0) * 1000)
    return res


async def run_os(db: Session, cluster: Cluster, run: ServiceConfigApplyRun, plan: dict[str, Any],
                 opts: dict[str, Any], creds: dict[str, Any], log: RunLog) -> dict[str, Any]:
    cfg = get_settings(db)
    values = validate_pairs(plan["values"])
    sysctl_file = cfg["sysctl_file"]
    backup = f"{sysctl_file}.pep-bak-v{plan['baseline_version_no'] or 0}"
    content = render_sysctl_file(values, cluster_name=cluster.name, version_no=plan["version_no"],
                                 group_name=plan["group"]["name"])
    targets = plan["targets"]
    batch = max(1, min(int(opts.get("batch_size") or 1), 50))
    pause = max(0, min(int(opts.get("pause_sec") or 0), 600))
    log.log("info", f"시작 — LINUX(OS) {plan['group']['name']} V{plan['version_no']} · 노드 {len(targets)}개 · {batch}대씩"
                    f" · 대기 {pause}초 · 실패 시 {'중단' if opts.get('stop_on_failure', True) else '계속'}"
                    f" · {'영구 파일 기록 ' + sysctl_file if opts.get('persist', True) else 'sysctl -w 만'}")
    results: list[dict[str, Any]] = []
    loop = asyncio.get_running_loop()
    stopped = False
    for i in range(0, len(targets), batch):
        if _stop_requested(db, run):
            stopped = True
            log.log("warn", "중지 요청 — 남은 노드를 건너뜁니다.")
        failed_before = any(r["status"] == "failed" for r in results)
        if stopped or (failed_before and opts.get("stop_on_failure", True)):
            for t in targets[i:]:
                results.append({"node": t["node"], "host": t["host"], "status": "skipped", "before": {}, "after": {},
                                "error": "중지" if stopped else "앞 노드 실패로 중단", "duration_ms": 0})
            if not stopped:
                log.log("warn", f"앞 배치에서 실패 — 남은 {len(targets) - i}개 노드는 건너뜁니다.")
            break
        chunk = targets[i:i + batch]
        done = await asyncio.gather(*[
            loop.run_in_executor(None, _os_node, t["node"], t["host"], values, content, opts, creds,
                                 sysctl_file, backup, log)
            for t in chunk
        ])
        results.extend(done)
        _flush(db, run, log, results)
        will_stop = opts.get("stop_on_failure", True) and any(r["status"] == "failed" for r in results)
        if i + batch < len(targets) and pause and not will_stop:  # 어차피 멈출 거면 기다리지 않는다
            log.log("info", f"대기 {pause}초 (배치 사이)")
            await asyncio.sleep(pause)
    # 감시 규칙은 범위 전체에 적용했을 때만 갱신한다 — 일부 노드만 바꿨으면 나머지 노드가 위반으로 잡히므로.
    if (opts.get("update_watch_rules", True) and run.target_mode == "scope" and not stopped
            and any(r["status"] == "ok" for r in results)):
        try:
            update_watch_rules(db, cluster, plan, log)
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            log.log("warn", f"감시 규칙 갱신 실패 — 적용은 유지 ({exc})")
    return _finish(db, cluster, run, log, results, stopped)


def update_watch_rules(db: Session, cluster: Cluster, plan: dict[str, Any], log: RunLog) -> int:
    """적용 값으로 OS 파라미터 감시 규칙(클러스터 규칙, eq)을 만들거나 갱신한다 — 드리프트 감시가 새 기준을 따른다.
    기본 범위 적용이면 그 키를 재정의한 노드 그룹이 있을 때 건너뛴다(그룹 노드가 기본 규칙에 걸려 오탐이 나므로)."""
    gid = plan["group"]["id"]
    pattern = None
    overridden: set[str] = set()
    groups = V.list_groups(db, cluster.id, "linux")
    if gid:
        pattern = next((g.node_pattern for g in groups if str(g.id) == gid), None)
    else:
        for g in groups:
            gv = V.list_versions(db, cluster.id, "linux", g.id)
            if gv:
                overridden |= set((gv[0].values or {}).keys())
    n = 0
    skipped = []
    for key, value in sorted(plan["values"].items()):
        if not gid and key in overridden:
            skipped.append(key)
            continue
        q = db.query(NodeParamWatchRule).filter(
            NodeParamWatchRule.cluster_id == cluster.id, NodeParamWatchRule.param == key,
            NodeParamWatchRule.created_by == WATCH_RULE_OWNER)
        q = q.filter(NodeParamWatchRule.node_pattern.is_(None) if pattern is None else NodeParamWatchRule.node_pattern == pattern)
        rule = q.first()
        if rule is None:
            rule = NodeParamWatchRule(cluster_id=cluster.id, param=key, node_pattern=pattern, severity="warning",
                                      alert_on_change=True, check_persistent=True, enabled=True,
                                      created_by=WATCH_RULE_OWNER)
            db.add(rule)
        rule.operator = "eq"
        rule.expected = C.norm(value)
        rule.description = f"서비스 구성 적용 값(V{plan['version_no']}, {plan['group']['name']}) — 다음 적용 때 갱신된다."
        n += 1
    db.commit()
    log.log("info", f"OS 파라미터 감시 규칙 {n}개를 적용 값으로 갱신"
                    + (f" · 그룹이 재정의한 {len(skipped)}개는 건너뜀({', '.join(skipped[:5])})" if skipped else ""))
    return n


# ── CILIUM ───────────────────────────────────────────────────────────────────

def k8s_apis(cluster: Cluster):
    """(CoreV1Api, AppsV1Api) — 테스트에서 바꿔 끼운다."""
    import os

    from kubernetes import client as k8s_client

    from app.services.k8s_client_pool import get_api_client_for_path
    from app.services.kubeconfig import ensure_kubeconfig_file

    kc = ensure_kubeconfig_file(cluster)
    if not kc or not os.path.exists(kc):
        raise RuntimeError("kubeconfig 가 등록되지 않은 클러스터입니다(클러스터 관리에서 kubeconfig 를 올리세요).")
    api = get_api_client_for_path(kc)
    return k8s_client.CoreV1Api(api), k8s_client.AppsV1Api(api)


async def run_cilium(db: Session, cluster: Cluster, run: ServiceConfigApplyRun, plan: dict[str, Any],
                     opts: dict[str, Any], log: RunLog) -> dict[str, Any]:
    from app.services.config_snapshot import store_if_changed

    cfg = get_settings(db)
    ns, cm_name, ds_name = cfg["cilium_namespace"], cfg["cilium_configmap"], cfg["cilium_daemonset"]
    timeout = int(opts.get("rollout_timeout_sec") or cfg["rollout_timeout_sec"])
    loop = asyncio.get_running_loop()
    res: dict[str, Any] = {"node": C.CLUSTER_NODE, "host": f"{ns}/{cm_name}", "status": "failed",
                           "before": {}, "after": {}, "error": None}
    t0 = time.monotonic()
    stopped = False
    step = ["configmap", "ConfigMap 변경"]  # 실패 시 진행 중이던 단계를 실패로 표시
    log.log("info", f"시작 — CILIUM V{plan['version_no']} · ConfigMap {ns}/{cm_name}"
                    f" · {'DaemonSet ' + ns + '/' + ds_name + ' 롤링 재시작' if opts.get('restart', True) else '재시작 안 함'}")
    try:
        log.step("configmap", "ConfigMap 변경", "running")
        core, apps = await loop.run_in_executor(None, k8s_apis, cluster)
        cm = await loop.run_in_executor(None, lambda: core.read_namespaced_config_map(cm_name, ns, _request_timeout=15))
        data = dict(cm.data or {})
        want = {k: C.norm(v) or "" for k, v in plan["values"].items()}
        patch = {k: v for k, v in want.items() if C.norm(data.get(k)) != v}
        res["before"] = {k: data.get(k) for k in patch}
        if not patch:
            log.log("info", "ConfigMap 이 이미 이 버전과 같습니다 — 변경·재시작 없이 끝냅니다.")
            log.step("configmap", "ConfigMap 변경", "done")
        else:
            for k, v in patch.items():
                log.log("info", f"변경 {k}: {data.get(k, '(없음)')} → {v}")
            await loop.run_in_executor(None, lambda: core.patch_namespaced_config_map(
                cm_name, ns, {"data": patch}, _request_timeout=15))
            log.log("info", f"ConfigMap patch 완료 ({len(patch)}개 키)")
            log.step("configmap", "ConfigMap 변경", "done")
            if opts.get("restart", True):
                step[:] = ["rollout", "cilium 롤링 재시작"]
                log.step("rollout", "cilium 롤링 재시작", "running")
                now = datetime.now(timezone.utc).isoformat()
                body = {"spec": {"template": {"metadata": {"annotations": {"kubectl.kubernetes.io/restartedAt": now}}}}}
                await loop.run_in_executor(None, lambda: apps.patch_namespaced_daemon_set(ds_name, ns, body, _request_timeout=15))
                log.log("info", f"DaemonSet {ns}/{ds_name} 재시작 요청 — 롤아웃 완료를 기다립니다(최대 {timeout}초)")
                deadline = time.monotonic() + timeout
                last = ""
                while True:
                    ds = await loop.run_in_executor(None, lambda: apps.read_namespaced_daemon_set(ds_name, ns, _request_timeout=15))
                    st = ds.status
                    desired = int(getattr(st, "desired_number_scheduled", 0) or 0)
                    updated = int(getattr(st, "updated_number_scheduled", 0) or 0)
                    avail = int(getattr(st, "number_available", 0) or 0)
                    observed = int(getattr(st, "observed_generation", 0) or 0)
                    gen = int(getattr(ds.metadata, "generation", 0) or 0)
                    line = f"롤아웃 {updated}/{desired} 갱신 · {avail}/{desired} 사용 가능"
                    if line != last:
                        log.log("info", line)
                        last = line
                    if observed >= gen and desired > 0 and updated == desired and avail == desired:
                        break
                    if _stop_requested(db, run):
                        stopped = True
                        log.log("warn", "중지 요청 — 롤아웃 대기를 멈춥니다(쿠버네티스 롤아웃은 계속 진행됩니다).")
                        break
                    if time.monotonic() > deadline:
                        raise RuntimeError(f"롤아웃이 {timeout}초 안에 끝나지 않았습니다 ({line}) — cilium 파드 상태를 확인하세요.")
                    _flush(db, run, log, [res])
                    await asyncio.sleep(float(opts.get("poll_sec") or 5))
                log.step("rollout", "cilium 롤링 재시작", "done" if not stopped else "failed")
            else:
                log.log("warn", "재시작하지 않았습니다 — cilium 에이전트가 다시 시작될 때 새 설정이 반영됩니다.")
        cm2 = await loop.run_in_executor(None, lambda: core.read_namespaced_config_map(cm_name, ns, _request_timeout=15))
        data2 = dict(cm2.data or {})
        res["after"] = {k: data2.get(k) for k in want}
        mismatch = [k for k, v in want.items() if C.norm(data2.get(k)) != v]
        if mismatch:
            raise RuntimeError("다시 읽은 ConfigMap 값이 다릅니다: " + ", ".join(mismatch[:8]))
        version = data2.get("cilium-version") or data2.get("cni-version")
        if store_if_changed(db, cluster.id, "cilium_config", "cni", version, {"data": data2}, datetime.utcnow()):
            db.commit()
        log.log("info", f"확인 {len(want)}/{len(want)} 일치 · 현재 값 스냅샷 갱신")
        res["status"] = "ok" if not stopped else "failed"
        if stopped:
            res["error"] = "롤아웃 대기 중 중지"
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        res["error"] = str(exc)[:500]
        log.log("error", res["error"])
        log.step(step[0], step[1], "failed")
    res["duration_ms"] = int((time.monotonic() - t0) * 1000)
    return _finish(db, cluster, run, log, [res], stopped)


async def execute(db: Session, cluster: Cluster, run_id: UUID, plan: dict[str, Any], opts: dict[str, Any],
                  creds: dict[str, Any], emit: Callable[[dict], None]) -> dict[str, Any]:
    run = db.query(ServiceConfigApplyRun).filter(ServiceConfigApplyRun.id == run_id).one()
    log = RunLog(emit)
    try:
        if run.service == "linux":
            return await run_os(db, cluster, run, plan, opts, creds, log)
        return await run_cilium(db, cluster, run, plan, opts, log)
    except Exception as exc:  # noqa: BLE001 — 실행 행이 running 으로 남지 않게
        db.rollback()
        log.log("error", f"적용 중단: {str(exc)[:300]}")
        return _finish(db, cluster, run, log, list(run.node_results or []), False)
