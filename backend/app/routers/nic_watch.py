"""NIC 상태 라우터 — 서비스 구성 ▸ NIC 화면(읽기 전용).

노드 파라미터 에이전트(1.2.0+)가 보고한 인터페이스 상태(본딩/LACP·링크·MTU·ring buffer·드롭·offload)를
노드 × 인터페이스 표와 경고로 돌려준다. 보고 수신은 ``node_param_watch`` 의 에이전트 보고(``nic`` 필드)가 맡는다.
경로의 ``cluster_id`` 는 마운트 의존성(``enforce_cluster_access``)이 판정한다. 설정 변경은 admin.
"""
from __future__ import annotations

import logging
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user, require_admin
from app.database import get_db
from app.models.cluster import Cluster
from app.models.user import User
from app.services import audit_logger
from app.services.nic_watch import service as svc
from app.services.nic_watch.analyze import FEATURE_LABELS
from app.services.nic_watch.settings import BOND_MODES, HASH_POLICIES, KINDS, LACP_RATES, get_settings, set_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/nic-watch", tags=["NIC Watch"])


class SettingsUpdate(BaseModel):
    enabled: Optional[bool] = None
    include_kinds: Optional[list[str]] = Field(default=None, max_length=10)
    include_names: Optional[list[str]] = Field(default=None, max_length=50)
    exclude_names: Optional[list[str]] = Field(default=None, max_length=50)
    expected_bond_mode: Optional[str] = Field(default=None, max_length=32)
    expected_hash_policy: Optional[str] = Field(default=None, max_length=32)
    expected_lacp_rate: Optional[str] = Field(default=None, max_length=16)
    min_speed_mbps: Optional[int] = None
    cross_node_check: Optional[bool] = None
    rate_window_minutes: Optional[int] = None
    drop_warn_per_min: Optional[int] = None
    crc_warn_count: Optional[int] = None
    flap_warn_count: Optional[int] = None
    # [{name: 커널 기능 이름, on: bool}] — 이름이 키인 맵은 화면의 camelCase 변환에 깨지므로 목록으로 주고받는다.
    offload_expect: Optional[list[dict[str, Any]]] = Field(default=None, max_length=40)
    stale_minutes: Optional[int] = None


def _settings_out(db: Session) -> dict[str, Any]:
    cfg = get_settings(db)
    return {**cfg, "offload_expect": [{"name": k, "on": v} for k, v in sorted(cfg["offload_expect"].items())], "options": {
        "kinds": list(KINDS), "bond_modes": list(BOND_MODES), "hash_policies": list(HASH_POLICIES),
        "lacp_rates": list(LACP_RATES),
        "features": [{"name": k, "label": v} for k, v in FEATURE_LABELS.items()],
    }}


@router.get("/settings")
def read_settings(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return _settings_out(db)


@router.put("/settings")
def update_settings(
    body: SettingsUpdate,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict[str, Any]:
    patch = body.model_dump(exclude_unset=True)
    try:
        set_settings(db, patch)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("nic-watch 설정 저장 실패")
        raise HTTPException(status_code=500, detail=f"NIC 설정 저장 실패: {exc}") from exc
    svc.invalidate()
    audit_logger.record(db, action="nic_watch.settings.update", actor=user, target_type="app_setting",
                        target_id="nic_watch.settings", details={"fields": sorted(patch)}, request=request)
    return _settings_out(db)


def _cluster(db: Session, cluster_id: UUID) -> Cluster:
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    return cluster


def _offload_list(cfg: dict[str, Any]) -> dict[str, Any]:
    return {**cfg, "offload_expect": [{"name": k, "on": v} for k, v in sorted(cfg["offload_expect"].items())]}


@router.get("/clusters/{cluster_id}")
def cluster_nic(
    cluster_id: UUID,
    q: str = Query(default="", max_length=200, description="노드·인터페이스 이름 부분 일치 또는 glob"),
    kind: str = Query(default="", max_length=16),
    only_flagged: bool = Query(default=False, description="위험·확인 필요 행만"),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=0, le=500, description="0 = 요약만"),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
    cluster = _cluster(db, cluster_id)
    try:
        out = svc.cluster_view(db, cluster, q=q, kind=kind, only_flagged=only_flagged, offset=offset, limit=limit)
        return {**out, "settings": _offload_list(out["settings"])}
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("nic-watch 조회 실패 (%s)", cluster_id)
        raise HTTPException(status_code=500, detail=f"NIC 상태 조회 실패: {exc}") from exc


@router.get("/clusters/{cluster_id}/nodes/{node}/interfaces/{iface}")
def interface_detail(cluster_id: UUID, node: str, iface: str, db: Session = Depends(get_db),
                     _: User = Depends(get_current_user)) -> dict[str, Any]:
    """행 상세 — 카운터·offload 전체·본딩 하위 상태·그 행의 경고."""
    cluster = _cluster(db, cluster_id)
    row = svc.interface_detail(db, cluster, node, iface)
    if row is None:
        raise HTTPException(status_code=404, detail=f"{node} 의 인터페이스 {iface} 보고가 없습니다.")
    return row
