from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from uuid import UUID

from app.auth.deps import get_tenant_scope
from app.database import get_db
from app.services.tenant_scope import TenantScope
from app.models.mindmap import MindMap, MindMapNode
from app.schemas.mindmap import (
    MindMapCreate, MindMapUpdate, MindMapResponse, MindMapListItem,
    MindMapNodeCreate, MindMapNodeUpdate, MindMapNodeResponse,
)

router = APIRouter(prefix="/mindmaps", tags=["mindmaps"])


def _get_map(db: Session, map_id: UUID, scope: TenantScope) -> MindMap:
    """맵 조회 + 테넌트 가시 범위 확인 — 노드 엔드포인트도 부모 맵 기준으로 판정한다."""
    m = db.query(MindMap).filter(MindMap.id == map_id).first()
    if not m or not scope.visible(m.tenant_id):
        raise HTTPException(status_code=404, detail="MindMap not found")
    return m


# ── Maps ─────────────────────────────────────────────────────────────────────

@router.get("/", response_model=list[MindMapListItem])
def list_mindmaps(db: Session = Depends(get_db), scope: TenantScope = Depends(get_tenant_scope)):
    maps = scope.apply(db.query(MindMap), MindMap.tenant_id).order_by(MindMap.updated_at.desc()).all()
    result = []
    for m in maps:
        item = MindMapListItem(
            id=m.id,
            title=m.title,
            description=m.description,
            confluence_url=m.confluence_url,
            tenant_id=m.tenant_id,
            created_at=m.created_at,
            updated_at=m.updated_at,
            node_count=len(m.nodes),
        )
        result.append(item)
    return result


@router.post("/", response_model=MindMapResponse, status_code=status.HTTP_201_CREATED)
def create_mindmap(payload: MindMapCreate, db: Session = Depends(get_db),
                   scope: TenantScope = Depends(get_tenant_scope)):
    scope.ensure_assignable(payload.tenant_id)
    m = MindMap(
        title=payload.title,
        description=payload.description,
        confluence_url=payload.confluence_url,
        tenant_id=payload.tenant_id,
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


@router.get("/{map_id}", response_model=MindMapResponse)
def get_mindmap(map_id: UUID, db: Session = Depends(get_db),
                scope: TenantScope = Depends(get_tenant_scope)):
    return _get_map(db, map_id, scope)


@router.put("/{map_id}", response_model=MindMapResponse)
def update_mindmap(map_id: UUID, payload: MindMapUpdate, db: Session = Depends(get_db),
                   scope: TenantScope = Depends(get_tenant_scope)):
    m = _get_map(db, map_id, scope)
    if "tenant_id" in payload.model_fields_set:
        scope.ensure_assignable(payload.tenant_id)
        m.tenant_id = payload.tenant_id
    if payload.title is not None:
        m.title = payload.title
    if payload.description is not None:
        m.description = payload.description
    if payload.confluence_url is not None:
        m.confluence_url = payload.confluence_url or None
    db.commit()
    db.refresh(m)
    return m


@router.delete("/{map_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_mindmap(map_id: UUID, db: Session = Depends(get_db),
                   scope: TenantScope = Depends(get_tenant_scope)):
    m = _get_map(db, map_id, scope)
    db.delete(m)
    db.commit()


# ── Nodes ─────────────────────────────────────────────────────────────────────

@router.post("/{map_id}/nodes", response_model=MindMapNodeResponse, status_code=status.HTTP_201_CREATED)
def create_node(map_id: UUID, payload: MindMapNodeCreate, db: Session = Depends(get_db),
                scope: TenantScope = Depends(get_tenant_scope)):
    _get_map(db, map_id, scope)
    node = MindMapNode(
        mindmap_id=map_id,
        parent_id=payload.parent_id,
        label=payload.label,
        note=payload.note,
        color=payload.color,
        x=payload.x,
        y=payload.y,
        collapsed=payload.collapsed,
        sort_order=payload.sort_order,
        extra=payload.extra,
    )
    db.add(node)
    db.commit()
    db.refresh(node)
    return node


@router.put("/{map_id}/nodes/{node_id}", response_model=MindMapNodeResponse)
def update_node(map_id: UUID, node_id: UUID, payload: MindMapNodeUpdate, db: Session = Depends(get_db),
                scope: TenantScope = Depends(get_tenant_scope)):
    _get_map(db, map_id, scope)
    node = db.query(MindMapNode).filter(
        MindMapNode.id == node_id, MindMapNode.mindmap_id == map_id
    ).first()
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(node, field, value)
    db.commit()
    db.refresh(node)
    return node


@router.delete("/{map_id}/nodes/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_node(map_id: UUID, node_id: UUID, db: Session = Depends(get_db),
                scope: TenantScope = Depends(get_tenant_scope)):
    _get_map(db, map_id, scope)
    node = db.query(MindMapNode).filter(
        MindMapNode.id == node_id, MindMapNode.mindmap_id == map_id
    ).first()
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    # Also delete all descendant nodes
    all_nodes = db.query(MindMapNode).filter(MindMapNode.mindmap_id == map_id).all()
    to_delete = {str(node_id)}
    changed = True
    while changed:
        changed = False
        for n in all_nodes:
            if str(n.parent_id) in to_delete and str(n.id) not in to_delete:
                to_delete.add(str(n.id))
                changed = True
    for n in all_nodes:
        if str(n.id) in to_delete:
            db.delete(n)
    db.commit()


# Bulk position save (drag-and-drop canvas)
@router.patch("/{map_id}/nodes/positions", response_model=list[MindMapNodeResponse])
def bulk_update_positions(
    map_id: UUID,
    updates: list[dict],
    db: Session = Depends(get_db),
    scope: TenantScope = Depends(get_tenant_scope),
):
    """Update x/y positions for multiple nodes at once."""
    m = _get_map(db, map_id, scope)

    node_map = {str(n.id): n for n in m.nodes}
    for upd in updates:
        node_id = str(upd.get("id", ""))
        if node_id in node_map:
            n = node_map[node_id]
            if "x" in upd:
                n.x = upd["x"]
            if "y" in upd:
                n.y = upd["y"]

    db.commit()
    db.refresh(m)
    return m.nodes
