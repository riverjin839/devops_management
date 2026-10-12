"""점검 매트릭스 상용화 재검토(2026-10) 회귀 테스트.

커버하는 계약:
  CR-1  본문/아이템 경유 엔드포인트도 테넌트 바인딩을 지킨다 — 행 실행은 실행 권한이 있는
        클러스터만, preview·새 플레이북 대상은 operate 검사, 수행 로그·항목 상세는 가려진
        클러스터를 보여주지 않는다.
  CR-2  source-config 응답은 필드명을 값 자리에 둔 리스트(``param_values``)도 준다 — 응답 키
        camelCase 변환에 깨지지 않는다. 저장 시 타입이 강제된다.
  CR-3  셀 실행은 큐잉 후 즉시 반환하고, 같은 셀이 이미 실행 중이면 새로 만들지 않는다.
  CR-4  그리드 셀에 최근 수행 상태(``last_run_state``)가 실려 실패·건너뜀이 보인다.
  CR-5  cron 을 새로 넣거나 바꾸면 기준점이 "지금" 이라 즉시 발화하지 않는다. 비활성 항목은
        cron 으로 돌지 않는다. 수동 입력 항목에는 cron 을 넣을 수 없다.
  CR-6  행 전용 정의는 행 삭제 시 함께 지워져 공유 행을 오염시키지 않는다.
  CR-7  입력 검증 — NaN 수동 값·빈 이름·너무 긴 단위는 422.
  CR-8  런북은 애드온 config 의 비밀값을 가린다.
"""
import json
import uuid
from datetime import datetime, timedelta

import pytest

from app.database import Base, SessionLocal, engine
from app.main import _ensure_pgvector_extension
from app.models import (
    Addon,
    CheckMatrixItem,
    CheckMatrixResult,
    CheckMatrixResultLog,
    CheckMatrixRun,
    CheckMatrixRunState,
    CheckMatrixSchedule,
    CheckMatrixSourceType,
    CheckMatrixTrigger,
    Cluster,
    DeepCheckDefinition,
)
from app.models.audit_log import AuditLog
from app.models.tenant import ClusterBinding, Tenant, TenantMember
from app.models.user import User
from app.services import check_matrix_service as svc


@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


@pytest.fixture
def world(db):
    """열린 클러스터 + 테넌트 바인딩 클러스터, 사용자 3명, 테스트 항목 3종."""
    tag = uuid.uuid4().hex[:8]
    c_open = Cluster(name=f"cr-open-{tag}", api_endpoint="https://127.0.0.1:65535")
    c_bound = Cluster(name=f"cr-bound-{tag}", api_endpoint="https://127.0.0.1:65534")
    users = {
        k: User(username=f"cr-{k}-{tag}", hashed_password="x", role=role)
        for k, role in (("admin", "admin"), ("member", "operator"), ("outsider", "operator"))
    }
    tenant = Tenant(name=f"cr-team-{tag}")
    deep = CheckMatrixItem(
        name=f"cr-deep-{tag}", source_type=CheckMatrixSourceType.deep_check,
        source_ref="pvc_health", sort_order=9000,
    )
    manual = CheckMatrixItem(
        name=f"cr-manual-{tag}", source_type=CheckMatrixSourceType.manual, sort_order=9010,
    )
    addon_item = CheckMatrixItem(
        name=f"cr-addon-{tag}", source_type=CheckMatrixSourceType.addon,
        source_ref="jenkins", sort_order=9020,
    )
    db.add_all([c_open, c_bound, tenant, deep, manual, addon_item, *users.values()])
    db.commit()
    db.add_all([
        TenantMember(tenant_id=tenant.id, user_id=users["member"].id),
        ClusterBinding(tenant_id=tenant.id, cluster_id=c_bound.id, access="operate"),
    ])
    db.commit()
    w = {"open": c_open, "bound": c_bound, "deep": deep, "manual": manual, "addon": addon_item, **users}
    item_ids = [deep.id, manual.id, addon_item.id]
    cids = [c_open.id, c_bound.id]
    uids = [u.id for u in users.values()]
    tenant_id = tenant.id
    yield w

    db.rollback()
    for model in (CheckMatrixRun, CheckMatrixResultLog, CheckMatrixResult, CheckMatrixSchedule):
        db.query(model).filter(
            (model.item_id.in_(item_ids)) | (model.cluster_id.in_(cids))
        ).delete(synchronize_session=False)
    db.query(Addon).filter(Addon.cluster_id.in_(cids)).delete(synchronize_session=False)
    def_ids = [
        r[0] for r in db.query(CheckMatrixItem.definition_id)
        .filter(CheckMatrixItem.id.in_(item_ids), CheckMatrixItem.definition_id.isnot(None))
    ]
    db.query(CheckMatrixItem).filter(CheckMatrixItem.id.in_(item_ids)).delete(synchronize_session=False)
    if def_ids:
        db.query(DeepCheckDefinition).filter(DeepCheckDefinition.id.in_(def_ids)).delete(
            synchronize_session=False)
    db.query(AuditLog).filter(AuditLog.actor_user_id.in_(uids)).delete(synchronize_session=False)
    db.query(ClusterBinding).filter(ClusterBinding.cluster_id.in_(cids)).delete(synchronize_session=False)
    db.query(TenantMember).filter(TenantMember.user_id.in_(uids)).delete(synchronize_session=False)
    db.query(Tenant).filter(Tenant.id == tenant_id).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id.in_(cids)).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(uids)).delete(synchronize_session=False)
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


