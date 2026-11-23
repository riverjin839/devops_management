"""공통 서비스 — 평탄화·마스킹·diff(순수), 인스턴스 저장·자격증명 비공개, 수집 실행(변경 감지·실행 로그·실패 격리), API·SSE."""
import json
import os
import uuid
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test")

from app.services.common_services import catalog as K  # noqa: E402
from app.services.common_services import collectors as CO  # noqa: E402
from app.services.common_services import flatten as F  # noqa: E402
from app.services.common_services import service as S  # noqa: E402


# ── 순수 함수 ────────────────────────────────────────────────────────────────

def test_flatten_uses_names_for_object_lists_and_masks_secrets():
    data = {"realm": "corp", "clients": [{"clientId": "b", "enabled": True}, {"clientId": "a", "enabled": False}],
            "smtpServer": {"password": "p@ss", "host": "mail"}, "redirectUris": ["https://x/*", "https://y/*"]}
    flat = F.flatten(data)
    assert flat["clients[a].enabled"] == "false" and flat["clients[b].enabled"] == "true"
    assert flat["smtpServer.host"] == "mail"
    assert flat["smtpServer.password"].startswith("(숨김 · ") and "p@ss" not in flat["smtpServer.password"]
    assert flat["redirectUris"] == json.dumps(["https://x/*", "https://y/*"])
    # 순서만 바뀐 이름 있는 목록은 같은 결과
    data2 = {**data, "clients": list(reversed(data["clients"]))}
    assert F.content_hash(F.flatten(data2)) == F.content_hash(flat)
    # 비밀 값이 바뀌면 해시가 바뀌어 변경으로 잡힌다
    data3 = {**data, "smtpServer": {"password": "other", "host": "mail"}}
    assert F.diff_flat(flat, F.flatten(data3)) == [
        {"key": "smtpServer.password", "old": flat["smtpServer.password"], "new": F.flatten(data3)["smtpServer.password"]}]


def test_mask_env_and_properties():
    env = F.mask_env({"KC_DB_PASSWORD": "x", "KC_HOSTNAME": "kc", "API_TOKEN": ""})
    assert env["KC_HOSTNAME"] == "kc" and env["KC_DB_PASSWORD"].startswith("(숨김") and env["API_TOKEN"] == ""
    props = F.parse_properties("# c\napplication-port=8081\n\nnexus-context-path : /\n!x\n")
    assert props == {"application-port": "8081", "nexus-context-path": "/"}


def test_diff_flat_added_removed():
    assert F.diff_flat({"a": "1", "b": "2"}, {"b": "3", "c": "4"}) == [
        {"key": "a", "old": "1", "new": None}, {"key": "b", "old": "2", "new": "3"}, {"key": "c", "old": None, "new": "4"}]


def test_catalog_fields_have_label_and_help_and_normalize():
    assert set(K.SERVICE_KEYS) == {"ldap_ad", "keycloak", "jenkins", "argocd", "nexus"}
    for s in K.SERVICES:
        assert s["default_host_kind"] in s["host_kinds"]
        for f in s["param_fields"]:
            assert f["label"] and f["help"], (s["key"], f["key"])
        for c in s["credentials"]:
            assert c["purpose"] in K.CRED_PURPOSES and c["help"]
    p = K.normalize_params("keycloak", {"realms": "a, b,,", "unknown": 1})
    assert p == {"realms": ["a", "b"], "auth_realm": "master", "client_id": "admin-cli"}


def test_podman_cmd_rejects_injection():
    inst = SimpleNamespace(name="n")
    with pytest.raises(CO.CollectError):
        CO.podman_cmd(CO.Ctx(inst=inst, params={"podman_cmd": "podman; rm -rf /"}, creds={}))
    assert CO.podman_cmd(CO.Ctx(inst=inst, params={"podman_cmd": "sudo podman"}, creds={})) == "sudo podman"


def test_settings_normalize():
    s = S.normalize_settings({"interval_min": 1, "change_severity": "bogus", "unreachable_after": "x"})
    assert s["interval_min"] == 5 and s["change_severity"] == "warning" and s["unreachable_after"] == 3


# ── DB ───────────────────────────────────────────────────────────────────────

_TABLES = ("common_service_instances", "common_service_credentials", "common_service_links", "common_service_snapshots",
           "alert_notify_rules", "users", "user_notifications",
           "common_service_changes", "common_service_runs", "app_settings", "alert_events", "audit_logs")


