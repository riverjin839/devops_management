from datetime import datetime
import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import PlainTextResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import AnsibleInventory, AnsiblePlaybookFile, Cluster, Playbook, PlaybookRun
from app.models.user import User
from app.auth.deps import get_cluster_scope, require_operator
from app.services.cluster_access import ClusterScope
from app.schemas.playbook import (
    PlaybookCreate,
    PlaybookUpdate,
    PlaybookResponse,
    PlaybookListResponse,
    PlaybookRunRequest,
    PlaybookRunResponse,
    PlaybookRunHistoryListResponse,
    PlaybookRunProgress,
    PlaybookRunStartResponse,
)
from app.services.playbook_service import begin_playbook_run, execute_playbook_run, reap_if_stale
from app.services.playbook_run_jobs import start_background_run
from app.services import audit_logger
from app.services.cluster_access import require_cluster_access

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/playbooks", tags=["playbooks"])


def _serialize(pb: Playbook) -> dict:
    """Playbook → dict (FK joined name 포함). PlaybookResponse 와 호환."""
    return {
        "id": pb.id,
        "cluster_id": pb.cluster_id,
        "name": pb.name,
        "description": pb.description,
        "playbook_file_id": pb.playbook_file_id,
        "inventory_id": pb.inventory_id,
        "playbook_path": pb.playbook_path,
        "inventory_path": pb.inventory_path,
        "extra_vars": pb.extra_vars,
        "tags": pb.tags,
        "timeout_seconds": pb.timeout_seconds,
        "status": pb.status,
        "show_on_dashboard": pb.show_on_dashboard,
        "last_run_at": pb.last_run_at,
        "last_result": pb.last_result,
        "created_at": pb.created_at,
        "updated_at": pb.updated_at,
        "playbook_file_name": pb.playbook_file.name if pb.playbook_file else None,
        "inventory_name": pb.inventory.name if pb.inventory else None,
    }

STATUS_LABEL = {
    "healthy": "OK",
    "warning": "Changed",
    "critical": "FAILED",
    "running": "Running",
    "unknown": "Not Run",
}


@router.get("", response_model=PlaybookListResponse)
def list_playbooks(
    cluster_id: UUID | None = Query(default=None),
    db: Session = Depends(get_db),
    scope: ClusterScope = Depends(get_cluster_scope),
):
    """클러스터별 또는 전체 Playbook 목록 조회 — 테넌트 바인딩으로 가려진 클러스터는 제외."""
    query = scope.apply(db.query(Playbook), Playbook.cluster_id)
    if cluster_id:
        query = query.filter(Playbook.cluster_id == cluster_id)
    playbooks = query.order_by(Playbook.created_at.desc()).all()
    return PlaybookListResponse(data=[_serialize(p) for p in playbooks])


