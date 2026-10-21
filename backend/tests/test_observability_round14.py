"""14차 감사 — 관측 지표(/observability) 서버 회귀 테스트 (D-181·D-183·D-186·D-191).

- D-181: 지표 현재값·규칙·스크레이프 대상·발화 중 알람·미리 조회가 클러스터 테넌트 read 권한을
  **캐시보다 먼저** 판정한다. ``cluster_id`` 생략(전역 Prometheus)은 admin 만, 그 외 422.
- D-183: Prometheus·Alertmanager 실패를 ``errors`` 로 드러내고(빈 목록과 구분), 발화 중 알람은
  한쪽 실패 시 partial/live+detail. push 스냅샷은 ``stale``·``snapshot_age_sec`` (AppSetting 기준).
- D-186: 모듈·지표 생성/수정/삭제 감사 기록(이름·식별자만), ``POST /metrics/preview`` fail-safe,
  사용 안 함 모듈·지표 목록 노출.
실제 DB 로 검증하고 Prometheus/Alertmanager 호출은 가짜로 바꾼다.
"""
import asyncio
import os
import uuid
from datetime import datetime, timedelta

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.database import Base, SessionLocal, engine
from app.main import _ensure_pgvector_extension
from app.models.app_setting import AppSetting
from app.models.audit_log import AuditLog
from app.models.cluster import Cluster
from app.models.observability import ObservabilityMetric, ObservabilityModule, ObservabilitySnapshot
from app.models.tenant import ClusterBinding, Tenant, TenantMember
from app.models.user import User
from app.routers import observability as obs
from app.services.alertmanager_service import AlertmanagerService
from app.services.observability.view_settings import OBSERVABILITY_SETTINGS_KEY, snapshot_freshness
from app.services.prometheus_service import PrometheusService

READ_PATHS = (
    "/api/v1/observability/metrics/values",
    "/api/v1/observability/prometheus/rules",
    "/api/v1/observability/prometheus/targets",
    "/api/v1/observability/prometheus/active-alerts",
)


# ── 가짜 Prometheus / Alertmanager ────────────────────────────────────────────

class FakeBackends:
    """테스트마다 응답을 바꿀 수 있는 가짜 외부 서비스."""

    def __init__(self):
        self.query = {"status": "ok", "value": 42.0, "labels": {"instance": "n1"},
                      "results": [{"labels": {"instance": "n1"}, "value": 42.0}], "error": None}
        self.rules = {"status": "ok", "data": {"groups": [{"name": "g", "rules": [
            {"name": "HighCPU", "type": "alerting", "state": "firing", "query": "up == 0"}]}]}}
        self.targets = {"status": "ok", "data": {"activeTargets": [
            {"labels": {"job": "node", "instance": "10.0.0.1:9100"}, "health": "up",
             "scrapeUrl": "http://10.0.0.1:9100/metrics"}]}}
        self.prom_alerts = {"status": "ok", "data": {"alerts": [
            {"labels": {"alertname": "PromAlert", "severity": "warning"}, "state": "firing"}]}}
        self.am_alerts = {"status": "ok", "data": [
            {"labels": {"alertname": "AmAlert", "severity": "critical"}, "status": {"state": "active"}}]}
        self.query_calls = 0


@pytest.fixture
def fake(monkeypatch):
    f = FakeBackends()

    async def _query(self, promql):  # noqa: ARG001
        f.query_calls += 1
        return f.query

    async def _rules(self, rule_type=None):  # noqa: ARG001
        return f.rules

    async def _targets(self, state=None):  # noqa: ARG001
        return f.targets

    async def _active(self):  # noqa: ARG001
        return f.prom_alerts

    async def _am(self, **_kw):  # noqa: ARG001
        if isinstance(f.am_alerts, Exception):
            raise f.am_alerts
        return f.am_alerts

    monkeypatch.setattr(PrometheusService, "query", _query)
    monkeypatch.setattr(PrometheusService, "rules", _rules)
    monkeypatch.setattr(PrometheusService, "targets", _targets)
    monkeypatch.setattr(PrometheusService, "active_alerts", _active)
    monkeypatch.setattr(AlertmanagerService, "alerts", _am)
    obs._values_cache.clear()
    yield f
    obs._values_cache.clear()


