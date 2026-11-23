"""NIC 상태 라우터 — 서비스 구성 ▸ NIC 화면(읽기 전용).

노드 파라미터 에이전트(1.2.0+)가 보고한 인터페이스 상태(본딩/LACP·링크·MTU·ring buffer·드롭·offload)를
노드 × 인터페이스 표와 경고로 돌려준다. 보고 수신은 ``node_param_watch`` 의 에이전트 보고(``nic`` 필드)가 맡는다.
경로의 ``cluster_id`` 는 마운트 의존성(``enforce_cluster_access``)이 판정한다. 설정 변경은 admin.
"""
from __future__ import annotations

import logging
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user, require_admin
from app.database import get_db
from app.models.cluster import Cluster
from app.models.user import User
from app.services import audit_logger
from app.services.nic_watch import service as svc
from app.services.nic_watch.analyze import FEATURE_LABELS
from app.services.nic_watch import learn
from app.services.nic_watch.settings import (
    BOND_MODES,
    DEFAULTS,
    HASH_POLICIES,
    KINDS,
    LACP_RATES,
    clear_cluster_override,
    get_cluster_settings,
    get_settings,
    override_summary,
    set_cluster_override,
    set_settings,
)

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


class ClusterSettingsUpdate(SettingsUpdate):
    """클러스터 재정의 — 보낸 필드만 재정의로 저장하고, ``reset_fields`` 의 필드는 공통을 따르게 되돌린다."""
    reset_fields: Optional[list[str]] = Field(default=None, max_length=40)


def _options() -> dict[str, Any]:
    return {
        "kinds": list(KINDS), "bond_modes": list(BOND_MODES), "hash_policies": list(HASH_POLICIES),
        "lacp_rates": list(LACP_RATES),
        "features": [{"name": k, "label": v} for k, v in FEATURE_LABELS.items()],
    }


def _with_offload_list(cfg: dict[str, Any]) -> dict[str, Any]:
    return {**cfg, "offload_expect": [{"name": k, "on": v} for k, v in sorted(cfg["offload_expect"].items())]}


def _cluster_settings_out(db: Session, cluster_id: UUID) -> dict[str, Any]:
    cs = get_cluster_settings(db, cluster_id)
    return {"effective": _with_offload_list(cs["effective"]), "global": _with_offload_list(cs["global"]),
            "overridden": cs["overridden"], "options": _options()}


def _settings_out(db: Session) -> dict[str, Any]:
    cfg = get_settings(db)
    return {**_with_offload_list(cfg), "options": _options()}


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
    audit_logger.record(db, action="nic_watch.settings.update", actor=user, target_type="app_setting",
                        target_id="nic_watch.settings", details={"fields": sorted(patch)}, request=request)
    return _settings_out(db)


@router.get("/clusters/{cluster_id}")
def cluster_nic(cluster_id: UUID, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    try:
        out = svc.cluster_view(db, cluster)
        out["settings"] = {**out["settings"],
                           "offload_expect": [{"name": k, "on": v} for k, v in sorted(out["settings"]["offload_expect"].items())]}
        return out
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("nic-watch 조회 실패 (%s)", cluster_id)
        raise HTTPException(status_code=500, detail=f"NIC 상태 조회 실패: {exc}") from exc


# ── 클러스터별 판정 기준(공통 기준 위의 재정의) ──────────────────────────────

def _get_cluster(db: Session, cluster_id: UUID) -> Cluster:
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    return cluster


@router.get("/overrides")
def list_overrides(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict[str, Any]]:
    """클러스터별 재정의 현황 — 공통 기준 화면의 '재정의한 클러스터'. 읽기 권한이 없는 클러스터는 이름을 내보내지 않는다."""
    from app.services.cluster_access import has_cluster_access

    summary = override_summary(db)
    out: list[dict[str, Any]] = []
    for cid, fields in sorted(summary.items()):
        try:
            cluster = db.query(Cluster).filter(Cluster.id == UUID(cid)).first()
            if cluster is not None and has_cluster_access(db, user, cluster.id, "read"):
                out.append({"cluster_id": cid, "cluster_name": cluster.name, "fields": fields})
        except Exception:  # noqa: BLE001 — 한 클러스터의 판정 실패가 목록 전체를 막지 않는다
            db.rollback()
    return out


@router.get("/clusters/{cluster_id}/settings")
def read_cluster_settings(cluster_id: UUID, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    _get_cluster(db, cluster_id)
    return _cluster_settings_out(db, cluster_id)


@router.put("/clusters/{cluster_id}/settings")
def update_cluster_settings(
    cluster_id: UUID,
    body: ClusterSettingsUpdate,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict[str, Any]:
    _get_cluster(db, cluster_id)
    patch = body.model_dump(exclude_unset=True, exclude={"reset_fields"})
    reset = [k for k in (body.reset_fields or []) if k in DEFAULTS]
    try:
        set_cluster_override(db, cluster_id, patch, reset)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("nic-watch 클러스터 설정 저장 실패 (%s)", cluster_id)
        raise HTTPException(status_code=500, detail=f"NIC 클러스터 설정 저장 실패: {exc}") from exc
    audit_logger.record(db, action="nic_watch.cluster_settings.update", actor=user, target_type="cluster",
                        target_id=str(cluster_id), details={"fields": sorted(patch), "reset": sorted(reset)}, request=request)
    return _cluster_settings_out(db, cluster_id)


@router.delete("/clusters/{cluster_id}/settings")
def clear_cluster_settings(
    cluster_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
) -> dict[str, Any]:
    """이 클러스터의 재정의를 모두 지워 공통 기준을 따르게 한다."""
    _get_cluster(db, cluster_id)
    try:
        clear_cluster_override(db, cluster_id)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("nic-watch 클러스터 설정 초기화 실패 (%s)", cluster_id)
        raise HTTPException(status_code=500, detail=f"NIC 클러스터 설정 초기화 실패: {exc}") from exc
    audit_logger.record(db, action="nic_watch.cluster_settings.clear", actor=user, target_type="cluster",
                        target_id=str(cluster_id), details={}, request=request)
    return _cluster_settings_out(db, cluster_id)


@router.get("/clusters/{cluster_id}/observed")
def cluster_observed(cluster_id: UUID, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    """에이전트가 보고한 구성에서 뽑은 기준 제안(읽기 전용) — 화면의 '관측 값으로 채우기'."""
    from app.models.node_nic import NodeNicState

    _get_cluster(db, cluster_id)
    try:
        rows = db.query(NodeNicState).filter(NodeNicState.cluster_id == cluster_id).all()
        return learn.observe([{"node": r.node, "interfaces": r.interfaces or []} for r in rows])
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("nic-watch 관측 값 조회 실패 (%s)", cluster_id)
        raise HTTPException(status_code=500, detail=f"NIC 관측 값 조회 실패: {exc}") from exc
