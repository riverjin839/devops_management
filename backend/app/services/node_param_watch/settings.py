"""노드 OS 파라미터 감시 설정 — AppSetting ``node_param_watch.settings`` (UI-First).

에이전트 보고 주기·무응답 판정 시간·설치 매니페스트에 들어갈 이미지/주소는 설치 환경마다 다르므로
코드 상수가 아니라 화면에서 고치는 값으로 둔다. 저장값이 손상돼 있어도 기본값으로 되돌려
조회·수신이 죽지 않게 한다(fail-safe).
"""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

SETTINGS_KEY = "node_param_watch.settings"

DEFAULTS: dict[str, Any] = {
    # 에이전트 보고 주기(초). 보고 응답으로 전달되므로 저장 즉시 다음 주기부터 반영된다.
    "interval_sec": 60,
    # 마지막 보고 뒤 이 시간(분)이 지나면 '에이전트 무응답' 알람. 0 = 끔.
    "offline_minutes": 10,
    # 설치 매니페스트 기본값 — 폐쇄망이면 사내 레지스트리 경로로 바꾼다. 전용 Rust 에이전트 이미지(정적 바이너리).
    # backend 이미지를 지정해 둔 기존 설치는 Python 에이전트 방식으로 렌더된다(manifest.is_python_agent_image).
    "agent_image": "ghcr.io/riverjin839/devops_management/node-agent:latest",
    "agent_namespace": "k8s-monitor-agent",
    # 에이전트가 접속할 PEP API 주소(…/api/v1). 비우면 화면을 연 주소로 채운다.
    "ingest_base_url": "",
    # 에이전트가 PEP 의 TLS 인증서를 검증할지(사설 인증서면 끄거나 CA 를 마운트).
    "tls_verify": True,
}

_LIMITS = {"interval_sec": (15, 3600), "offline_minutes": (0, 1440)}


def _normalize(stored: Any) -> dict[str, Any]:
    merged = {**DEFAULTS, **(stored if isinstance(stored, dict) else {})}
    for key, (lo, hi) in _LIMITS.items():
        try:
            val = int(merged.get(key))
        except (TypeError, ValueError):
            val = DEFAULTS[key]
        merged[key] = val if lo <= val <= hi else DEFAULTS[key]
    for key in ("agent_image", "agent_namespace", "ingest_base_url"):
        merged[key] = str(merged.get(key) or "").strip()
    merged["agent_image"] = merged["agent_image"] or DEFAULTS["agent_image"]
    merged["agent_namespace"] = merged["agent_namespace"] or DEFAULTS["agent_namespace"]
    merged["ingest_base_url"] = merged["ingest_base_url"].rstrip("/")
    merged["tls_verify"] = bool(merged.get("tls_verify"))
    return {k: merged[k] for k in DEFAULTS}


def get_settings(db: Session) -> dict[str, Any]:
    from app.models.app_setting import AppSetting

    try:
        row = db.query(AppSetting).filter(AppSetting.key == SETTINGS_KEY).first()
    except Exception:  # noqa: BLE001
        db.rollback()
        return _normalize(None)
    return _normalize(row.value if row else None)


def set_settings(db: Session, patch: dict[str, Any]) -> dict[str, Any]:
    from app.models.app_setting import AppSetting

    row = db.query(AppSetting).filter(AppSetting.key == SETTINGS_KEY).first()
    prev = row.value if row and isinstance(row.value, dict) else {}
    merged = _normalize({**prev, **{k: v for k, v in patch.items() if v is not None}})
    if row:
        row.value = merged
    else:
        db.add(AppSetting(key=SETTINGS_KEY, value=merged))
    db.commit()
    return get_settings(db)