@pytest.fixture
def db():
    """이 테스트가 쓰는 테이블(+FK 의존)만 만든다 — pgvector 가 없는 로컬 DB 에서도 돈다."""
    import app.models  # noqa: F401 — 모델 등록
    from app.database import Base, SessionLocal, engine

    need, stack = set(), [Base.metadata.tables[t] for t in _TABLES if t in Base.metadata.tables]
    while stack:
        t = stack.pop()
        if t.name in need:
            continue
        need.add(t.name)
        stack.extend(fk.column.table for fk in t.foreign_keys)
    Base.metadata.create_all(bind=engine, tables=[Base.metadata.tables[n] for n in need])
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def instance(db):
    from app.models.common_service import CommonServiceInstance

    inst = S.save_instance(db, {
        "service_type": "jenkins", "name": f"jk-{uuid.uuid4().hex[:8]}", "host_kind": "external",
        "endpoint_url": "https://jenkins.example", "params": {"plugins": False},
        "credentials": [{"purpose": "app_api", "auth_type": "token", "username": "ro", "secret": "tok-123"}],
    }, "tester")
    yield inst
    db.rollback()
    db.query(CommonServiceInstance).filter(CommonServiceInstance.id == inst.id).delete(synchronize_session=False)
    db.commit()


def test_save_instance_validates_and_hides_secret(db, instance):
    out = S.serialize(db, instance)
    assert out["credentials"] == [{"purpose": "app_api", "auth_type": "token", "username": "ro", "has_secret": True}]
    assert "tok-123" not in json.dumps(out)
    assert out["params"] == [{"key": "casc_configmap", "value": ""}, {"key": "plugins", "value": False}]
    # 빈 secret 으로 저장하면 기존 값 유지
    S.save_instance(db, {**out, "credentials": [{"purpose": "app_api", "username": "ro2"}], "links": []}, "t", instance.id)
    assert S._creds(db, instance)["app_api"] == {"username": "ro2", "secret": "tok-123", "auth_type": "password"}
    with pytest.raises(S.CommonServiceError) as e:
        S.save_instance(db, {"service_type": "argocd", "name": "x", "host_kind": "external"}, "t")
    assert e.value.status == 422
    with pytest.raises(S.CommonServiceError) as e:
        S.save_instance(db, {"service_type": "jenkins", "name": instance.name, "host_kind": "external",
                             "endpoint_url": "https://j"}, "t")
    assert e.value.status == 409


def test_secret_encrypted_at_rest_and_masked_in_backup(db, instance):
    from sqlalchemy import text

    from app.services.backup_service import SENSITIVE_COLUMNS

    raw = db.execute(text("select secret from common_service_credentials where instance_id = :i"),
                     {"i": str(instance.id)}).scalar()
    assert raw and "tok-123" not in raw
    assert "secret" in SENSITIVE_COLUMNS["common_service_credentials"]