# ── DB 픽스처 ─────────────────────────────────────────────────────────────────

@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def world(db):
    """바인딩된 클러스터 + 바인딩 없는 클러스터 + push 클러스터, 테넌트 1개, 사용자 4명, 모듈·지표 1개."""
    tag = uuid.uuid4().hex[:8]
    module_key = f"mod-{tag}"
    bound = Cluster(name=f"obs-bound-{tag}", api_endpoint="https://bound:6443",
                    observability_enabled=True, observability_mode="pull",
                    prometheus_url="http://prom-bound:9090", alertmanager_url="http://am-bound:9093")
    open_ = Cluster(name=f"obs-open-{tag}", api_endpoint="https://open:6443",
                    observability_enabled=True, observability_mode="pull",
                    prometheus_url="http://prom-open:9090")
    push = Cluster(name=f"obs-push-{tag}", api_endpoint="https://push:6443",
                   observability_enabled=True, observability_mode="push")
    users = {
        key: User(username=f"obs-{key}-{tag}", hashed_password="x", role=role)
        for key, role in (("member", "operator"), ("outsider", "operator"),
                          ("viewer", "viewer"), ("admin", "admin"))
    }
    tenant = Tenant(name=f"obs-team-{tag}")
    module = ObservabilityModule(key=module_key, label=f"모듈 {tag}", status="planned")
    db.add_all([bound, open_, push, tenant, module, *users.values()])
    db.commit()
    metric = ObservabilityMetric(module_key=module_key, key="cpu", label="CPU 사용률",
                                 promql="secret_query_text", unit="%", thresholds="warning:70,critical:90")
    db.add_all([
        metric,
        TenantMember(tenant_id=tenant.id, user_id=users["member"].id),
        TenantMember(tenant_id=tenant.id, user_id=users["viewer"].id),
        ClusterBinding(tenant_id=tenant.id, cluster_id=bound.id, access="operate"),
    ])
    db.commit()
    prev_setting = db.query(AppSetting).filter(AppSetting.key == OBSERVABILITY_SETTINGS_KEY).first()
    prev_value = dict(prev_setting.value) if prev_setting else None
    yield {"bound": bound, "open": open_, "push": push, "tag": tag, "module": module,
           "module_key": module_key, "metric": metric, **users}
    db.rollback()
    uids = [u.id for u in users.values()]
    cids = [bound.id, open_.id, push.id]
    db.query(AuditLog).filter(AuditLog.actor_user_id.in_(uids)).delete(synchronize_session=False)
    db.query(ObservabilitySnapshot).filter(ObservabilitySnapshot.cluster_id.in_(cids)).delete(
        synchronize_session=False)
    db.query(ObservabilityMetric).filter(ObservabilityMetric.module_key.like(f"%{tag}%")).delete(
        synchronize_session=False)
    db.query(ObservabilityModule).filter(ObservabilityModule.key.like(f"%{tag}%")).delete(
        synchronize_session=False)
    db.query(ClusterBinding).filter(ClusterBinding.cluster_id.in_(cids)).delete(synchronize_session=False)
    db.query(TenantMember).filter(TenantMember.user_id.in_(uids)).delete(synchronize_session=False)
    db.query(Tenant).filter(Tenant.id == tenant.id).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id.in_(cids)).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(uids)).delete(synchronize_session=False)
    row = db.query(AppSetting).filter(AppSetting.key == OBSERVABILITY_SETTINGS_KEY).first()
    if prev_value is None:
        if row:
            db.delete(row)
    elif row:
        row.value = prev_value
    db.commit()


