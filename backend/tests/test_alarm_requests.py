"""알람 등록 요청 — ``/alarm-requests`` 를 실제 Postgres 로 태운다.

요청 등록(요청자 고정·클러스터 이름 스냅샷) → 수정·취소 권한 → 관리자 처리 상태 전이 → 반영 완료 시
카탈로그 기본 임계치 갱신 → 알림 팬아웃까지.
"""
import os
import uuid

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from fastapi.testclient import TestClient  # noqa: E402

from app.auth.security import create_access_token, hash_password  # noqa: E402
from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations, app  # noqa: E402
from app.models.alarm_request import AlarmCatalogItem, AlarmRequest  # noqa: E402
from app.models.cluster import Cluster  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.user_notification import UserNotification  # noqa: E402
from app.services import alarm_requests as svc  # noqa: E402

PREFIX = "ar-test-"


@pytest.fixture(scope="module", autouse=True)
def _ensure_schema():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    _run_migrations()
    yield


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    s = SessionLocal()
    s.query(AlarmRequest).filter(AlarmRequest.metric_name.like(f"{PREFIX}%")).delete(synchronize_session=False)
    s.query(AlarmCatalogItem).filter(AlarmCatalogItem.metric_name.like(f"{PREFIX}%")).delete(synchronize_session=False)
    s.query(UserNotification).filter(UserNotification.type.in_(("alarm_request", "alarm_request_status"))).delete(
        synchronize_session=False)
    s.query(Cluster).filter(Cluster.name.like(f"{PREFIX}%")).delete(synchronize_session=False)
    s.query(User).filter(User.username.like(f"{PREFIX}%")).delete(synchronize_session=False)
    s.commit()
    s.close()


@pytest.fixture
def client():
    return TestClient(app)


def _user(db, role: str, name: str) -> User:
    u = User(username=f"{PREFIX}{role}-{uuid.uuid4().hex[:6]}", hashed_password=hash_password("x"),
             role=role, display_name=name, is_active=True)
    db.add(u)
    db.commit()
    return u


def _h(user: User) -> dict:
    return {"Authorization": f"Bearer {create_access_token(subject=user.username, role=user.role)}"}


def _cluster(db, name: str) -> Cluster:
    c = Cluster(name=f"{PREFIX}{name}", api_endpoint="https://127.0.0.1:6443")
    db.add(c)
    db.commit()
    return c


def _payload(clusters, metric=f"{PREFIX}Lag", **kw):
    body = {
        "service": "cnpg", "metric_name": metric, "meaning": "복제 지연",
        "thresholds": [{"severity": "warning", "base_expr": "lag > 30", "base_for": "5m",
                        "new_expr": "lag > 60", "new_for": "10m"}],
        "cluster_ids": [str(c.id) for c in clusters], "note": "오탐 축소",
    }
    body.update(kw)
    return body


def test_meta_and_seeded_catalog(client, db):
    viewer = _user(db, "viewer", "뷰어")
    svc.seed_catalog(db)
    meta = client.get("/api/v1/alarm-requests/meta", headers=_h(viewer)).json()
    assert {"k8s", "cilium", "aistor", "cnpg", "keycloak", "nexus", "jenkins", "argocd"} <= set(meta["services"])
    cat = client.get("/api/v1/alarm-requests/catalog?service=cnpg", headers=_h(viewer)).json()
    assert cat and all(i["service"] == "cnpg" for i in cat)
    assert "for" in cat[0]["thresholds"][0]


def test_create_fixes_requester_and_snapshots_clusters(client, db):
    viewer = _user(db, "viewer", "홍길동")
    admin = _user(db, "admin", "관리자")
    c1, c2 = _cluster(db, "prod-1"), _cluster(db, "prod-2")
    r = client.post("/api/v1/alarm-requests", json=_payload([c1, c2]), headers=_h(viewer))
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["requested_by"] == viewer.username and body["requester_name"] == "홍길동"
    assert body["status"] == "in_progress" and body["code"].startswith("AR-")
    assert [c["name"] for c in body["clusters"]] == [c1.name, c2.name]
    assert body["history"][0]["action"] == "created"
    # 관리자에게 알림
    assert db.query(UserNotification).filter(UserNotification.type == "alarm_request",
                                             UserNotification.recipient_user_id == admin.id).count() == 1


