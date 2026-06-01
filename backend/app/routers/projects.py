from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.project import Project
from app.models.work_item import WorkItem
from app.auth.deps import get_current_user
from app.models.user import User
from app.schemas.project import (
    ProjectCreate,
    ProjectUpdate,
    ProjectResponse,
    ProjectListResponse,
)

router = APIRouter(prefix="/projects", tags=["projects"])


def _not_found(project_id: UUID) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"error": "PROJECT_NOT_FOUND", "message": "Project not found", "id": str(project_id)},
    )


def _build_response(project: Project, db: Session) -> ProjectResponse:
    items = db.query(WorkItem).filter(WorkItem.project_id == project.id).all()
    total = len(items)
    done = sum(1 for w in items if w.kanban_status == "done")
    rate = round((done / total) * 100, 1) if total > 0 else 0.0
    assignees = sorted({w.primary_assignee for w in items if w.primary_assignee})

    resp = ProjectResponse.model_validate(project)
    resp.total_items = total
    resp.done_items = done
    resp.achievement_rate = rate
    resp.assignees = assignees
    return resp


@router.get("", response_model=ProjectListResponse)
def list_projects(
    status_filter: Optional[str] = Query(None, alias="status"),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    q = db.query(Project)
    if status_filter:
        q = q.filter(Project.status == status_filter)
    projects = q.order_by(Project.created_at.desc()).all()
    return ProjectListResponse(
        data=[_build_response(p, db) for p in projects],
        total=len(projects),
    )


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
def create_project(
    payload: ProjectCreate,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    project = Project(**payload.model_dump())
    db.add(project)
    db.commit()
    db.refresh(project)
    return _build_response(project, db)


@router.get("/{project_id}", response_model=ProjectResponse)
def get_project(
    project_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise _not_found(project_id)
    return _build_response(project, db)


@router.put("/{project_id}", response_model=ProjectResponse)
def update_project(
    project_id: UUID,
    payload: ProjectUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise _not_found(project_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(project, field, value)
    db.commit()
    db.refresh(project)
    return _build_response(project, db)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise _not_found(project_id)
    # project_id=null 로 업무 연결 해제
    db.query(WorkItem).filter(WorkItem.project_id == project_id).update({"project_id": None})
    db.delete(project)
    db.commit()