@pytest.fixture
def client_as():
    from fastapi.testclient import TestClient

    from app.auth.deps import get_current_user
    from app.main import app

    def _as(user):
        app.dependency_overrides[get_current_user] = lambda: user
        return TestClient(app)

    try:
        yield _as
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def _params(path: str, world, cluster) -> dict:
    p = {"cluster_id": str(cluster.id)}
    if path.endswith("/metrics/values"):
        p["module"] = world["module_key"]
    return p


# ── D-181 테넌트 판정 ─────────────────────────────────────────────────────────

def test_outsider_gets_403_on_every_read_even_after_cache_warm(world, client_as, fake):
    member = client_as(world["member"])
    for path in READ_PATHS:
        r = member.get(path, params=_params(path, world, world["bound"]))
        assert r.status_code == 200, (path, r.text)
    assert obs._values_cache, "멤버 조회로 지표 캐시가 예열돼야 한다"

    outsider = client_as(world["outsider"])
    for path in READ_PATHS:
        r = outsider.get(path, params=_params(path, world, world["bound"]))
        assert r.status_code == 403, (path, r.status_code, r.text)
        # 캐시에 있던 응답(지표 값·라벨)이 새지 않는다
        # (UUID 는 16진수라 "n1"·"query" 가 우연히 섞이지 않는다)
        assert "n1" not in r.text and "secret_query_text" not in r.text and "data" not in r.json()


def test_member_and_viewer_member_get_200(world, client_as, fake):
    for who in ("member", "viewer"):
        c = client_as(world[who])
        for path in READ_PATHS:
            r = c.get(path, params=_params(path, world, world["bound"]))
            assert r.status_code == 200, (who, path, r.text)
    body = client_as(world["member"]).get(
        READ_PATHS[0], params=_params(READ_PATHS[0], world, world["bound"])).json()
    assert body["data"][0]["value"] == 42.0
    assert body["errors"] == [] and body["stale"] is False and body["snapshot_age_sec"] is None


def test_unbound_cluster_open_to_outsider(world, client_as, fake):
    outsider = client_as(world["outsider"])
    for path in READ_PATHS:
        assert outsider.get(path, params=_params(path, world, world["open"])).status_code == 200


def test_missing_cluster_id_is_admin_only(world, client_as, fake):
    for who in ("outsider", "viewer"):
        c = client_as(world[who])
        for path in READ_PATHS:
            params = {"module": world["module_key"]} if path.endswith("/metrics/values") else {}
            r = c.get(path, params=params)
            assert r.status_code == 422, (who, path, r.text)
            assert "클러스터를 선택하세요" in r.json()["detail"]
    admin = client_as(world["admin"])
    for path in READ_PATHS:
        params = {"module": world["module_key"]} if path.endswith("/metrics/values") else {}
        assert admin.get(path, params=params).status_code == 200, path


def test_unknown_cluster_404(world, client_as, fake):
    r = client_as(world["member"]).get(READ_PATHS[1], params={"cluster_id": str(uuid.uuid4())})
    assert r.status_code == 404


# ── D-183 실패 출처 · 스냅샷 신선도 ───────────────────────────────────────────

def test_active_alerts_alertmanager_failure_is_reported(world, client_as, fake):
    fake.am_alerts = {"status": "offline", "data": None, "error": "Alertmanager is not reachable."}
    body = client_as(world["member"]).get(
        READ_PATHS[3], params={"cluster_id": str(world["bound"].id)}).json()
    assert body["source"] == "live"
    assert [a["alertname"] for a in body["alerts"]] == ["PromAlert"]
    assert [e["source"] for e in body["errors"]] == ["alertmanager"]
    assert "Alertmanager 조회 실패" in body["detail"]


def test_active_alerts_alertmanager_exception_is_failsafe(world, client_as, fake):
    fake.am_alerts = RuntimeError("boom")
    r = client_as(world["member"]).get(READ_PATHS[3], params={"cluster_id": str(world["bound"].id)})
    assert r.status_code == 200
    assert [e["source"] for e in r.json()["errors"]] == ["alertmanager"]


