"""Architecture Docs endpoints — 서비스 모듈별 아키텍처/플로우 다이어그램 문서.

- `GET    /architecture-docs`                          모듈별 문서 요약 목록
- `GET    /architecture-docs/schedule`                 전역 자동 sync cron 조회
- `PUT    /architecture-docs/schedule`                 전역 자동 sync cron 설정
- `GET    /architecture-docs/{service_id}`             문서 조회 (없으면 빈 shell 생성)
- `POST   /architecture-docs/{service_id}/sync`        즉시 현행화 (?prune= 로 stale 정리)
- `POST   /architecture-docs/{service_id}/llm-regenerate`  LLM 요약/플로우 재생성
- `PATCH  /architecture-docs/{service_id}`             summary/annotations/auto_sync 수정
- `PATCH  /architecture-docs/{service_id}/layout`      뷰별 노드 배치 bulk 저장
- `POST/PATCH/DELETE .../manual-nodes[/{pk}]`          수동 노드 CRUD
- `POST/PATCH/DELETE .../manual-edges[/{pk}]`          수동 엣지 CRUD
- `GET    /architecture-docs/{service_id}/audit`       현행화/편집 감사 이력

sync 는 fail-soft — 실패해도 200 + last_sync_status="failed" (빈 500 금지).
"""
from __future__ import annotations

import asyncio
import logging
import uuid as uuid_mod
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user
from app.database import get_db
from app.models import LakeService, TopologyAuditLog
from app.models.service_arch_doc import (
    ServiceArchDoc,
    ServiceArchManualEdge,
    ServiceArchManualNode,
)
from app.models.user import User
from app.schemas.architecture_doc import (
    ArchDocResponse,
    ArchDocSummary,
    AuditEntryOut,
    DocPatch,
    LayoutPatch,
    ManualEdgeCreate,
    ManualEdgeOut,
    ManualEdgeUpdate,
    ManualNodeCreate,
    ManualNodeOut,
    ManualNodeUpdate,
    SchedulePayload,
    ScheduleOut,
)
from app.services import architecture_doc_service as svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/architecture-docs", tags=["architecture-docs"])


# ── helpers ──────────────────────────────────────────────────────────────────
def _require_service(service_id: UUID, db: Session) -> LakeService:
    s = db.query(LakeService).filter(LakeService.id == service_id).first()
    if s is None:
        raise HTTPException(status_code=404, detail="Service module not found")
    return s


def _doc_response(doc: ServiceArchDoc) -> ArchDocResponse:
    return ArchDocResponse(
        id=doc.id,
        service_id=doc.lake_service_id,
        cluster_id=doc.cluster_id,
        namespace=doc.namespace,
        auto_graph=doc.auto_graph,
        traffic_edges=doc.traffic_edges or [],
        llm_content=doc.llm_content,
        layout=doc.layout or {},
        annotations={k: v for k, v in (doc.annotations or {}).items() if v is not None},
        summary_override=doc.summary_override,
        source_hash=doc.source_hash,
        drift=doc.drift,
        last_synced_at=doc.last_synced_at,
        last_sync_status=doc.last_sync_status,
        sync_error=doc.sync_error,
        auto_sync_enabled=doc.auto_sync_enabled,
        llm_status=doc.llm_status,
        manual_nodes=[ManualNodeOut.model_validate(n) for n in doc.manual_nodes],
        manual_edges=[
            ManualEdgeOut.model_validate(e)
            for e in sorted(doc.manual_edges, key=lambda e: (e.sort_order, e.created_at))
        ],
        updated_at=doc.updated_at,
    )


def _audit_edit(
    db: Session, doc: ServiceArchDoc, *, entity: str, action: str,
    username: Optional[str], before: Optional[dict] = None, after: Optional[dict] = None,
) -> None:
    try:
        db.add(TopologyAuditLog(
            cluster_id=doc.cluster_id,
            entity_type="arch_doc",
            entity_id=str(doc.lake_service_id),
            action=action,
            scope="edit",
            status="success",
            reason=entity,
            before_data=before,
            after_data={**(after or {}), "username": username},
        ))
    except Exception as e:  # noqa: BLE001
        logger.warning("arch_doc edit audit 실패: %s", e)


# ── list / schedule (정적 경로 — /{service_id} 보다 먼저 선언) ────────────────
@router.get("", response_model=list[ArchDocSummary])
def list_docs(cluster_id: Optional[UUID] = None, db: Session = Depends(get_db)):
    return svc.list_doc_summaries(db, cluster_id)


@router.get("/schedule", response_model=ScheduleOut)
def get_schedule(db: Session = Depends(get_db)):
    return svc.get_schedule(db)


@router.put("/schedule", response_model=ScheduleOut)
def set_schedule(payload: SchedulePayload, db: Session = Depends(get_db)):
    try:
        from croniter import croniter
        if not croniter.is_valid(payload.cron):
            raise HTTPException(status_code=422, detail="cron 표현식이 올바르지 않습니다.")
    except ImportError:  # pragma: no cover
        pass
    val = svc.set_schedule(db, payload.enabled, payload.cron)
    return ScheduleOut(**val)


