"""D-111 — K8s 이벤트 통계·목록 has_more, 알람 목록 has_more, 해소 수신 occurrences 회귀 테스트.

실제 DB 를 쓴다. 다른 테스트의 행과 섞이지 않게 전부 이 테스트가 만든 클러스터로 필터한다.
"""
import os
import uuid
from datetime import datetime, timedelta

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension  # noqa: E402
from app.models.alert_event import AlertEvent  # noqa: E402
from app.models.cluster import Cluster  # noqa: E402
from app.models.k8s_event import K8sEvent  # noqa: E402
from app.models.tenant import ClusterBinding, Tenant, TenantMember  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.observability.alert_ingest import ParsedAlert  # noqa: E402
from app.services.observability.alert_router import upsert_alert_event  # noqa: E402


@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def world(db):
    tag = uuid.uuid4().hex[:8]
    c_open = Cluster(name=f"pg-open-{tag}", api_endpoint="https://open:6443")
    c_bound = Cluster(name=f"pg-bound-{tag}", api_endpoint="https://bound:6443")
    viewer = User(username=f"pg-viewer-{tag}", hashed_password="x", role="viewer")
    tenant = Tenant(name=f"pg-team-{tag}")
    db.add_all([c_open, c_bound, viewer, tenant])
    db.commit()
    # viewer 는 테넌트 멤버가 아님 → c_bound 는 보이지 않는다
    db.add(ClusterBinding(tenant_id=tenant.id, cluster_id=c_bound.id, access="operate"))
    db.commit()

    now = datetime.utcnow()
    sevs = ["critical"] * 2 + ["warning"] * 3 + ["info"] * 4  # 9건
    for i, sev in enumerate(sevs):
        db.add(K8sEvent(cluster_id=c_open.id, event_type="ADDED", resource_kind="Pod" if i % 2 else "Node",
                        resource_name=f"r-{i}", severity=sev, received_at=now - timedelta(seconds=i)))
    db.add(K8sEvent(cluster_id=c_bound.id, event_type="ADDED", resource_kind="Pod",
                    resource_name="hidden", severity="critical"))
    for i in range(5):
        db.add(AlertEvent(cluster_id=c_open.id, fingerprint=f"fp-{tag}-{i}", alertname=f"A{i}",
                          severity="warning", status="firing", received_at=now - timedelta(seconds=i),
                          updated_at=now))
    db.commit()
    w = {"open": c_open, "bound": c_bound, "viewer": viewer, "tenant": tenant, "tag": tag}
    yield w
    cids = [c_open.id, c_bound.id]
    db.query(K8sEvent).filter(K8sEvent.cluster_id.in_(cids)).delete(synchronize_session=False)
    db.query(AlertEvent).filter(AlertEvent.fingerprint.like(f"%{tag}%")).delete(synchronize_session=False)
    db.query(ClusterBinding).filter(ClusterBinding.tenant_id == tenant.id).delete(synchronize_session=False)
    db.query(TenantMember).filter(TenantMember.tenant_id == tenant.id).delete(synchronize_session=False)
    db.query(Tenant).filter(Tenant.id == tenant.id).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id.in_(cids)).delete(synchronize_session=False)
    db.query(User).filter(User.id == viewer.id).delete(synchronize_session=False)
    db.commit()


@pytest.fixture
def client(world):
    from fastapi.testclient import TestClient

    from app.auth.deps import get_current_user
    from app.main import app

    app.dependency_overrides[get_current_user] = lambda: world["viewer"]
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_current_user, None)


# ── /events/stats ───────────────────────────────────────────────────────────

def test_event_stats_by_severity(client, world):
    r = client.get("/api/v1/events/stats", params={"cluster_id": str(world["open"].id)})
    assert r.status_code == 200, r.text  # `/{event_id}` 보다 먼저 매칭돼야 한다(422 아님)
    assert r.json() == {"total": 9, "by_severity": {"critical": 2, "warning": 3, "info": 4}}


def test_event_stats_ignores_list_filters(client, world):
    # 목록 필터(severity/resource_kind)는 통계에 영향 없다 — 쿼리로 와도 무시.
    r = client.get("/api/v1/events/stats",
                   params={"cluster_id": str(world["open"].id), "severity": "critical", "resource_kind": "Pod"})
    assert r.json()["total"] == 9


def test_event_stats_respects_tenant_scope(client, world):
    r = client.get("/api/v1/events/stats", params={"cluster_id": str(world["bound"].id)})
    assert r.status_code == 200
    assert r.json() == {"total": 0, "by_severity": {"critical": 0, "warning": 0, "info": 0}}


# ── 목록 has_more ───────────────────────────────────────────────────────────

def test_event_list_has_more(client, world):
    p = {"cluster_id": str(world["open"].id), "limit": 4}
    first = client.get("/api/v1/events/", params={**p, "offset": 0}).json()
    assert first["total"] == 9 and len(first["data"]) == 4 and first["has_more"] is True
    mid = client.get("/api/v1/events/", params={**p, "offset": 4}).json()
    assert mid["has_more"] is True
    last = client.get("/api/v1/events/", params={**p, "offset": 8}).json()
    assert len(last["data"]) == 1 and last["has_more"] is False
    filtered = client.get("/api/v1/events/", params={**p, "severity": "critical"}).json()
    assert filtered["total"] == 2 and filtered["has_more"] is False


def test_event_pages_do_not_overlap(client, world):
    # 같은 시각 행이 있어도 페이지 경계가 고정돼 겹치거나 빠지지 않는다
    p = {"cluster_id": str(world["open"].id), "limit": 4}
    ids: list[str] = []
    for off in (0, 4, 8):
        ids += [e["id"] for e in client.get("/api/v1/events/", params={**p, "offset": off}).json()["data"]]
    assert len(ids) == 9 and len(set(ids)) == 9