def test_active_alerts_prometheus_failure_is_partial(world, client_as, fake):
    fake.prom_alerts = {"status": "offline", "data": None, "error": "Prometheus is not reachable."}
    body = client_as(world["member"]).get(
        READ_PATHS[3], params={"cluster_id": str(world["bound"].id)}).json()
    assert body["source"] == "partial"
    assert [a["alertname"] for a in body["alerts"]] == ["AmAlert"]
    assert [e["source"] for e in body["errors"]] == ["prometheus"]


def test_active_alerts_both_fail_offline(world, client_as, fake):
    fake.prom_alerts = {"status": "offline", "error": "p down"}
    fake.am_alerts = {"status": "offline", "error": "a down"}
    body = client_as(world["member"]).get(
        READ_PATHS[3], params={"cluster_id": str(world["bound"].id)}).json()
    assert body["source"] == "offline" and body["alerts"] == []
    assert sorted(e["source"] for e in body["errors"]) == ["alertmanager", "prometheus"]


def test_rules_and_targets_failure_errors(world, client_as, fake):
    fake.rules = {"status": "offline", "error": "Prometheus is not reachable."}
    fake.targets = {"status": "error", "error": "HTTP 500"}
    c = client_as(world["member"])
    for path in (READ_PATHS[1], READ_PATHS[2]):
        body = c.get(path, params={"cluster_id": str(world["bound"].id)}).json()
        assert body["source"] == "offline"
        assert body["errors"] and body["errors"][0]["source"] == "prometheus"
        assert body["errors"][0]["message"].startswith("Prometheus 조회 실패")


def test_metric_values_all_failed_reports_prometheus_error(world, client_as, fake):
    fake.query = {"status": "offline", "error": "Prometheus is not reachable."}
    body = client_as(world["member"]).get(
        READ_PATHS[0], params=_params(READ_PATHS[0], world, world["bound"])).json()
    assert [e["source"] for e in body["errors"]] == ["prometheus"]


def test_push_snapshot_stale_flags(world, client_as, fake, db):
    push = world["push"]
    c = client_as(world["member"])
    # 스냅샷이 없으면 push 오류
    body = c.get(READ_PATHS[1], params={"cluster_id": str(push.id)}).json()
    assert body["source"] == "offline" and body["errors"][0]["source"] == "push"

    old = datetime.utcnow() - timedelta(minutes=30)
    for kind, payload in (("metrics", {"cpu": {"value": 10}}), ("rules", {"groups": []}),
                          ("targets", {"activeTargets": []}), ("alerts", {"alerts": []})):
        db.add(ObservabilitySnapshot(cluster_id=push.id, module_key=world["module_key"] if kind == "metrics"
                                     else "kube-prometheus-stack", kind=kind, payload=payload,
                                     collected_at=old))
    db.commit()
    for path in READ_PATHS:
        body = c.get(path, params=_params(path, world, push)).json()
        assert body["source"] == "snapshot", (path, body)
        assert body["stale"] is True
        assert 1700 <= body["snapshot_age_sec"] <= 1900

    # 기준을 60분으로 올리면 오래되지 않음 — 캐시된 지표 응답도 다시 판정
    assert client_as(world["admin"]).put(
        "/api/v1/observability/settings", json={"stale_minutes": 60}).status_code == 200
    for path in READ_PATHS:
        body = c.get(path, params=_params(path, world, push)).json()
        assert body["stale"] is False, path


def test_snapshot_freshness_helper():
    now = datetime(2026, 10, 21, 12, 0, 0)
    assert snapshot_freshness(now - timedelta(minutes=16), 15, now) == (True, 960)
    assert snapshot_freshness(now - timedelta(minutes=5), 15, now) == (False, 300)
    assert snapshot_freshness(None, 15, now) == (True, None)
    assert snapshot_freshness(now + timedelta(minutes=1), 15, now) == (False, 0)


