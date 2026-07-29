"""Observability / 알람 수신 단위 테스트 (DB·Prometheus 불필요 — 순수 로직).

커버 범위
 - Alertmanager webhook v4 파싱 / 사내 alert-forwarder generic fallback 파싱
 - fingerprint 안정성, 타임스탬프 파싱, severity 별칭 정규화
 - ingest 토큰 fail-closed (미설정 503 / 불일치 401 / 일치 통과)
 - 지표 임계값 판정(invert 포함) + 대표값 선택
 - Prometheus rules/targets/alerts 페이로드 → dense 행 변환
 - **중복 억제**: 창 안에서 반복 수신 시 알림 1건 (first_only / summarize)
 - 알림 규칙 매칭 + severity 재정의
"""
import os

os.environ.setdefault(
    "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test"
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.config import settings
from app.routers.observability import (
    _alerts_from_prometheus,
    _evaluate_state,
    _parse_thresholds,
    _pick_representative,
    _rules_from_payload,
    _targets_from_payload,
    _verify_alert_token,
)
from app.services.observability.alert_ingest import (
    compute_fingerprint,
    normalize_severity,
    parse_alert_payload,
    parse_ts,
)
from app.services.observability.alert_router import (
    DEFAULT_ALERT_SETTINGS,
    _rule_matches,
    apply_notification,
)


# ── 테스트 더블 ───────────────────────────────────────────────────────────────

class FakeQuery:
    def __init__(self, rows):
        self._rows = list(rows)

    def filter(self, *_args, **_kwargs):
        return self

    def order_by(self, *_args):
        return self

    def all(self):
        return list(self._rows)

    def first(self):
        return self._rows[0] if self._rows else None


class FakeSession:
    """apply_notification 이 쓰는 최소 인터페이스만 흉내낸다."""

    def __init__(self, users=None, notifications=None):
        self.added = []
        self.users = users if users is not None else [
            SimpleNamespace(username="alice", display_name="앨리스", is_active=True),
            SimpleNamespace(username="bob", display_name="밥", is_active=True),
        ]
        self.notifications = notifications or []

    def add(self, obj):
        self.added.append(obj)

    def query(self, model):
        name = getattr(model, "__name__", str(model))
        if name == "User":
            return FakeQuery(self.users)
        if name == "UserNotification":
            return FakeQuery(self.notifications)
        return FakeQuery([])


def make_event(**overrides):
    base = dict(
        id="11111111-1111-1111-1111-111111111111",
        alertname="KubePodCrashLooping",
        severity="critical",
        status="firing",
        namespace="kube-system",
        resource="coredns-abc",
        summary="Pod is crash looping",
        description=None,
        occurrences=1,
        notify_count=0,
        suppressed_count=0,
        last_notified_at=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def policy(**overrides):
    base = {
        "notify_mode": "all",
        "recipients": [],
        "severity_min": "warning",
        "dedup_window_sec": 300,
        "dedup_mode": "summarize",
        "severity_override": None,
        "channel_ids": [],
    }
    base.update(overrides)
    return base


# ── Alertmanager webhook v4 파싱 ──────────────────────────────────────────────

ALERTMANAGER_PAYLOAD = {
    "version": "4",
    "groupKey": '{}:{alertname="KubePodCrashLooping"}',
    "status": "firing",
    "receiver": "pep",
    "commonLabels": {"cluster": "prod-a", "severity": "critical"},
    "commonAnnotations": {"runbook_url": "https://runbook/x"},
    "alerts": [
        {
            "status": "firing",
            "labels": {
                "alertname": "KubePodCrashLooping",
                "namespace": "kube-system",
                "pod": "coredns-7d9",
                "severity": "critical",
            },
            "annotations": {"summary": "Pod is crash looping", "description": "restarts > 5"},
            "startsAt": "2026-07-28T01:02:03.123456789Z",
            "endsAt": "0001-01-01T00:00:00Z",
            "generatorURL": "http://prometheus/graph?g0.expr=x",
            "fingerprint": "abc123def456",
        }
    ],
}


def test_parses_alertmanager_webhook_v4():
    alerts = parse_alert_payload(ALERTMANAGER_PAYLOAD)
    assert len(alerts) == 1
    a = alerts[0]
    assert a.alertname == "KubePodCrashLooping"
    assert a.fingerprint == "abc123def456"
    assert a.status == "firing"
    assert a.severity == "critical"
    assert a.namespace == "kube-system"
    assert a.resource == "coredns-7d9"
    assert a.summary == "Pod is crash looping"
    assert a.source == "alertmanager"
    assert a.cluster_hint == "prod-a"           # commonLabels 가 병합돼야 한다
    assert a.annotations.get("runbook_url") == "https://runbook/x"
    assert a.starts_at == datetime(2026, 7, 28, 1, 2, 3, 123456)
    assert a.ends_at is None                    # 0001-01-01 은 "미설정" 이다


def test_alertmanager_resolved_status():
    payload = {**ALERTMANAGER_PAYLOAD, "alerts": [
        {**ALERTMANAGER_PAYLOAD["alerts"][0], "status": "resolved",
         "endsAt": "2026-07-28T02:00:00Z"},
    ]}
    a = parse_alert_payload(payload)[0]
    assert a.status == "resolved"
    assert a.ends_at == datetime(2026, 7, 28, 2, 0, 0)


# ── generic (사내 alert-forwarder) fallback ───────────────────────────────────

def test_parses_generic_forwarder_payload():
    payload = {
        "title": "NodeDiskPressure",
        "level": "P1",
        "message": "노드 디스크 사용률 92%",
        "host": "worker-03",
        "cluster": "prod-b",
        "timestamp": 1785000000,
    }
    alerts = parse_alert_payload(payload)
    assert len(alerts) == 1
    a = alerts[0]
    assert a.alertname == "NodeDiskPressure"
    assert a.severity == "critical"             # P1 → critical
    assert a.resource == "worker-03"
    assert a.cluster_hint == "prod-b"
    assert a.source == "forwarder"
    assert a.fingerprint                        # 라벨셋 sha1 로 생성됨
    assert a.starts_at is not None


def test_generic_resolved_aliases():
    for word in ("resolved", "ok", "recovered", "cleared"):
        a = parse_alert_payload({"name": "X", "status": word})[0]
        assert a.status == "resolved", word


def test_unparseable_payload_returns_empty():
    assert parse_alert_payload("not-a-dict") == []
    assert parse_alert_payload(None) == []


def test_fingerprint_is_stable_and_label_sensitive():
    labels = {"alertname": "A", "pod": "p1"}
    assert compute_fingerprint("A", labels) == compute_fingerprint("A", dict(reversed(list(labels.items()))))
    assert compute_fingerprint("A", labels) != compute_fingerprint("A", {"alertname": "A", "pod": "p2"})


@pytest.mark.parametrize("raw,expected", [
    ("critical", "critical"), ("CRIT", "critical"), ("P1", "critical"), ("error", "critical"),
    ("warn", "warning"), ("Major", "warning"),
    ("info", "info"), ("low", "info"),
    ("무슨값", None),
])
def test_severity_alias_normalisation(raw, expected):
    assert normalize_severity(raw) == expected


def test_parse_ts_handles_epoch_seconds_and_millis():
    assert parse_ts(1785000000) == parse_ts(1785000000000)
    assert parse_ts("") is None
    assert parse_ts("0001-01-01T00:00:00Z") is None


# ── ingest 토큰 fail-closed ───────────────────────────────────────────────────

def test_ingest_disabled_when_token_unset(monkeypatch):
    monkeypatch.setattr(settings, "alert_ingest_token", "", raising=False)
    with pytest.raises(HTTPException) as exc:
        _verify_alert_token(authorization="Bearer anything")
    assert exc.value.status_code == 503


def test_ingest_rejects_wrong_token(monkeypatch):
    monkeypatch.setattr(settings, "alert_ingest_token", "s3cret", raising=False)
    with pytest.raises(HTTPException) as exc:
        _verify_alert_token(authorization="Bearer nope")
    assert exc.value.status_code == 401
    with pytest.raises(HTTPException) as exc2:
        _verify_alert_token(authorization="")
    assert exc2.value.status_code == 401


def test_ingest_accepts_correct_token(monkeypatch):
    monkeypatch.setattr(settings, "alert_ingest_token", "s3cret", raising=False)
    assert _verify_alert_token(authorization="Bearer s3cret") is None


# ── 지표 임계값 판정 ──────────────────────────────────────────────────────────

def test_parse_thresholds():
    assert _parse_thresholds("warning:70,critical:90") == {"warning": 70.0, "critical": 90.0}
    assert _parse_thresholds(None) == {}
    assert _parse_thresholds("garbage") == {}


def test_evaluate_state_normal_direction():
    assert _evaluate_state(95, "warning:70,critical:90", False) == "critical"
    assert _evaluate_state(75, "warning:70,critical:90", False) == "warning"
    assert _evaluate_state(10, "warning:70,critical:90", False) == "ok"
    assert _evaluate_state(None, "warning:70", False) == "unknown"
    # 임계 미설정 = 정보성 지표라 항상 ok
    assert _evaluate_state(12345, None, False) == "ok"


def test_evaluate_state_inverted():
    """up 처럼 값이 낮을수록 나쁜 지표 — critical:1 이면 1 미만이 critical."""
    assert _evaluate_state(0, "critical:1", True) == "critical"
    assert _evaluate_state(1, "critical:1", True) == "ok"


def test_pick_representative_takes_worst_series():
    result = {
        "value": None,
        "results": [
            {"value": 10.0, "labels": {"instance": "a"}},
            {"value": 91.0, "labels": {"instance": "b"}},
        ],
    }
    value, labels, count = _pick_representative(result, invert=False)
    assert (value, labels["instance"], count) == (91.0, "b", 2)

    value, labels, count = _pick_representative(result, invert=True)
    assert (value, labels["instance"], count) == (10.0, "a", 2)


def test_pick_representative_handles_empty():
    assert _pick_representative({"value": None, "results": []}, False) == (None, {}, 0)


# ── Prometheus 페이로드 → dense 행 ────────────────────────────────────────────

RULES_PAYLOAD = {
    "groups": [{
        "name": "kubernetes-apps",
        "file": "/etc/prometheus/rules/x.yaml",
        "rules": [
            {
                "name": "KubePodCrashLooping", "type": "alerting", "state": "firing",
                "query": "rate(kube_pod_container_status_restarts_total[5m]) > 0",
                "duration": 900, "health": "ok", "evaluationTime": 0.002,
                "labels": {"severity": "warning"},
                "annotations": {"summary": "crash looping"},
                "alerts": [{"state": "firing"}, {"state": "firing"}],
            },
            {"name": "RecordRule", "type": "recording", "query": "sum(x)", "health": "ok"},
        ],
    }],
}


def test_rules_payload_to_rows_and_filters():
    rows = _rules_from_payload(RULES_PAYLOAD, state=None, q=None)
    assert len(rows) == 2
    alerting = next(r for r in rows if r.type == "alerting")
    assert alerting.group == "kubernetes-apps"
    assert alerting.severity == "warning"
    assert alerting.active_alerts == 2
    assert {kv.k for kv in alerting.labels} == {"severity"}

    assert len(_rules_from_payload(RULES_PAYLOAD, state="firing", q=None)) == 1
    assert len(_rules_from_payload(RULES_PAYLOAD, state=None, q="record")) == 1
    assert _rules_from_payload({}, None, None) == []


def test_targets_payload_to_rows_and_health_filter():
    payload = {"activeTargets": [
        {"labels": {"job": "node-exporter", "instance": "10.0.0.1:9100"}, "health": "up",
         "scrapeUrl": "http://10.0.0.1:9100/metrics", "lastScrapeDuration": 0.01},
        {"labels": {"job": "kubelet", "instance": "10.0.0.2:10250"}, "health": "down",
         "lastError": "connection refused"},
    ]}
    rows = _targets_from_payload(payload, health=None)
    assert len(rows) == 2
    down = _targets_from_payload(payload, health="down")
    assert len(down) == 1 and down[0].last_error == "connection refused"


def test_prometheus_active_alerts_rows():
    payload = {"alerts": [{
        "labels": {"alertname": "TargetDown", "severity": "critical", "namespace": "monitoring",
                   "instance": "10.0.0.2:10250"},
        "annotations": {"summary": "target down"},
        "state": "firing", "activeAt": "2026-07-28T00:00:00Z", "value": "1e+00",
    }]}
    rows = _alerts_from_prometheus(payload)
    assert len(rows) == 1
    assert rows[0].alertname == "TargetDown"
    assert rows[0].resource == "10.0.0.2:10250"
    assert rows[0].origin == "prometheus"


# ── 중복 억제 (사용자 핵심 요구) ──────────────────────────────────────────────

def test_first_notification_is_created_for_each_active_user():
    db = FakeSession()
    event = make_event()
    assert apply_notification(db, event, policy()) == "created"
    # notify_mode=all → 활성 사용자 수만큼 개인 행으로 팬아웃
    assert len(db.added) == 2
    assert {n.recipient for n in db.added} == {"alice", "bob"}
    assert event.notify_count == 1
    assert event.last_notified_at is not None


def test_dedup_first_only_suppresses_within_window():
    """5분 창 안에서 10번 더 와도 알림은 최초 1건뿐이어야 한다."""
    db = FakeSession()
    event = make_event()
    assert apply_notification(db, event, policy(dedup_mode="first_only")) == "created"
    created = len(db.added)

    for i in range(10):
        event.occurrences += 1
        assert apply_notification(db, event, policy(dedup_mode="first_only")) == "suppressed"

    assert len(db.added) == created          # 추가 알림 없음
    assert event.notify_count == 1
    assert event.suppressed_count == 10


def test_dedup_summarize_updates_existing_notification_text():
    """summarize 모드는 알림을 늘리지 않고 기존 문구를 'N회'로 갱신한다."""
    existing = SimpleNamespace(title="old", body="old", type="alert",
                               link="/alerts?id=11111111-1111-1111-1111-111111111111",
                               created_at=datetime.utcnow())
    db = FakeSession(notifications=[existing])
    event = make_event(notify_count=1, last_notified_at=datetime.utcnow(), occurrences=10)

    assert apply_notification(db, event, policy(dedup_mode="summarize")) == "summarized"
    assert db.added == []                     # 새 알림 없음
    assert "×10" in existing.title
    assert "10회" in existing.body
    assert event.suppressed_count == 1


def test_new_notification_after_window_expires():
    db = FakeSession()
    event = make_event(
        notify_count=1,
        last_notified_at=datetime.utcnow() - timedelta(seconds=600),  # 창(300s) 밖
        occurrences=4,
    )
    assert apply_notification(db, event, policy()) == "created"
    assert len(db.added) == 2
    assert event.notify_count == 2


def test_notify_mode_none_keeps_inbox_only():
    db = FakeSession()
    event = make_event()
    assert apply_notification(db, event, policy(notify_mode="none")) == "skipped_mode"
    assert db.added == []
    assert event.notify_count == 0


def test_notify_mode_users_targets_listed_recipients():
    db = FakeSession()
    event = make_event()
    assert apply_notification(db, event, policy(notify_mode="users", recipients=["앨리스"])) == "created"
    assert [n.recipient for n in db.added] == ["앨리스"]


def test_severity_below_minimum_is_skipped():
    db = FakeSession()
    event = make_event(severity="info")
    assert apply_notification(db, event, policy(severity_min="warning")) == "skipped_severity"
    assert db.added == []


def test_resolved_alert_creates_no_notification():
    db = FakeSession()
    event = make_event(status="resolved")
    assert apply_notification(db, event, policy()) == "skipped_resolved"
    assert db.added == []


# ── 알림 규칙 매칭 ────────────────────────────────────────────────────────────

def rule(**overrides):
    base = dict(
        cluster_id=None, module_key=None, alertname_pattern=None, namespace_pattern=None,
        label_matchers=None, severity_min=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def parsed(**overrides):
    from app.services.observability.alert_ingest import ParsedAlert

    base = dict(alertname="KubePodCrashLooping", fingerprint="fp1", severity="critical",
                namespace="team-a", labels={"team": "platform"})
    base.update(overrides)
    return ParsedAlert(**base)


def test_empty_rule_matches_everything():
    assert _rule_matches(rule(), parsed(), None) is True


def test_rule_matches_by_alertname_regex():
    assert _rule_matches(rule(alertname_pattern="^KubePod"), parsed(), None) is True
    assert _rule_matches(rule(alertname_pattern="^Node"), parsed(), None) is False


def test_invalid_regex_falls_back_to_substring():
    """깨진 정규식이 와도 예외 대신 부분 문자열 매칭으로 떨어진다(규칙 저장 실수 방어)."""
    broken = rule(alertname_pattern="Kube(Pod")
    # 리터럴이 포함되면 매칭, 아니면 미매칭 — 어느 쪽이든 예외는 나지 않아야 한다.
    assert _rule_matches(broken, parsed(alertname="Kube(PodDown"), None) is True
    assert _rule_matches(broken, parsed(alertname="KubePodCrashLooping"), None) is False


def test_rule_matches_by_namespace_and_labels():
    assert _rule_matches(rule(namespace_pattern="team-"), parsed(), None) is True
    assert _rule_matches(rule(label_matchers={"team": "platform"}), parsed(), None) is True
    assert _rule_matches(rule(label_matchers={"team": "network"}), parsed(), None) is False


def test_rule_severity_minimum():
    assert _rule_matches(rule(severity_min="critical"), parsed(severity="warning"), None) is False
    assert _rule_matches(rule(severity_min="warning"), parsed(severity="critical"), None) is True


def test_default_settings_shape():
    """전역 기본값이 라우터/엔진이 기대하는 키를 모두 갖고 있어야 한다."""
    for key in ("default_notify_mode", "default_severity_min", "dedup_window_sec",
                "dedup_mode", "retention_days", "default_recipients"):
        assert key in DEFAULT_ALERT_SETTINGS