# ── doc read / sync / llm ────────────────────────────────────────────────────
@router.get("/{service_id}", response_model=ArchDocResponse)
def get_doc(service_id: UUID, db: Session = Depends(get_db)):
    service = _require_service(service_id, db)
    doc = svc.get_or_create_doc(db, service)
    return _doc_response(doc)


@router.post("/{service_id}/sync", response_model=ArchDocResponse)
async def sync_doc(
    service_id: UUID,
    prune: bool = Query(False),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    service = _require_service(service_id, db)
    doc = await asyncio.to_thread(
        svc.sync_doc, db, service,
        triggered_by="manual", username=user.username, prune=prune,
    )
    # 최초 sync 성공 시 LLM enrichment 를 백그라운드로 1회 시도 (응답 비블로킹)
    if doc.last_sync_status in ("ok", "partial") and doc.llm_status == "none":
        try:
            from app.celery_app import generate_arch_doc_llm
            generate_arch_doc_llm.delay(str(doc.id))
        except Exception as e:  # noqa: BLE001
            logger.warning("LLM enrichment 큐잉 실패(무시): %s", e)
    return _doc_response(doc)


@router.post("/{service_id}/llm-regenerate", response_model=ArchDocResponse)
async def llm_regenerate(service_id: UUID, db: Session = Depends(get_db)):
    service = _require_service(service_id, db)
    doc = svc.get_or_create_doc(db, service)
    doc = await svc.generate_llm_content(db, doc, service)
    return _doc_response(doc)


# ── doc patch / layout ───────────────────────────────────────────────────────
@router.patch("/{service_id}", response_model=ArchDocResponse)
def patch_doc(
    service_id: UUID,
    payload: DocPatch,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    service = _require_service(service_id, db)
    doc = svc.get_or_create_doc(db, service)
    data = payload.model_dump(exclude_unset=True)
    if "summary_override" in data:
        doc.summary_override = data["summary_override"]
    if "auto_sync_enabled" in data and data["auto_sync_enabled"] is not None:
        doc.auto_sync_enabled = data["auto_sync_enabled"]
    if data.get("annotations") is not None:
        merged = dict(doc.annotations or {})
        for entry in data["annotations"]:
            if entry["text"] is None:
                merged.pop(entry["id"], None)
            else:
                merged[entry["id"]] = entry["text"]
        doc.annotations = merged
    _audit_edit(db, doc, entity="doc", action="update", username=user.username,
                after={"fields": sorted(data.keys())})
    try:
        db.commit(); db.refresh(doc)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=500, detail=f"문서 저장 실패: {str(e)[:200]}") from e
    return _doc_response(doc)


@router.patch("/{service_id}/layout", response_model=ArchDocResponse)
def patch_layout(service_id: UUID, payload: LayoutPatch, db: Session = Depends(get_db)):
    service = _require_service(service_id, db)
    doc = svc.get_or_create_doc(db, service)
    layout = dict(doc.layout or {})
    view_map = dict(layout.get(payload.view) or {})
    for p in payload.positions:
        view_map[p.id] = {"x": round(p.x, 2), "y": round(p.y, 2)}
    layout[payload.view] = view_map
    doc.layout = layout
    try:
        db.commit(); db.refresh(doc)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=500, detail=f"배치 저장 실패: {str(e)[:200]}") from e
    return _doc_response(doc)


# ── manual nodes CRUD ────────────────────────────────────────────────────────
@router.post("/{service_id}/manual-nodes", response_model=ManualNodeOut, status_code=201)
def create_manual_node(
    service_id: UUID,
    payload: ManualNodeCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    service = _require_service(service_id, db)
    doc = svc.get_or_create_doc(db, service)
    node = ServiceArchManualNode(
        doc_id=doc.id,
        node_id=f"manual:{uuid_mod.uuid4().hex}",
        label=payload.label,
        kind=payload.kind,
        description=payload.description,
        style=payload.style,
        created_by=user.username,
    )
    db.add(node)
    _audit_edit(db, doc, entity="manual_node", action="create", username=user.username,
                after={"label": payload.label, "kind": payload.kind})
    try:
        db.commit(); db.refresh(node)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=500, detail=f"수동 노드 저장 실패: {str(e)[:200]}") from e
    return node


@router.patch("/{service_id}/manual-nodes/{node_pk}", response_model=ManualNodeOut)
def update_manual_node(
    service_id: UUID,
    node_pk: UUID,
    payload: ManualNodeUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    service = _require_service(service_id, db)
    doc = svc.get_or_create_doc(db, service)
    node = (
        db.query(ServiceArchManualNode)
        .filter(ServiceArchManualNode.id == node_pk, ServiceArchManualNode.doc_id == doc.id)
        .first()
    )
    if not node:
        raise HTTPException(status_code=404, detail="Manual node not found")
    before = {"label": node.label, "kind": node.kind}
    for field, val in payload.model_dump(exclude_unset=True).items():
        setattr(node, field, val)
    _audit_edit(db, doc, entity="manual_node", action="update", username=user.username,
                before=before, after={"label": node.label, "kind": node.kind})
    try:
        db.commit(); db.refresh(node)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=500, detail=f"수동 노드 수정 실패: {str(e)[:200]}") from e
    return node