@pytest.fixture
def fake_queue(monkeypatch):
    """Celery 큐잉을 가로채 큐잉된 run id 를 모은다(실행은 하지 않음)."""
    from app import celery_app

    queued: list[str] = []

    class _FakeTask:
        @staticmethod
        def apply_async(args=None, **_kw):
            queued.append(args[0])

    monkeypatch.setattr(celery_app, "run_check_matrix_run_one", _FakeTask)
    return queued


# ── CR-1 테넌트 격리 ───────────────────────────────────────────────────────────

def test_item_run_skips_clusters_without_operate(client_as, world, fake_queue, db):
    r = client_as(world["outsider"]).post(f"/api/v1/check-matrix/items/{world['deep'].id}/run")
    assert r.status_code == 200, r.text
    run_ids = r.json()["run_ids"]
    clusters = {
        str(row.cluster_id) for row in db.query(CheckMatrixRun).filter(CheckMatrixRun.id.in_(run_ids))
    }
    assert str(world["open"].id) in clusters
    assert str(world["bound"].id) not in clusters


def test_item_run_rejects_disabled_item(client_as, world, fake_queue, db):
    world["deep"].enabled = False
    db.commit()
    r = client_as(world["admin"]).post(f"/api/v1/check-matrix/items/{world['deep'].id}/run")
    assert r.status_code == 400


def test_preview_requires_operate_on_body_cluster(client_as, world):
    body = {"source_type": "deep_check", "source_ref": "pvc_health", "cluster_id": str(world["bound"].id)}
    r = client_as(world["outsider"]).post("/api/v1/check-matrix/items/preview", json=body)
    assert r.status_code == 403


def test_preview_apply_mode_is_admin_only(client_as, world):
    body = {
        "source_type": "playbook", "cluster_id": str(world["open"].id),
        "playbook_content": "- hosts: all\n  tasks: []\n", "check_mode": False,
    }
    r = client_as(world["member"]).post("/api/v1/check-matrix/items/preview", json=body)
    assert r.status_code == 403


def test_new_playbook_targets_require_operate(client_as, world):
    body = {
        "name": f"pb-{uuid.uuid4().hex[:6]}", "source_type": "playbook",
        "new_playbook": {
            "name": f"pb-{uuid.uuid4().hex[:6]}", "content": "- hosts: all\n  tasks: []\n",
            "cluster_ids": [str(world["bound"].id)],
        },
    }
    r = client_as(world["outsider"]).post("/api/v1/check-matrix/items", json=body)
    assert r.status_code == 403