def test_create_validation(client, db):
    viewer = _user(db, "viewer", "v")
    c1 = _cluster(db, "a")
    no_new = _payload([c1], thresholds=[{"severity": "warning", "base_expr": "x > 1", "base_for": "5m",
                                         "new_expr": "", "new_for": ""}])
    assert client.post("/api/v1/alarm-requests", json=no_new, headers=_h(viewer)).status_code == 422
    bad_for = _payload([c1], thresholds=[{"severity": "warning", "new_expr": "x > 1", "new_for": "5분"}])
    assert client.post("/api/v1/alarm-requests", json=bad_for, headers=_h(viewer)).status_code == 422
    unknown = _payload([c1], cluster_ids=[str(uuid.uuid4())])
    assert client.post("/api/v1/alarm-requests", json=unknown, headers=_h(viewer)).status_code == 422
    dup = _payload([c1], thresholds=[{"severity": "warning", "new_expr": "x"}, {"severity": "warning", "new_expr": "y"}])
    assert client.post("/api/v1/alarm-requests", json=dup, headers=_h(viewer)).status_code == 422


def test_edit_and_cancel_only_owner_while_requested(client, db):
    owner = _user(db, "viewer", "요청자")
    other = _user(db, "viewer", "다른 사람")
    op = _user(db, "operator", "운영자")
    c1 = _cluster(db, "b")
    rid = client.post("/api/v1/alarm-requests", json=_payload([c1]), headers=_h(owner)).json()["id"]
    upd = _payload([c1], note="수정함")
    assert client.put(f"/api/v1/alarm-requests/{rid}", json=upd, headers=_h(other)).status_code == 403
    r = client.put(f"/api/v1/alarm-requests/{rid}", json=upd, headers=_h(owner))
    assert r.status_code == 200 and r.json()["note"] == "수정함"
    assert client.post(f"/api/v1/alarm-requests/{rid}/status", json={"status": "done"},
                       headers=_h(op)).status_code == 200
    assert client.put(f"/api/v1/alarm-requests/{rid}", json=upd, headers=_h(owner)).status_code == 409
    assert client.delete(f"/api/v1/alarm-requests/{rid}", headers=_h(owner)).status_code == 409


def test_admin_actions_require_operator(client, db):
    viewer = _user(db, "viewer", "v")
    c1 = _cluster(db, "c")
    rid = client.post("/api/v1/alarm-requests", json=_payload([c1]), headers=_h(viewer)).json()["id"]
    assert client.post(f"/api/v1/alarm-requests/{rid}/status", json={"status": "done"},
                       headers=_h(viewer)).status_code == 403
    # 예전 승인 흐름 상태 값은 받지 않는다
    op = _user(db, "operator", "o")
    assert client.post(f"/api/v1/alarm-requests/{rid}/status", json={"status": "approved"},
                       headers=_h(op)).status_code == 422


def test_reject_requires_comment_and_notifies_requester(client, db):
    viewer = _user(db, "viewer", "요청자")
    op = _user(db, "operator", "운영자")
    c1 = _cluster(db, "d")
    rid = client.post("/api/v1/alarm-requests", json=_payload([c1]), headers=_h(viewer)).json()["id"]
    url = f"/api/v1/alarm-requests/{rid}/status"
    assert client.post(url, json={"status": "rejected"}, headers=_h(op)).status_code == 422
    r = client.post(url, json={"status": "rejected", "comment": "네임스페이스 조건으로 다시"}, headers=_h(op))
    assert r.status_code == 200 and r.json()["status"] == "rejected"
    assert r.json()["review_comment"] == "네임스페이스 조건으로 다시"
    # 같은 상태로는 바꾸지 않고, 다른 상태로는 언제든 바꿀 수 있다
    assert client.post(url, json={"status": "rejected", "comment": "x"}, headers=_h(op)).status_code == 409
    r2 = client.post(url, json={"status": "in_progress"}, headers=_h(op))
    assert r2.status_code == 200 and r2.json()["status"] == "in_progress" and r2.json()["review_comment"] is None
    n = db.query(UserNotification).filter(UserNotification.type == "alarm_request_status",
                                          UserNotification.recipient_user_id == viewer.id).all()
    assert len(n) == 2 and sorted("반려" in x.title for x in n) == [False, True]


