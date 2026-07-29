"""수신 알람 페이로드 정규화.

두 가지 입력을 모두 받는다:

1. **Alertmanager webhook v4** — `webhook_configs` 가 보내는 표준 포맷.
   `{version, groupKey, status, receiver, groupLabels, commonLabels, commonAnnotations,
     externalURL, alerts: [{status, labels, annotations, startsAt, endsAt,
                            generatorURL, fingerprint}]}`
2. **generic fallback** — 사내 `alert-forwarder` 처럼 포맷이 임의인 경우. `alerts` 배열이
   없으면 단일 객체로 보고 흔한 키 별칭(title/message/level/host …)을 최선노력으로 매핑한다.

파서는 **절대 예외를 밖으로 던지지 않는다.** 이상한 페이로드는 최소한의 필드만 채운
`ParsedAlert` 로 떨어뜨려서, 알람이 유실되는 대신 인박스에 "정체불명 알람"으로라도 남게 한다.
"""
from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

_log = logging.getLogger(__name__)

VALID_SEVERITIES = ("info", "warning", "critical")

# generic 페이로드에서 각 필드로 매핑할 후보 키 (앞에 있을수록 우선)
_ALERTNAME_KEYS = ("alertname", "alert_name", "name", "title", "subject", "rule", "check")
_SUMMARY_KEYS = ("summary", "title", "subject", "message", "text", "msg")
_DESC_KEYS = ("description", "detail", "details", "body", "message", "text")
_SEVERITY_KEYS = ("severity", "priority", "level", "urgency", "criticality")
_NAMESPACE_KEYS = ("namespace", "ns", "project")
_RESOURCE_KEYS = ("pod", "instance", "node", "host", "hostname", "resource", "target", "service")
_CLUSTER_KEYS = ("cluster", "cluster_name", "clustername", "prometheus", "k8s_cluster")

# 사내 포워더 등이 쓰는 심각도 표현 → 정규 severity
_SEVERITY_ALIAS = {
    "critical": "critical", "crit": "critical", "fatal": "critical", "disaster": "critical",
    "emergency": "critical", "p1": "critical", "sev1": "critical", "high": "critical",
    "error": "critical", "err": "critical",
    "warning": "warning", "warn": "warning", "major": "warning", "minor": "warning",
    "p2": "warning", "sev2": "warning", "medium": "warning", "degraded": "warning",
    "info": "info", "information": "info", "informational": "info", "notice": "info",
    "low": "info", "p3": "info", "p4": "info", "sev3": "info", "debug": "info", "none": "info",
}


@dataclass
class ParsedAlert:
    """정규화된 알람 1건 — 그대로 AlertEvent 로 upsert 된다."""

    alertname: str
    fingerprint: str
    status: str = "firing"                    # firing | resolved
    severity: str = "warning"
    summary: Optional[str] = None
    description: Optional[str] = None
    namespace: Optional[str] = None
    resource: Optional[str] = None
    cluster_hint: Optional[str] = None        # 라벨에서 뽑은 클러스터 이름 후보
    starts_at: Optional[datetime] = None
    ends_at: Optional[datetime] = None
    generator_url: Optional[str] = None
    labels: dict[str, Any] = field(default_factory=dict)
    annotations: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)
    source: str = "alertmanager"              # alertmanager | forwarder


# ── helpers ──────────────────────────────────────────────────────────────────

def _as_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        s = value.strip()
        return s or None
    if isinstance(value, (int, float, bool)):
        return str(value)
    return None


def _pick(source: dict[str, Any], keys: tuple[str, ...]) -> Optional[str]:
    """대소문자 무시하고 후보 키 중 처음 값이 있는 것을 반환."""
    if not isinstance(source, dict):
        return None
    lowered = {str(k).lower(): v for k, v in source.items()}
    for key in keys:
        val = _as_str(lowered.get(key))
        if val:
            return val
    return None


def normalize_severity(value: Optional[str]) -> Optional[str]:
    """자유 표기 심각도를 info/warning/critical 로 정규화. 모르면 None."""
    if not value:
        return None
    key = str(value).strip().lower()
    return _SEVERITY_ALIAS.get(key)