def test_runs_hide_bound_cluster_from_outsider(client_as, world, db):
    run = svc.create_run(db, world["deep"], world["bound"], trigger=CheckMatrixTrigger.manual_cell)
    c = client_as(world["outsider"])
    listed = c.get(f"/api/v1/check-matrix/runs?item_id={world['deep'].id}").json()
    assert all(x["cluster_id"] != str(world["bound"].id) for x in listed["runs"])
    assert c.get(f"/api/v1/check-matrix/runs/{run.id}").status_code == 404
    assert client_as(world["member"]).get(f"/api/v1/check-matrix/runs/{run.id}").status_code == 200


def test_item_detail_hides_bound_cluster(client_as, world):
    r = client_as(world["outsider"]).get(f"/api/v1/check-matrix/items/{world['deep'].id}/detail")
    assert r.status_code == 200
    cids = {cell["cluster_id"] for cell in r.json()["cells"]}
    assert str(world["bound"].id) not in cids and str(world["open"].id) in cids


def test_invalid_trigger_filter_is_422(client_as, world):
    r = client_as(world["admin"]).get("/api/v1/check-matrix/runs?trigger=bogus")
    assert r.status_code == 422


# ── CR-2 source-config 리스트 형태 + 타입 강제 ────────────────────────────────

def test_source_config_list_shape(client_as, world):
    data = client_as(world["admin"]).get(
        f"/api/v1/check-matrix/items/{world['deep'].id}/source-config").json()
    assert isinstance(data["param_values"], list)
    assert all(set(v) == {"name", "value"} for v in data["param_values"])
    field_names = {f["name"] for f in data["param_fields"]}
    assert field_names <= {v["name"] for v in data["param_values"]}


def test_source_config_coerces_types(db, world):
    from app.services.registered_checks import REGISTRY

    spec = REGISTRY["pvc_health"][1]
    int_field = next((f for f in spec.threshold_fields + spec.param_fields if f.type == "int"), None)
    if int_field is None:
        pytest.skip("pvc_health 에 int 필드가 없음")
    group = "thresholds" if int_field in spec.threshold_fields else "params"
    with pytest.raises(ValueError):
        svc.update_item_source_config(db, world["deep"], dedicated=True, **{group: {int_field.name: "abc"}})
    db.rollback()
    out = svc.update_item_source_config(db, world["deep"], dedicated=True, **{group: {int_field.name: "7"}})
    d = db.query(DeepCheckDefinition).filter(DeepCheckDefinition.id == out["definition_id"]).one()
    assert getattr(d, group)[int_field.name] == 7


def test_shared_source_config_edit_is_admin_only(client_as, world):
    url = f"/api/v1/check-matrix/items/{world['deep'].id}/source-config"
    r = client_as(world["member"]).put(url, json={"dedicated": False, "params": {}})
    assert r.status_code == 403
    r = client_as(world["member"]).put(url, json={"dedicated": True, "params": {}})
    assert r.status_code == 200, r.text


# ── CR-3 셀 실행 큐잉 + 중복 방지 ─────────────────────────────────────────────

def test_cell_run_queues_and_dedupes(client_as, world, fake_queue):
    url = f"/api/v1/check-matrix/cell/{world['deep'].id}/{world['open'].id}/run"
    c = client_as(world["admin"])
    first = c.post(url).json()
    assert first["run_state"] == "queued" and first["deduplicated"] is False
    second = c.post(url).json()
    assert second["id"] == first["id"] and second["deduplicated"] is True
    assert fake_queue == [first["id"]]


def test_batch_skips_already_active_cells(db, world, fake_queue):
    svc.create_run(db, world["deep"], world["open"], trigger=CheckMatrixTrigger.cron)
    out = svc.start_batch(db, [(world["deep"], world["open"])], trigger=CheckMatrixTrigger.manual_item)
    assert out["total"] == 0 and out["skipped"] == 1


