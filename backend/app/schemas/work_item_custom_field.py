from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

DataType = Literal["text", "number", "date", "checkbox", "select"]


class WorkItemCustomFieldBase(BaseModel):
    key: str = Field(..., min_length=1, max_length=64, pattern=r"^[A-Za-z][A-Za-z0-9_]*$")
    label: str = Field(..., min_length=1, max_length=128)
    data_type: DataType = "text"
    options: Optional[list[str]] = None
    description: Optional[str] = None
    sort_order: int = Field(default=0, ge=0, le=10000)


class WorkItemCustomFieldCreate(WorkItemCustomFieldBase):
    pass


class WorkItemCustomFieldUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    label: Optional[str] = None
    data_type: Optional[DataType] = None
    options: Optional[list[str]] = None
    description: Optional[str] = None
    sort_order: Optional[int] = None


class WorkItemCustomFieldOut(WorkItemCustomFieldBase):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    created_at: datetime
    updated_at: datetime


class WorkItemCustomFieldList(BaseModel):
    data: list[WorkItemCustomFieldOut]
