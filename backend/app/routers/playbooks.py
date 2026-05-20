from datetime import datetime
import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import PlainTextResponse
from kubernetes import client as k8s_client, config as k8s_config
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import AnsibleInventory, AnsiblePlaybookFile, Cluster, Playbook
from app.models.user import User
from app.auth.deps import require_operator
from app.schemas.playbook import (
    PlaybookCreate,
    PlaybookUpdate,
    PlaybookResponse,
    PlaybookListResponse,
    PlaybookRunRequest,
    PlaybookRunResponse,
)
from app.services.kubeconfig import ensure_kubeconfig_file
from app.services.playbook_executor import run_playbook
from app.services import audit_logger

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/playbooks", tags=["playbooks"])


def _cluster_node_hosts(cluster: Cluster) -> list[str]:
    """클러스터의 모든 노드 InternalIP (없으면 노드명) 를 반환.

    Playbook 실행 시 inventory 가 비어있으면 이 결과로 동적 inventory 가 생성된다.
    실패하면 빈 리스트를 반환 (호출자가 fallback 로직을 결정).
    """
    kc = ensure_kubeconfig_file(cluster)
    if not kc:
        return []
    try:
        api_client = k8s_config.new_client_from_config(config_file=kc)
        v1 = k8s_client.CoreV1Api(api_client)
        nodes = v1.list_node(_request_timeout=10)
    except Exception as e:
        logger.warning("failed to list nodes for cluster %s: %s", cluster.id, str(e)[:200])
        return []

    hosts: list[str] = []
    for n in nodes.items:
        internal_ip: str | None = None
        for addr in (n.status.addresses or []):
            if addr.type == "InternalIP":
                internal_ip = addr.address
                break
        hosts.append(internal_ip or n.metadata.name)
    return hosts


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
):
    """클러스터별 또는 전체 Playbook 목록 조회"""
    query = db.query(Playbook)
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
    for key, value in payload.model_dump(exclude_unset=True).items():
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


@router.post("/{playbook_id}/run", response_model=PlaybookRunResponse)
def run_playbook_endpoint(
    playbook_id: UUID,
    request: Request,
    payload: PlaybookRunRequest = PlaybookRunRequest(),
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """Playbook 실행 (동기).

    payload 로 전달된 SSH 자격증명은 휘발성 — DB 에 저장되지 않고
    extra_vars 에 합쳐 ``ansible-playbook -e`` 로만 전달된다.
    """
    playbook = db.query(Playbook).filter(Playbook.id == playbook_id).first()
    if not playbook:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playbook not found")
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

    # running 상태로 업데이트
    playbook.status = "running"
    db.commit()

    # 실행 시 inventory 우선순위:
    #   1) DB 관리형 Inventory  (playbook.inventory.content)
    #   2) inventory_path        (구 호환 — 실행 호스트의 ini 파일 경로)
    #   3) K8s 전체 노드          (위 둘 다 없을 때 cluster 의 노드 IP 로 동적 생성)
    pb_content = playbook.playbook_file.content if playbook.playbook_file else None
    inv_content = playbook.inventory.content if playbook.inventory else None
    inventory_hosts: list[str] | None = None
    if not inv_content and not playbook.inventory_path:
        inventory_hosts = _cluster_node_hosts(playbook.cluster) or None

    # SSH 자격증명을 extra_vars 로 머지 — playbook 의 hostvars 기본값을 덮음.
    # (인벤토리에 이미 동일 변수가 있으면 ansible 우선순위 규칙상 group/host vars 가 이김 →
    #  여기서는 dynamic inventory 케이스를 위해 -e 로 전달.)
    merged_vars: dict = dict(playbook.extra_vars or {})
    if payload.ssh_username:
        merged_vars["ansible_user"] = payload.ssh_username
    if payload.ssh_password:
        merged_vars["ansible_ssh_pass"] = payload.ssh_password
    if payload.ssh_port:
        merged_vars["ansible_port"] = payload.ssh_port
    if payload.become is not None:
        merged_vars["ansible_become"] = bool(payload.become)
    if payload.become_password:
        merged_vars["ansible_become_pass"] = payload.become_password

    result = run_playbook(
        playbook_path=playbook.playbook_path,
        inventory_path=playbook.inventory_path,
        playbook_content=pb_content,
        inventory_content=inv_content,
        extra_vars=merged_vars or None,
        tags=playbook.tags,
        inventory_hosts=inventory_hosts,
        ssh_private_key=payload.ssh_private_key,
    )

    # 결과 저장
    playbook.status = result.status
    playbook.last_run_at = datetime.utcnow()
    playbook.last_result = {
        "message": result.message,
        "stats": result.stats,
        "duration_ms": result.duration_ms,
        "raw_output": result.raw_output[:5000] if result.raw_output else None,
    }
    db.commit()
    db.refresh(playbook)

    return PlaybookRunResponse(
        id=playbook.id,
        status=result.status,
        message=result.message,
        stats=result.stats,
        duration_ms=result.duration_ms,
    )