def parse_ts(value: Any) -> Optional[datetime]:
    """RFC3339 / epoch 초·밀리초를 naive UTC datetime 으로. 실패하면 None.

    Alertmanager 는 미설정 시각을 "0001-01-01T00:00:00Z" 로 보낸다 — 이건 None 취급한다.
    """
    if value in (None, "", 0):
        return None
    if isinstance(value, (int, float)):
        try:
            ts = float(value)
            if ts > 1e11:      # 밀리초로 온 경우
                ts /= 1000.0
            return datetime.utcfromtimestamp(ts)
        except (ValueError, OSError, OverflowError):
            return None
    text = str(value).strip()
    if not text or text.startswith("0001-01-01"):
        return None
    # 나노초 정밀도(파이썬은 마이크로초까지)를 잘라낸다
    cleaned = text.replace("Z", "+00:00")
    if "." in cleaned:
        head, _, tail = cleaned.partition(".")
        digits = ""
        rest = ""
        for i, ch in enumerate(tail):
            if ch.isdigit():
                digits += ch
            else:
                rest = tail[i:]
                break
        cleaned = f"{head}.{digits[:6]}{rest}" if digits else f"{head}{rest}"
    try:
        dt = datetime.fromisoformat(cleaned)
    except ValueError:
        return None
    # DB 는 naive UTC 로 통일 — tz 가 붙어 오면 UTC 로 변환 후 tzinfo 를 떼어낸다.
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def compute_fingerprint(alertname: str, labels: dict[str, Any]) -> str:
    """Alertmanager 가 fingerprint 를 안 줬을 때 라벨셋으로 안정적인 식별자를 만든다."""
    parts = [f"{k}={labels[k]}" for k in sorted(labels or {}) if labels.get(k) is not None]
    payload = "|".join([alertname, *parts])
    return hashlib.sha1(payload.encode("utf-8", errors="replace")).hexdigest()[:40]


def _flatten(obj: Any, prefix: str = "", out: Optional[dict] = None, depth: int = 0) -> dict:
    """generic 페이로드에서 라벨 후보를 뽑기 위한 얕은 평탄화(최대 3단계)."""
    if out is None:
        out = {}
    if depth > 3 or not isinstance(obj, dict):
        return out
    for k, v in obj.items():
        key = f"{prefix}{k}"
        if isinstance(v, dict):
            _flatten(v, f"{key}.", out, depth + 1)
        elif isinstance(v, (str, int, float, bool)) or v is None:
            out[key] = v
    return out


# ── Alertmanager v4 ──────────────────────────────────────────────────────────

def _parse_alertmanager_alert(item: dict[str, Any], common: dict[str, Any]) -> ParsedAlert:
    labels = {**(common.get("labels") or {}), **(item.get("labels") or {})}
    annotations = {**(common.get("annotations") or {}), **(item.get("annotations") or {})}

    alertname = _as_str(labels.get("alertname")) or _pick(annotations, _ALERTNAME_KEYS) or "UnknownAlert"
    status = "resolved" if str(item.get("status") or common.get("status") or "").lower() == "resolved" else "firing"
    severity = normalize_severity(_pick(labels, _SEVERITY_KEYS)) or "warning"

    fingerprint = _as_str(item.get("fingerprint")) or compute_fingerprint(alertname, labels)

    return ParsedAlert(
        alertname=alertname[:255],
        fingerprint=fingerprint[:64],
        status=status,
        severity=severity,
        summary=(_pick(annotations, _SUMMARY_KEYS) or "")[:500] or None,
        description=_pick(annotations, _DESC_KEYS),
        namespace=(_pick(labels, _NAMESPACE_KEYS) or "")[:253] or None,
        resource=(_pick(labels, _RESOURCE_KEYS) or "")[:253] or None,
        cluster_hint=_pick(labels, _CLUSTER_KEYS),
        starts_at=parse_ts(item.get("startsAt") or item.get("starts_at")),
        ends_at=parse_ts(item.get("endsAt") or item.get("ends_at")),
        generator_url=(_as_str(item.get("generatorURL") or item.get("generator_url")) or "")[:1024] or None,
        labels=labels,
        annotations=annotations,
        raw=item,
        source="alertmanager",
    )


