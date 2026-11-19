"""노드 OS(커널) 파라미터 감시 라우터.

- ``ingest_router`` : **JWT 없음**. 노드 에이전트(DaemonSet)가 Bearer ``NODE_PARAM_INGEST_TOKEN`` 으로 보고한다.
  토큰 미설정 시 **503 fail-closed**(알람·kubewatch·superpod 수신과 같은 정책).
- ``router``        : JWT. 감시 규칙 CRUD, 노드별 현재 상태·변경 이력, 에이전트 설치 매니페스트, 설정.
  경로의 ``cluster_id`` 는 마운트 의존성(``enforce_cluster_access``)이 read/operate 를 판정하고,
  본문으로 클러스터를 받는 규칙 쓰기는 핸들러가 직접 판정한다.

판정·알람 로직은 ``services/node_param_watch/`` 에 있다.
"""
from __future__ import annotations

import logging
import secrets
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.auth.deps import get_cluster_scope, get_current_user, require_admin, require_operator
from app.config import settings
from app.database import get_db
from app.models import OsParamChange
from app.models.cluster import Cluster
from app.models.node_param_watch import NodeParamAgent, NodeParamWatchRule
from app.models.user import User
from app.services import audit_logger
from app.services.cluster_access import ClusterScope, require_cluster_access
from app.services.node_param_watch import rules as R
from app.services.node_param_watch import service as svc
from app.services.node_param_watch.manifest import render_manifest
from app.services.node_param_watch.settings import get_settings, set_settings

logger = logging.getLogger(__name__)

ingest_router = APIRouter(prefix="/node-params", tags=["Node Params Ingest"])
router = APIRouter(prefix="/node-params", tags=["Node Params"])


# ── 수신 (에이전트) ──────────────────────────────────────────────────────────

def _verify_token(authorization: str = Header(default="")) -> None:
    expected = (settings.node_param_ingest_token or "").strip()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail=(
                "노드 파라미터 수신 비활성화: NODE_PARAM_INGEST_TOKEN 이 설정되지 않았습니다. "
                "backend 환경변수에 토큰을 설정한 뒤 에이전트 Secret 에 같은 값을 넣으세요."
            ),
        )
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(None, 1)[1].strip()
    if not secrets.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="수신 토큰이 올바르지 않습니다.")


class AgentReport(BaseModel):
    cluster: str = Field(..., min_length=1, max_length=253, description="클러스터 UUID 또는 이름")
    node: str = Field(..., min_length=1, max_length=253)
    host_ip: Optional[str] = Field(default=None, max_length=64)
    agent_version: Optional[str] = Field(default=None, max_length=32)
    collected_at: Optional[str] = None
    runtime: dict[str, Optional[str]] = Field(default_factory=dict)
    persistent: dict[str, dict[str, Any]] = Field(default_factory=dict)
    errors: list[str] = Field(default_factory=list, max_length=200)


