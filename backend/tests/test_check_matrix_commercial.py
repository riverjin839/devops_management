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
  CR-10 kubeconfig·연결 실패는 판정이 아니라 실행 실패 — 셀은 이전 값을 유지한다. 체커 단계
        로그는 끝난 뒤가 아니라 실행 중에 진행 로그로 쌓인다.
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


# ── P2 후속 ───────────────────────────────────────────────────────────────────

def test_manual_item_opt_in_affects_cluster_status(db, world):
    from app.models import StatusEnum
    from app.services import cluster_status_service

    world["manual"].affects_cluster_status = True
    db.commit()
    svc.record_manual_entry(db, world["manual"].id, world["open"].id, StatusEnum.critical, None, "NAS full")
    out = cluster_status_service.recompute(db, world["open"].id)
    assert out["status"] == "critical"
    assert any(c["source_type"] == "check_matrix" and c["edit_id"] == str(world["manual"].id) for c in out["contributors"])
    # 끄면 반영되지 않는다
    world["manual"].affects_cluster_status = False
    db.commit()
    out = cluster_status_service.recompute(db, world["open"].id)
    assert not any(c["source_type"] == "check_matrix" for c in out["contributors"])


def test_opt_in_rejected_for_deep_check(client_as, world):
    r = client_as(world["admin"]).put(f"/api/v1/check-matrix/items/{world['deep'].id}", json={
        "name": world["deep"].name, "source_type": "deep_check", "source_ref": "pvc_health",
        "affects_cluster_status": True,
    })
    assert r.status_code == 400


def test_deep_check_status_uses_each_lineage(db, world):
    """같은 종류 커스텀 카드 둘 — A 위험·B 정상이어도 클러스터는 위험(예전엔 최신 1건만 봤다)."""
    from app.models import DeepCheckResult, StatusEnum
    from app.services import cluster_status_service

    a = svc.create_dedicated_definition(db, "pvc_health", name="cr-a")
    b = svc.create_dedicated_definition(db, "pvc_health", name="cr-b")
    a.affects_cluster_status = b.affects_cluster_status = True
    world["deep"].definition_id = a.id
    other = CheckMatrixItem(name="cr-deep-b", source_type=CheckMatrixSourceType.deep_check,
                            source_ref="pvc_health", definition_id=b.id, sort_order=9030)
    db.add(other)
    db.commit()
    now = datetime.utcnow()
    db.add_all([
        DeepCheckResult(cluster_id=world["open"].id, definition_id=a.id, check_type="pvc_health",
                        status=StatusEnum.critical, checked_at=now - timedelta(minutes=1)),
        DeepCheckResult(cluster_id=world["open"].id, definition_id=b.id, check_type="pvc_health",
                        status=StatusEnum.healthy, checked_at=now),
    ])
    db.commit()
    try:
        out = cluster_status_service.recompute(db, world["open"].id)
        assert out["status"] == "critical"
    finally:
        db.query(DeepCheckResult).filter(DeepCheckResult.definition_id.in_([a.id, b.id])).delete(synchronize_session=False)
        db.delete(other)
        world["deep"].definition_id = None
        db.commit()
        db.query(DeepCheckDefinition).filter(DeepCheckDefinition.id.in_([a.id, b.id])).delete(synchronize_session=False)
        db.commit()


def test_purge_reports_remaining_when_budget_exhausted(db):
    out = svc.purge_expired_logs(db, time_budget_seconds=0)
    assert out["remaining"] is True


def test_playbook_timeout_extends_task_limit(db, world):
    from app.models import Playbook

    pb = Playbook(cluster_id=world["open"].id, name=f"cr-pb-{uuid.uuid4().hex[:6]}",
                  playbook_path="/tmp/x.yml", timeout_seconds=900)
    db.add(pb)
    item = CheckMatrixItem(name="cr-pb-item", source_type=CheckMatrixSourceType.playbook,
                           source_ref=pb.name, sort_order=9040)
    db.add(item)
    db.commit()
    try:
        assert svc._task_time_limit(db, item) == 960
        assert svc._task_time_limit(db, world["deep"]) is None
    finally:
        db.delete(item)
        db.delete(pb)
        db.commit()