def test_settings_read_any_user_write_admin_only(world, client_as):
    viewer = client_as(world["viewer"])
    r = viewer.get("/api/v1/observability/settings")
    assert r.status_code == 200 and "stale_minutes" in r.json()
    assert viewer.put("/api/v1/observability/settings", json={"stale_minutes": 20}).status_code == 403
    assert client_as(world["member"]).put(
        "/api/v1/observability/settings", json={"stale_minutes": 20}).status_code == 403
    admin = client_as(world["admin"])
    assert admin.put("/api/v1/observability/settings", json={"stale_minutes": 0}).status_code == 422
    assert admin.put("/api/v1/observability/settings", json={"stale_minutes": 1441}).status_code == 422
    r = admin.put("/api/v1/observability/settings", json={"stale_minutes": 30})
    assert r.status_code == 200 and r.json()["stale_minutes"] == 30
    assert viewer.get("/api/v1/observability/settings").json()["stale_minutes"] == 30


# ── D-186 감사 · 미리 조회 · 사용 안 함 목록 ──────────────────────────────────

def _audit_rows(db, actor, prefix):
    db.expire_all()
    return (db.query(AuditLog)
            .filter(AuditLog.actor_user_id == actor.id, AuditLog.action.like(f"{prefix}%"))
            .order_by(AuditLog.created_at.asc()).all())


def test_metric_crud_is_audited_without_query(world, client_as, db):
    c = client_as(world["member"])
    r = c.post("/api/v1/observability/metrics", json={
        "module_key": world["module_key"], "key": "mem", "label": "메모리", "promql": "secret_query_text"})
    assert r.status_code == 201, r.text
    mid = r.json()["id"]
    assert c.put(f"/api/v1/observability/metrics/{mid}", json={"enabled": False, "label": "메모리2"}).status_code == 200
    # 끈 지표도 다시 찾을 수 있다
    listed = c.get("/api/v1/observability/metrics", params={"module": world["module_key"]}).json()
    assert any(m["id"] == mid and m["enabled"] is False for m in listed)
    assert c.get(f"/api/v1/observability/metrics/{mid}").json()["enabled"] is False
    assert c.delete(f"/api/v1/observability/metrics/{mid}").status_code == 204

    rows = _audit_rows(db, world["member"], "observability.metric.")
    assert [r.action for r in rows] == [
        "observability.metric.create", "observability.metric.update", "observability.metric.delete"]
    for row in rows:
        assert row.target_id == mid
        assert set(row.details) <= {"id", "name", "key", "module_key", "fields", "request_id"}
        assert "secret_query_text" not in str(row.details)
    assert sorted(rows[1].details["fields"]) == ["enabled", "label"]


def test_module_crud_audited_and_disabled_listed(world, client_as, db):
    c = client_as(world["member"])
    key = f"new-{world['tag']}"
    r = c.post("/api/v1/observability/modules", json={"key": key, "label": "새 모듈"})
    assert r.status_code == 201, r.text
    mod_id = r.json()["id"]
    assert c.post("/api/v1/observability/modules", json={"key": key, "label": "중복"}).status_code == 409
    assert c.put(f"/api/v1/observability/modules/{mod_id}", json={"enabled": False}).status_code == 200

    default_keys = {m["key"] for m in c.get("/api/v1/observability/modules").json()}
    all_keys = {m["key"] for m in c.get(
        "/api/v1/observability/modules", params={"include_disabled": "true"}).json()}
    assert key not in default_keys and key in all_keys

    # 지표가 남은 모듈은 삭제 거부
    r = c.delete(f"/api/v1/observability/modules/{world['module'].id}")
    assert r.status_code == 409
    assert c.delete(f"/api/v1/observability/modules/{mod_id}").status_code == 204

    rows = _audit_rows(db, world["member"], "observability.module.")
    assert [r.action for r in rows] == [
        "observability.module.create", "observability.module.update", "observability.module.delete"]
    assert all(set(r.details) <= {"id", "name", "key", "fields", "request_id"} for r in rows)


