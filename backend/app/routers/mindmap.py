from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session
from uuid import UUID

from app.auth.deps import get_current_user, get_tenant_scope
from app.database import get_db
from app.services import audit_logger
from app.services.tenant_scope import TenantScope
from app.models.mindmap import MindMap, MindMapNode
from app.models.user import User
from app.schemas.mindmap import (
    MindMapCreate, MindMapUpdate, MindMapResponse, MindMapListItem,
    MindMapNodeCreate, MindMapNodeUpdate, MindMapNodeResponse,
)

router = APIRouter(prefix="/mindmaps", tags=["mindmaps"])


def _get_map(db: Session, map_id: UUID, scope: TenantScope, *, lock: bool = False) -> MindMap:
    """맵 조회 + 테넌트 가시 범위 확인 — 노드 엔드포인트도 부모 맵 기준으로 판정한다.

    ``lock=True`` 면 맵 행을 ``SELECT ... FOR UPDATE`` 로 잠근다 — 같은 맵의 노드 생성·부모 변경을
    직렬화해, 동시 요청이 서로의 변경을 못 본 채 ``_validate_parent`` 를 통과해 순환을 만드는 것을 막는다.
    """
    q = db.query(MindMap).filter(MindMap.id == map_id)
    if lock:
        q = q.with_for_update()
    m = q.first()
    if not m or not scope.visible(m.tenant_id):
        raise HTTPException(status_code=404, detail="MindMap not found")
    return m


def _validate_parent(db: Session, map_id: UUID, parent_id: UUID | None, node_id: UUID | None = None) -> None:
    """``parent_id`` 검증 — 같은 맵의 노드여야 하고, 자기 자신·자손을 부모로 두면(순환) 422.

    순환 부모는 화면의 부모 추적(``getBranchColor`` 등)을 무한 루프로 만든다(A-20).
    부모 사슬은 방문 집합으로 따라가므로 이미 저장된 순환이 있어도 멈춘다.
    """
    if parent_id is None:
        return
    parents = dict(
        db.query(MindMapNode.id, MindMapNode.parent_id).filter(MindMapNode.mindmap_id == map_id).all()
    )
    if parent_id not in parents:
        raise HTTPException(status_code=422, detail="parent_id 는 같은 마인드맵의 노드여야 합니다")
    if node_id is None:
        return
    cur: UUID | None = parent_id
    seen: set[UUID] = set()
    while cur is not None and cur not in seen:
        if cur == node_id:
            raise HTTPException(status_code=422, detail="자기 자신이나 하위 노드를 부모로 지정할 수 없습니다")
        seen.add(cur)
        cur = parents.get(cur)


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
    # 보낸 필드만 반영 — 명시적 null 은 값 지우기(title 은 스키마가 null·공백을 422 로 막는다).
    fields = payload.model_fields_set
    if "title" in fields:
        m.title = payload.title
    if "description" in fields:
        m.description = payload.description
    if "confluence_url" in fields:
        m.confluence_url = (payload.confluence_url or "").strip() or None
    db.commit()
    db.refresh(m)
    return m


@router.delete("/{map_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_mindmap(map_id: UUID, request: Request, db: Session = Depends(get_db),
                   scope: TenantScope = Depends(get_tenant_scope),
                   actor: User = Depends(get_current_user)):
    m = _get_map(db, map_id, scope)
    # 감사 — id·제목만 남긴다(노드 본문·메모는 기록하지 않음).
    details = {"title": m.title, "node_count": len(m.nodes)}
    tenant_id = m.tenant_id
    db.delete(m)
    db.commit()
    audit_logger.record(
        db, action="mindmap.delete", actor=actor, target_type="mindmap", target_id=map_id,
        details=details, request=request, tenant_id=tenant_id,
    )


# ── Nodes ─────────────────────────────────────────────────────────────────────

@router.post("/{map_id}/nodes", response_model=MindMapNodeResponse, status_code=status.HTTP_201_CREATED)
def create_node(map_id: UUID, payload: MindMapNodeCreate, db: Session = Depends(get_db),
                scope: TenantScope = Depends(get_tenant_scope)):
    _get_map(db, map_id, scope, lock=True)  # 커밋까지 맵 잠금 — 부모 검증·저장 직렬화
    _validate_parent(db, map_id, payload.parent_id)
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
    _get_map(db, map_id, scope, lock=True)  # 커밋까지 맵 잠금 — 동시 부모 변경이 순환을 만들지 않게
    node = db.query(MindMapNode).filter(
        MindMapNode.id == node_id, MindMapNode.mindmap_id == map_id
    ).first()
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    if "parent_id" in payload.model_fields_set:
        _validate_parent(db, map_id, payload.parent_id, node_id=node.id)
    # 보낸 필드만 반영 — 명시적 null 은 값 지우기(메모·색·좌표·parent_id). 지울 수 없는 필드의
    # null 은 스키마(NODE_NON_NULLABLE_FIELDS)가 422 로 막는다.
    for field in payload.model_fields_set:
        setattr(node, field, getattr(payload, field))
    db.commit()
    db.refresh(node)
    return node


@router.delete("/{map_id}/nodes/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_node(map_id: UUID, node_id: UUID, request: Request, db: Session = Depends(get_db),
                scope: TenantScope = Depends(get_tenant_scope),
                actor: User = Depends(get_current_user)):
    m = _get_map(db, map_id, scope)
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
    details = {
        "mindmap_id": str(map_id), "mindmap_title": m.title,
        "label": node.label, "deleted_count": len(to_delete),
    }
    tenant_id = m.tenant_id
    db.commit()
    # 감사 — id·제목만 남긴다(메모·색 등 본문은 기록하지 않음).
    audit_logger.record(
        db, action="mindmap.node.delete", actor=actor, target_type="mindmap_node", target_id=node_id,
        details=details, request=request, tenant_id=tenant_id,
    )


# Bulk position save (drag-and-drop canvas)
@router.patch("/{map_id}/nodes/positions", response_model=list[MindMapNodeResponse])
def bulk_update_positions(
    map_id: UUID,
    updates: list[dict],
    db: Session = Depends(get_db),
    scope: TenantScope = Depends(get_tenant_scope),
):
    """Update x/y positions for multiple nodes at once.

    부분 목록을 받는다 — 움직인 노드만 보내면 그 노드만 바뀌고 나머지는 그대로다(정책 ⑦).
    다른 맵의 노드 id·모르는 id 는 무시한다. 응답은 맵의 전체 노드.
    """
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