# ── CR-10 수집 실패 분리 · 단계 로그 실시간 ─────────────────────────────────────

def _fake_checker(raise_exc=None):
    from app.models import StatusEnum
    from app.services.registered_checks.base import DeepCheckerBase, DeepCheckOutcome

    class _Fake(DeepCheckerBase):
        check_type = "pvc_health"
        display_name = "가짜 PVC"

        def run(self, ctx):
            with self._step("probe", "PVC 조회"):
                if raise_exc is not None:
                    raise raise_exc
            return DeepCheckOutcome(status=StatusEnum.warning, message="pending PVC 1", details={})

    return _Fake


@pytest.fixture
def deep_def(db, world, monkeypatch):
    """world["deep"] 에 전용 정의를 걸고, 이전 정상 결과(값 7)를 셀에 넣어 둔다."""
    from app.models import DeepCheckResult, StatusEnum

    d = svc.create_dedicated_definition(db, "pvc_health", name="cr-collect")
    world["deep"].definition_id = d.id
    db.commit()
    svc._upsert_result(db, world["deep"].id, world["open"].id, StatusEnum.healthy, 7.0, "이전 정상", None)
    db.commit()
    yield d
    db.rollback()
    db.query(DeepCheckResult).filter(DeepCheckResult.definition_id == d.id).delete(synchronize_session=False)
    db.commit()


def _use_fake(monkeypatch, cls):
    from app.services.registered_checks.registry import REGISTRY

    monkeypatch.setitem(REGISTRY, "pvc_health", (cls, REGISTRY["pvc_health"][1]))


def _cell(db, world):
    db.expire_all()
    return db.query(CheckMatrixResult).filter(
        CheckMatrixResult.item_id == world["deep"].id, CheckMatrixResult.cluster_id == world["open"].id,
    ).one()


@pytest.mark.parametrize("exc,kind,hint", [
    (None, "kubeconfig", "/cluster-manage"),
    (ConnectionError("Max retries exceeded: connection refused"), "connection", "엔드포인트"),
])
def test_collection_error_fails_run_and_keeps_previous_value(db, world, deep_def, monkeypatch, exc, kind, hint):
    from app.models import StatusEnum
    from app.services.k8s_client_pool import K8sClientError

    _use_fake(monkeypatch, _fake_checker(exc or K8sClientError("kubeconfig 로드 실패: No configuration found")))
    run = svc.create_run(db, world["deep"], world["open"], trigger=CheckMatrixTrigger.manual_cell,
                         triggered_by="tester")
    svc.execute_run(db, run.id)
    out = svc.get_run(db, run.id)
    assert out["run_state"] == "failed"
    assert hint in (out["error"] or "")
    assert any("수집 실패" in line for line in out["log_lines"])
    cell = _cell(db, world)
    assert cell.status == StatusEnum.healthy and cell.value == 7.0  # 이전 값 그대로


def test_step_logs_stream_before_finish(db, world, deep_def, monkeypatch):
    _use_fake(monkeypatch, _fake_checker())
    run = svc.create_run(db, world["deep"], world["open"], trigger=CheckMatrixTrigger.manual_cell,
                         triggered_by="tester")
    svc.execute_run(db, run.id)
    lines = svc.get_run(db, run.id)["log_lines"]
    start = next(i for i, ln in enumerate(lines) if "단계 시작 — PVC 조회" in ln)
    done = next(i for i, ln in enumerate(lines) if "단계 PVC 조회: success" in ln)
    assert start < done < len(lines) - 1  # 마감 줄보다 앞
    assert sum("단계 PVC 조회: success" in ln for ln in lines) == 1  # 끝난 뒤 재기록 없음
    assert _cell(db, world).message == "pending PVC 1"  # 정상 실행은 셀을 갱신한다


