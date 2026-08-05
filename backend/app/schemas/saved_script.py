from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field

ScriptLanguage = Literal["bash", "python"]


class SavedScriptBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    language: ScriptLanguage = "bash"
    content: str = Field(..., min_length=1)
    description: Optional[str] = Field(default=None, max_length=500)


class SavedScriptCreate(SavedScriptBase):
    pass


class SavedScriptUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    language: Optional[ScriptLanguage] = None
    content: Optional[str] = Field(default=None, min_length=1)
    description: Optional[str] = Field(default=None, max_length=500)


class SavedScriptResponse(SavedScriptBase):
    id: UUID
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
