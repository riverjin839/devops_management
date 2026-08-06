"""알람/K8s 이벤트 → AI 자동 분석 훅 — 범위(scope) 매칭 + 디바운스 + 레이트 리밋.

두 소스에서 호출된다:
- ``alert_router.route_and_notify`` — 알람을 upsert 한 직후
- ``routers/k8s_events.receive_kubewatch_event`` — kubewatch 이벤트 저장 직후

**어떤 실패도 원본 수신(ingest)을 막지 않는다** — 전체가 try/except 로 격리돼
있고, Redis 불가 시 fail-open(디바운스/레이트 제한 없이 스킵이 아니라 '분석을
안 보내는' 보수적 동작 — 아래 주석 참고)으로 동작한다.

범위 설정: AppSetting ``llm_analysis_scope`` (Settings → AI/LLM 탭에서 편집).
전역 기본 ``enabled: false`` — 배포 직후 자동 분석은 아무것도 실행되지 않고,
운영자가 규칙을 켜면서 사용량 대시보드로 부하를 보며 점진 확대한다. 규칙마다
``sources`` (alert/k8s_event 부분집합)로 어느 파이프라인에 적용할지 고른다 —
기존(마이그레이션 이전) 규칙은 필드가 없으면 둘 다에 적용된다(하위 호환).
"""
from __future__ import annotations

import fnmatch
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.config import settings
from app.models.alert_event import SEVERITY_ORDER, AlertEvent
from app.models.app_setting import AppSetting
from app.models.k8s_event import K8sEvent

logger = logging.getLogger(__name__)

ALL_SOURCES = ("alert", "k8s_event")

SCOPE_KEY = "llm_analysis_scope"

DEFAULT_SCOPE: dict[str, Any] = {
    "enabled": False,
    "debounce_seconds": 600,
    "global_max_per_hour": 30,
    "rules": [],
}

_SCOPE_CACHE_TTL = 60
_scope_cache: Optional[dict] = None
_scope_cache_at: float = 0.0

_redis_client = None


def _get_redis():
    """디바운스/레이트 카운터용 Redis — login_rate_limiter 와 동일한 접근."""
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    try:
        import redis as _redis
        _redis_client = _redis.Redis.from_url(
            settings.redis_url, socket_connect_timeout=1, socket_timeout=1,
        )
    except Exception:  # noqa: BLE001
        _redis_client = False
    return _redis_client


def normalize_scope(raw: Optional[dict]) -> dict:
    """defensive merge — 저장값이 어떤 형태여도 안전한 scope 로 정규화."""
    out = dict(DEFAULT_SCOPE)
    if not isinstance(raw, dict):
        return {**out, "rules": []}
    out["enabled"] = bool(raw.get("enabled", False))
    try:
        out["debounce_seconds"] = max(0, int(raw.get("debounce_seconds", 600)))
    except (TypeError, ValueError):
        out["debounce_seconds"] = 600
    try:
        out["global_max_per_hour"] = max(1, int(raw.get("global_max_per_hour", 30)))
    except (TypeError, ValueError):
        out["global_max_per_hour"] = 30
    rules: list[dict] = []
    for r in raw.get("rules") or []:
        if not isinstance(r, dict):
            continue
        try:
            raw_sources = r.get("sources")
            sources = (
                [s for s in raw_sources if s in ALL_SOURCES]
                if isinstance(raw_sources, list) else None
            )
            rules.append({
                "id": str(r.get("id") or uuid.uuid4().hex[:8]),
                "priority": int(r.get("priority", 100)),
                "enabled": bool(r.get("enabled", True)),
                # 필드 미지정(기존 규칙) 또는 빈 배열 → 두 소스 모두 적용(하위 호환).
                "sources": sources if sources else list(ALL_SOURCES),
                "cluster_id": (str(r["cluster_id"]) if r.get("cluster_id") else None),
                "namespace_pattern": str(r.get("namespace_pattern") or "*"),
                "alertname_pattern": str(r.get("alertname_pattern") or "*"),
                "severity_min": (
                    r.get("severity_min") if r.get("severity_min") in SEVERITY_ORDER else "warning"
                ),
                "max_per_hour": max(1, int(r.get("max_per_hour", 10))),
                "notify_analysis": bool(r.get("notify_analysis", False)),
                "include_logs": bool(r.get("include_logs", False)),
            })
        except (TypeError, ValueError):
            continue
    rules.sort(key=lambda r: r["priority"])
    out["rules"] = rules
    return out


