import re
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

# 화면(3D 그래프 툴팁 등)에 그대로 찍히는 문자열 — HTML 꺾쇠와 제어문자는 받지 않는다(A-2, 저장형 XSS 방어).
# 프론트도 이스케이프하지만 서버에서 한 번 더 막아 다른 소비자(RAG 인용·내보내기)까지 안전하게 둔다.
_FORBIDDEN_DISPLAY_CHARS = re.compile(r"[<>\x00-\x1f\x7f]")


def _check_display_text(value: str | None, label: str) -> str | None:
    if value is None:
        return value
    if _FORBIDDEN_DISPLAY_CHARS.search(value):
        raise ValueError(f"{label}에는 '<', '>' 와 제어문자(줄바꿈·탭 포함)를 쓸 수 없습니다.")
    stripped = value.strip()
    if not stripped:
        raise ValueError(f"{label}은(는) 공백만으로 채울 수 없습니다.")
    return stripped


class OntologyEntityCreate(BaseModel):
    cluster_id: UUID
    entity_type: str
    name: str = Field(..., min_length=1, max_length=255)
    external_id: str | None = Field(default=None, max_length=255)
    version: str | None = Field(default=None, max_length=100)
    properties: dict = Field(default_factory=dict)

    @field_validator("name")
    @classmethod
    def _v_name(cls, v: str) -> str:
        return _check_display_text(v, "엔티티 이름")

    @field_validator("version")
    @classmethod
    def _v_version(cls, v: str | None) -> str | None:
        return _check_display_text(v, "버전")

    @field_validator("external_id")
    @classmethod
    def _v_external_id(cls, v: str | None) -> str | None:
        return _check_display_text(v, "외부 ID")


class OntologyEntityRead(BaseModel):
    id: UUID
    cluster_id: UUID
    entity_type: str
    name: str
    external_id: str | None = None
    version: str | None = None
    properties: dict
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class OntologyRelationshipCreate(BaseModel):
    cluster_id: UUID
    source_entity_id: UUID
    relation_type: str = Field(..., min_length=2, max_length=50)
    target_entity_id: UUID
    weight: float = Field(default=1.0, ge=0.0, le=1.0)
    relation_metadata: dict = Field(default_factory=dict)

    @field_validator("relation_type")
    @classmethod
    def _v_relation_type(cls, v: str) -> str:
        return _check_display_text(v, "관계 유형")


class OntologyRelationshipRead(BaseModel):
    id: UUID
    cluster_id: UUID
    source_entity_id: UUID
    relation_type: str
    target_entity_id: UUID
    weight: float
    relation_metadata: dict
    created_at: datetime

    class Config:
        from_attributes = True


# 영향 분석은 가정(what-if) 시뮬레이션이다 — 실제 구성 변경 이벤트와 섞이지 않게 서버가 분류를 고정한다(A-17).
IMPACT_SIMULATION_CATEGORY = "impact_simulation"


class ConfigChangeImpactRequest(BaseModel):
    cluster_id: UUID
    config_entity_id: UUID
    # 하위 호환으로 받기는 하지만 저장은 항상 category="impact_simulation", severity="info" 다.
    category: str = Field(default=IMPACT_SIMULATION_CATEGORY, min_length=2, max_length=50)
    severity: str = Field(default="info", pattern="^(info|warning|critical)$")
    title: str = Field(..., min_length=2, max_length=255)
    description: str | None = None
    evidence: dict = Field(default_factory=dict)
    max_depth: int = Field(default=4, ge=1, le=8)


class ImpactPath(BaseModel):
    path: list[UUID]
    path_names: list[str]
    path_relations: list[str]
    score: float


class ConfigChangeImpactResponse(BaseModel):
    event_id: UUID
    blast_radius_score: float
    impacted_entities: list[OntologyEntityRead]
    impact_paths: list[ImpactPath]


class OntologyGraphResponse(BaseModel):
    cluster_id: UUID
    entities: list[OntologyEntityRead]
    relationships: list[OntologyRelationshipRead]
