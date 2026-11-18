"""서비스 구성 라우터 — K8S 허브 ▸ 구성 ▸ 서비스 구성.

서비스 목록, 서비스별 설정 화면 데이터(설정 항목 × 버전 값 × 노드별 현재 값, 노드 그룹 범위), 현재 값으로 V1 만들기,
초안 의존 평가, 버전 저장·비교·되돌리기, 노드 그룹 CRUD.
경로의 ``cluster_id`` 는 마운트 의존성(``enforce_cluster_access``)이 read(GET)/operate(POST·PUT·DELETE)를 판정한다.
초안 평가는 읽기라 viewer 도 써야 해서 경로가 아니라 본문으로 클러스터를 받고 핸들러가 read 를 판정한다.
노드에는 아무것도 실행하지 않는다(수집은 ``versions`` 라우터, 적용은 다음 단계).
"""
from __future__ import annotations

from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user, require_operator
from app.database import get_db
from app.models.cluster import Cluster
from app.models.user import User
from app.services import audit_logger
from app.services.cluster_access import require_cluster_access
from app.services.service_config import view as V

router = APIRouter(prefix="/service-config", tags=["Service Config"])


def _cluster(db: Session, cluster_id: UUID) -> Cluster:
    c = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if c is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    return c


@router.get("/services")
def list_services(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return {"items": V.service_list(db)}


def _raise(exc: "V.ServiceConfigError"):
    raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


@router.get("/clusters/{cluster_id}/{service}")
def service_view(
    cluster_id: UUID,
    service: str,
    version: Optional[int] = Query(default=None, ge=1, description="보여줄 버전 번호(없으면 최신)"),
    group_id: Optional[UUID] = Query(default=None, description="노드 그룹(없으면 기본 그룹)"),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        return V.build_view(db, _cluster(db, cluster_id), service, version, group_id)
    except V.ServiceConfigError as exc:
        _raise(exc)


@router.post("/clusters/{cluster_id}/{service}/import", status_code=201)
def import_current(
    cluster_id: UUID,
    service: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
) -> dict[str, Any]:
    """현재 노드 값으로 V1 을 만든다(DB 저장만 — 노드에는 아무것도 하지 않는다)."""
    cluster = _cluster(db, cluster_id)
    try:
        out = V.import_v1(db, cluster, service, user.username)
    except V.ServiceConfigError as exc:
        _raise(exc)
    audit_logger.record(db, action="service_config.import", actor=user, target_type="cluster",
                        target_id=str(cluster_id),
                        details={"service": service, "imported": out["imported"], "mixed": len(out["mixed"])},
                        request=request)
    return out


# ── 초안 평가(읽기) ──────────────────────────────────────────────────────────

class ConfigValue(BaseModel):
    """설정 값 1개. 맵이 아니라 목록으로 받는 이유: 프런트 axios 가 요청 본문 키를 snake_case 로 바꾸므로
    ``SystemdCgroup`` 같은 설정 키가 객체 키로 오면 망가진다 — 키를 값 자리에 둔다."""
    key: str = Field(..., min_length=1, max_length=300)
    value: Optional[str] = Field(default=None, max_length=2000)


def _as_map(values: list[ConfigValue]) -> dict[str, Optional[str]]:
    return {v.key: v.value for v in values}


class EvaluateInput(BaseModel):
    cluster_id: UUID
    service: str = Field(..., max_length=32)
    group_id: Optional[UUID] = None
    values: list[ConfigValue] = Field(default_factory=list, max_length=1000)


@router.post("/evaluate")
def evaluate(
    body: EvaluateInput,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """편집 중인 초안 값 → 의존 규칙 결과(권장·필수·영향). 저장하지 않는다."""
    require_cluster_access(db, user, body.cluster_id, "read")
    try:
        return V.evaluate_draft(db, _cluster(db, body.cluster_id), body.service, body.group_id, _as_map(body.values))
    except V.ServiceConfigError as exc:
        _raise(exc)


# ── 버전 ─────────────────────────────────────────────────────────────────────

class SaveVersionInput(BaseModel):
    base_version_no: int = Field(..., ge=0, description="편집을 시작한 버전 번호 — 그사이 다른 저장이 있으면 409")
    group_id: Optional[UUID] = None
    values: list[ConfigValue] = Field(..., max_length=1000)
    note: Optional[str] = Field(default=None, max_length=2000)


@router.post("/clusters/{cluster_id}/{service}/versions", status_code=201)
def save_version(
    cluster_id: UUID,
    service: str,
    body: SaveVersionInput,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
) -> dict[str, Any]:
    """새 설정 버전 저장(노드에는 아무것도 하지 않는다 — 적용은 따로)."""
    try:
        out = V.save_version(db, _cluster(db, cluster_id), service, body.group_id, body.base_version_no,
                             _as_map(body.values), body.note, user.username)
    except V.ServiceConfigError as exc:
        _raise(exc)
    audit_logger.record(db, action="service_config.version.save", actor=user, target_type="cluster",
                        target_id=str(cluster_id),
                        details={"service": service, "group_id": str(body.group_id or ""),
                                 "version_no": out["version"]["version_no"],
                                 "keys": [c["key"] for c in out["changes"]][:50]},
                        request=request)
    return out


@router.get("/clusters/{cluster_id}/{service}/versions/compare")
def compare_versions(
    cluster_id: UUID,
    service: str,
    a: int = Query(..., ge=1),
    b: int = Query(..., ge=1),
    group_id: Optional[UUID] = Query(default=None),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        return V.compare_versions(db, _cluster(db, cluster_id), service, group_id, a, b)
    except V.ServiceConfigError as exc:
        _raise(exc)


@router.post("/clusters/{cluster_id}/{service}/versions/{version_no}/revert", status_code=201)
def revert_version(
    cluster_id: UUID,
    service: str,
    version_no: int,
    request: Request,
    group_id: Optional[UUID] = Query(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
) -> dict[str, Any]:
    """고른 버전의 값으로 새 버전을 저장한다(적용은 따로)."""
    try:
        out = V.revert_to(db, _cluster(db, cluster_id), service, group_id, version_no, user.username)
    except V.ServiceConfigError as exc:
        _raise(exc)
    audit_logger.record(db, action="service_config.version.revert", actor=user, target_type="cluster",
                        target_id=str(cluster_id),
                        details={"service": service, "group_id": str(group_id or ""), "from": version_no,
                                 "version_no": out["version"]["version_no"]},
                        request=request)
    return out


# ── 노드 그룹 ────────────────────────────────────────────────────────────────

class GroupInput(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    node_pattern: str = Field(..., min_length=1, max_length=500)
    description: Optional[str] = Field(default=None, max_length=2000)


def _group_out(g) -> dict[str, Any]:
    return {"id": str(g.id), "name": g.name, "node_pattern": g.node_pattern, "description": g.description,
            "sort_order": g.sort_order}


@router.post("/clusters/{cluster_id}/{service}/groups", status_code=201)
def create_group(
    cluster_id: UUID,
    service: str,
    body: GroupInput,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
) -> dict[str, Any]:
    try:
        g = V.save_group(db, _cluster(db, cluster_id), service, None, body.name, body.node_pattern,
                         body.description, user.username)
    except V.ServiceConfigError as exc:
        _raise(exc)
    audit_logger.record(db, action="service_config.group.create", actor=user, target_type="cluster",
                        target_id=str(cluster_id), details={"service": service, "name": g.name}, request=request)
    return _group_out(g)


@router.put("/clusters/{cluster_id}/{service}/groups/{group_id}")
def update_group(
    cluster_id: UUID,
    service: str,
    group_id: UUID,
    body: GroupInput,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
) -> dict[str, Any]:
    try:
        g = V.save_group(db, _cluster(db, cluster_id), service, group_id, body.name, body.node_pattern,
                         body.description, user.username)
    except V.ServiceConfigError as exc:
        _raise(exc)
    audit_logger.record(db, action="service_config.group.update", actor=user, target_type="cluster",
                        target_id=str(cluster_id), details={"service": service, "name": g.name}, request=request)
    return _group_out(g)


@router.delete("/clusters/{cluster_id}/{service}/groups/{group_id}", status_code=204)
def delete_group(
    cluster_id: UUID,
    service: str,
    group_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    """그룹과 그 그룹의 재정의 버전을 지운다 — 그룹 노드는 기본 그룹 값으로 돌아간다(노드 적용은 따로)."""
    try:
        name = V.delete_group(db, _cluster(db, cluster_id), service, group_id)
    except V.ServiceConfigError as exc:
        _raise(exc)
    audit_logger.record(db, action="service_config.group.delete", actor=user, target_type="cluster",
                        target_id=str(cluster_id), details={"service": service, "name": name}, request=request)