@router.delete("/{service_id}/manual-nodes/{node_pk}", status_code=204)
def delete_manual_node(
    service_id: UUID,
    node_pk: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    service = _require_service(service_id, db)
    doc = svc.get_or_create_doc(db, service)
    node = (
        db.query(ServiceArchManualNode)
        .filter(ServiceArchManualNode.id == node_pk, ServiceArchManualNode.doc_id == doc.id)
        .first()
    )
    if not node:
        raise HTTPException(status_code=404, detail="Manual node not found")
    # 이 노드에 걸린 수동 엣지도 함께 제거 (string-anchor 라 FK cascade 가 없음)
    db.query(ServiceArchManualEdge).filter(
        ServiceArchManualEdge.doc_id == doc.id,
        (ServiceArchManualEdge.source_id == node.node_id)
        | (ServiceArchManualEdge.target_id == node.node_id),
    ).delete(synchronize_session=False)
    _audit_edit(db, doc, entity="manual_node", action="delete", username=user.username,
                before={"label": node.label, "node_id": node.node_id})
    db.delete(node)
    db.commit()
    return None


# ── manual edges CRUD ────────────────────────────────────────────────────────
@router.post("/{service_id}/manual-edges", response_model=ManualEdgeOut, status_code=201)
def create_manual_edge(
    service_id: UUID,
    payload: ManualEdgeCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    service = _require_service(service_id, db)
    doc = svc.get_or_create_doc(db, service)
    if payload.source_id == payload.target_id:
        raise HTTPException(status_code=422, detail="source 와 target 이 같을 수 없습니다.")
    edge = ServiceArchManualEdge(
        doc_id=doc.id,
        source_id=payload.source_id,
        target_id=payload.target_id,
        edge_type=payload.edge_type,
        label=payload.label,
        description=payload.description,
        view=payload.view,
        sort_order=payload.sort_order,
        created_by=user.username,
    )
    db.add(edge)
    _audit_edit(db, doc, entity="manual_edge", action="create", username=user.username,
                after={"source": payload.source_id, "target": payload.target_id,
                       "type": payload.edge_type})
    try:
        db.commit(); db.refresh(edge)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=500, detail=f"수동 엣지 저장 실패: {str(e)[:200]}") from e
    return edge


@router.patch("/{service_id}/manual-edges/{edge_pk}", response_model=ManualEdgeOut)
def update_manual_edge(
    service_id: UUID,
    edge_pk: UUID,
    payload: ManualEdgeUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    service = _require_service(service_id, db)
    doc = svc.get_or_create_doc(db, service)
    edge = (
        db.query(ServiceArchManualEdge)
        .filter(ServiceArchManualEdge.id == edge_pk, ServiceArchManualEdge.doc_id == doc.id)
        .first()
    )
    if not edge:
        raise HTTPException(status_code=404, detail="Manual edge not found")
    before = {"type": edge.edge_type, "label": edge.label, "view": edge.view}
    for field, val in payload.model_dump(exclude_unset=True).items():
        setattr(edge, field, val)
    _audit_edit(db, doc, entity="manual_edge", action="update", username=user.username,
                before=before,
                after={"type": edge.edge_type, "label": edge.label, "view": edge.view})
    try:
        db.commit(); db.refresh(edge)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=500, detail=f"수동 엣지 수정 실패: {str(e)[:200]}") from e
    return edge


@router.delete("/{service_id}/manual-edges/{edge_pk}", status_code=204)
def delete_manual_edge(
    service_id: UUID,
    edge_pk: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    service = _require_service(service_id, db)
    doc = svc.get_or_create_doc(db, service)
    edge = (
        db.query(ServiceArchManualEdge)
        .filter(ServiceArchManualEdge.id == edge_pk, ServiceArchManualEdge.doc_id == doc.id)
        .first()
    )
    if not edge:
        raise HTTPException(status_code=404, detail="Manual edge not found")
    _audit_edit(db, doc, entity="manual_edge", action="delete", username=user.username,
                before={"source": edge.source_id, "target": edge.target_id})
    db.delete(edge)
    db.commit()
    return None


# ── audit ────────────────────────────────────────────────────────────────────
@router.get("/{service_id}/audit", response_model=list[AuditEntryOut])
def list_audit(
    service_id: UUID,
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    _require_service(service_id, db)
    rows = (
        db.query(TopologyAuditLog)
        .filter(TopologyAuditLog.entity_type == "arch_doc",
                TopologyAuditLog.entity_id == str(service_id))
        .order_by(TopologyAuditLog.created_at.desc())
        .limit(limit)
        .all()
    )
    return rows