def test_event_list_rejects_negative_offset(client, world):
    r = client.get("/api/v1/events/", params={"offset": -1})
    assert r.status_code == 422


def test_alert_list_has_more(client, world):
    p = {"cluster_id": str(world["open"].id), "limit": 3}
    first = client.get("/api/v1/observability/alerts", params={**p, "offset": 0})
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["total"] == 5 and len(body["data"]) == 3 and body["has_more"] is True
    last = client.get("/api/v1/observability/alerts", params={**p, "offset": 3}).json()
    assert len(last["data"]) == 2 and last["has_more"] is False


# ── 키셋 커서 "더 보기" — 페이지 사이 행이 빠져도 누락 없음 ─────────────────

def _walk(client, url, params):
    ids, cursor, guard = [], None, 0
    while True:
        q = {**params, **({"cursor": cursor} if cursor else {})}
        body = client.get(url, params=q).json()
        ids += [r["id"] for r in body["data"]]
        cursor = body.get("next_cursor")
        assert (cursor is not None) == body["has_more"]
        guard += 1
        if not cursor or guard > 20:
            return ids


def test_event_cursor_pages_cover_all_rows(client, world):
    ids = _walk(client, "/api/v1/events/", {"cluster_id": str(world["open"].id), "limit": 4})
    assert len(ids) == 9 and len(set(ids)) == 9


def test_event_cursor_does_not_skip_when_rows_leave(client, world, db):
    p = {"cluster_id": str(world["open"].id), "limit": 4}
    first = client.get("/api/v1/events/", params=p).json()
    # 1페이지를 본 뒤 그 페이지의 행 2개가 사라진다(정리·삭제) — offset 4 였다면 2개를 건너뛴다
    gone = [first["data"][0]["id"], first["data"][1]["id"]]
    db.query(K8sEvent).filter(K8sEvent.id.in_([uuid.UUID(g) for g in gone])).delete(synchronize_session=False)
    db.commit()
    rest = _walk(client, "/api/v1/events/", {**p, "cursor": first["next_cursor"]}) if first["next_cursor"] else []
    seen = [e["id"] for e in first["data"]] + rest
    assert len(set(seen)) == 9  # 처음 9건이 모두 한 번씩 보인다(삭제된 2건은 1페이지에서 이미 봤다)
    offset_page = client.get("/api/v1/events/", params={**p, "offset": 4}).json()["data"]
    assert len({e["id"] for e in first["data"]} | {e["id"] for e in offset_page}) < 8  # offset 방식은 누락


def test_alert_cursor_does_not_skip_when_rows_resolve(client, world, db):
    p = {"cluster_id": str(world["open"].id), "status": "firing", "limit": 2}
    first = client.get("/api/v1/observability/alerts", params=p).json()
    assert first["total"] == 5 and first["next_cursor"]
    db.query(AlertEvent).filter(AlertEvent.id == uuid.UUID(first["data"][0]["id"])).update(
        {"status": "resolved"}, synchronize_session=False)
    db.commit()
    rest = _walk(client, "/api/v1/observability/alerts", {**p, "cursor": first["next_cursor"]})
    assert len(set([a["id"] for a in first["data"]] + rest)) == 5


def test_cursor_same_timestamp_boundary(client, world, db):
    # 같은 received_at 행이 페이지 경계에 걸려도 겹치거나 빠지지 않는다(id 보조키)
    ts = datetime.utcnow() + timedelta(hours=1)
    for i in range(5):
        db.add(K8sEvent(cluster_id=world["open"].id, event_type="ADDED", resource_kind="Pod",
                        resource_name=f"same-{i}", severity="info", received_at=ts))
    db.commit()
    ids = _walk(client, "/api/v1/events/", {"cluster_id": str(world["open"].id), "limit": 3})
    assert len(ids) == 14 and len(set(ids)) == 14


@pytest.mark.parametrize("bad", ["nope", "2026-10-18T00:00:00|not-a-uuid", "|"])
def test_invalid_cursor_is_422(client, world, bad):
    assert client.get("/api/v1/events/", params={"cursor": bad}).status_code == 422
    assert client.get("/api/v1/observability/alerts", params={"cursor": bad}).status_code == 422


# ── 해소 수신은 occurrences 를 올리지 않는다 ─────────────────────────────────

def test_resolved_receipt_does_not_increment_occurrences(db, world):
    fp = f"occ-{world['tag']}"
    starts = datetime.utcnow().replace(microsecond=0)

    def _alert(status):
        return ParsedAlert(alertname="Occ", fingerprint=fp, status=status, severity="warning",
                           starts_at=starts)

    row, created = upsert_alert_event(db, _alert("firing"), world["open"].id, "warning", "payload")
    db.commit()
    assert created and row.occurrences == 1

    row, created = upsert_alert_event(db, _alert("firing"), world["open"].id, "warning", "payload")
    db.commit()
    assert not created and row.occurrences == 2

    row, created = upsert_alert_event(db, _alert("resolved"), world["open"].id, "warning", "payload")
    db.commit()
    assert not created
    assert row.status == "resolved" and row.ends_at is not None
    assert row.occurrences == 2


def test_resolved_without_starts_at_closes_open_row_without_increment(db, world):
    fp = f"occ2-{world['tag']}"
    row, _ = upsert_alert_event(
        db, ParsedAlert(alertname="Occ2", fingerprint=fp, status="firing"), world["open"].id, "warning", "payload")
    db.commit()
    row, created = upsert_alert_event(
        db, ParsedAlert(alertname="Occ2", fingerprint=fp, status="resolved"), world["open"].id, "warning",
        "payload")
    db.commit()
    assert not created and row.status == "resolved" and row.occurrences == 1