def test_returned_kubectl_tls_failure_is_collection_error(db, world, deep_def, monkeypatch):
    """예외 없이 critical 을 돌려주는 체커라도 kubectl 이 하나도 성공 못 하고 x509 로 끝났으면 수집 실패."""
    import time

    from app.models import StatusEnum
    from app.services.registered_checks.base import DeepCheckerBase, DeepCheckOutcome

    class _KubectlTls(DeepCheckerBase):
        check_type = "pvc_health"
        display_name = "가짜 kubectl"

        def run(self, ctx):
            self._record_command(
                ["kubectl", "get", "pvc"], time.time(), exit_code=1, stdout="",
                stderr="Unable to connect to the server: x509: certificate signed by unknown authority",
            )
            return DeepCheckOutcome(status=StatusEnum.critical, message="kubectl 종료 코드 1", details={})

    _use_fake(monkeypatch, _KubectlTls)
    run = svc.create_run(db, world["deep"], world["open"], trigger=CheckMatrixTrigger.manual_cell,
                         triggered_by="tester")
    svc.execute_run(db, run.id)
    assert svc.get_run(db, run.id)["run_state"] == "failed"
    assert _cell(db, world).value == 7.0


def test_collection_error_does_not_drive_cluster_status(db, world, deep_def, monkeypatch):
    """affects_cluster_status 정의라도 수집 실패 결과는 클러스터 롤업에서 빠지고 직전 판정이 쓰인다."""
    from app.models import DeepCheckResult, StatusEnum
    from app.services.cluster_status_service import recompute
    from app.services.k8s_client_pool import K8sClientError

    deep_def.affects_cluster_status = True
    db.add(DeepCheckResult(cluster_id=world["open"].id, definition_id=deep_def.id, check_type="pvc_health",
                           status=StatusEnum.healthy, message="이전 정상", details={},
                           checked_at=datetime.utcnow() - timedelta(hours=1)))
    db.commit()
    _use_fake(monkeypatch, _fake_checker(K8sClientError("kubeconfig 로드 실패: x")))
    run = svc.create_run(db, world["deep"], world["open"], trigger=CheckMatrixTrigger.manual_cell,
                         triggered_by="tester")
    svc.execute_run(db, run.id)
    out = recompute(db, world["open"].id)
    mine = [c for c in out["contributors"] if c.get("message") == "이전 정상"]
    assert mine and mine[0]["status"] == "healthy"
    assert out["status"] != "critical"


# ── CR-11 실행 취소 · 응답 뒤 큐잉 (1.59 후속: "전체 실행 후 응답없음·취소 불가") ─────────────

@pytest.fixture
def fake_revoke(monkeypatch):
    from app.celery_app import celery_app

    calls: list[tuple[list[str], dict]] = []
    monkeypatch.setattr(celery_app.control, "revoke", lambda ids, **kw: calls.append((list(ids), kw)))
    return calls


def test_queued_run_cancel_is_kept_and_worker_skips_it(db, world, fake_revoke):
    run = svc.create_run(db, world["deep"], world["open"], trigger=CheckMatrixTrigger.manual_cell)
    out = svc.cancel_runs(db, run_ids=[run.id], actor="tester")
    assert out["cancelled"] == 1 and out["was_running"] == 0
    assert fake_revoke and fake_revoke[0][0] == [str(run.id)]
    db.refresh(run)
    assert run.run_state == CheckMatrixRunState.cancelled
    assert "사용자 취소" in (run.error or "")
    # 워커가 뒤늦게 집어도 실행하지 않는다.
    res = svc.execute_run(db, run.id)
    assert res["run_state"] == "cancelled"
    # 이미 끝난 수행은 다시 취소되지 않는다.
    assert svc.cancel_runs(db, run_ids=[run.id])["cancelled"] == 0