# ── CR-4 그리드에 최근 수행 상태 ──────────────────────────────────────────────

def test_grid_exposes_last_run_state(db, world):
    run = svc.create_run(db, world["deep"], world["open"], trigger=CheckMatrixTrigger.cron)
    svc._finish_run(run, CheckMatrixRunState.failed, error="kubeconfig 해석 실패")
    db.commit()
    grid = svc.build_grid(db)
    cell = grid["cells"][str(world["deep"].id)][str(world["open"].id)]
    assert cell["last_run_state"] == "failed"
    assert "kubeconfig" in cell["last_run_message"]
    assert grid["timezone"]


# ── CR-5 스케줄 ───────────────────────────────────────────────────────────────

def test_new_cron_does_not_fire_immediately(client_as, world, db, monkeypatch):
    from app import celery_app

    fired: list = []

    class _Fake:
        @staticmethod
        def apply_async(args=None, **_kw):
            fired.append(args)

    monkeypatch.setattr(celery_app, "run_check_matrix_cell_one", _Fake)
    monkeypatch.setattr(celery_app, "run_check_matrix_core_bundle_one", _Fake)
    monkeypatch.setattr(celery_app, "run_check_matrix_definition_one", _Fake)
    # 지금으로부터 몇 시간 뒤 시각으로 — 예전엔 기준점이 하루 전이라 즉시 발화했다.
    hour = (datetime.now().hour + 6) % 24
    r = client_as(world["admin"]).put(
        f"/api/v1/check-matrix/schedule/{world['deep'].id}/{world['open'].id}",
        json={"cron_expr": f"0 {hour} * * *", "enabled": True},
    )
    assert r.status_code == 200, r.text
    assert r.json()["last_run_at"] is not None
    svc.dispatch_due(db, jitter_seconds=0)
    assert [str(world["deep"].id), str(world["open"].id)] not in fired


def test_disabled_item_not_dispatched(db, world, monkeypatch):
    from app import celery_app

    fired: list = []

    class _Fake:
        @staticmethod
        def apply_async(args=None, **_kw):
            fired.append(args)

    monkeypatch.setattr(celery_app, "run_check_matrix_cell_one", _Fake)
    monkeypatch.setattr(celery_app, "run_check_matrix_core_bundle_one", _Fake)
    monkeypatch.setattr(celery_app, "run_check_matrix_definition_one", _Fake)
    world["deep"].enabled = False
    db.add(CheckMatrixSchedule(
        item_id=world["deep"].id, cluster_id=world["open"].id, cron_expr="*/5 * * * *",
        enabled=True, last_run_at=datetime.utcnow() - timedelta(hours=1),
    ))
    db.commit()
    svc.dispatch_due(db, jitter_seconds=0)
    assert [str(world["deep"].id), str(world["open"].id)] not in fired


def test_dispatch_claim_is_exclusive(db, world):
    sch = CheckMatrixSchedule(
        item_id=world["deep"].id, cluster_id=world["open"].id, cron_expr="*/5 * * * *",
        enabled=True, last_run_at=datetime.utcnow() - timedelta(hours=1),
    )
    db.add(sch)
    db.commit()
    old = sch.last_run_at
    now = datetime.utcnow()
    col, idc = CheckMatrixSchedule.last_run_at, CheckMatrixSchedule.id
    assert svc._claim(db, col, idc, sch.id, old, now) is True
    # 같은 old 값을 읽었던 두 번째 디스패처는 가져가지 못한다.
    assert svc._claim(db, col, idc, sch.id, old, now) is False


def test_manual_item_rejects_cron(client_as, world):
    r = client_as(world["admin"]).put(
        f"/api/v1/check-matrix/schedule/{world['manual'].id}/{world['open'].id}",
        json={"cron_expr": "0 9 * * *", "enabled": True},
    )
    assert r.status_code == 400


