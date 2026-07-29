"""LLM 게이트웨이 설정 라우터 — Settings → AI/LLM 탭의 백엔드.

- 설정(프로필/라우팅/analyzer_backend/언어)은 AppSetting ``llm_settings`` 에 저장.
- API 키 원문은 절대 반환하지 않는다 — ``llm_credentials`` (암호화 테이블) 의
  이름 목록과 마스킹 힌트만 노출한다.
- 쓰기 계열은 admin 전용.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import require_admin
from app.config import settings
from app.database import get_db
from app.models.app_setting import AppSetting
from app.models.llm_credential import LlmCredential
from app.models.user import User
from app.services.llm import llm_service, LLM_SETTINGS_KEY, PURPOSES
from app.services.llm.service import merge_llm_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/llm", tags=["llm-settings"])


# ── Schemas ───────────────────────────────────────────────────────────

class LlmProfileSchema(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    provider: str = Field(..., pattern="^(ollama|openai_compat)$")
    base_url: str = Field(..., min_length=1)
    model: str = Field(default="")
    api_key_ref: str = Field(default="")
    timeout_seconds: int = Field(default=120, ge=5, le=600)
    max_concurrency: int = Field(default=2, ge=1, le=32)
    enabled: bool = True


class LlmRouteSchema(BaseModel):
    primary: str
    fallback: Optional[str] = None


class LlmSettingsPayload(BaseModel):
    language: str = Field(default="ko", pattern="^(ko|en)$")
    analyzer_backend: str = Field(default="rule_based", pattern="^(claude|local_llm|rule_based)$")
    embedding_model: str = Field(default="")
    profiles: list[LlmProfileSchema]
    routing: dict[str, LlmRouteSchema]


class LlmTestRequest(BaseModel):
    profile: str
    prompt: str = Field(
        default="한국어로 한 문장으로 답하세요: 정상적으로 연결되면 '연결 확인 완료' 라고 답하십시오.",
        max_length=500,
    )


class LlmCredentialCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    api_key: str = Field(..., min_length=1, max_length=4096)


# ── Settings CRUD ─────────────────────────────────────────────────────

@router.get("/settings")
def get_llm_settings(db: Session = Depends(get_db)):
    """현재 유효 설정 (defensive merge 적용, 키 원문 없음)."""
    cfg = llm_service.resolve_settings(db)
    return {"data": cfg, "purposes": list(PURPOSES)}


@router.put("/settings")
def update_llm_settings(
    payload: LlmSettingsPayload,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    if not payload.profiles:
        raise HTTPException(status_code=400, detail="프로필이 최소 1개 필요합니다.")
    names = [p.name.strip() for p in payload.profiles]
    if len(set(names)) != len(names):
        raise HTTPException(status_code=400, detail="프로필 이름이 중복됩니다.")
    name_set = set(names)
    for purpose, route in payload.routing.items():
        if purpose not in PURPOSES:
            raise HTTPException(status_code=400, detail=f"알 수 없는 용도(purpose): {purpose}")
        if route.primary not in name_set:
            raise HTTPException(
                status_code=400,
                detail=f"용도 '{purpose}' 의 primary 프로필 '{route.primary}' 이 존재하지 않습니다.",
            )
        if route.fallback and route.fallback not in name_set:
            raise HTTPException(
                status_code=400,
                detail=f"용도 '{purpose}' 의 fallback 프로필 '{route.fallback}' 이 존재하지 않습니다.",
            )
    # credential 참조 유효성 (경고 수준 — 저장은 허용하되 알려준다)
    warnings: list[str] = []
    for p in payload.profiles:
        ref = (p.api_key_ref or "").strip()
        if ref.startswith("credential:"):
            cred_name = ref[len("credential:"):].strip()
            exists = db.query(LlmCredential).filter(LlmCredential.name == cred_name).first()
            if exists is None:
                warnings.append(f"프로필 '{p.name}' 이 참조하는 자격증명 '{cred_name}' 이 없습니다.")
    # 임베딩 모델 변경 경고 — pgvector 차원 결합 (기존 임베딩 재계산 필요)
    current = llm_service.resolve_settings(db)
    new_embedding_model = payload.embedding_model.strip() or settings.embedding_model
    if new_embedding_model != current.get("embedding_model"):
        warnings.append(
            "임베딩 모델이 변경됩니다 — 기존에 저장된 임베딩(work_items/work_guides)과 "
            "비교할 수 없게 되므로 전체 재계산이 필요합니다. 차원(embedding_dim)이 다르면 "
            "저장 자체가 실패합니다."
        )

    value = {
        "language": payload.language,
        "analyzer_backend": payload.analyzer_backend,
        "embedding_model": new_embedding_model,
        "profiles": [p.model_dump() for p in payload.profiles],
        "routing": {k: v.model_dump() for k, v in payload.routing.items()},
    }
    row = db.query(AppSetting).filter(AppSetting.key == LLM_SETTINGS_KEY).first()
    if row is None:
        row = AppSetting(key=LLM_SETTINGS_KEY, value=value)
        db.add(row)
    else:
        row.value = value
    db.commit()
    llm_service.invalidate_cache()
    return {"data": merge_llm_settings(value), "warnings": warnings}


# ── Health / Models / Test ────────────────────────────────────────────

@router.get("/health")
async def llm_health(db: Session = Depends(get_db)):
    """전 프로필 병렬 health — Settings 탭 상태 pill."""
    return {"data": await llm_service.health_all(db)}


@router.get("/profiles/{name}/models")
async def llm_profile_models(name: str, db: Session = Depends(get_db)):
    """프로필 엔드포인트의 모델 목록 (ollama: /api/tags, openai_compat: /v1/models)."""
    if llm_service.get_profile(name, llm_service.resolve_settings(db)) is None:
        raise HTTPException(status_code=404, detail=f"프로필 '{name}' 이 없습니다.")
    models = await llm_service.list_profile_models(name, db)
    return {"data": models}


@router.post("/test")
async def llm_test(
    body: LlmTestRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    """짧은 프롬프트 1회 호출로 프로필 연결을 검증한다 (라우팅 우회, 해당 프로필 직접)."""
    profile = llm_service.get_profile(body.profile, llm_service.resolve_settings(db))
    if profile is None:
        raise HTTPException(status_code=404, detail=f"프로필 '{body.profile}' 이 없습니다.")
    provider = llm_service.build_provider(profile)
    result = await provider.chat(body.prompt, system="간결하게 한국어로 답하십시오.")
    return {
        "status": result.status,
        "latency_ms": result.latency_ms,
        "model": result.model,
        "answer_preview": (result.text or "")[:300],
        "error": result.error,
    }


@router.get("/usage")
def llm_usage(_: Session = Depends(get_db)):
    """프로필 × 용도별 최근 24h 사용량 (Redis 시간버킷 집계, fail-open)."""
    return {"data": llm_service.usage_stats()}


# ── Credentials ───────────────────────────────────────────────────────

def _mask_key(key: str) -> str:
    if len(key) <= 8:
        return "****"
    return f"{key[:3]}****{key[-4:]}"


@router.get("/credentials")
def list_credentials(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    rows = db.query(LlmCredential).order_by(LlmCredential.name).all()
    return {"data": [
        {
            "name": r.name,
            "hint": _mask_key(r.api_key or ""),
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]}


@router.post("/credentials")
def create_credential(
    body: LlmCredentialCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    existing = db.query(LlmCredential).filter(LlmCredential.name == body.name).first()
    if existing is not None:
        # upsert — 같은 이름이면 키 교체 (회전 용도)
        existing.api_key = body.api_key
        db.commit()
        return {"data": {"name": existing.name, "hint": _mask_key(body.api_key)}, "updated": True}
    row = LlmCredential(name=body.name, api_key=body.api_key)
    db.add(row)
    db.commit()
    return {"data": {"name": row.name, "hint": _mask_key(body.api_key)}, "updated": False}


@router.delete("/credentials/{name}")
def delete_credential(
    name: str,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    row = db.query(LlmCredential).filter(LlmCredential.name == name).first()
    if row is None:
        raise HTTPException(status_code=404, detail=f"자격증명 '{name}' 이 없습니다.")
    # 참조 중인 프로필이 있으면 경고와 함께 거부
    cfg = llm_service.resolve_settings(db)
    ref = f"credential:{name}"
    users = [p["name"] for p in cfg["profiles"] if (p.get("api_key_ref") or "").strip() == ref]
    if users:
        raise HTTPException(
            status_code=400,
            detail=f"프로필 {users} 이 이 자격증명을 참조 중입니다. 먼저 프로필에서 참조를 제거하세요.",
        )
    db.delete(row)
    db.commit()
    return {"ok": True}
