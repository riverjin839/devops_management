from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.workflow import Workflow, WorkflowStep, WorkflowEdge
from app.models.user import User
from app.auth.deps import require_operator
from app.schemas.workflow import (
    WorkflowCreate,
    WorkflowUpdate,
    WorkflowResponse,
    WorkflowListResponse,
    WorkflowStepCreate,
    WorkflowStepUpdate,
    WorkflowStepResponse,
    WorkflowEdgeCreate,
    WorkflowEdgeResponse,
)

router = APIRouter(prefix="/workflows", tags=["workflows"])


# ── Workflow CRUD ──────────────────────────────────────────────────────────────

@router.get("", response_model=WorkflowListResponse)
def list_workflows(db: Session = Depends(get_db)):
    workflows = db.query(Workflow).order_by(Workflow.created_at.desc()).all()
    return WorkflowListResponse(data=workflows)


@router.get("/{workflow_id}", response_model=WorkflowResponse)
def get_workflow(workflow_id: UUID, db: Session = Depends(get_db)):
    wf = db.query(Workflow).filter(Workflow.id == workflow_id).first()
    if not wf:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workflow not found")
    return wf


@router.post("", response_model=WorkflowResponse, status_code=status.HTTP_201_CREATED)
def create_workflow(
    payload: WorkflowCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    wf = Workflow(**payload.model_dump())
    db.add(wf)
    db.commit()
    db.refresh(wf)
    return wf


@router.put("/{workflow_id}", response_model=WorkflowResponse)
def update_workflow(
    workflow_id: UUID,
    payload: WorkflowUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    wf = db.query(Workflow).filter(Workflow.id == workflow_id).first()
    if not wf:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workflow not found")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(wf, k, v)
    db.commit()
    db.refresh(wf)
    return wf


@router.delete("/{workflow_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workflow(
    workflow_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    wf = db.query(Workflow).filter(Workflow.id == workflow_id).first()
    if not wf:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workflow not found")
    db.delete(wf)
    db.commit()


# ── Step CRUD ──────────────────────────────────────────────────────────────────

@router.post("/{workflow_id}/steps", response_model=WorkflowStepResponse, status_code=status.HTTP_201_CREATED)
def create_step(
    workflow_id: UUID,
    payload: WorkflowStepCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    wf = db.query(Workflow).filter(Workflow.id == workflow_id).first()
    if not wf:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workflow not found")
    step = WorkflowStep(workflow_id=workflow_id, **payload.model_dump())
    db.add(step)
    db.commit()
    db.refresh(step)
    return step


@router.put("/{workflow_id}/steps/{step_id}", response_model=WorkflowStepResponse)
def update_step(
    workflow_id: UUID,
    step_id: UUID,
    payload: WorkflowStepUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    step = (
        db.query(WorkflowStep)
        .filter(WorkflowStep.id == step_id, WorkflowStep.workflow_id == workflow_id)
        .first()
    )
    if not step:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Step not found")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(step, k, v)
    db.commit()
    db.refresh(step)
    return step


@router.delete("/{workflow_id}/steps/{step_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_step(
    workflow_id: UUID,
    step_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    step = (
        db.query(WorkflowStep)
        .filter(WorkflowStep.id == step_id, WorkflowStep.workflow_id == workflow_id)
        .first()
    )
    if not step:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Step not found")
    db.delete(step)
    db.commit()


# ── Edge CRUD ──────────────────────────────────────────────────────────────────

@router.post("/{workflow_id}/edges", response_model=WorkflowEdgeResponse, status_code=status.HTTP_201_CREATED)
def create_edge(
    workflow_id: UUID,
    payload: WorkflowEdgeCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    wf = db.query(Workflow).filter(Workflow.id == workflow_id).first()
    if not wf:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workflow not found")
    if payload.source_step_id == payload.target_step_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Source and target must differ")
    # Idempotent: return existing edge if duplicate
    existing = (
        db.query(WorkflowEdge)
        .filter(
            WorkflowEdge.workflow_id == workflow_id,
            WorkflowEdge.source_step_id == payload.source_step_id,
            WorkflowEdge.target_step_id == payload.target_step_id,
        )
        .first()
    )
    if existing:
        return existing
    edge = WorkflowEdge(workflow_id=workflow_id, **payload.model_dump())
    db.add(edge)
    db.commit()
    db.refresh(edge)
    return edge


@router.delete("/{workflow_id}/edges/{edge_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_edge(
    workflow_id: UUID,
    edge_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    edge = (
        db.query(WorkflowEdge)
        .filter(WorkflowEdge.id == edge_id, WorkflowEdge.workflow_id == workflow_id)
        .first()
    )
    if not edge:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Edge not found")
    db.delete(edge)
    db.commit()
