"""NS 마이그레이션 요청 스키마."""
from __future__ import annotations

from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

_K8S_NAME = r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$"


class MigrationRule(BaseModel):
    type: Literal["image_registry", "string", "replicas", "label"]
    # pydantic 예약어 회피 — JSON 키는 from/to 그대로.
    from_: str = Field("", alias="from", max_length=500)
    to: str = Field("", max_length=500)
    kind: Optional[str] = None
    name: Optional[str] = None

    model_config = {"populate_by_name": True}


class MigrationOptions(BaseModel):
    keep_node_ports: bool = False
    force_conflicts: bool = False


class MigrationSpec(BaseModel):
    source_cluster_id: UUID
    target_cluster_id: UUID
    source_namespace: str = Field(..., max_length=63, pattern=_K8S_NAME)
    target_namespace: str = Field(..., max_length=63, pattern=_K8S_NAME)
    kinds: list[str] = Field(default_factory=list)
    include_secrets: bool = False
    rules: list[MigrationRule] = Field(default_factory=list)
    options: MigrationOptions = Field(default_factory=MigrationOptions)

    @field_validator("kinds")
    @classmethod
    def _known_kinds(cls, v: list[str]) -> list[str]:
        from app.services.ns_migration.transform import KIND_BY_NAME
        bad = [k for k in v if k not in KIND_BY_NAME]
        if bad:
            raise ValueError(f"지원하지 않는 리소스 종류: {', '.join(bad)}")
        return v

    def spec_dict(self) -> dict:
        return {
            "kinds": self.kinds, "include_secrets": self.include_secrets,
            "rules": [r.model_dump(by_alias=True) for r in self.rules],
            "options": self.options.model_dump(),
        }


class RunCreate(MigrationSpec):
    mode: Literal["plan", "apply"] = "plan"


class ProfileBody(MigrationSpec):
    name: str = Field(..., min_length=1, max_length=128)
