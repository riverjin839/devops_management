"""화면별 접근 제어(feature access) — 서버 측 강제.

Settings "접근 제어" 가 저장하는 ``app_settings['feature_access']`` 는 라우트 경로(예: ``/mindmap``)를
키로 쓰는 규칙 맵이다. 이전에는 프론트(``canAccessFeature``)만 이 맵을 평가해 화면을 숨겼고,
같은 데이터를 주는 API 는 인증만 통과하면 누구에게나 응답했다 — UI 가드일 뿐 격리가 아니었다.

이 모듈은 같은 규칙을 백엔드에서 평가한다:

- ``FEATURE_API_PATTERNS``: 화면(feature 키) → 그 화면 **전용** API 경로 정규식.
  여러 화면이 공유하는 API(``/clusters``, ``/work-items`` 등)는 넣지 않는다 — 한 화면을 막으려다
  다른 화면이 깨지기 때문이다. 경로는 ``/api/v1`` 을 뗀 나머지와 매칭한다.
- ``enforce_feature_access``: ``main.py`` 의 ``_auth`` 의존성 목록에 붙어 인증 라우터 전체에서
  요청 경로를 검사하고, 매칭된 feature 규칙이 현재 사용자를 허용하지 않으면 403.

판정 규칙은 프론트 ``hooks/useFeatureAccess.ts`` 의 ``canAccessFeature`` 와 반드시 같아야 한다.
"""
from __future__ import annotations

import re
from typing import Any

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user
from app.database import get_db
from app.models.app_setting import AppSetting
from app.models.user import User

FEATURE_ACCESS_KEY = "feature_access"

_API_PREFIX = "/api/v1"

# feature(라우트 경로) → 그 화면만 호출하는 API 경로 정규식.
# 추가 기준: frontend/src/services/api.ts 의 해당 API 객체를 그 화면(+전용 컴포넌트/훅)만 쓰는 경우.
FEATURE_API_PATTERNS: dict[str, tuple[str, ...]] = {
    "/k8s-rbac": (r"^/clusters/[^/]+/rbac(/|$)",),
    # masters(master-candidates)는 배치잡 호스트 선택·k9s 가 공유하므로 제외.
    "/etcdctl": (r"^/clusters/[^/]+/etcdctl/(run|logs|presets)(/|$)",),
    "/mc": (r"^/clusters/[^/]+/mc(/|$)", r"^/mc(/|$)"),
    "/isilon-nfs": (r"^/isilon-nfs(/|$)",),
    "/k8s-allocation": (r"^/k8s/[^/]+/allocation(/|$)",),
    "/k8s-events": (r"^/events(/|$)",),
    "/pod-bottleneck": (r"^/pod-bottleneck(/|$)",),
    # lake-service-types 는 Settings 에서도 편집하므로 제외.
    "/lake-services": (r"^/lake-services(/|$)",),
    "/mindmap": (r"^/mindmaps(/|$)",),
    "/ontology": (r"^/ontology(/|$)",),
    "/trends": (r"^/trends(/|$)",),
    "/service-topology": (r"^/service-topology(/|$)",),
    "/service-architecture": (r"^/architecture-docs(/|$)",),
    # /agent/health 는 아키텍처 화면도 쓰므로 대화 API 만 묶는다.
    "/agent-chat": (r"^/agent/(chat|conversations)(/|$)",),
}

_COMPILED: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (feature, re.compile(p)) for feature, pats in FEATURE_API_PATTERNS.items() for p in pats
)


def normalize_feature_access(raw: Any) -> dict:
    """저장값 방어적 정규화 — 형식이 어긋난 항목은 버린다."""
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    for feature, rule in raw.items():
        if not isinstance(rule, dict):
            continue
        roles = rule.get("roles")
        users = rule.get("users")
        entry = {
            "roles": [str(r) for r in roles] if isinstance(roles, list) else [],
            "users": [str(u) for u in users] if isinstance(users, list) else [],
        }
        # enabled 는 명시적으로 false 일 때만 저장 — 기본값(true/미설정)은 저장하지 않아
        # payload 를 최소화하고, "미설정 = 열림" 의미를 필드 부재로 표현한다.
        if rule.get("enabled") is False:
            entry["enabled"] = False
        out[str(feature)] = entry
    # 레거시 마이그레이션: Your Island 이전엔 WBS 만 지원했고 키가 'wbs' 였다.
    # 화면별 접근 제어가 라우트 경로를 키로 쓰는 규칙으로 통일되면서 '/wbs' 로 승격한다.
    # '/wbs' 가 이미 있으면(신규 설정 우선) 구 키는 버리고, 없으면 그 값을 승격한다 —
    # 어느 쪽이든 'wbs' 라는 레거시 키 자체는 결과에 남기지 않는다.
    if "wbs" in out:
        legacy = out.pop("wbs")
        out.setdefault("/wbs", legacy)
    return out


def can_access_feature(access: dict, feature: str, user: User) -> bool:
    """프론트 ``canAccessFeature`` 와 동일한 판정."""
    role = "viewer" if user.role == "user" else user.role
    if role == "admin":
        return True
    rule = access.get(feature)
    if not rule:
        return True
    if rule.get("enabled") is False:
        return False
    roles = rule.get("roles") or []
    users = rule.get("users") or []
    if not roles and not users:
        return True
    if role in roles:
        return True
    ids = {v for v in (user.username, user.display_name) if v}
    return any(u in ids for u in users)


def feature_for_path(path: str) -> str | None:
    """요청 경로(``/api/v1/...`` 포함 가능)가 속한 feature 키. 전용 API 가 아니면 None."""
    if path.startswith(_API_PREFIX):
        path = path[len(_API_PREFIX):]
    for feature, pattern in _COMPILED:
        if pattern.match(path):
            return feature
    return None


def load_feature_access(db: Session) -> dict:
    row = db.query(AppSetting).filter(AppSetting.key == FEATURE_ACCESS_KEY).first()
    return normalize_feature_access(row.value if row is not None else None)


def enforce_feature_access(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """인증 라우터 공통 의존성 — 화면 전용 API 를 feature_access 규칙으로 차단."""
    feature = feature_for_path(request.url.path)
    if feature is None or user.role == "admin":
        return
    if not can_access_feature(load_feature_access(db), feature, user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"'{feature}' 화면에 대한 접근 권한이 없습니다. (Settings → 접근 제어)",
        )