@router.get("/report")
def export_report(
    cluster_id: UUID | None = Query(default=None),
    db: Session = Depends(get_db),
):
    """Playbook 실행 결과를 Markdown 테이블로 내보내기"""
    query = db.query(Playbook).join(Cluster)
    if cluster_id:
        query = query.filter(Playbook.cluster_id == cluster_id)
    playbooks = query.order_by(Cluster.name, Playbook.name).all()

    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    today = datetime.utcnow().strftime("%Y-%m-%d")

    lines = [
        f"# K8s Daily Check Report",
        f"",
        f"> Generated: {now}",
        f"",
    ]

    # 클러스터별 그룹
    clusters: dict[str, list] = {}
    for pb in playbooks:
        cname = pb.cluster.name
        clusters.setdefault(cname, []).append(pb)

    if not clusters:
        lines.append("No playbooks registered.")
    else:
        for cluster_name, pbs in clusters.items():
            lines.append(f"## Cluster: {cluster_name}")
            lines.append("")
            lines.append("| 검사 항목 | 날짜 | 상태 | 수치 |")
            lines.append("|-----------|------|------|------|")

            for pb in pbs:
                name = pb.name
                run_date = pb.last_run_at.strftime("%Y-%m-%d %H:%M") if pb.last_run_at else "-"
                status_label = STATUS_LABEL.get(pb.status, pb.status)
                stats_str = _format_stats(pb.last_result)
                lines.append(f"| {name} | {run_date} | {status_label} | {stats_str} |")

            lines.append("")

    md_content = "\n".join(lines)
    filename = f"k8s-daily-report-{today}.md"

    return PlainTextResponse(
        content=md_content,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _format_stats(last_result: dict | None) -> str:
    """last_result에서 수치 문자열 생성"""
    if not last_result:
        return "-"
    stats = last_result.get("stats", {})
    totals = stats.get("totals")
    if not totals:
        # totals 없으면 message만
        msg = last_result.get("message", "-")
        return msg[:60]

    parts = []
    for key in ("ok", "changed", "failures", "unreachable", "skipped"):
        val = totals.get(key, 0)
        if val > 0 or key in ("ok", "failures"):
            parts.append(f"{key}={val}")
    host_count = totals.get("host_count", 0)
    if host_count:
        parts.append(f"hosts={host_count}")
    duration = last_result.get("duration_ms")
    if duration is not None:
        parts.append(f"{duration}ms")
    return ", ".join(parts)


@router.get("/dashboard/{cluster_id}", response_model=PlaybookListResponse)
def get_dashboard_playbooks(cluster_id: UUID, db: Session = Depends(get_db)):
    """Dashboard에 표시할 Playbook 목록 (show_on_dashboard=True)"""
    playbooks = (
        db.query(Playbook)
        .filter(Playbook.cluster_id == cluster_id, Playbook.show_on_dashboard.is_(True))
        .order_by(Playbook.name)
        .all()
    )
    return PlaybookListResponse(data=[_serialize(p) for p in playbooks])


@router.patch("/{playbook_id}/dashboard", response_model=PlaybookResponse)
def toggle_dashboard(
    playbook_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """Playbook의 Dashboard 표시 토글"""
    playbook = db.query(Playbook).filter(Playbook.id == playbook_id).first()
    if not playbook:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playbook not found")

    playbook.show_on_dashboard = not playbook.show_on_dashboard
    db.commit()
    db.refresh(playbook)
    return _serialize(playbook)


@router.get("/{playbook_id}", response_model=PlaybookResponse)
def get_playbook(playbook_id: UUID, db: Session = Depends(get_db)):
    """Playbook 상세 조회"""
    playbook = db.query(Playbook).filter(Playbook.id == playbook_id).first()
    if not playbook:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playbook not found")
    return _serialize(playbook)


def _validate_assets(payload, db: Session, current_cluster_id: UUID | None = None):
    """playbook_file_id / inventory_id 무결성 검증."""
    if payload.playbook_file_id:
        if not db.query(AnsiblePlaybookFile).filter(
            AnsiblePlaybookFile.id == payload.playbook_file_id,
        ).first():
            raise HTTPException(status_code=422, detail="playbook_file_id 가 유효하지 않습니다.")
    if payload.inventory_id:
        inv = db.query(AnsibleInventory).filter(
            AnsibleInventory.id == payload.inventory_id,
        ).first()
        if not inv:
            raise HTTPException(status_code=422, detail="inventory_id 가 유효하지 않습니다.")
        target_cluster = current_cluster_id or getattr(payload, "cluster_id", None)
        if target_cluster and inv.cluster_id != target_cluster:
            raise HTTPException(
                status_code=422,
                detail="inventory 가 이 cluster 에 속하지 않습니다.",
            )


@router.post("", response_model=PlaybookResponse, status_code=status.HTTP_201_CREATED)
def create_playbook(
    payload: PlaybookCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """새 Playbook 등록"""
    cluster = db.query(Cluster).filter(Cluster.id == payload.cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    existing = (
        db.query(Playbook)
        .filter(Playbook.cluster_id == payload.cluster_id, Playbook.name == payload.name)
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Playbook '{payload.name}' already exists for this cluster",
        )

    _validate_assets(payload, db)
    playbook = Playbook(**payload.model_dump())
    db.add(playbook)
    db.commit()
    db.refresh(playbook)
    return _serialize(playbook)


@router.put("/{playbook_id}", response_model=PlaybookResponse)
def update_playbook(
    playbook_id: UUID,
    payload: PlaybookUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """Playbook 수정"""
    playbook = db.query(Playbook).filter(Playbook.id == playbook_id).first()
    if not playbook:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playbook not found")

    _validate_assets(payload, db, current_cluster_id=playbook.cluster_id)
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and not (data["name"] or "").strip():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="이름은 비울 수 없습니다.")
    # D-144 — 설명·태그는 null(또는 빈 값)을 보내면 비운다. 안 보낸 필드는 그대로 둔다.
    for key in ("description", "tags"):
        if key in data and isinstance(data[key], str) and not data[key].strip():
            data[key] = None
    for key, value in data.items():
        setattr(playbook, key, value)

    db.commit()
    db.refresh(playbook)
    return _serialize(playbook)


@router.delete("/{playbook_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_playbook(
    playbook_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """Playbook 삭제"""
    playbook = db.query(Playbook).filter(Playbook.id == playbook_id).first()
    if not playbook:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playbook not found")

    db.delete(playbook)
    db.commit()
    return None


def _progress(run: PlaybookRun, since: int) -> PlaybookRunProgress:
    lines = list(run.log_lines or [])
    since = max(0, min(since, len(lines)))
    return PlaybookRunProgress(
        run_id=run.id,
        playbook_id=run.playbook_id,
        status=run.status,
        finished=run.status != "running",
        message=run.message,
        stats=run.stats,
        duration_ms=run.duration_ms or 0,
        started_at=run.started_at,
        finished_at=run.finished_at,
        cancel_requested=bool(run.cancel_requested),
        cancelled_by=run.cancelled_by,
        log_lines=lines[since:],
        next=len(lines),
    )


@router.post("/{playbook_id}/runs", response_model=PlaybookRunStartResponse, status_code=status.HTTP_202_ACCEPTED)
def start_playbook_run(
    playbook_id: UUID,
    request: Request,
    payload: PlaybookRunRequest = PlaybookRunRequest(),
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """Playbook 백그라운드 실행(R1) — ``run_id`` 를 바로 돌려주고, 진행·로그는
    ``GET /playbooks/runs/{run_id}?since=N`` 으로, 취소는 ``POST /playbooks/runs/{run_id}/cancel`` 로 한다.

    SSH 자격증명은 이 프로세스의 실행 스레드에만 넘긴다 — DB·브로커에 남지 않는다.
    같은 플레이북이 이미 실행 중이면 409.
    """
    playbook = db.query(Playbook).filter(Playbook.id == playbook_id).first()
    if not playbook:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playbook not found")
    require_cluster_access(db, actor, playbook.cluster_id)

    active = (
        db.query(PlaybookRun)
        .filter(PlaybookRun.playbook_id == playbook.id, PlaybookRun.status == "running")
        .order_by(PlaybookRun.started_at.desc())
        .all()
    )
    still_running = [r for r in active if not reap_if_stale(db, r, playbook)]
    if still_running:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"이미 실행 중입니다 (run {still_running[0].id}) — 끝나거나 취소한 뒤 다시 실행하세요.",
        )

    audit_logger.record(
        db,
        action="playbook.run",
        actor=actor,
        status="success",
        target_type="playbook",
        target_id=playbook.id,
        details={"name": playbook.name, "cluster_id": str(playbook.cluster_id) if playbook.cluster_id else None, "mode": "background"},
        request=request,
    )
    run, prev_status = begin_playbook_run(
        db, playbook,
        trigger="manual",
        triggered_by_user_id=str(actor.id),
        triggered_by_username=actor.display_name or actor.username,
    )
    start_background_run(run.id, prev_status, {
        "ssh_username": payload.ssh_username,
        "ssh_password": payload.ssh_password,
        "ssh_port": payload.ssh_port,
        "ssh_private_key": payload.ssh_private_key,
        "become": payload.become,
        "become_password": payload.become_password,
    })
    return PlaybookRunStartResponse(run_id=run.id, playbook_id=playbook.id, status=run.status)


@router.get("/runs/{run_id}", response_model=PlaybookRunProgress)
def get_playbook_run(
    run_id: UUID,
    since: int = Query(default=0, ge=0, description="이미 받은 로그 줄 수 — 그 뒤 줄만 돌려준다"),
    db: Session = Depends(get_db),
    scope: ClusterScope = Depends(get_cluster_scope),
):
    """실행 진행(R1) — 상태·요약과 ``since`` 이후 로그 줄. 실행 스레드가 사라진 행은 여기서 실패로 마감한다."""
    run = db.query(PlaybookRun).filter(PlaybookRun.id == run_id).first()
    if not run:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playbook run not found")
    playbook = db.query(Playbook).filter(Playbook.id == run.playbook_id).first()
    if playbook is not None and not scope.visible(playbook.cluster_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playbook run not found")
    reap_if_stale(db, run, playbook)
    return _progress(run, since)


@router.post("/runs/{run_id}/cancel", response_model=PlaybookRunProgress)
def cancel_playbook_run(
    run_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """실행 취소(R2) — 실행 스레드가 1초 안에 이 요청을 보고 ansible 프로세스 그룹을 끊는다.
    이미 끝난 실행이면 상태를 그대로 돌려준다(멱등)."""
    run = db.query(PlaybookRun).filter(PlaybookRun.id == run_id).first()
    if not run:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playbook run not found")
    playbook = db.query(Playbook).filter(Playbook.id == run.playbook_id).first()
    if playbook is not None:
        require_cluster_access(db, actor, playbook.cluster_id)
    if run.status == "running" and not reap_if_stale(db, run, playbook):
        who = actor.display_name or actor.username
        run.cancel_requested = True
        run.cancelled_by = (who or "")[:64]
        db.commit()
        audit_logger.record(
            db,
            action="playbook.run.cancel",
            actor=actor,
            status="success",
            target_type="playbook",
            target_id=run.playbook_id,
            details={"run_id": str(run.id), "name": playbook.name if playbook else None},
            request=request,
        )
        db.refresh(run)
    return _progress(run, 0)


@router.post("/{playbook_id}/run", response_model=PlaybookRunResponse)
def run_playbook_endpoint(
    playbook_id: UUID,
    request: Request,
    payload: PlaybookRunRequest = PlaybookRunRequest(),
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """Playbook 실행 (동기) — 구 API 호환. 화면은 ``POST /playbooks/{id}/runs``(백그라운드 실행 +
    실시간 로그 + 취소)를 쓴다.

    payload 로 전달된 SSH 자격증명은 휘발성 — DB 에 저장되지 않고
    extra_vars 에 합쳐 ``ansible-playbook -e`` 로만 전달된다.
    """
    playbook = db.query(Playbook).filter(Playbook.id == playbook_id).first()
    if not playbook:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playbook not found")
    require_cluster_access(db, actor, playbook.cluster_id)
    audit_logger.record(
        db,
        action="playbook.run",
        actor=actor,
        status="success",
        target_type="playbook",
        target_id=playbook.id,
        details={"name": playbook.name, "cluster_id": str(playbook.cluster_id) if playbook.cluster_id else None},
        request=request,
    )

    _run, result = execute_playbook_run(
        db, playbook,
        trigger="manual",
        triggered_by_user_id=str(actor.id),
        triggered_by_username=actor.display_name or actor.username,
        ssh_username=payload.ssh_username,
        ssh_password=payload.ssh_password,
        ssh_port=payload.ssh_port,
        ssh_private_key=payload.ssh_private_key,
        become=payload.become,
        become_password=payload.become_password,
    )

    return PlaybookRunResponse(
        id=playbook.id,
        status=result.status,
        message=result.message,
        stats=result.stats,
        duration_ms=result.duration_ms,
    )


@router.get("/{playbook_id}/runs", response_model=PlaybookRunHistoryListResponse)
def list_playbook_runs(
    playbook_id: UUID,
    limit: int = Query(default=50, ge=1, le=500),
    db: Session = Depends(get_db),
):
    """실행 이력(D-066) — ``last_result`` 최신 스냅샷과 달리 append-only 로 전부 보존된다."""
    playbook = db.query(Playbook).filter(Playbook.id == playbook_id).first()
    if not playbook:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playbook not found")
    runs = (
        db.query(PlaybookRun)
        .filter(PlaybookRun.playbook_id == playbook_id)
        .order_by(PlaybookRun.started_at.desc())
        .limit(limit)
        .all()
    )
    return PlaybookRunHistoryListResponse(data=runs)