def test_apply_promotes_thresholds_to_catalog(client, db):
    viewer = _user(db, "viewer", "요청자")
    op = _user(db, "operator", "운영자")
    c1 = _cluster(db, "e")
    metric = f"{PREFIX}NewAlarm"
    rid = client.post("/api/v1/alarm-requests", json=_payload([c1], metric=metric), headers=_h(viewer)).json()["id"]
    url = f"/api/v1/alarm-requests/{rid}/status"
    r = client.post(url, json={"status": "done"}, headers=_h(op))
    assert r.status_code == 200 and r.json()["status"] == "done" and r.json()["applied_at"]
    db.expire_all()
    item = db.query(AlarmCatalogItem).filter(AlarmCatalogItem.metric_name == metric).one()
    assert item.thresholds == [{"severity": "warning", "expr": "lag > 60", "for": "10m"}]
    assert r.json()["catalog_item_id"] == item.id
    actions = [h["action"] for h in r.json()["history"]]
    assert actions == ["created", "done"]


def test_catalog_crud_operator_only(client, db):
    viewer = _user(db, "viewer", "v")
    op = _user(db, "operator", "o")
    body = {"service": "nexus", "metric_name": f"{PREFIX}Blob", "meaning": "m",
            "thresholds": [{"severity": "warning", "expr": "x > 1", "for": "5m"}]}
    assert client.post("/api/v1/alarm-requests/catalog", json=body, headers=_h(viewer)).status_code == 403
    r = client.post("/api/v1/alarm-requests/catalog", json=body, headers=_h(op))
    assert r.status_code == 201, r.text
    iid = r.json()["id"]
    assert client.post("/api/v1/alarm-requests/catalog", json=body, headers=_h(op)).status_code == 409
    body["enabled"] = False
    assert client.put(f"/api/v1/alarm-requests/catalog/{iid}", json=body, headers=_h(op)).json()["enabled"] is False
    listed = client.get("/api/v1/alarm-requests/catalog?service=nexus", headers=_h(viewer)).json()
    assert iid not in [i["id"] for i in listed]
    assert client.delete(f"/api/v1/alarm-requests/catalog/{iid}", headers=_h(op)).status_code == 204


def test_foreign_catalog_id_is_ignored_and_not_overwritten(client, db):
    """다른 서비스·항목의 catalog_item_id 를 보내도 그 항목의 임계치를 덮어쓰지 않는다."""
    viewer = _user(db, "viewer", "요청자")
    op = _user(db, "operator", "운영자")
    c1 = _cluster(db, "f")
    victim = AlarmCatalogItem(service="nexus", metric_name=f"{PREFIX}Victim", meaning="m", enabled=True,
                              thresholds=[{"severity": "warning", "expr": "orig > 1", "for": "5m"}])
    db.add(victim)
    db.commit()
    metric = f"{PREFIX}Other"
    body = _payload([c1], metric=metric, catalog_item_id=victim.id)
    r = client.post("/api/v1/alarm-requests", json=body, headers=_h(viewer))
    assert r.status_code == 201 and r.json()["catalog_item_id"] is None
    rid = r.json()["id"]
    url = f"/api/v1/alarm-requests/{rid}/status"
    assert client.post(url, json={"status": "done"}, headers=_h(op)).status_code == 200
    db.expire_all()
    assert db.get(AlarmCatalogItem, victim.id).thresholds == [{"severity": "warning", "expr": "orig > 1", "for": "5m"}]
    created = db.query(AlarmCatalogItem).filter(AlarmCatalogItem.metric_name == metric).one()
    assert created.service == "cnpg" and created.id != victim.id


# ── PrometheusRule 자동 적용 ───────────────────────────────────────────────────
import json  # noqa: E402

