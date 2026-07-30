"""알람 → AI 자동 분석 훅 단위 테스트 (순수 로직 — DB/Redis 불필요).

- scope 정규화 (defensive merge) / 규칙 매칭 (priority first-match, severity_min, 패턴)
- maybe_enqueue_analysis 의 게이트 순서와 결과 코드
- **어떤 예외도 알람 수신을 막지 않는다** (절대 raise 하지 않음)
"""
import uuid
from types import SimpleNamespace as NS
from unittest.mock import MagicMock

import pytest

from app.services.observability import analysis_hook as hook
from app.services.observability.analysis_hook import (
    match_rule,
    match_rule_for_k8s_event,
    maybe_enqueue_analysis,
    maybe_enqueue_analysis_for_k8s_event,
    normalize_scope,
)


def _event(**overrides):
    base = dict(
        id=uuid.uuid4(),
        cluster_id=uuid.uuid4(),
        status="firing",
        severity="critical",
        alertname="KubePodCrashLooping",
        namespace="prod-api",
        resource="api-5c9d",
        analysis_status=None,
    )
    base.update(overrides)
    return NS(**base)


def _k8s_event(**overrides):
    base = dict(
        id=uuid.uuid4(),
        cluster_id=uuid.uuid4(),
        severity="critical",
        reason="CrashLoopBackOff",
        namespace="prod-api",
        resource_name="api-5c9d",
        analysis_status=None,
    )
    base.update(overrides)
    return NS(**base)


def _scope(**overrides):
    base = {
        "enabled": True,
        "debounce_seconds": 600,
        "global_max_per_hour": 30,
        "rules": [{
            "id": "r1", "priority": 100, "enabled": True, "cluster_id": None,
            "namespace_pattern": "*", "alertname_pattern": "*",
            "severity_min": "warning", "max_per_hour": 10,
            "notify_analysis": False, "include_logs": False,
        }],
    }
    base.update(overrides)
    return normalize_scope(base)


# ── normalize_scope ───────────────────────────────────────────────────────

def test_normalize_scope_defaults_on_garbage():
    for raw in (None, "nope", [], {"rules": "x"}):
        scope = normalize_scope(raw)  # type: ignore[arg-type]
        assert scope["enabled"] is False
        assert scope["rules"] == []


def test_normalize_scope_sorts_rules_by_priority_and_fixes_values():
    scope = normalize_scope({
        "enabled": True,
        "debounce_seconds": "bad",
        "rules": [
            {"id": "b", "priority": 200},
            {"id": "a", "priority": 10, "severity_min": "wat", "max_per_hour": 0},
            "garbage",
        ],
    })
    assert scope["debounce_seconds"] == 600
    assert [r["id"] for r in scope["rules"]] == ["a", "b"]
    assert scope["rules"][0]["severity_min"] == "warning"   # 잘못된 값 → 기본
    assert scope["rules"][0]["max_per_hour"] == 1           # 최소 1


# ── match_rule ────────────────────────────────────────────────────────────

def test_match_rule_first_match_by_priority():
    scope = _scope(rules=[
        {"id": "specific", "priority": 10, "enabled": True, "cluster_id": None,
         "namespace_pattern": "prod-*", "alertname_pattern": "KubePod*",
         "severity_min": "warning", "max_per_hour": 5},
        {"id": "catchall", "priority": 100, "enabled": True, "cluster_id": None,
         "namespace_pattern": "*", "alertname_pattern": "*",
         "severity_min": "info", "max_per_hour": 5},
    ])
    rule = match_rule(scope, _event())
    assert rule is not None and rule["id"] == "specific"


def test_match_rule_severity_min_excludes_lower():
    scope = _scope()
    assert match_rule(scope, _event(severity="info")) is None
    assert match_rule(scope, _event(severity="warning")) is not None


def test_match_rule_namespace_and_alertname_patterns():
    scope = _scope(rules=[{
        "id": "r", "priority": 1, "enabled": True, "cluster_id": None,
        "namespace_pattern": "prod-*", "alertname_pattern": "KubeNode*",
        "severity_min": "info", "max_per_hour": 5,
    }])
    assert match_rule(scope, _event(alertname="KubeNodeNotReady")) is not None
    assert match_rule(scope, _event(alertname="DiskFull")) is None
    assert match_rule(scope, _event(namespace="dev-x", alertname="KubeNodeNotReady")) is None


def test_match_rule_cluster_scoping():
    cid = uuid.uuid4()
    scope = _scope(rules=[{
        "id": "r", "priority": 1, "enabled": True, "cluster_id": str(cid),
        "namespace_pattern": "*", "alertname_pattern": "*",
        "severity_min": "info", "max_per_hour": 5,
    }])
    assert match_rule(scope, _event(cluster_id=cid)) is not None
    assert match_rule(scope, _event(cluster_id=uuid.uuid4())) is None


