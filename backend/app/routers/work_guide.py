from uuid import UUID
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.work_guide import WorkGuide
from app.schemas.work_guide import (
    WorkGuideCreate,
    WorkGuideUpdate,
    WorkGuideResponse,
    WorkGuideListResponse,
)

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
):
    q = db.query(WorkGuide)
    if category:
        q = q.filter(WorkGuide.category == category)
    if guide_status:
        q = q.filter(WorkGuide.status == guide_status)
    if priority:
        q = q.filter(WorkGuide.priority == priority)
    return WorkGuideListResponse(data=q.order_by(WorkGuide.created_at.desc()).all())


@router.get("/{guide_id}", response_model=WorkGuideResponse)
def get_guide(guide_id: UUID, db: Session = Depends(get_db)):
    guide = db.query(WorkGuide).filter(WorkGuide.id == guide_id).first()
    if not guide:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Guide not found")
    return guide


@router.post("", response_model=WorkGuideResponse, status_code=status.HTTP_201_CREATED)
def create_guide(payload: WorkGuideCreate, db: Session = Depends(get_db)):
    guide = WorkGuide(**payload.model_dump())
    db.add(guide)
    db.commit()
    db.refresh(guide)
    _queue_embedding_recompute(guide.id)  # 비동기 — 쓰기 응답 속도에 영향 없음
    return guide


@router.put("/{guide_id}", response_model=WorkGuideResponse)
def update_guide(guide_id: UUID, payload: WorkGuideUpdate, db: Session = Depends(get_db)):
    guide = db.query(WorkGuide).filter(WorkGuide.id == guide_id).first()
    if not guide:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Guide not found")
    update_data = payload.model_dump(exclude_unset=True)
    for k, v in update_data.items():
        setattr(guide, k, v)
    db.commit()
    db.refresh(guide)
    if "title" in update_data or "content" in update_data:
        _queue_embedding_recompute(guide.id)
    return guide


@router.delete("/{guide_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_guide(guide_id: UUID, db: Session = Depends(get_db)):
    guide = db.query(WorkGuide).filter(WorkGuide.id == guide_id).first()
    if not guide:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Guide not found")
    db.delete(guide)
    db.commit()
