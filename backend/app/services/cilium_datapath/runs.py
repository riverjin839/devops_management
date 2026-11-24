"""「지금 수집」 실행 — 화면 → PEP → 에이전트(long-poll) → PEP(로그·보고) → 화면(SSE).

흐름:
1. ``create_run`` : 보고 중인 에이전트 노드를 대상으로 실행 1건을 만든다(없으면 ValueError — 화면에 사유 표시).
2. ``claim_task`` : 에이전트의 작업 수신(long-poll)이 대상 노드의 미전달 실행을 받아 간다.
3. ``append_logs``: 에이전트가 단계별 로그를 흘린다(노드 이름을 붙여 쌓는다, 상한 ``LOG_LINE_LIMIT``).
4. ``mark_done``  : 그 실행 ID 로 보고가 오면 노드 완료 — 전부 끝나면 succeeded.
5. ``finalize``   : 제한 시간까지 끝나지 않은 노드가 있으면 partial(일부)/failed(전부) 로 닫는다.

여러 에이전트가 같은 행을 동시에 고치므로 갱신은 ``SELECT … FOR UPDATE`` 로 직렬화한다.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Optional
from uuid import UUID

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.cilium_datapath import CiliumBpfAgent, CiliumDatapathRun
from app.models.cluster import Cluster
from app.services.cilium_datapath.settings import get_settings

LOG_LINE_LIMIT = 5000
_LEVELS = ("info", "warn", "error")


def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _line(level: str, message: str, node: Optional[str] = None, ts: Optional[str] = None) -> dict[str, Any]:
    return {"ts": ts or _now_iso(), "level": level if level in _LEVELS else "info",
            "message": str(message)[:2000], "node": node}


def _append(run: CiliumDatapathRun, lines: list[dict[str, Any]]) -> None:
    cur = list(run.log_lines or [])
    room = LOG_LINE_LIMIT - len(cur)
    if room <= 0:
        return
    if len(lines) > room:
        lines = lines[: room - 1] + [_line("warn", f"로그가 {LOG_LINE_LIMIT}줄을 넘어 이후 줄은 저장하지 않습니다.")]
    run.log_lines = cur + lines
    flag_modified(run, "log_lines")


def _locked(db: Session, run_id: Any) -> Optional[CiliumDatapathRun]:
    try:
        rid = run_id if isinstance(run_id, UUID) else UUID(str(run_id))
    except (ValueError, TypeError):
        return None
    return db.query(CiliumDatapathRun).filter(CiliumDatapathRun.id == rid).with_for_update().first()


def online_nodes(db: Session, cluster_id: UUID) -> list[str]:
    cfg = get_settings(db)
    since = datetime.utcnow() - timedelta(minutes=cfg["offline_minutes"])
    rows = (db.query(CiliumBpfAgent.node)
            .filter(CiliumBpfAgent.cluster_id == cluster_id, CiliumBpfAgent.last_seen_at >= since)
            .order_by(CiliumBpfAgent.node.asc()).all())
    return [r.node for r in rows]


def create_run(db: Session, cluster: Cluster, requested_by: Optional[str], nodes: Optional[list[str]] = None) -> CiliumDatapathRun:
    online = online_nodes(db, cluster.id)
    if not online:
        raise ValueError(
            "보고 중인 에이전트가 없습니다 — 「에이전트 설치」 매니페스트로 pep-bpf-agent 를 배포하고, "
            "backend 의 CILIUM_BPF_AGENT_TOKEN 과 에이전트 Secret 의 토큰이 같은지 확인하세요."
        )
    targets = online
    if nodes:
        wanted = {n.strip() for n in nodes if n and n.strip()}
        targets = [n for n in online if n in wanted]
        missing = sorted(wanted - set(online))
        if not targets:
            raise ValueError(f"선택한 노드의 에이전트가 보고 중이 아닙니다: {', '.join(missing)}")
    cfg = get_settings(db)
    run = CiliumDatapathRun(cluster_id=cluster.id, kind="collect", status="running", target_nodes=targets,
                            claimed_nodes=[], done_nodes=[], summary={}, requested_by=requested_by, log_lines=[])
    _append(run, [_line("info", f"작업 생성 · 대상 {len(targets)}개 노드 ({', '.join(targets[:12])}"
                                f"{' 외' if len(targets) > 12 else ''}) · 제한 시간 {cfg['run_timeout_sec']}초")])
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def claim_task(db: Session, cluster_id: UUID, node: str) -> Optional[dict[str, Any]]:
    """이 노드가 아직 받아 가지 않은 진행 중 실행 1건 — 받아 간 것으로 표시하고 돌려준다."""
    cfg = get_settings(db)
    since = datetime.utcnow() - timedelta(seconds=cfg["run_timeout_sec"])
    candidates = (db.query(CiliumDatapathRun.id)
                  .filter(CiliumDatapathRun.cluster_id == cluster_id, CiliumDatapathRun.status == "running",
                          CiliumDatapathRun.created_at >= since)
                  .order_by(CiliumDatapathRun.created_at.asc()).all())
    for (rid,) in candidates:
        run = _locked(db, rid)
        if run is None or run.status != "running":
            db.rollback()
            continue
        if node not in (run.target_nodes or []) or node in (run.claimed_nodes or []):
            db.rollback()
            continue
        run.claimed_nodes = list(run.claimed_nodes or []) + [node]
        flag_modified(run, "claimed_nodes")
        _append(run, [_line("info", "에이전트에 작업 전달", node)])
        db.commit()
        return {"run_id": str(run.id), "kind": run.kind}
    return None


def append_logs(db: Session, run_id: str, cluster_id: UUID, node: str, lines: list[dict[str, Any]]) -> bool:
    run = _locked(db, run_id)
    if run is None or run.cluster_id != cluster_id or node not in (run.target_nodes or []):
        db.rollback()
        return False
    clean = [_line(str(ln.get("level") or "info"), str(ln.get("message") or ""), node, str(ln.get("ts") or "")[:40] or None)
             for ln in lines[:500] if isinstance(ln, dict)]
    _append(run, clean)
    db.commit()
    return True


def mark_done(db: Session, run_id: str, cluster_id: UUID, node: str, node_summary: dict[str, Any]) -> None:
    run = _locked(db, run_id)
    if run is None or run.cluster_id != cluster_id or node not in (run.target_nodes or []):
        db.rollback()
        return
    if node not in (run.done_nodes or []):
        run.done_nodes = list(run.done_nodes or []) + [node]
        flag_modified(run, "done_nodes")
    summary = dict(run.summary or {})
    nodes = dict(summary.get("nodes") or {})
    nodes[node] = node_summary
    summary["nodes"] = nodes
    run.summary = summary
    flag_modified(run, "summary")
    # 위험·주의 맵은 실행 실패가 아니라 판정 결과 — error 는 실행 실패(보고 실패·전원 무응답)에만 쓴다.
    level = "warn" if (node_summary.get("critical") or node_summary.get("warning")) else "info"
    _append(run, [_line(level, f"보고 수신 · 맵 {node_summary.get('maps', 0)}개 · 위험 {node_summary.get('critical', 0)} · "
                               f"주의 {node_summary.get('warning', 0)} · {node_summary.get('collect_ms') or 0}ms", node)])
    if run.status == "running" and set(run.done_nodes) >= set(run.target_nodes or []):
        _close(run, "succeeded")
    db.commit()


def _close(run: CiliumDatapathRun, status: str) -> None:
    nodes = (run.summary or {}).get("nodes") or {}
    crit = sum(int(v.get("critical") or 0) for v in nodes.values())
    warn = sum(int(v.get("warning") or 0) for v in nodes.values())
    missing = [n for n in run.target_nodes or [] if n not in (run.done_nodes or [])]
    summary = {**(run.summary or {}), "critical": crit, "warning": warn, "missing": missing}
    run.summary = summary
    flag_modified(run, "summary")
    run.status = status
    run.finished_at = datetime.utcnow()
    text = f"완료 · {len(run.done_nodes or [])}/{len(run.target_nodes or [])} 노드 · 위험 {crit} · 주의 {warn}"
    if missing:
        text += f" · 응답 없음 {', '.join(missing)}"
    _append(run, [_line("error" if status == "failed" else ("warn" if missing else "info"), text)])


def finalize(db: Session, run_id: Any) -> Optional[CiliumDatapathRun]:
    """제한 시간이 지난 실행을 닫는다 — 이미 닫혔으면 그대로 둔다."""
    run = _locked(db, run_id)
    if run is None:
        db.rollback()
        return None
    if run.status == "running":
        done = len(run.done_nodes or [])
        not_claimed = [n for n in run.target_nodes or [] if n not in (run.claimed_nodes or [])]
        if not_claimed:
            _append(run, [_line("warn", f"작업을 받아 가지 않은 노드: {', '.join(not_claimed)} — 에이전트 작업 수신(long-poll) 상태를 확인하세요.")])
        _close(run, "partial" if done else "failed")
    db.commit()
    db.refresh(run)
    return run


def run_out(run: CiliumDatapathRun, *, with_log: bool = False) -> dict[str, Any]:
    out = {
        "id": str(run.id),
        "cluster_id": str(run.cluster_id),
        "kind": run.kind,
        "status": run.status,
        "target_nodes": run.target_nodes or [],
        "done_nodes": run.done_nodes or [],
        "summary": run.summary or {},
        "requested_by": run.requested_by,
        "created_at": run.created_at.isoformat() + "Z" if run.created_at else None,
        "finished_at": run.finished_at.isoformat() + "Z" if run.finished_at else None,
    }
    if with_log:
        out["log_lines"] = run.log_lines or []
    return out
