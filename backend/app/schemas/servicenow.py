"""ServiceNow ITSM 연동 pydantic 스키마."""
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel


# ── 공통 설정 (관리자, AppSetting key=servicenow_integration) ────────────────────
class ServiceNowConfig(BaseModel):
    base_url: str = ""
    enabled: bool = False
    verify_tls: bool = True
    # 실제 인스턴스 스펙 확인 전까지는 ServiceNow 표준 Table API 를 가정한 기본값.
    # 다르면 코드 수정 없이 여기서 조정한다(UI-First 원칙).
    table_name: str = "incident"
    field_mapping: dict[str, str] = {
        "short_description": "title",
        "description": "content",
    }
    priority_map: dict[str, str] = {"high": "1", "medium": "2", "low": "3"}


class ServiceNowConfigUpdate(BaseModel):
    base_url: Optional[str] = None
    enabled: Optional[bool] = None
    verify_tls: Optional[bool] = None
    table_name: Optional[str] = None
    field_mapping: Optional[dict[str, str]] = None
    priority_map: Optional[dict[str, str]] = None


class ServiceNowTestResult(BaseModel):
    ok: bool
    detail: str = ""
    display_name: Optional[str] = None


# ── 업무 → ServiceNow 등록 ───────────────────────────────────────────────────
class ServiceNowRegisterStep(BaseModel):
    step: str            # auth | config | payload | create
    status: Literal["ok", "error"]
    message: str = ""


class ServiceNowRegisterResult(BaseModel):
    status: Literal["ok", "error"]
    ticket_number: Optional[str] = None
    ticket_url: Optional[str] = None
    detail: str = ""
    auth_issue: bool = False
    steps: list[ServiceNowRegisterStep] = []
    synced_at: Optional[datetime] = None
