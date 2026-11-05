from typing import Optional

from pydantic import BaseModel, Field, field_validator

MAX_NS_SELECTED = 200        # 클러스터당 마지막 선택으로 기억하는 NS 상한
MAX_NS_CLUSTERS = 200        # 계정당 기억하는 클러스터 수 상한 — 넘으면 가장 오래 안 쓴 클러스터부터 버린다
MAX_NS_NAME_LEN = 253        # K8s 이름 상한(DNS subdomain)
DEFAULT_RECENT_LIMIT = 3
MAX_RECENT_LIMIT = 10


class NsClusterPrefs(BaseModel):
    cluster_id: str
    selected: list[str] = Field(default_factory=list)   # 비어 있으면 "전체 네임스페이스"
    recent: list[str] = Field(default_factory=list)     # 최근 선택 NS, 최신이 앞


class NsPrefsOut(BaseModel):
    recent_limit: int = DEFAULT_RECENT_LIMIT
    # 키가 동적인 dict 대신 목록 — axios 의 camelCase/snake_case 자동 변환이 클러스터 ID 를 건드리지 않게.
    clusters: list[NsClusterPrefs] = Field(default_factory=list)


class NsPrefsUpdate(BaseModel):
    cluster_id: str = Field(..., min_length=1, max_length=64)
    selected: list[str] = Field(default_factory=list, max_length=MAX_NS_SELECTED)
    recent_limit: Optional[int] = Field(None, ge=1, le=MAX_RECENT_LIMIT)

    @field_validator("selected")
    @classmethod
    def _clean(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        for name in v:
            name = (name or "").strip()
            if not name or len(name) > MAX_NS_NAME_LEN or name in out:
                continue
            out.append(name)
        return out
