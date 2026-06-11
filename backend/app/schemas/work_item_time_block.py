"""WorkItemTimeBlock pydantic 스키마."""
from datetime import date, datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field, model_validator


class TimeBlockBase(BaseModel):
    block_date: date
    start_minute: int = Field(ge=0, le=1439)
    end_minute: int = Field(ge=1, le=1440)
    note: Optional[str] = None

    @model_validator(mode="after")
    def _check_order(self):
        if self.end_minute <= self.start_minute:
            raise ValueError("end_minute 은 start_minute 보다 커야 합니다.")
        return self


class TimeBlockCreate(TimeBlockBase):
    pass


class TimeBlockUpdate(BaseModel):
    block_date: Optional[date] = None
    start_minute: Optional[int] = Field(default=None, ge=0, le=1439)
    end_minute: Optional[int] = Field(default=None, ge=1, le=1440)
    note: Optional[str] = None


class TimeBlockResponse(TimeBlockBase):
    id: UUID
    work_item_id: UUID
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