@ingest_router.post("/agent/report")
def agent_report(
    body: AgentReport,
    db: Session = Depends(get_db),
    _: None = Depends(_verify_token),
) -> dict[str, Any]:
    """에이전트 보고 1건 — 응답으로 다음 보고 주기와 감시 파라미터 목록을 돌려준다."""
    cluster = svc.resolve_cluster(db, body.cluster)
    if cluster is None:
        raise HTTPException(status_code=404, detail=f"클러스터 '{body.cluster}' 를 찾을 수 없습니다.")
    try:
        return svc.handle_report(db, cluster, body.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("node-param report 처리 실패 (%s/%s)", body.cluster, body.node)
        raise HTTPException(status_code=500, detail=f"보고 처리 실패: {exc}") from exc


# ── 설정 ─────────────────────────────────────────────────────────────────────

class SettingsUpdate(BaseModel):
    interval_sec: Optional[int] = Field(default=None, ge=15, le=3600)
    offline_minutes: Optional[int] = Field(default=None, ge=0, le=1440)
    agent_image: Optional[str] = Field(default=None, max_length=500)
    agent_namespace: Optional[str] = Field(default=None, max_length=63)
    ingest_base_url: Optional[str] = Field(default=None, max_length=500)
    tls_verify: Optional[bool] = None


def _settings_out(db: Session) -> dict[str, Any]:
    return {**get_settings(db), "token_configured": bool((settings.node_param_ingest_token or "").strip())}


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
    set_settings(db, patch)
    audit_logger.record(db, action="node_params.settings.update", actor=user, target_type="app_setting",
                        target_id="node_param_watch.settings", details={"fields": sorted(patch)}, request=request)
    return _settings_out(db)


# ── 규칙 ─────────────────────────────────────────────────────────────────────

class RuleInput(BaseModel):
    cluster_id: Optional[UUID] = None
    param: str = Field(..., min_length=1, max_length=R.PARAM_NAME_MAX)
    operator: str = "any"
    expected: Optional[str] = Field(default=None, max_length=500)
    node_pattern: Optional[str] = Field(default=None, max_length=500)
    severity: str = "warning"
    alert_on_change: bool = True
    check_persistent: bool = True
    description: Optional[str] = Field(default=None, max_length=2000)
    enabled: bool = True

    @field_validator("param")
    @classmethod
    def _param(cls, v: str) -> str:
        v = v.strip().replace("/", ".")
        if not R.valid_param_name(v):
            raise ValueError("파라미터 이름은 sysctl 표기(예: net.core.somaxconn)여야 합니다.")
        return v

    @field_validator("operator")
    @classmethod
    def _op(cls, v: str) -> str:
        if v not in R.OPERATORS:
            raise ValueError(f"operator 는 {', '.join(R.OPERATORS)} 중 하나여야 합니다.")
        return v

    @field_validator("severity")
    @classmethod
    def _sev(cls, v: str) -> str:
        if v not in R.SEVERITIES:
            raise ValueError(f"severity 는 {', '.join(R.SEVERITIES)} 중 하나여야 합니다.")
        return v


def _check_expected_input(body: RuleInput) -> None:
    if body.operator == "any":
        return
    exp = (body.expected or "").strip()
    if not exp:
        raise HTTPException(status_code=422, detail="기준값을 입력하세요 (판정 방식이 '변경만 추적' 이 아니면 필수).")
    if body.operator in ("gte", "lte") and R._as_number(R.normalize_value(exp)) is None:  # noqa: SLF001
        raise HTTPException(status_code=422, detail="'이상'/'이하' 의 기준값은 숫자여야 합니다.")


def _rule_out(r: NodeParamWatchRule, names: dict[UUID, str]) -> dict[str, Any]:
    return {
        "id": str(r.id),
        "cluster_id": str(r.cluster_id) if r.cluster_id else None,
        "cluster_name": names.get(r.cluster_id) if r.cluster_id else None,
        "param": r.param,
        "operator": r.operator,
        "expected": r.expected,
        "node_pattern": r.node_pattern,
        "severity": r.severity,
        "alert_on_change": r.alert_on_change,
        "check_persistent": r.check_persistent,
        "description": r.description,
        "enabled": r.enabled,
        "created_by": r.created_by,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }


def _authorize_rule_write(db: Session, user: User, cluster_id: Optional[UUID]) -> None:
    """공통 규칙(모든 클러스터)은 admin, 클러스터 규칙은 그 클러스터 operate 권한."""
    if cluster_id is None:
        if user.role != "admin":
            raise HTTPException(status_code=403, detail="모든 클러스터에 적용되는 공통 규칙은 관리자만 바꿀 수 있습니다.")
        return
    require_cluster_access(db, user, cluster_id, "operate")
    if not db.query(Cluster.id).filter(Cluster.id == cluster_id).first():
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")


@router.get("/rules")
def list_rules(
    cluster_id: Optional[UUID] = Query(default=None, description="지정하면 공통 규칙 + 이 클러스터 규칙만"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    scope: ClusterScope = Depends(get_cluster_scope),
) -> dict[str, Any]:
    q = db.query(NodeParamWatchRule)
    if cluster_id is not None:
        require_cluster_access(db, user, cluster_id, "read")
        q = q.filter((NodeParamWatchRule.cluster_id.is_(None)) | (NodeParamWatchRule.cluster_id == cluster_id))
    rows = [r for r in q.order_by(NodeParamWatchRule.param.asc(), NodeParamWatchRule.created_at.asc()).all()
            if r.cluster_id is None or scope.visible(r.cluster_id)]
    names = {c.id: c.name for c in db.query(Cluster.id, Cluster.name).all()}
    return {
        "items": [_rule_out(r, names) for r in rows],
        "operators": [{"value": k, "label": v} for k, v in R.OPERATOR_LABELS.items()],
    }


@router.post("/rules", status_code=201)
def create_rule(
    body: RuleInput,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
) -> dict[str, Any]:
    _authorize_rule_write(db, user, body.cluster_id)
    _check_expected_input(body)
    row = NodeParamWatchRule(**body.model_dump(), created_by=user.username)
    db.add(row)
    db.commit()
    db.refresh(row)
    audit_logger.record(db, action="node_params.rule.create", actor=user, target_type="node_param_rule",
                        target_id=str(row.id), details={"param": row.param, "cluster_id": str(row.cluster_id or "")},
                        request=request)
    names = {c.id: c.name for c in db.query(Cluster.id, Cluster.name).all()}
    return _rule_out(row, names)


@router.put("/rules/{rule_id}")
def update_rule(
    rule_id: UUID,
    body: RuleInput,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
) -> dict[str, Any]:
    row = db.query(NodeParamWatchRule).filter(NodeParamWatchRule.id == rule_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="규칙을 찾을 수 없습니다.")
    _authorize_rule_write(db, user, row.cluster_id)
    if body.cluster_id != row.cluster_id:
        _authorize_rule_write(db, user, body.cluster_id)
    _check_expected_input(body)
    data = body.model_dump()
    changed = sorted(k for k, v in data.items() if getattr(row, k) != v)
    for k, v in data.items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    audit_logger.record(db, action="node_params.rule.update", actor=user, target_type="node_param_rule",
                        target_id=str(row.id), details={"param": row.param, "fields": changed}, request=request)
    names = {c.id: c.name for c in db.query(Cluster.id, Cluster.name).all()}
    return _rule_out(row, names)


@router.delete("/rules/{rule_id}", status_code=204)
def delete_rule(
    rule_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    row = db.query(NodeParamWatchRule).filter(NodeParamWatchRule.id == rule_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="규칙을 찾을 수 없습니다.")
    _authorize_rule_write(db, user, row.cluster_id)
    param = row.param
    db.delete(row)
    db.commit()
    audit_logger.record(db, action="node_params.rule.delete", actor=user, target_type="node_param_rule",
                        target_id=str(rule_id), details={"param": param}, request=request)


# ── 클러스터별 조회 ──────────────────────────────────────────────────────────

def _cluster(db: Session, cluster_id: UUID) -> Cluster:
    c = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if c is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    return c


@router.get("/clusters/{cluster_id}/nodes")
def cluster_nodes(cluster_id: UUID, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> dict[str, Any]:
    return svc.node_states(db, _cluster(db, cluster_id))


@router.get("/clusters/{cluster_id}/changes")
def cluster_changes(
    cluster_id: UUID,
    node: Optional[str] = Query(default=None, max_length=253),
    param: Optional[str] = Query(default=None, max_length=300),
    limit: int = Query(default=200, ge=1, le=1000),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
    """OS 파라미터 변경 이력 — 에이전트 감지분과 SSH 수집 비교(``kernel_param_drift``)분을 함께 보여준다."""
    _cluster(db, cluster_id)
    q = db.query(OsParamChange).filter(OsParamChange.cluster_id == cluster_id)
    if node:
        q = q.filter(OsParamChange.node == node)
    if param:
        q = q.filter(OsParamChange.param == param)
    rows = q.order_by(OsParamChange.detected_at.desc()).limit(limit).all()
    return {"items": [{
        "id": str(r.id),
        "node": r.node,
        "param": r.param,
        "old_value": r.old_value,
        "new_value": r.new_value,
        "change_type": r.change_type,
        "source": (r.extra or {}).get("source") or "ssh",
        "last_unchanged_at": (r.extra or {}).get("last_unchanged_at"),
        "detected_at": r.detected_at.isoformat() if r.detected_at else None,
    } for r in rows]}


@router.delete("/clusters/{cluster_id}/agents/{agent_id}", status_code=204)
def delete_agent(
    cluster_id: UUID,
    agent_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    """없앤 노드의 에이전트를 목록에서 지운다(열린 알람은 닫고 이력은 남긴다). 노드가 살아 있으면 다음 보고 때 다시 생긴다."""
    cluster = _cluster(db, cluster_id)
    agent = (db.query(NodeParamAgent)
             .filter(NodeParamAgent.id == agent_id, NodeParamAgent.cluster_id == cluster_id).first())
    if agent is None:
        raise HTTPException(status_code=404, detail="에이전트를 찾을 수 없습니다.")
    node = agent.node
    svc.remove_agent(db, cluster, agent)
    audit_logger.record(db, action="node_params.agent.delete", actor=user, target_type="cluster",
                        target_id=str(cluster_id), details={"node": node}, request=request)


@router.get("/clusters/{cluster_id}/manifest")
def agent_manifest(
    cluster_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
) -> dict[str, Any]:
    """이 클러스터용 에이전트 설치 매니페스트(토큰은 자리표시자)."""
    cluster = _cluster(db, cluster_id)
    cfg = get_settings(db)
    base = cfg["ingest_base_url"] or str(request.base_url).rstrip("/") + "/api/v1"
    yaml_text = render_manifest(
        cluster_id=str(cluster.id), cluster_name=cluster.name, api_base_url=base,
        image=cfg["agent_image"], namespace=cfg["agent_namespace"], tls_verify=cfg["tls_verify"],
    )
    return {
        "yaml": yaml_text,
        "api_base_url": base,
        "api_base_url_from_settings": bool(cfg["ingest_base_url"]),
        "token_configured": bool((settings.node_param_ingest_token or "").strip()),
    }
