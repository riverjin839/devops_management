from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class OpsNoteCreate(BaseModel):
    service: str = Field(..., min_length=1, max_length=50)
    title: str = Field(..., min_length=1, max_length=200)
    content: Optional[str] = None
    back_content: Optional[str] = None
    color: str = Field(default="yellow", pattern="^(yellow|green|blue|pink|purple)$")
    author: Optional[str] = Field(None, max_length=100)
    pinned: bool = False
    confluence_url: Optional[str] = Field(None, max_length=2048)
    dl_url: Optional[str] = Field(None, max_length=2048)


class OpsNoteUpdate(BaseModel):
    service: Optional[str] = Field(None, min_length=1, max_length=50)
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    content: Optional[str] = None
    back_content: Optional[str] = None
    color: Optional[str] = Field(None, pattern="^(yellow|green|blue|pink|purple)$")
    author: Optional[str] = Field(None, max_length=100)
    pinned: Optional[bool] = None
    confluence_url: Optional[str] = Field(None, max_length=2048)
    dl_url: Optional[str] = Field(None, max_length=2048)


class OpsNoteResponse(BaseModel):
    id: str
    service: str
    title: str
    content: Optional[str] = None
    back_content: Optional[str] = None
    color: str
    author: Optional[str] = None
    pinned: bool
    confluence_url: Optional[str] = None
    dl_url: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class OpsNoteListResponse(BaseModel):
    data: list[OpsNoteResponse]
    total: int
