from datetime import date
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.sprint import Sprint
from app.models.work_item import WorkItem
from app.auth.deps import get_current_user
from app.models.user import User
from app.schemas.sprint import (
    SprintCreate,
    SprintUpdate,
    SprintResponse,
    SprintListResponse,
)

router = APIRouter(prefix="/sprints", tags=["sprints"])


def _not_found(sprint_id: UUID) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"error": "SPRINT_NOT_FOUND", "message": "Sprint not found", "id": str(sprint_id)},
    )


def _build_response(sprint: Sprint, db: Session) -> SprintResponse:
    items = db.query(WorkItem).filter(WorkItem.sprint_id == sprint.id).all()
    total = len(items)
    done = sum(1 for w in items if w.kanban_status == "done")
    rate = round((done / total) * 100, 1) if total > 0 else 0.0
    effort = sum(w.effort_hours or 0 for w in items)
    assignees = sorted({w.primary_assignee for w in items if w.primary_assignee})

    resp = SprintResponse.model_validate(sprint)
    resp.total_items = total
    resp.done_items = done
    resp.achievement_rate = rate
    resp.total_effort_hours = effort
    resp.assignees = assignees
    return resp


@router.get("", response_model=SprintListResponse)
def list_sprints(
    status_filter: Optional[str] = Query(None, alias="status"),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    q = db.query(Sprint)
    if status_filter:
        q = q.filter(Sprint.status == status_filter)
    sprints = q.order_by(Sprint.start_date.desc()).all()
    return SprintListResponse(
        data=[_build_response(s, db) for s in sprints],
        total=len(sprints),
    )


@router.get("/current", response_model=Optional[SprintResponse])
def current_sprint(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """현재 스프린트 — 오늘 날짜가 포함된 스프린트(완료 제외). 없으면 가장 임박한 예정,
    그것도 없으면 가장 최근 것. 하나도 없으면 null."""
    today = date.today()
    # 1) 오늘이 기간에 포함 + 미완료
    s = (
        db.query(Sprint)
        .filter(Sprint.start_date <= today, Sprint.end_date >= today, Sprint.status != "completed")
        .order_by(Sprint.start_date.desc())
        .first()
    )
    # 2) 다가오는 스프린트
    if not s:
        s = (
            db.query(Sprint)
            .filter(Sprint.start_date > today, Sprint.status != "completed")
            .order_by(Sprint.start_date.asc())
            .first()
        )
    # 3) 가장 최근
    if not s:
        s = db.query(Sprint).order_by(Sprint.start_date.desc()).first()
    if not s:
        return None
    return _build_response(s, db)


@router.post("", response_model=SprintResponse, status_code=status.HTTP_201_CREATED)
def create_sprint(
    payload: SprintCreate,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    if payload.end_date < payload.start_date:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "SPRINT_INVALID_RANGE", "message": "종료일은 시작일 이후여야 합니다."},
        )
    sprint = Sprint(**payload.model_dump())
    db.add(sprint)
    db.commit()
    db.refresh(sprint)
    return _build_response(sprint, db)


@router.get("/{sprint_id}", response_model=SprintResponse)
def get_sprint(
    sprint_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    sprint = db.query(Sprint).filter(Sprint.id == sprint_id).first()
    if not sprint:
        raise _not_found(sprint_id)
    return _build_response(sprint, db)


@router.put("/{sprint_id}", response_model=SprintResponse)
def update_sprint(
    sprint_id: UUID,
    payload: SprintUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    sprint = db.query(Sprint).filter(Sprint.id == sprint_id).first()
    if not sprint:
        raise _not_found(sprint_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(sprint, field, value)
    db.commit()
    db.refresh(sprint)
    return _build_response(sprint, db)


@router.post("/{sprint_id}/carry-over", response_model=SprintResponse)
def carry_over(
    sprint_id: UUID,
    to: UUID = Query(..., description="미완료 항목을 옮길 대상 스프린트 ID"),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """미완료(kanban_status != done) 항목을 다른 스프린트로 이월."""
    src = db.query(Sprint).filter(Sprint.id == sprint_id).first()
    if not src:
        raise _not_found(sprint_id)
    dst = db.query(Sprint).filter(Sprint.id == to).first()
    if not dst:
        raise _not_found(to)
    moved = (
        db.query(WorkItem)
        .filter(WorkItem.sprint_id == sprint_id, WorkItem.kanban_status != "done")
        .update({"sprint_id": to}, synchronize_session=False)
    )
    db.commit()
    resp = _build_response(dst, db)
    # 이월 건수는 stats 에 직접 노출하지 않고 헤더 대신 응답 그대로 반환(프론트가 refetch).
    _ = moved
    return resp


@router.delete("/{sprint_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sprint(
    sprint_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    sprint = db.query(Sprint).filter(Sprint.id == sprint_id).first()
    if not sprint:
        raise _not_found(sprint_id)
    # sprint_id=null 로 업무 연결 해제 (업무는 삭제하지 않음)
    db.query(WorkItem).filter(WorkItem.sprint_id == sprint_id).update({"sprint_id": None})
    db.delete(sprint)
    db.commit()