def test_stale_sweep_keeps_waiting_queued_run(db, world):
    run = svc.create_run(db, world["deep"], world["open"], trigger=CheckMatrixTrigger.manual_item)
    run.queued_at = datetime.utcnow() - timedelta(minutes=45)  # 예전 기준(30분)이면 오인 마감
    db.commit()
    svc._sweep_stale_runs(db)
    db.refresh(run)
    assert run.run_state == CheckMatrixRunState.queued


# ── CR-6 행 전용 정의 정리 ────────────────────────────────────────────────────

def test_delete_item_removes_dedicated_definition(client_as, world, db):
    d = svc.create_dedicated_definition(db, "pvc_health", name="cr-dedicated")
    world["deep"].definition_id = d.id
    db.commit()
    def_id = d.id
    r = client_as(world["admin"]).delete(f"/api/v1/check-matrix/items/{world['deep'].id}")
    assert r.status_code == 200
    db.expire_all()
    assert db.query(DeepCheckDefinition).filter(DeepCheckDefinition.id == def_id).first() is None


# ── CR-7 입력 검증 ────────────────────────────────────────────────────────────

def test_manual_entry_rejects_nan(client_as, world):
    r = client_as(world["admin"]).post(
        f"/api/v1/check-matrix/cell/{world['manual'].id}/{world['open'].id}/manual-entry",
        content='{"status": "healthy", "value": NaN}',
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 422


def test_item_validation(client_as, world):
    c = client_as(world["admin"])
    assert c.post("/api/v1/check-matrix/items", json={"name": "   ", "source_type": "manual"}).status_code == 422
    assert c.post("/api/v1/check-matrix/items", json={
        "name": "ok", "source_type": "manual", "unit": "x" * 21,
    }).status_code == 422


# ── CR-8 런북 비밀값 마스킹 ───────────────────────────────────────────────────

def test_runbook_masks_addon_secrets(db, world):
    from app.services.check_matrix_runbook import build_runbook, mask_secrets

    db.add(Addon(
        cluster_id=world["open"].id, name="jenkins", type="jenkins",
        config={"url": "http://jenkins", "api_token": "s3cr3t", "nested": {"password": "pw"}},
    ))
    db.commit()
    rb = build_runbook(db, world["addon"], world["open"])
    rendered = json.dumps(rb, ensure_ascii=False)
    assert "s3cr3t" not in rendered and "http://jenkins" in rendered
    assert mask_secrets({"nested": {"password": "pw"}}) == {"nested": {"password": "********"}}


# ── CR-9 실시간 진행 로그 ─────────────────────────────────────────────────────

def test_run_detail_has_progress_log_lines(db, world):
    run = svc.create_run(db, world["deep"], world["open"], trigger=CheckMatrixTrigger.manual_cell,
                         triggered_by="tester")
    queued = svc.get_run(db, run.id)
    assert any("대기열 등록" in line for line in queued["log_lines"])
    svc.execute_run(db, run.id)  # 정의가 없거나 연결 실패 — 어느 쪽이든 마감 줄이 붙는다
    done = svc.get_run(db, run.id)
    assert any("실행 시작" in line for line in done["log_lines"])
    assert len(done["log_lines"]) >= 3
    assert "_log" not in done["details"]


def test_masked_secret_roundtrip_keeps_original(db, world):
    from app.services.check_matrix_runbook import MASKED_VALUE

    addon = Addon(cluster_id=world["open"].id, name="jenkins", type="jenkins",
                  config={"url": "http://a", "api_token": "keep-me"})
    db.add(addon)
    db.commit()
    svc.update_source_config(db, world["addon"], world["open"], [
        {"group": "config", "name": "api_token", "value": MASKED_VALUE},
        {"group": "config", "name": "url", "value": "http://b"},
    ])
    db.refresh(addon)
    assert addon.config["api_token"] == "keep-me" and addon.config["url"] == "http://b"