def get_analysis_scope(db: Session, *, use_cache: bool = True) -> dict:
    global _scope_cache, _scope_cache_at
    now = time.monotonic()
    if use_cache and _scope_cache is not None and (now - _scope_cache_at) < _SCOPE_CACHE_TTL:
        return _scope_cache
    raw: Optional[dict] = None
    try:
        row = db.query(AppSetting).filter(AppSetting.key == SCOPE_KEY).first()
        raw = row.value if row is not None else None
    except Exception as exc:  # noqa: BLE001
        logger.warning("llm_analysis_scope 조회 실패 — 비활성 기본값 사용: %s", exc)
    scope = normalize_scope(raw)
    _scope_cache = scope
    _scope_cache_at = now
    return scope


def set_analysis_scope(db: Session, raw: dict) -> dict:
    scope = normalize_scope(raw)
    row = db.query(AppSetting).filter(AppSetting.key == SCOPE_KEY).first()
    if row is None:
        row = AppSetting(key=SCOPE_KEY, value=scope)
        db.add(row)
    else:
        row.value = scope
    db.commit()
    invalidate_scope_cache()
    return scope


def invalidate_scope_cache() -> None:
    global _scope_cache, _scope_cache_at
    _scope_cache = None
    _scope_cache_at = 0.0


@dataclass
class _MatchFields:
    """규칙 매칭에 필요한 값만 뽑은 공통 형태 — AlertEvent/K8sEvent 어느 쪽이든 변환."""

    source: str          # "alert" | "k8s_event"
    severity: str
    cluster_id: Any
    name: str             # AlertEvent.alertname 또는 K8sEvent.reason (규칙의 alertname_pattern 대상)
    namespace: Optional[str]
    resource: str         # 디바운스 키에 쓰는 리소스 식별자


def _fields_from_alert(event: AlertEvent) -> _MatchFields:
    return _MatchFields(
        source="alert", severity=event.severity or "info", cluster_id=event.cluster_id,
        name=event.alertname or "", namespace=event.namespace, resource=event.resource or "",
    )


def _fields_from_k8s_event(event: K8sEvent) -> _MatchFields:
    return _MatchFields(
        source="k8s_event", severity=event.severity or "info", cluster_id=event.cluster_id,
        name=event.reason or "", namespace=event.namespace, resource=event.resource_name or "",
    )


def _match_rule(scope: dict, fields: _MatchFields) -> Optional[dict]:
    """priority 오름차순 first-match (AlertNotifyRule 의 의미론과 동일)."""
    ev_sev = SEVERITY_ORDER.get(fields.severity, 0)
    for rule in scope["rules"]:
        if not rule["enabled"]:
            continue
        if fields.source not in rule["sources"]:
            continue
        if rule["cluster_id"] and str(fields.cluster_id or "") != rule["cluster_id"]:
            continue
        if ev_sev < SEVERITY_ORDER.get(rule["severity_min"], 1):
            continue
        if not fnmatch.fnmatch(fields.name, rule["alertname_pattern"]):
            continue
        if not fnmatch.fnmatch(fields.namespace or "", rule["namespace_pattern"]):
            continue
        return rule
    return None


def match_rule(scope: dict, event: AlertEvent) -> Optional[dict]:
    """알람용 규칙 매칭 (하위 호환 이름 유지)."""
    return _match_rule(scope, _fields_from_alert(event))


def match_rule_for_k8s_event(scope: dict, event: K8sEvent) -> Optional[dict]:
    return _match_rule(scope, _fields_from_k8s_event(event))


def _debounce_ok(fields: _MatchFields, seconds: int) -> bool:
    """같은 (cluster, namespace, resource) 로 seconds 내 재분석 방지 — 알람/K8s 이벤트
    공용 키 스페이스라, 같은 대상에 대해 두 파이프라인이 겹쳐 들어와도 중복 분석되지 않는다.

    Redis 불가 시 False (분석 안 보냄) — 디바운스가 안 되는 상태에서 분석을
    무제한 보내는 것보다 보수적으로 막는 쪽이 부하 안전하다.
    """
    if seconds <= 0:
        return True
    client = _get_redis()
    if not client:
        return False
    try:
        key = f"llm:debounce:{fields.cluster_id}:{fields.namespace}:{fields.resource}"
        return bool(client.set(key, "1", nx=True, ex=seconds))
    except Exception:  # noqa: BLE001
        return False