def test_match_rule_skips_disabled():
    scope = _scope(rules=[{
        "id": "r", "priority": 1, "enabled": False, "cluster_id": None,
        "namespace_pattern": "*", "alertname_pattern": "*",
        "severity_min": "info", "max_per_hour": 5,
    }])
    assert match_rule(scope, _event()) is None


# ── sources (alert/k8s_event) ───────────────────────────────────────────────

def test_normalize_scope_defaults_sources_to_both_when_absent():
    scope = normalize_scope({
        "enabled": True,
        "rules": [{"id": "r", "priority": 1}],
    })
    assert scope["rules"][0]["sources"] == ["alert", "k8s_event"]


def test_normalize_scope_defaults_sources_to_both_on_invalid_value():
    for bad in (None, "alert", [], ["bogus"]):
        scope = normalize_scope({"enabled": True, "rules": [{"id": "r", "priority": 1, "sources": bad}]})
        assert scope["rules"][0]["sources"] == ["alert", "k8s_event"]


def test_normalize_scope_keeps_explicit_source_subset():
    scope = normalize_scope({
        "enabled": True,
        "rules": [{"id": "r", "priority": 1, "sources": ["k8s_event", "bogus"]}],
    })
    assert scope["rules"][0]["sources"] == ["k8s_event"]


def test_match_rule_for_k8s_event_uses_reason_as_alertname_pattern_target():
    scope = _scope(rules=[{
        "id": "r", "priority": 1, "enabled": True, "cluster_id": None,
        "namespace_pattern": "*", "alertname_pattern": "CrashLoop*",
        "severity_min": "info", "max_per_hour": 5,
    }])
    assert match_rule_for_k8s_event(scope, _k8s_event(reason="CrashLoopBackOff")) is not None
    assert match_rule_for_k8s_event(scope, _k8s_event(reason="OOMKilling")) is None


def test_match_rule_source_scoping_excludes_other_pipeline():
    alert_only = _scope(rules=[{
        "id": "r", "priority": 1, "enabled": True, "sources": ["alert"], "cluster_id": None,
        "namespace_pattern": "*", "alertname_pattern": "*", "severity_min": "info", "max_per_hour": 5,
    }])
    assert match_rule(alert_only, _event()) is not None
    assert match_rule_for_k8s_event(alert_only, _k8s_event()) is None

    k8s_only = _scope(rules=[{
        "id": "r", "priority": 1, "enabled": True, "sources": ["k8s_event"], "cluster_id": None,
        "namespace_pattern": "*", "alertname_pattern": "*", "severity_min": "info", "max_per_hour": 5,
    }])
    assert match_rule(k8s_only, _event()) is None
    assert match_rule_for_k8s_event(k8s_only, _k8s_event()) is not None


# ── maybe_enqueue_analysis 게이트 순서 ────────────────────────────────────

@pytest.fixture(autouse=True)
def _fresh_cache():
    hook.invalidate_scope_cache()
    yield
    hook.invalidate_scope_cache()


def test_enqueue_skips_resolved_alert(monkeypatch):
    assert maybe_enqueue_analysis(MagicMock(), _event(status="resolved")) == "not_firing"


def test_enqueue_disabled_scope(monkeypatch):
    monkeypatch.setattr(hook, "get_analysis_scope", lambda db, **k: _scope(enabled=False))
    assert maybe_enqueue_analysis(MagicMock(), _event()) == "disabled"


def test_enqueue_no_match(monkeypatch):
    monkeypatch.setattr(hook, "get_analysis_scope", lambda db, **k: _scope(rules=[]))
    assert maybe_enqueue_analysis(MagicMock(), _event()) == "no_match"


def test_enqueue_debounced(monkeypatch):
    monkeypatch.setattr(hook, "get_analysis_scope", lambda db, **k: _scope())
    monkeypatch.setattr(hook, "_debounce_ok", lambda event, seconds: False)
    event = _event()
    assert maybe_enqueue_analysis(MagicMock(), event) == "debounced"
    assert event.analysis_status == "skipped"


def test_enqueue_rate_limited(monkeypatch):
    monkeypatch.setattr(hook, "get_analysis_scope", lambda db, **k: _scope())
    monkeypatch.setattr(hook, "_debounce_ok", lambda event, seconds: True)
    monkeypatch.setattr(hook, "_rate_ok", lambda rid, rmax, gmax: False)
    event = _event()
    assert maybe_enqueue_analysis(MagicMock(), event) == "rate_limited"
    assert event.analysis_status == "skipped"


