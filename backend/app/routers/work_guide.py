from uuid import UUID
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth.deps import get_tenant_scope
from app.database import get_db
from app.services.tenant_scope import TenantScope
from app.models.work_guide import WorkGuide
from app.schemas.work_guide import (
    WorkGuideCreate,
    WorkGuideUpdate,
    WorkGuideResponse,
    WorkGuideListResponse,
)
from app.schemas.confluence_docs import GuideSearchResult
from app.services import knowledge_search

router = APIRouter(prefix="/work-guides", tags=["work-guides"])


def _queue_embedding_recompute(work_guide_id) -> None:
    """임베딩 재계산 큐잉 — best-effort (work_items.py 의 동일 헬퍼와 동일한 패턴)."""
    try:
        from app.celery_app import compute_work_guide_embedding
        compute_work_guide_embedding.delay(str(work_guide_id))
    except Exception:
        import logging
        logging.getLogger(__name__).warning(
            "Failed to queue embedding recompute for work_guide %s", work_guide_id
        )


@router.get("", response_model=WorkGuideListResponse)
def list_guides(
    category: Optional[str] = None,
    guide_status: Optional[str] = None,
    priority: Optional[str] = None,
    db: Session = Depends(get_db),
    scope: TenantScope = Depends(get_tenant_scope),
):
    q = scope.apply(db.query(WorkGuide), WorkGuide.tenant_id)
    if category:
        q = q.filter(WorkGuide.category == category)
    if guide_status:
        q = q.filter(WorkGuide.status == guide_status)
    if priority:
        q = q.filter(WorkGuide.priority == priority)
    return WorkGuideListResponse(data=q.order_by(WorkGuide.created_at.desc()).all())


# 주의: `/{guide_id}` 보다 위에 선언해야 "search" 가 UUID 로 파싱되지 않는다.
@router.get("/search", response_model=GuideSearchResult)
async def search_guides_endpoint(
    q: str,
    limit: int = 10,
    db: Session = Depends(get_db),
    scope: TenantScope = Depends(get_tenant_scope),
):
    """문서 검색 — 임베딩 시맨틱(cosine) 우선, 불가 시 ILIKE 폴백.

    `embedding_available=false` 는 실패가 아니라 "시맨틱 아직 준비 안 됨"
    (Ollama 미기동 / pgvector 부재 / 임베딩 미계산)."""
    # 가려진 테넌트 문서를 걸러낸 뒤에도 limit 개를 채우도록 여유 있게 받아 자른다.
    result = await knowledge_search.search_guides(db, q, limit if scope.is_admin else limit * 3)
    if not scope.is_admin and result.get("items"):
        ids = [it["id"] for it in result["items"]]
        visible = {
            gid for (gid,) in scope.apply(
                db.query(WorkGuide.id).filter(WorkGuide.id.in_(ids)), WorkGuide.tenant_id,
            ).all()
        }
        result["items"] = [it for it in result["items"] if it["id"] in visible][:limit]
    return GuideSearchResult(**result)


@router.get("/{guide_id}", response_model=WorkGuideResponse)
def get_guide(guide_id: UUID, db: Session = Depends(get_db),
              scope: TenantScope = Depends(get_tenant_scope)):
    guide = db.query(WorkGuide).filter(WorkGuide.id == guide_id).first()
    if not guide or not scope.visible(guide.tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Guide not found")
    return guide


@router.post("", response_model=WorkGuideResponse, status_code=status.HTTP_201_CREATED)
def create_guide(payload: WorkGuideCreate, db: Session = Depends(get_db),
                 scope: TenantScope = Depends(get_tenant_scope)):
    scope.ensure_assignable(payload.tenant_id)
    guide = WorkGuide(**payload.model_dump())
    db.add(guide)
    db.commit()
    db.refresh(guide)
    _queue_embedding_recompute(guide.id)  # 비동기 — 쓰기 응답 속도에 영향 없음
    return guide


@router.put("/{guide_id}", response_model=WorkGuideResponse)
def update_guide(guide_id: UUID, payload: WorkGuideUpdate, db: Session = Depends(get_db),
                 scope: TenantScope = Depends(get_tenant_scope)):
    guide = db.query(WorkGuide).filter(WorkGuide.id == guide_id).first()
    if not guide or not scope.visible(guide.tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Guide not found")
    if "tenant_id" in payload.model_fields_set:
        scope.ensure_assignable(payload.tenant_id)
    update_data = payload.model_dump(exclude_unset=True)
    new_parent = update_data.get("parent_id")
    if new_parent is not None:
        # 자기 자신·자기 자손을 상위로 두면 순환이 생겨 트리에서 사라지고 삭제(D-158)도 영영 막힌다.
        cur, seen = new_parent, set()
        while cur is not None and cur not in seen:
            if cur == guide.id:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="자기 자신이나 하위 페이지를 상위 페이지로 지정할 수 없습니다.",
                )
            seen.add(cur)
            cur = db.query(WorkGuide.parent_id).filter(WorkGuide.id == cur).scalar()
    for k, v in update_data.items():
        setattr(guide, k, v)
    # Confluence 연결 문서의 제목/본문이 바뀌면 "재게시 필요" 상태로 전이
    if guide.confluence_page_id and ("title" in update_data or "content" in update_data):
        guide.confluence_sync_status = "modified"
    db.commit()
    db.refresh(guide)
    if "title" in update_data or "content" in update_data:
        _queue_embedding_recompute(guide.id)
    return guide


@router.delete("/{guide_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_guide(guide_id: UUID, db: Session = Depends(get_db),
                 scope: TenantScope = Depends(get_tenant_scope)):
    guide = db.query(WorkGuide).filter(WorkGuide.id == guide_id).first()
    if not guide or not scope.visible(guide.tenant_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Guide not found")
    # D-158 — parent_id 는 FK 가 없어 부모만 지우면 하위 페이지(와 그 자손)가 트리에서 사라진다.
    # 하위가 있으면 지우지 않고 409 로 사유를 돌려준다. 다른 테넌트의 하위도 고아가 되므로 범위와
    # 상관없이 센다(개수만 알리고 제목은 노출하지 않는다).
    child_count = db.query(WorkGuide).filter(
        WorkGuide.parent_id == guide.id, WorkGuide.id != guide.id,
    ).count()
    if child_count:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"하위 페이지 {child_count}개가 있어 삭제할 수 없습니다. "
                "하위 페이지를 다른 상위로 옮기거나 먼저 삭제하세요."
            ),
        )
    db.delete(guide)
    db.commit()
