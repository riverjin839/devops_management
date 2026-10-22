"""Ontology 엔드포인트 — 클러스터별 구성 요소 그래프 + 변경 영향(what-if) 분석.

권한 (R-4 15차 A-1):
- 그래프 조회 ``GET /graph/{cluster_id}`` — 마운트(`_cluster_scoped`)가 경로 기준 read 를 판정한다.
- 엔티티·관계 생성 — ``require_operator`` + 본문 ``cluster_id`` 에 operate (경로 판정이 닿지 않아 핸들러가 직접).
- 영향 분석 — 인증 사용자 + 본문 ``cluster_id`` 에 read. 가정 분석이므로
  ``category="impact_simulation"``, ``severity="info"`` 로 고정 기록하고 RAG 대상(임베딩)에서 뺀다(A-17).
"""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user, require_operator
from app.database import get_db
from app.models.cluster import Cluster
from app.models.ontology import OntologyEntity, OntologyEntityType, OntologyEvent, OntologyRelationship
from app.models.user import User
from app.schemas.ontology import (
    IMPACT_SIMULATION_CATEGORY,
    ConfigChangeImpactRequest,
    ConfigChangeImpactResponse,
    ImpactPath,
    OntologyEntityCreate,
    OntologyEntityRead,
    OntologyGraphResponse,
    OntologyRelationshipCreate,
    OntologyRelationshipRead,
)
from app.services import audit_logger
from app.services.cluster_access import require_cluster_access
from app.services.ontology_service import Edge, calculate_blast_radius

router = APIRouter(prefix="/ontology", tags=["ontology"])


@router.post("/entities", response_model=OntologyEntityRead)
def create_entity(
    payload: OntologyEntityCreate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    cluster = db.query(Cluster).filter(Cluster.id == payload.cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")
    require_cluster_access(db, actor, payload.cluster_id, "operate")

    try:
        entity_type = OntologyEntityType(payload.entity_type)
    except ValueError as e:
        valid_values = ", ".join([t.value for t in OntologyEntityType])
        raise HTTPException(status_code=422, detail=f"Invalid entity_type. allowed: {valid_values}") from e

    row = OntologyEntity(
        cluster_id=payload.cluster_id,
        entity_type=entity_type,
        name=payload.name,
        external_id=payload.external_id,
        version=payload.version,
        properties=payload.properties,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    audit_logger.record(
        db, action="ontology.entity.create", actor=actor,
        target_type="cluster", target_id=payload.cluster_id,
        details={"entity_id": str(row.id), "entity_type": entity_type.value, "name": row.name},
        request=request,
    )
    return row


@router.post("/relationships", response_model=OntologyRelationshipRead)
def create_relationship(
    payload: OntologyRelationshipCreate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    require_cluster_access(db, actor, payload.cluster_id, "operate")
    source = db.query(OntologyEntity).filter(
        OntologyEntity.id == payload.source_entity_id,
        OntologyEntity.cluster_id == payload.cluster_id,
    ).first()
    target = db.query(OntologyEntity).filter(
        OntologyEntity.id == payload.target_entity_id,
        OntologyEntity.cluster_id == payload.cluster_id,
    ).first()
    if not source or not target:
        raise HTTPException(status_code=404, detail="Source/target ontology entity not found")

    row = OntologyRelationship(**payload.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    audit_logger.record(
        db, action="ontology.relationship.create", actor=actor,
        target_type="cluster", target_id=payload.cluster_id,
        details={"relationship_id": str(row.id), "relation_type": row.relation_type,
                 "source_entity_id": str(row.source_entity_id),
                 "target_entity_id": str(row.target_entity_id)},
        request=request,
    )
    return row


@router.get("/graph/{cluster_id}", response_model=OntologyGraphResponse)
def get_graph(cluster_id: UUID, db: Session = Depends(get_db)):
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")

    entities = db.query(OntologyEntity).filter(OntologyEntity.cluster_id == cluster_id).all()
    relationships = db.query(OntologyRelationship).filter(OntologyRelationship.cluster_id == cluster_id).all()

    return OntologyGraphResponse(
        cluster_id=cluster_id,
        entities=entities,
        relationships=relationships,
    )


@router.post("/impact", response_model=ConfigChangeImpactResponse)
def analyze_config_change_impact(
    payload: ConfigChangeImpactRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_cluster_access(db, user, payload.cluster_id, "read")
    config_entity = db.query(OntologyEntity).filter(
        OntologyEntity.id == payload.config_entity_id,
        OntologyEntity.cluster_id == payload.cluster_id,
    ).first()
    if not config_entity:
        raise HTTPException(status_code=404, detail="Config ontology entity not found")

    relations = db.query(OntologyRelationship).filter(OntologyRelationship.cluster_id == payload.cluster_id).all()
    edges = [
        Edge(
            source=r.source_entity_id,
            target=r.target_entity_id,
            relation_type=r.relation_type,
            weight=r.weight,
        )
        for r in relations
    ]

    blast_map, paths = calculate_blast_radius(
        start_entity_id=payload.config_entity_id,
        edges=edges,
        max_depth=payload.max_depth,
    )

    impacted_ids = [entity_id for entity_id, score in blast_map.items() if entity_id != payload.config_entity_id and score >= 0.1]
    impacted_entities = db.query(OntologyEntity).filter(
        OntologyEntity.cluster_id == payload.cluster_id,
        OntologyEntity.id.in_(impacted_ids),
    ).all() if impacted_ids else []

    blast_radius_score = round(sum(blast_map.values()) / max(len(blast_map), 1), 4)

    # 가정 분석 기록 — 분류는 서버가 고정한다. 실제 변경 이력이 아니므로 RAG 임베딩을 큐잉하지 않는다
    # (rag_service 도 impact_simulation 을 검색에서 제외한다). 클라이언트가 보낸 분류는 근거에만 남긴다.
    evidence = dict(payload.evidence or {})
    if payload.category != IMPACT_SIMULATION_CATEGORY or payload.severity != "info":
        evidence.setdefault("requested", {"category": payload.category, "severity": payload.severity})
    evidence.setdefault("requested_by", getattr(user, "username", None))
    event = OntologyEvent(
        cluster_id=payload.cluster_id,
        category=IMPACT_SIMULATION_CATEGORY,
        severity="info",
        title=payload.title,
        description=payload.description,
        evidence=evidence,
        blast_radius_score=blast_radius_score,
        impacted_count=len(impacted_entities),
    )
    db.add(event)
    db.commit()
    db.refresh(event)

    entity_name_map = {
        e.id: e.name
        for e in db.query(OntologyEntity).filter(OntologyEntity.cluster_id == payload.cluster_id).all()
    }

    impact_paths = [
        ImpactPath(
            path=impact.nodes,
            path_names=[entity_name_map.get(node_id, str(node_id)) for node_id in impact.nodes],
            path_relations=impact.relations,
            score=impact.score,
        )
        for impact in paths[:20]
    ]

    return ConfigChangeImpactResponse(
        event_id=event.id,
        blast_radius_score=blast_radius_score,
        impacted_entities=impacted_entities,
        impact_paths=impact_paths,
    )
