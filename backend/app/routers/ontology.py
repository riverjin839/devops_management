from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.cluster import Cluster
from app.models.ontology import OntologyEntity, OntologyEntityType, OntologyEvent, OntologyRelationship
from app.schemas.ontology import (
    ConfigChangeImpactRequest,
    ConfigChangeImpactResponse,
    ImpactPath,
    OntologyEntityCreate,
    OntologyEntityRead,
    OntologyGraphResponse,
    OntologyRelationshipCreate,
    OntologyRelationshipRead,
)
from app.services.ontology_service import Edge, calculate_blast_radius

router = APIRouter(prefix="/ontology", tags=["ontology"])


def _queue_embedding_recompute(ontology_event_id) -> None:
    """RAG 검색용 임베딩 계산 큐잉 — best-effort (ops_note.py 의 동일 헬퍼 패턴)."""
    try:
        from app.celery_app import compute_ontology_event_embedding
        compute_ontology_event_embedding.delay(str(ontology_event_id))
    except Exception:
        import logging
        logging.getLogger(__name__).warning(
            "Failed to queue embedding recompute for ontology_event %s", ontology_event_id
        )


@router.post("/entities", response_model=OntologyEntityRead)
def create_entity(payload: OntologyEntityCreate, db: Session = Depends(get_db)):
    cluster = db.query(Cluster).filter(Cluster.id == payload.cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")

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
    return row


@router.post("/relationships", response_model=OntologyRelationshipRead)
def create_relationship(payload: OntologyRelationshipCreate, db: Session = Depends(get_db)):
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
def analyze_config_change_impact(payload: ConfigChangeImpactRequest, db: Session = Depends(get_db)):
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

    event = OntologyEvent(
        cluster_id=payload.cluster_id,
        category=payload.category,
        severity=payload.severity,
        title=payload.title,
        description=payload.description,
        evidence=payload.evidence,
        blast_radius_score=blast_radius_score,
        impacted_count=len(impacted_entities),
    )
    db.add(event)
    db.commit()
    db.refresh(event)

    _queue_embedding_recompute(event.id)

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