def test_enqueue_queued_calls_celery_with_llm_queue(monkeypatch):
    monkeypatch.setattr(hook, "get_analysis_scope", lambda db, **k: _scope())
    monkeypatch.setattr(hook, "_debounce_ok", lambda event, seconds: True)
    monkeypatch.setattr(hook, "_rate_ok", lambda rid, rmax, gmax: True)

    captured = {}

    class _FakeTask:
        @staticmethod
        def apply_async(args=None, kwargs=None, queue=None):
            captured["args"] = args
            captured["kwargs"] = kwargs
            captured["queue"] = queue

    import app.celery_app as celery_module
    monkeypatch.setattr(celery_module, "run_auto_incident_analysis", _FakeTask)

    event = _event()
    assert maybe_enqueue_analysis(MagicMock(), event) == "queued"
    assert event.analysis_status == "queued"
    assert captured["queue"] == "llm"
    assert captured["args"] == [str(event.id)]
    assert captured["kwargs"]["rule_id"] == "r1"


def test_enqueue_never_raises_even_if_scope_load_explodes(monkeypatch):
    def _boom(db, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(hook, "get_analysis_scope", _boom)
    assert maybe_enqueue_analysis(MagicMock(), _event()) == "error"


# ── maybe_enqueue_analysis_for_k8s_event 게이트 순서 (알람 경로와 동일 계약) ─────

def test_k8s_enqueue_disabled_scope(monkeypatch):
    monkeypatch.setattr(hook, "get_analysis_scope", lambda db, **k: _scope(enabled=False))
    assert maybe_enqueue_analysis_for_k8s_event(MagicMock(), _k8s_event()) == "disabled"


def test_k8s_enqueue_no_match(monkeypatch):
    monkeypatch.setattr(hook, "get_analysis_scope", lambda db, **k: _scope(rules=[]))
    assert maybe_enqueue_analysis_for_k8s_event(MagicMock(), _k8s_event()) == "no_match"


def test_k8s_enqueue_debounced(monkeypatch):
    monkeypatch.setattr(hook, "get_analysis_scope", lambda db, **k: _scope())
    monkeypatch.setattr(hook, "_debounce_ok", lambda fields, seconds: False)
    event = _k8s_event()
    assert maybe_enqueue_analysis_for_k8s_event(MagicMock(), event) == "debounced"
    assert event.analysis_status == "skipped"


def test_k8s_enqueue_rate_limited(monkeypatch):
    monkeypatch.setattr(hook, "get_analysis_scope", lambda db, **k: _scope())
    monkeypatch.setattr(hook, "_debounce_ok", lambda fields, seconds: True)
    monkeypatch.setattr(hook, "_rate_ok", lambda rid, rmax, gmax: False)
    event = _k8s_event()
    assert maybe_enqueue_analysis_for_k8s_event(MagicMock(), event) == "rate_limited"
    assert event.analysis_status == "skipped"


def test_k8s_enqueue_queued_calls_celery_with_llm_queue(monkeypatch):
    monkeypatch.setattr(hook, "get_analysis_scope", lambda db, **k: _scope())
    monkeypatch.setattr(hook, "_debounce_ok", lambda fields, seconds: True)
    monkeypatch.setattr(hook, "_rate_ok", lambda rid, rmax, gmax: True)

    captured = {}

    class _FakeTask:
        @staticmethod
        def apply_async(args=None, kwargs=None, queue=None):
            captured["args"] = args
            captured["kwargs"] = kwargs
            captured["queue"] = queue

    import app.celery_app as celery_module
    monkeypatch.setattr(celery_module, "run_auto_incident_analysis_k8s_event", _FakeTask)

    event = _k8s_event()
    assert maybe_enqueue_analysis_for_k8s_event(MagicMock(), event) == "queued"
    assert event.analysis_status == "queued"
    assert captured["queue"] == "llm"
    assert captured["args"] == [str(event.id)]
    assert captured["kwargs"]["rule_id"] == "r1"


def test_k8s_enqueue_never_raises_even_if_scope_load_explodes(monkeypatch):
    def _boom(db, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(hook, "get_analysis_scope", _boom)
    assert maybe_enqueue_analysis_for_k8s_event(MagicMock(), _k8s_event()) == "error"


def test_debounce_key_shared_across_alert_and_k8s_event_sources():
    """같은 (cluster,namespace,resource) 면 두 소스가 동일 디바운스 키를 쓴다
    (한쪽이 먼저 분석을 잡으면 다른 쪽 트리거가 겹쳐 들어와도 중복 분석되지 않음)."""
    cid = uuid.uuid4()
    alert_fields = hook._fields_from_alert(_event(cluster_id=cid, namespace="prod-api", resource="api-5c9d"))
    k8s_fields = hook._fields_from_k8s_event(
        _k8s_event(cluster_id=cid, namespace="prod-api", resource_name="api-5c9d")
    )
    assert (alert_fields.cluster_id, alert_fields.namespace, alert_fields.resource) == (
        k8s_fields.cluster_id, k8s_fields.namespace, k8s_fields.resource,
    )