def test_viewer_cannot_edit_catalog(world, client_as):
    c = client_as(world["viewer"])
    assert c.post("/api/v1/observability/metrics", json={
        "module_key": world["module_key"], "key": "x", "label": "x", "promql": "up"}).status_code == 403
    assert c.post("/api/v1/observability/modules", json={"key": "x", "label": "x"}).status_code == 403


class _FakeResp:
    def __init__(self, body, status_code=200):
        self._body = body
        self.status_code = status_code

    def json(self):
        return self._body


class _FakeClient:
    def __init__(self, behaviour):
        self.behaviour = behaviour
        self.calls = []

    async def get(self, url, params=None, timeout=None):
        self.calls.append((url, params, timeout))
        b = self.behaviour
        if isinstance(b, Exception):
            raise b
        if callable(b):
            return await b()
        return b


@pytest.fixture
def prom_client(monkeypatch):
    holder = {"client": _FakeClient(_FakeResp({"status": "success", "data": {"resultType": "vector", "result": []}}))}
    monkeypatch.setattr(PrometheusService, "_get_client", lambda self: holder["client"])
    return holder


def _preview(c, cluster, query="up"):
    return c.post("/api/v1/observability/metrics/preview",
                  json={"cluster_id": str(cluster.id), "query": query})


def test_preview_success_truncates_to_20(world, client_as, prom_client):
    result = [{"metric": {"instance": f"n{i}"}, "value": [0, str(i)]} for i in range(25)]
    prom_client["client"] = _FakeClient(_FakeResp(
        {"status": "success", "data": {"resultType": "vector", "result": result}}))
    r = _preview(client_as(world["member"]), world["bound"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["result_type"] == "vector" and body["error"] is None
    assert len(body["samples"]) == 20 and body["series_count"] == 25
    assert body["samples"][3] == {"labels": [{"k": "instance", "v": "n3"}], "value": 3.0}
    assert isinstance(body["duration_ms"], int)
    _, params, timeout = prom_client["client"].calls[0]
    assert params["query"] == "up" and timeout <= 10


def test_preview_bad_promql_and_exceptions_are_failsafe(world, client_as, prom_client, monkeypatch):
    c = client_as(world["member"])
    prom_client["client"] = _FakeClient(_FakeResp(
        {"status": "error", "errorType": "bad_data", "error": "parse error"}, 400))
    body = _preview(c, world["bound"], "sum(").json()
    assert body["ok"] is False and "parse error" in body["error"]

    prom_client["client"] = _FakeClient(RuntimeError("kaboom"))
    r = _preview(c, world["bound"])
    assert r.status_code == 200 and r.json()["ok"] is False and "kaboom" in r.json()["error"]

    prom_client["client"] = _FakeClient(_FakeResp("not-json-dict"))
    assert _preview(c, world["bound"]).json()["ok"] is False

    async def _slow():
        await asyncio.sleep(1)
        return _FakeResp({"status": "success", "data": {"resultType": "vector", "result": []}})

    monkeypatch.setattr(obs, "_PREVIEW_TIMEOUT_SEC", 0.05)
    prom_client["client"] = _FakeClient(_slow)
    body = _preview(c, world["bound"]).json()
    assert body["ok"] is False and "초 안에" in body["error"]


def test_preview_permissions_and_modes(world, client_as, prom_client):
    assert _preview(client_as(world["outsider"]), world["bound"]).status_code == 403
    assert _preview(client_as(world["viewer"]), world["bound"]).status_code == 403
    assert _preview(client_as(world["outsider"]), world["open"]).status_code == 200
    body = _preview(client_as(world["member"]), world["push"]).json()
    assert body["ok"] is False and "push" in body["error"]
    r = client_as(world["member"]).post("/api/v1/observability/metrics/preview",
                                        json={"cluster_id": str(world["bound"].id), "query": "x" * 2001})
    assert r.status_code == 422
    r = client_as(world["member"]).post("/api/v1/observability/metrics/preview",
                                        json={"cluster_id": str(world["bound"].id), "promql": "up"})
    assert r.status_code == 200 and r.json()["ok"] is True