def _rate_ok(rule_id: str, rule_max: int, global_max: int) -> bool:
    """시간당 상한 — 규칙별 + 전역. Redis 불가 시 False (보수적)."""
    client = _get_redis()
    if not client:
        return False
    try:
        bucket = datetime.utcnow().strftime("%Y%m%d%H")
        pipe = client.pipeline()
        pipe.incr(f"llm:rate:rule:{rule_id}:{bucket}")
        pipe.expire(f"llm:rate:rule:{rule_id}:{bucket}", 2 * 3600, nx=True)
        pipe.incr(f"llm:rate:global:{bucket}")
        pipe.expire(f"llm:rate:global:{bucket}", 2 * 3600, nx=True)
        rule_count, _, global_count, _ = pipe.execute()
        return int(rule_count) <= rule_max and int(global_count) <= global_max
    except Exception:  # noqa: BLE001
        return False


def maybe_enqueue_analysis(db: Session, event: AlertEvent) -> str:
    """조건 충족 시 전용 llm 큐로 분석 태스크를 enqueue 한다.

    반환: "disabled" | "not_firing" | "no_match" | "debounced" | "rate_limited"
          | "queued" | "error". 절대 raise 하지 않는다.
    """
    try:
        if event.status != "firing":
            return "not_firing"
        scope = get_analysis_scope(db)
        if not scope["enabled"]:
            return "disabled"
        fields = _fields_from_alert(event)
        rule = _match_rule(scope, fields)
        if rule is None:
            return "no_match"
        if not _debounce_ok(fields, scope["debounce_seconds"]):
            event.analysis_status = event.analysis_status or "skipped"
            return "debounced"
        if not _rate_ok(rule["id"], rule["max_per_hour"], scope["global_max_per_hour"]):
            event.analysis_status = "skipped"
            return "rate_limited"

        from app.celery_app import run_auto_incident_analysis
        run_auto_incident_analysis.apply_async(
            args=[str(event.id)],
            kwargs={
                "rule_id": rule["id"],
                "include_logs": rule["include_logs"],
                "notify_analysis": rule["notify_analysis"],
            },
            queue="llm",
        )
        event.analysis_status = "queued"
        return "queued"
    except Exception as exc:  # noqa: BLE001
        logger.warning("alert 자동 분석 enqueue 실패 — 알람 수신은 계속 (%s)", exc)
        return "error"


def maybe_enqueue_analysis_for_k8s_event(db: Session, event: K8sEvent) -> str:
    """K8s 이벤트(kubewatch) 직접 트리거 — 알람 파이프라인을 거치지 않고도 자동 분석한다.

    K8s 이벤트는 firing/resolved 개념이 없어(수신 시점 1회성) 그 검사만 없고
    나머지(scope/규칙 매칭/디바운스/레이트/큐잉)는 알람 경로와 동일하다.
    반환값·예외 정책도 ``maybe_enqueue_analysis`` 와 동일.
    """
    try:
        scope = get_analysis_scope(db)
        if not scope["enabled"]:
            return "disabled"
        fields = _fields_from_k8s_event(event)
        rule = _match_rule(scope, fields)
        if rule is None:
            return "no_match"
        if not _debounce_ok(fields, scope["debounce_seconds"]):
            event.analysis_status = event.analysis_status or "skipped"
            return "debounced"
        if not _rate_ok(rule["id"], rule["max_per_hour"], scope["global_max_per_hour"]):
            event.analysis_status = "skipped"
            return "rate_limited"

        from app.celery_app import run_auto_incident_analysis_k8s_event
        run_auto_incident_analysis_k8s_event.apply_async(
            args=[str(event.id)],
            kwargs={
                "rule_id": rule["id"],
                "include_logs": rule["include_logs"],
                "notify_analysis": rule["notify_analysis"],
            },
            queue="llm",
        )
        event.analysis_status = "queued"
        return "queued"
    except Exception as exc:  # noqa: BLE001
        logger.warning("k8s_event 자동 분석 enqueue 실패 — 이벤트 수신은 계속 (%s)", exc)
        return "error"