from app.models.app_setting import AppSetting  # noqa: E402
from app.services import alarm_rule_apply as rule_apply  # noqa: E402


class _ApiErr(Exception):
    def __init__(self, status, message="err"):
        super().__init__(message)
        self.status = status
        self.body = json.dumps({"message": message})


class FakeCustomApi:
    """클러스터 이름별 PrometheusRule 저장소. fail_clusters 에 있으면 create 가 403."""

    def __init__(self, store, fail_clusters=()):
        self.store = store
        self.fail = set(fail_clusters)
        self.calls = []
        self.cluster = None

    def bind(self, cluster):
        self.cluster = cluster.name
        return self

    def get_namespaced_custom_object(self, group, version, ns, plural, name, **_):
        self.calls.append(("GET", self.cluster, ns, name))
        obj = self.store.get((self.cluster, ns, name))
        if obj is None:
            raise _ApiErr(404, "not found")
        return obj

    def create_namespaced_custom_object(self, group, version, ns, plural, body, **_):
        self.calls.append(("POST", self.cluster, ns, body["metadata"]["name"]))
        if self.cluster in self.fail:
            raise _ApiErr(403, "forbidden: cannot create prometheusrules")
        self.store[(self.cluster, ns, body["metadata"]["name"])] = {**body, "metadata": {**body["metadata"], "resourceVersion": "1"}}

    def replace_namespaced_custom_object(self, group, version, ns, plural, name, body, **_):
        self.calls.append(("PUT", self.cluster, ns, name, body["metadata"].get("resourceVersion")))
        self.store[(self.cluster, ns, name)] = body


@pytest.fixture
def fake_k8s(monkeypatch):
    store: dict = {}
    api = FakeCustomApi(store)
    monkeypatch.setattr(rule_apply, "_custom_api", api.bind)
    s = SessionLocal()
    row = s.query(AppSetting).filter(AppSetting.key == rule_apply.SETTINGS_KEY).first()
    saved = dict(row.value) if row else None
    s.close()
    yield api
    s = SessionLocal()
    row = s.query(AppSetting).filter(AppSetting.key == rule_apply.SETTINGS_KEY).first()
    if saved is None:
        if row is not None:
            s.delete(row)
    else:
        row.value = saved
    s.commit()
    s.close()


def _approved(client, db, clusters, metric=f"{PREFIX}RuleLag"):
    """등록만 하면 바로 「진행」 — 승인 절차 없이 적용할 수 있다."""
    viewer = _user(db, "viewer", "요청자")
    op = _user(db, "operator", "운영자")
    rid = client.post("/api/v1/alarm-requests", json=_payload(clusters, metric=metric), headers=_h(viewer)).json()["id"]
    return rid, viewer, op


def _sse(resp):
    return [json.loads(line[6:]) for line in resp.text.splitlines() if line.startswith("data: ")]


def test_apply_settings_validation_and_operator_only(client, db, fake_k8s):
    viewer = _user(db, "viewer", "v")
    op = _user(db, "operator", "o")
    got = client.get("/api/v1/alarm-requests/apply-settings", headers=_h(viewer)).json()
    assert got["namespace"] == "monitoring" and got["rule_labels"] == [{"key": "release", "value": "kube-prometheus-stack"}]
    body = {**got, "namespace": "Bad_NS"}
    assert client.put("/api/v1/alarm-requests/apply-settings", json=body, headers=_h(viewer)).status_code == 403
    assert client.put("/api/v1/alarm-requests/apply-settings", json=body, headers=_h(op)).status_code == 422
    body = {**got, "namespace": "obs", "rule_labels": [{"key": "prometheus", "value": "k8s"}],
            "alert_labels": [{"key": "teamName", "value": "platform"}]}
    r = client.put("/api/v1/alarm-requests/apply-settings", json=body, headers=_h(op))
    assert r.status_code == 200 and r.json()["namespace"] == "obs"
    assert r.json()["alert_labels"] == [{"key": "teamName", "value": "platform"}]
    bad = {**body, "rule_labels": [{"key": "bad key!", "value": "x"}]}
    assert client.put("/api/v1/alarm-requests/apply-settings", json=bad, headers=_h(op)).status_code == 422