def test_late_worker_finish_does_not_overwrite_cancelled(db, world, fake_revoke):
    """revoke 가 닿지 않아 실행이 끝까지 가도 결과가 cancelled 를 덮지 않는다(before_flush 가드)."""
    run = svc.create_run(db, world["deep"], world["open"], trigger=CheckMatrixTrigger.manual_cell)
    run.run_state = CheckMatrixRunState.running
    run.started_at = datetime.utcnow()
    db.commit()
    other = SessionLocal()
    try:
        svc.cancel_runs(other, run_ids=[run.id], actor="tester")
        assert fake_revoke[0][1].get("terminate") is True
    finally:
        other.close()
    # 워커 세션은 아직 running 이라고 알고 있다 → 성공으로 마감 시도.
    svc._finish_run(run, CheckMatrixRunState.success, message="done")
    db.commit()
    db.refresh(run)
    assert run.run_state == CheckMatrixRunState.cancelled


def test_progress_stops_a_cancelled_running_run(db, world, fake_revoke):
    run = svc.create_run(db, world["deep"], world["open"], trigger=CheckMatrixTrigger.manual_cell)
    run.run_state = CheckMatrixRunState.running
    db.commit()
    other = SessionLocal()
    try:
        svc.cancel_runs(other, run_ids=[run.id])
    finally:
        other.close()
    with pytest.raises(svc.RunCancelled):
        svc._progress(db, run, "다음 단계")


def test_batch_cancel_endpoint(client_as, world, fake_queue, fake_revoke, db):
    c = client_as(world["admin"])
    res = c.post(f"/api/v1/check-matrix/items/{world['deep'].id}/run").json()
    assert res["total"] >= 2
    out = c.post(f"/api/v1/check-matrix/batches/{res['batch_id']}/cancel")
    assert out.status_code == 200, out.text
    assert out.json()["cancelled"] == res["total"]
    states = {r.run_state for r in db.query(CheckMatrixRun).filter(
        CheckMatrixRun.batch_id == uuid.UUID(res["batch_id"]))}
    assert states == {CheckMatrixRunState.cancelled}
    # 수행 단건 취소 — 이미 끝났으면 0.
    one = c.post(f"/api/v1/check-matrix/runs/{res['run_ids'][0]}/cancel")
    assert one.status_code == 200 and one.json()["cancelled"] == 0


def test_batch_cancel_respects_tenant_operate(client_as, world, fake_queue, fake_revoke, db):
    res = client_as(world["admin"]).post(f"/api/v1/check-matrix/items/{world['deep'].id}/run").json()
    out = client_as(world["outsider"]).post(f"/api/v1/check-matrix/batches/{res['batch_id']}/cancel").json()
    left = {str(r.cluster_id) for r in db.query(CheckMatrixRun).filter(
        CheckMatrixRun.batch_id == uuid.UUID(res["batch_id"]),
        CheckMatrixRun.run_state == CheckMatrixRunState.queued)}
    assert str(world["bound"].id) in left  # 바인딩 클러스터 수행은 남는다
    assert out["cancelled"] >= 1


def test_run_endpoint_publishes_after_response_and_broker_failure_is_visible(
    client_as, world, monkeypatch, db,
):
    """브로커가 죽어도 요청은 batch_id 를 바로 돌려주고, 나머지 수행은 재시도 없이 실패로 마감된다."""
    from app import celery_app

    calls: list[str] = []

    class _Broken:
        @staticmethod
        def apply_async(args=None, **kw):
            calls.append(kw.get("task_id"))
            raise RuntimeError("broker unreachable")

    monkeypatch.setattr(celery_app, "run_check_matrix_run_one", _Broken)
    r = client_as(world["admin"]).post(f"/api/v1/check-matrix/items/{world['deep'].id}/run")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["batch_id"] and body["total"] >= 2
    assert len(calls) == 1  # 첫 실패 뒤로는 브로커를 두드리지 않는다
    assert calls[0] in body["run_ids"]  # 태스크 id = 수행 id (취소 시 revoke 대상)
    runs = db.query(CheckMatrixRun).filter(CheckMatrixRun.batch_id == uuid.UUID(body["batch_id"])).all()
    assert runs and all(r.run_state == CheckMatrixRunState.failed for r in runs)
    assert all("큐잉 실패" in (r.error or "") for r in runs)