def test_run_collect_detects_changes_and_logs(db, instance, monkeypatch):
    from app.models.common_service import CommonServiceChange

    state = {"mode": "NORMAL", "fail": False}

    def fake_app(ctx):
        assert ctx.creds["app_api"]["secret"] == "tok-123"
        ctx.log("info", "fake GET /api/json")
        if state["fail"]:
            raise CO.CollectError("인증 실패(401)")
        ctx.add("app:system", {"mode": state["mode"], "numExecutors": 2})

    monkeypatch.setitem(CO.APP_COLLECTORS, "jenkins", fake_app)
    events = []
    run = S.start_run(db, instance, "collect", "manual", "tester")
    out = S.run_collect(db, instance, run, events.append)
    assert out["status"] == "succeeded" and out["changed"] == 0 and out["keys"] == 2
    assert any(e["type"] == "step" and e["status"] == "done" for e in events)
    assert any(e["type"] == "log" and "fake GET" in e["message"] for e in events)
    db.refresh(run)
    assert run.status == "succeeded" and any("fake GET" in line[2] for line in run.log_lines)

    # 같은 값이면 새 스냅샷·변경 없음
    out = S.run_collect(db, instance, S.start_run(db, instance, "collect", "manual", "t"))
    assert out["changed"] == 0

    state["mode"] = "EXCLUSIVE"
    out = S.run_collect(db, instance, S.start_run(db, instance, "collect", "schedule", None))
    assert out["changed"] == 1 and out["changes"][0] == {"component": "app:system", "key": "mode",
                                                          "old": "NORMAL", "new": "EXCLUSIVE"}
    ch = db.query(CommonServiceChange).filter(CommonServiceChange.instance_id == instance.id).all()
    assert [(c.key, c.old_value, c.new_value, c.source) for c in ch] == [("mode", "NORMAL", "EXCLUSIVE", "schedule")]
    from app.models.alert_event import AlertEvent

    alert = (db.query(AlertEvent).filter(AlertEvent.source == S.ALERT_SOURCE, AlertEvent.alertname == S.ALERT_CHANGED,
                                         AlertEvent.resource == instance.name).first())
    assert alert is not None and "mode NORMAL→EXCLUSIVE" in alert.summary
    cfg = S.latest_config(db, instance)
    item = next(i for i in cfg["components"][0]["items"] if i["key"] == "mode")
    assert item["value"] == "EXCLUSIVE" and item["changed"]["old"] == "NORMAL"

    # 접속 테스트는 저장하지 않는다
    state["mode"] = "NORMAL"
    out = S.run_collect(db, instance, S.start_run(db, instance, "test", "manual", "t"))
    assert out["changed"] == 0
    assert db.query(CommonServiceChange).filter(CommonServiceChange.instance_id == instance.id).count() == 1

    # 실패는 단계 실패로 기록(fail-safe), 인스턴스 상태 error + 연속 실패 수
    state["fail"] = True
    out = S.run_collect(db, instance, S.start_run(db, instance, "collect", "schedule", None))
    assert out["status"] == "failed" and "인증 실패" in out["errors"][0]
    db.refresh(instance)
    assert instance.status == "error" and instance.fail_count == 1


def test_running_run_blocks_second_start(db, instance):
    S.start_run(db, instance, "collect", "manual", "t")
    with pytest.raises(S.CommonServiceError) as e:
        S.start_run(db, instance, "collect", "manual", "t")
    assert e.value.status == 409


def test_due_instances_respects_interval(db, instance):
    now = datetime.utcnow()
    instance.last_collected_at = now - timedelta(minutes=5)
    db.commit()
    assert instance.id not in {i.id for i in S.due_instances(db, now)}
    instance.last_collected_at = now - timedelta(hours=2)
    db.commit()
    assert instance.id in {i.id for i in S.due_instances(db, now)}


def test_api_viewer_reads_operator_runs_stream(db, instance, monkeypatch):
    from fastapi.testclient import TestClient

    from app.auth.deps import get_current_user
    from app.main import app

    monkeypatch.setitem(CO.APP_COLLECTORS, "jenkins", lambda ctx: ctx.add("app:system", {"mode": "NORMAL"}))
    viewer = SimpleNamespace(id=uuid.uuid4(), username="v", role="viewer", is_active=True, tenant_ids=[])
    admin = SimpleNamespace(id=uuid.uuid4(), username="a", role="admin", is_active=True, tenant_ids=[])
    try:
        app.dependency_overrides[get_current_user] = lambda: viewer
        client = TestClient(app)
        r = client.get("/api/v1/common-services/catalog")
        assert r.status_code == 200 and [s["key"] for s in r.json()["services"]][0] == "ldap_ad"
        r = client.get(f"/api/v1/common-services/instances/{instance.id}")
        assert r.status_code == 200 and "tok-123" not in r.text
        assert client.post(f"/api/v1/common-services/instances/{instance.id}/run/stream").status_code == 403

        app.dependency_overrides[get_current_user] = lambda: admin
        r = client.post(f"/api/v1/common-services/instances/{instance.id}/run/stream?kind=collect")
        assert r.status_code == 200
        evts = [json.loads(line[6:]) for line in r.text.splitlines() if line.startswith("data: ")]
        assert evts[0]["type"] == "run" and evts[-1]["type"] == "result"
        assert evts[-1]["result"]["status"] == "succeeded"
        runs = client.get(f"/api/v1/common-services/instances/{instance.id}/runs").json()["items"]
        detail = client.get(f"/api/v1/common-services/instances/{instance.id}/runs/{runs[0]['id']}").json()
        assert detail["log_lines"] and detail["status"] == "succeeded"
        assert client.get(f"/api/v1/common-services/instances/{instance.id}/config").json()["components"]
    finally:
        app.dependency_overrides.pop(get_current_user, None)