def test_preview_builds_prometheus_rule_without_touching_cluster(client, db, fake_k8s):
    c1, c2 = _cluster(db, "pv1"), _cluster(db, "pv2")
    rid, viewer, _ = _approved(client, db, [c1, c2])
    rule_apply.save_settings(db, {"cluster_overrides": [{"cluster_id": str(c2.id), "namespace": "obs2",
                                                          "rule_labels": {"prometheus": "k8s"}}]})
    items = client.get(f"/api/v1/alarm-requests/{rid}/rule-preview", headers=_h(viewer)).json()
    assert [i["namespace"] for i in items] == ["monitoring", "obs2"]
    import yaml
    m = yaml.safe_load(items[0]["yaml"])
    assert m["kind"] == "PrometheusRule" and m["metadata"]["labels"]["app.kubernetes.io/managed-by"] == "pep"
    assert m["metadata"]["labels"]["release"] == "kube-prometheus-stack"
    rule = m["spec"]["groups"][0]["rules"][0]
    assert rule == {"alert": f"{PREFIX}RuleLag", "expr": "lag > 60",
                    "labels": {"severity": "warning", "service": "cnpg"},
                    "annotations": {"summary": "복제 지연", "pep_request": rule["annotations"]["pep_request"]},
                    "for": "10m"}
    assert yaml.safe_load(items[1]["yaml"])["metadata"]["labels"]["prometheus"] == "k8s"
    assert fake_k8s.calls == []


def test_apply_stream_creates_rules_marks_applied_and_hides_commands(client, db, fake_k8s):
    admin = _user(db, "admin", "관리자")
    c1, c2 = _cluster(db, "ap1"), _cluster(db, "ap2")
    rid, viewer, op = _approved(client, db, [c1, c2])
    # 권한·상태 검증은 스트림을 열기 전에
    assert client.post(f"/api/v1/alarm-requests/{rid}/apply-rules/stream", headers=_h(viewer)).status_code == 403
    r = client.post(f"/api/v1/alarm-requests/{rid}/apply-rules/stream", headers=_h(op))
    assert r.status_code == 200
    events = _sse(r)
    assert events[-1]["type"] == "result" and events[-1]["result"]["ok"] is True
    assert events[-1]["result"]["status"] == "done"
    assert not [e for e in events if e.get("level") == "cmd"]          # operator 에게는 명령 줄이 안 간다
    assert [c[0] for c in fake_k8s.calls] == ["GET", "POST", "GET", "POST"]
    # 저장된 실행 기록: 관리자에게만 cmd 줄
    as_admin = client.get(f"/api/v1/alarm-requests/{rid}", headers=_h(admin)).json()
    as_viewer = client.get(f"/api/v1/alarm-requests/{rid}", headers=_h(viewer)).json()
    run = as_admin["apply_runs"][0]
    assert run["ok"] and [x["status"] for x in run["results"]] == ["created", "created"]
    assert any(line[1] == "cmd" and "POST /apis/monitoring.coreos.com/v1/namespaces/monitoring/prometheusrules" in line[2]
               for line in run["log"])
    assert not any(line[1] == "cmd" for line in as_viewer["apply_runs"][0]["log"])
    assert as_admin["status"] == "done"
    assert [h["action"] for h in as_admin["history"]][-2:] == ["rule_applied", "done"]
    # 완료 뒤에도 다시 적용할 수 있다(상태는 그대로) — 반려된 요청만 막는다
    again = _sse(client.post(f"/api/v1/alarm-requests/{rid}/apply-rules/stream", headers=_h(op)))[-1]["result"]
    assert again["ok"] is True and again["status"] == "done"
    assert client.post(f"/api/v1/alarm-requests/{rid}/status", json={"status": "rejected", "comment": "철회"},
                       headers=_h(op)).status_code == 200
    assert client.post(f"/api/v1/alarm-requests/{rid}/apply-rules/stream", headers=_h(op)).status_code == 409


