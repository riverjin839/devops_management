"""kubewatch 페이로드 파싱 + severity 분류."""
from __future__ import annotations

from typing import Any

CRITICAL_REASONS = {
    "OOMKilling",
    "BackOff",
    "CrashLoopBackOff",
    "NodeNotReady",
    "NodeLost",
    "Evicted",
    "FailedCreatePodSandBox",
    "NetworkNotReady",
    "KubeletNotReady",
}

WARNING_REASONS = {
    "Pulling",
    "FailedMount",
    "FailedAttachVolume",
    "FailedScheduling",
    "Unhealthy",
    "ProbeWarning",
    "ImagePullBackOff",
    "ErrImagePull",
    "Preempting",
    "Pending",
}


def classify_severity(reason: str | None) -> str:
    if not reason:
        return "info"
    if reason in CRITICAL_REASONS:
        return "critical"
    if reason in WARNING_REASONS:
        return "warning"
    return "info"


def parse_kubewatch_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """kubewatch 웹훅 페이로드 → 정규화된 필드 딕셔너리."""
    obj = payload.get("object") or {}
    metadata = obj.get("metadata") or {}
    status = obj.get("status") or {}

    resource_kind = obj.get("kind") or payload.get("kind") or "Unknown"
    resource_name = metadata.get("name") or ""
    namespace = metadata.get("namespace")
    reason = status.get("reason") or payload.get("reason")
    message = status.get("message") or payload.get("message")
    event_type = payload.get("type") or "MODIFIED"

    severity = classify_severity(reason)

    return {
        "event_type": event_type,
        "resource_kind": resource_kind,
        "resource_name": resource_name,
        "namespace": namespace,
        "reason": reason,
        "message": message,
        "severity": severity,
    }