# ── generic fallback ─────────────────────────────────────────────────────────

def _parse_generic_alert(payload: dict[str, Any]) -> ParsedAlert:
    flat = _flatten(payload)
    labels = payload.get("labels") if isinstance(payload.get("labels"), dict) else {}
    annotations = payload.get("annotations") if isinstance(payload.get("annotations"), dict) else {}
    # 라벨이 따로 없으면 평탄화 결과 자체를 라벨로 쓴다 — 인박스 상세에서 볼 수 있게.
    effective_labels = labels or {k: v for k, v in flat.items() if v not in (None, "")}

    alertname = (
        _pick(payload, _ALERTNAME_KEYS)
        or _pick(labels, _ALERTNAME_KEYS)
        or _pick(annotations, _ALERTNAME_KEYS)
        or "ExternalAlert"
    )
    raw_status = str(_pick(payload, ("status", "state", "action", "eventtype")) or "").lower()
    status = "resolved" if raw_status in ("resolved", "ok", "recovered", "clear", "cleared", "close", "closed") else "firing"

    severity = (
        normalize_severity(_pick(payload, _SEVERITY_KEYS))
        or normalize_severity(_pick(labels, _SEVERITY_KEYS))
        or normalize_severity(_pick(annotations, _SEVERITY_KEYS))
        or "warning"
    )

    fingerprint = (
        _as_str(payload.get("fingerprint"))
        or _as_str(payload.get("id"))
        or compute_fingerprint(alertname, effective_labels)
    )

    return ParsedAlert(
        alertname=alertname[:255],
        fingerprint=str(fingerprint)[:64],
        status=status,
        severity=severity,
        summary=((_pick(payload, _SUMMARY_KEYS) or _pick(annotations, _SUMMARY_KEYS)) or "")[:500] or None,
        description=_pick(payload, _DESC_KEYS) or _pick(annotations, _DESC_KEYS),
        namespace=((_pick(payload, _NAMESPACE_KEYS) or _pick(labels, _NAMESPACE_KEYS)) or "")[:253] or None,
        resource=((_pick(payload, _RESOURCE_KEYS) or _pick(labels, _RESOURCE_KEYS)) or "")[:253] or None,
        cluster_hint=_pick(payload, _CLUSTER_KEYS) or _pick(labels, _CLUSTER_KEYS),
        starts_at=parse_ts(
            payload.get("startsAt") or payload.get("starts_at")
            or payload.get("timestamp") or payload.get("time") or payload.get("occurred_at")
        ),
        ends_at=parse_ts(payload.get("endsAt") or payload.get("ends_at") or payload.get("resolved_at")),
        generator_url=(_as_str(payload.get("generatorURL") or payload.get("url") or payload.get("link")) or "")[:1024] or None,
        labels=effective_labels,
        annotations=annotations,
        raw=payload,
        source="forwarder",
    )


# ── entrypoint ───────────────────────────────────────────────────────────────

def parse_alert_payload(payload: Any) -> list[ParsedAlert]:
    """수신 페이로드를 ParsedAlert 리스트로 정규화한다. 예외를 던지지 않는다."""
    try:
        if isinstance(payload, list):
            out: list[ParsedAlert] = []
            for item in payload:
                out.extend(parse_alert_payload(item))
            return out

        if not isinstance(payload, dict):
            return []

        alerts = payload.get("alerts")
        if isinstance(alerts, list) and alerts:
            # Alertmanager webhook — commonLabels/commonAnnotations 를 각 알람에 병합
            common = {
                "labels": payload.get("commonLabels") or payload.get("groupLabels") or {},
                "annotations": payload.get("commonAnnotations") or {},
                "status": payload.get("status"),
            }
            parsed = []
            for item in alerts:
                if not isinstance(item, dict):
                    continue
                try:
                    parsed.append(_parse_alertmanager_alert(item, common))
                except Exception as e:  # noqa: BLE001
                    _log.warning("alert ingest: 개별 알람 파싱 실패 — 건너뜀 (%s)", e)
            return parsed

        return [_parse_generic_alert(payload)]

    except Exception as e:  # noqa: BLE001
        _log.exception("alert ingest: 페이로드 파싱 실패 (%s)", e)
        return []