def test_apply_updates_pep_rule_and_refuses_foreign_rule(client, db, fake_k8s):
    c1, c2 = _cluster(db, "up1"), _cluster(db, "up2")
    rid, _, op = _approved(client, db, [c1, c2])
    name = rule_apply.rule_name(rule_apply.get_settings(db), db.get(AlarmRequest, rid))
    fake_k8s.store[(c1.name, "monitoring", name)] = {
        "metadata": {"name": name, "resourceVersion": "7", "labels": {"app.kubernetes.io/managed-by": "pep"}}}
    fake_k8s.store[(c2.name, "monitoring", name)] = {
        "metadata": {"name": name, "resourceVersion": "3", "labels": {"app.kubernetes.io/managed-by": "helm"}}}
    events = _sse(client.post(f"/api/v1/alarm-requests/{rid}/apply-rules/stream", headers=_h(op)))
    res = events[-1]["result"]
    assert res["ok"] is False and res["status"] == "in_progress"
    assert [x["status"] for x in res["results"]] == ["updated", "failed"]
    assert ("PUT", c1.name, "monitoring", name, "7") in fake_k8s.calls
    assert not any(c[0] in ("PUT", "POST") and c[1] == c2.name for c in fake_k8s.calls)
    assert fake_k8s.store[(c2.name, "monitoring", name)]["metadata"]["labels"]["app.kubernetes.io/managed-by"] == "helm"
    failed = [e for e in events if e.get("type") == "step" and e.get("status") == "failed"]
    assert len(failed) == 1


def test_apply_partial_failure_keeps_in_progress_and_can_retry(client, db, fake_k8s):
    c1, c2 = _cluster(db, "pf1"), _cluster(db, "pf2")
    rid, _, op = _approved(client, db, [c1, c2])
    fake_k8s.fail = {c2.name}
    res = _sse(client.post(f"/api/v1/alarm-requests/{rid}/apply-rules/stream", headers=_h(op)))[-1]["result"]
    assert res["ok"] is False and "forbidden" in res["results"][1]["message"]
    fake_k8s.fail = set()
    res = _sse(client.post(f"/api/v1/alarm-requests/{rid}/apply-rules/stream", headers=_h(op)))[-1]["result"]
    assert res["ok"] is True and [x["status"] for x in res["results"]] == ["updated", "created"]
    db.expire_all()
    req = db.get(AlarmRequest, rid)
    assert req.status == "done" and len(req.apply_runs) == 2 and req.apply_runs[0]["ok"] is True


def test_admin_stream_shows_k8s_api_commands(client, db, fake_k8s):
    admin = _user(db, "admin", "관리자")
    c1 = _cluster(db, "adm1")
    rid, _, _ = _approved(client, db, [c1])
    events = _sse(client.post(f"/api/v1/alarm-requests/{rid}/apply-rules/stream", headers=_h(admin)))
    cmds = [e["message"] for e in events if e.get("level") == "cmd"]
    assert any(m.startswith("$ [k8s-api cluster ") and "GET /apis/monitoring.coreos.com/v1/namespaces/monitoring/prometheusrules/" in m
               for m in cmds)
    assert any("POST /apis/monitoring.coreos.com/v1" in m for m in cmds)
    # 명령 줄은 해당 단계(로그) 앞에 온다
    first_cmd = next(i for i, e in enumerate(events) if e.get("level") == "cmd")
    created = next(i for i, e in enumerate(events) if "생성 완료" in str(e.get("message", "")))
    assert first_cmd < created


def test_legacy_approval_statuses_are_migrated(db):
    """예전 승인 흐름 상태(requested/reviewing/approved/applied)는 부팅 마이그레이션이 진행/완료로 바꾼다."""
    from app.main import _run_migrations

    rows = []
    for st in ("requested", "reviewing", "approved", "applied", "rejected"):
        r = AlarmRequest(status=st, service="k8s", metric_name=f"{PREFIX}Legacy-{st}", meaning="m",
                         thresholds=[], clusters=[], requested_by="x", history=[])
        db.add(r)
        rows.append(r)
    db.commit()
    ids = [r.id for r in rows]
    _run_migrations()
    db.expire_all()
    got = [db.get(AlarmRequest, i).status for i in ids]
    assert got == ["in_progress", "in_progress", "in_progress", "done", "rejected"]
