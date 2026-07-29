"""Observability 도메인 서비스.

- `catalog_seed`  : 관측 모듈/지표 카탈로그 기본값 seed
- `alert_ingest`  : Alertmanager webhook / 사내 alert-forwarder 페이로드 정규화
- `alert_router`  : 수신 알람 → 알림 라우팅 + 중복 억제
"""
from app.services.observability.alert_ingest import ParsedAlert, parse_alert_payload
from app.services.observability.alert_router import (
    DEFAULT_ALERT_SETTINGS,
    ALERT_SETTINGS_KEY,
    get_alert_settings,
    set_alert_settings,
    route_and_notify,
)
from app.services.observability.catalog_seed import seed_observability_catalog

__all__ = [
    "ParsedAlert",
    "parse_alert_payload",
    "route_and_notify",
    "get_alert_settings",
    "set_alert_settings",
    "DEFAULT_ALERT_SETTINGS",
    "ALERT_SETTINGS_KEY",
    "seed_observability_catalog",
]
