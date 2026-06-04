"""WorkItemCustomField CRUD — 업무 사용자 정의 필드 정의. (값은 work_items.custom_values)"""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import WorkItem, WorkItemCustomField
from app.schemas.work_item_custom_field import (
    WorkItemCustomFieldCreate,
    WorkItemCustomFieldList,
    WorkItemCustomFieldOut,
    WorkItemCustomFieldUpdate,
)

router = APIRouter(tags=["work-item-custom-fields"])


@router.get("/work-item-custom-fields", response_model=WorkItemCustomFieldList)
def list_fields(db: Session = Depends(get_db)):
    rows = (
        db.query(WorkItemCustomField)
        .order_by(WorkItemCustomField.sort_order, WorkItemCustomField.label)
        .all()
    )
    return WorkItemCustomFieldList(data=[WorkItemCustomFieldOut.model_validate(r) for r in rows])


@router.post("/work-item-custom-fields", response_model=WorkItemCustomFieldOut,
             status_code=status.HTTP_201_CREATED)
def create_field(payload: WorkItemCustomFieldCreate, db: Session = Depends(get_db)):
    if db.query(WorkItemCustomField).filter(WorkItemCustomField.key == payload.key).first():
        raise HTTPException(status_code=409, detail=f"이미 존재하는 key: {payload.key}")
    data = payload.model_dump()
    if data.get("sort_order", 0) == 0:
        last = db.query(WorkItemCustomField).order_by(WorkItemCustomField.sort_order.desc()).first()
        data["sort_order"] = (last.sort_order + 10) if last else 10
    field = WorkItemCustomField(**data)
    db.add(field)
    db.commit()
    db.refresh(field)
    return WorkItemCustomFieldOut.model_validate(field)


@router.put("/work-item-custom-fields/{field_id}", response_model=WorkItemCustomFieldOut)
def update_field(field_id: UUID, payload: WorkItemCustomFieldUpdate, db: Session = Depends(get_db)):
    field = db.query(WorkItemCustomField).filter(WorkItemCustomField.id == field_id).first()
    if not field:
        raise HTTPException(status_code=404, detail="Field not found")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(field, k, v)
    db.commit()
    db.refresh(field)
    return WorkItemCustomFieldOut.model_validate(field)


@router.delete("/work-item-custom-fields/{field_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_field(field_id: UUID, db: Session = Depends(get_db)):
    field = db.query(WorkItemCustomField).filter(WorkItemCustomField.id == field_id).first()
    if not field:
        raise HTTPException(status_code=404, detail="Field not found")
    # 모든 업무의 custom_values 에서 해당 key 제거
    rows = db.query(WorkItem).filter(WorkItem.custom_values.isnot(None)).all()
    for w in rows:
        if isinstance(w.custom_values, dict) and field.key in w.custom_values:
            new_vals = {k: v for k, v in w.custom_values.items() if k != field.key}
            w.custom_values = new_vals or None
    db.delete(field)
    db.commit()
