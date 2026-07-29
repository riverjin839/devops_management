"""점검 매트릭스 수행(실행 로그 + 런북) 테스트.

커버하는 계약:
  SC-1  런북이 모든 실행 소스(core_bundle/deep_check/addon/manual)에 대해 조립되고,
        deep_check/addon 은 대상이 없을 때 blocked_reason 으로 이유를 알려준다.
  SC-2  대상이 없는 셀 실행은 실패가 아니라 'skipped' 로 로그에 남는다 — 셀이 왜
        비어 있는지가 로그만 보고 설명돼야 하기 때문.
  SC-3  수동 입력도 실행 로그에 남고 누가 넣었는지 보존된다.
  SC-4  클러스터(열)/항목(행) 단위 일괄 실행이 대상 쌍만큼 run 을 만든다.
  SC-5  실행 로그 목록/상세 조회가 필터와 상세 분해(steps/commands/runbook)를 지킨다.
"""
import uuid

import pytest

from app.models import (
    CheckMatrixItem,
    CheckMatrixRun,
    CheckMatrixRunState,
    CheckMatrixSourceType,
    CheckMatrixTrigger,
    Cluster,
    StatusEnum,
)
from app.services import check_matrix_service as svc
from app.services.check_matrix_runbook import build_runbook


@pytest.fixture
def db():
    from app.database import SessionLocal, engine, Base
    from app.main import _ensure_pgvector_extension

    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


@pytest.fixture
def fixture_ids(db):
    """테스트 전용 클러스터 + 항목 4종. 종료 시 run/log 까지 정리."""
    suffix = uuid.uuid4().hex[:8]
    cluster = Cluster(name=f"cm-test-{suffix}", api_endpoint="https://127.0.0.1:65535")
    db.add(cluster)
    items = {
        "core": CheckMatrixItem(
            name=f"core-{suffix}", source_type=CheckMatrixSourceType.core_bundle,
            unit="ms", is_system=True, sort_order=0,
        ),
        # cert_expiry 정의를 만들지 않으므로 이 클러스터에서는 실행 대상이 없다.
        "deep": CheckMatrixItem(
            name=f"deep-{suffix}", source_type=CheckMatrixSourceType.deep_check,
            source_ref="cert_expiry", sort_order=10,
        ),
        "addon": CheckMatrixItem(
            name=f"addon-{suffix}", source_type=CheckMatrixSourceType.addon,
            source_ref="etcd-leader", sort_order=20,
        ),
        "manual": CheckMatrixItem(
            name=f"manual-{suffix}", source_type=CheckMatrixSourceType.manual, sort_order=30,
        ),
    }
    for i in items.values():
        db.add(i)
    db.commit()

    ids = {"cluster": cluster.id, **{k: v.id for k, v in items.items()}}
    yield ids

    # 항목 행(row) 단위 실행은 다른 클러스터에도 run 을 남기므로 두 축 모두로 정리한다.
    item_ids = [ids["core"], ids["deep"], ids["addon"], ids["manual"]]
    from app.models import CheckMatrixResult, CheckMatrixResultLog
    for model in (CheckMatrixRun, CheckMatrixResultLog, CheckMatrixResult):
        db.query(model).filter(
            (model.cluster_id == ids["cluster"]) | (model.item_id.in_(item_ids)),
        ).delete(synchronize_session=False)
    db.query(CheckMatrixItem).filter(CheckMatrixItem.id.in_(item_ids)).delete(
        synchronize_session=False,
    )
    db.query(Cluster).filter(Cluster.id == ids["cluster"]).delete(synchronize_session=False)
    db.commit()


def _get(db, model, pk):
    return db.query(model).filter(model.id == pk).first()


# ── SC-1 런북 ────────────────────────────────────────────────────────────────
class TestRunbook:
    def test_core_bundle_lists_daily_checker_calls(self, db, fixture_ids):
        cluster = _get(db, Cluster, fixture_ids["cluster"])
        rb = build_runbook(db, _get(db, CheckMatrixItem, fixture_ids["core"]), cluster)
        assert rb["runnable"] is True
        assert rb["source_type"] == "core_bundle"
        joined = " ".join(c["command"] for c in rb["commands"])
        assert "/healthz" in joined and "list_node()" in joined
        assert rb["steps"], "core_bundle 은 단계 흐름을 항상 보여줘야 한다"

    def test_deep_check_without_definition_is_blocked_with_reason(self, db, fixture_ids):
        cluster = _get(db, Cluster, fixture_ids["cluster"])
        rb = build_runbook(db, _get(db, CheckMatrixItem, fixture_ids["deep"]), cluster)
        assert rb["runnable"] is False
        assert rb["blocked_reason"] and "cert_expiry" in rb["blocked_reason"]
        # 실행이 막혀 있어도 "무슨 명령을 도는 점검인지"는 보여야 한다.
        assert any("kubeadm certs check-expiration" in c["command"] for c in rb["commands"])
        assert rb["kubectl_prefix"] and cluster.api_endpoint in rb["kubectl_prefix"]

    def test_inputs_keep_real_parameter_names(self, db, fixture_ids):
        """설정값은 dict 가 아니라 {group,name,value} 리스트여야 한다.

        프론트 axios 레이어가 응답의 **키**를 camelCase 로 바꾸므로, 파라미터 이름을 키로
        내보내면 화면에 `labelSelector` 로 뜬다 — 운영자가 Ops Checks 에 실제로 입력해야 하는
        이름(`label_selector`)과 달라져 런북이 거짓말을 하게 된다.
        """
        # coredns_health 는 snake_case 파라미터를 여러 개 가진 대표 케이스.
        item = CheckMatrixItem(
            name="coredns-runbook-probe",
            source_type=CheckMatrixSourceType.deep_check,
            source_ref="coredns_health",
        )
        db.add(item)
        db.commit()
        try:
            rb = build_runbook(db, item, _get(db, Cluster, fixture_ids["cluster"]))
            assert isinstance(rb["inputs"], list)
            names = {row["name"] for row in rb["inputs"]}
            assert {"label_selector", "log_tail_lines"} <= names
            assert {"params", "thresholds"} == {row["group"] for row in rb["inputs"]}
            assert all(isinstance(row["value"], str) for row in rb["inputs"])
        finally:
            db.delete(item)
            db.commit()

    def test_addon_without_instance_is_blocked_with_reason(self, db, fixture_ids):
        cluster = _get(db, Cluster, fixture_ids["cluster"])
        rb = build_runbook(db, _get(db, CheckMatrixItem, fixture_ids["addon"]), cluster)
        assert rb["runnable"] is False
        assert "etcd-leader" in (rb["blocked_reason"] or "")
        assert any("etcdctl" in c["command"] for c in rb["commands"])

    def test_manual_declares_no_cluster_side_command(self, db, fixture_ids):
        cluster = _get(db, Cluster, fixture_ids["cluster"])
        rb = build_runbook(db, _get(db, CheckMatrixItem, fixture_ids["manual"]), cluster)
        assert rb["runnable"] is False
        assert {c["kind"] for c in rb["commands"]} == {"db"}, "수동 입력은 클러스터에 명령을 내지 않는다"

    def test_every_registered_check_type_has_commands(self):
        """새 체커를 추가하고 런북을 빠뜨리면 여기서 걸린다."""
        from app.services.check_matrix_runbook import _deep_check_commands
        from app.services.deep_checkers.registry import REGISTRY

        missing = [ct for ct in REGISTRY if not _deep_check_commands(ct, {})]
        assert missing == [], f"런북 명령이 없는 check_type: {missing}"

    def test_every_addon_type_has_commands(self):
        from app.services.check_matrix_runbook import _addon_commands
        from app.services.checkers import CHECKER_REGISTRY

        missing = [t for t in CHECKER_REGISTRY if not _addon_commands(t, None)]
        assert missing == [], f"런북 명령이 없는 addon type: {missing}"


# ── 셀 대표값 (요건: 인증서 만료는 "정상"이 아니라 잔여일 숫자가 보여야 함) ─────────
class TestCellValue:
    def test_every_check_type_has_value_spec(self):
        """새 체커를 추가하고 대표값 규칙을 빠뜨리면 여기서 걸린다."""
        from app.services.deep_checkers.registry import CELL_VALUE_SPECS, REGISTRY

        missing = [ct for ct in REGISTRY if ct not in CELL_VALUE_SPECS]
        assert missing == [], f"셀 대표값 규칙이 없는 check_type: {missing}"

    def test_cert_expiry_value_is_min_residual_days(self):
        from app.services.deep_checkers.registry import extract_cell_value, get_cell_value_unit

        assert extract_cell_value("cert_expiry", {"min_residual_days": 361}) == 361.0
        assert get_cell_value_unit("cert_expiry") == "일"

    def test_extraction_is_fail_safe(self):
        """키 누락/타입 오류/미지정 타입은 None — 결과 기록 자체를 막으면 안 된다."""
        from app.services.deep_checkers.registry import extract_cell_value

        assert extract_cell_value("cert_expiry", {}) is None
        assert extract_cell_value("cert_expiry", {"min_residual_days": "abc"}) is None
        assert extract_cell_value("unknown_type", {"x": 1}) is None
        assert extract_cell_value("cert_expiry", None) is None

    def test_count_specs_distinguish_zero_from_unmeasured(self):
        from app.services.deep_checkers.registry import extract_cell_value

        # 측정됐고 0건 → 0 (정상에 0건 표시). 키 자체가 없으면 None (미측정).
        assert extract_cell_value("pvc_health", {"pending_pvcs": [], "lost_pvcs": []}) == 0.0
        assert extract_cell_value("pvc_health", {}) is None

    def test_seed_sets_units_and_backfill_fills_legacy_rows(self, db):
        """단위/영역/색 도입 이전에 시드된 행이 부팅 backfill 로 채워진다."""
        row = CheckMatrixItem(
            name="legacy-cert-row", source_type=CheckMatrixSourceType.deep_check,
            source_ref="cert_expiry", unit=None, category=None, color=None,
        )
        db.add(row)
        db.commit()
        try:
            filled = svc.backfill_item_metadata(db)
            db.refresh(row)
            assert filled >= 1
            assert row.unit == "일"
            assert row.category == "k8s"                      # spec.category 에서 보강
            assert row.color == svc.CATEGORY_DEFAULT_COLORS["k8s"]
            # 두 번째 호출은 아무것도 바꾸지 않는다 (idempotent).
            assert svc.backfill_item_metadata(db) == 0
        finally:
            db.delete(row)
            db.commit()

    def test_backfill_respects_operator_cleared_color(self, db):
        """운영자가 색을 지운 행(category 있음·color 없음)은 다시 칠하지 않는다."""
        row = CheckMatrixItem(
            name="colorless-row", source_type=CheckMatrixSourceType.deep_check,
            source_ref="cert_expiry", unit="일", category="k8s", color=None,
        )
        db.add(row)
        db.commit()
        try:
            svc.backfill_item_metadata(db)
            db.refresh(row)
            assert row.color is None
        finally:
            db.delete(row)
            db.commit()


# ── 소스 설정 편집 (요건: 기본 등록 항목의 설정 확인·수정) ────────────────────────
class TestSourceConfigEdit:
    def test_deep_check_config_coerced_and_saved(self, db, fixture_ids):
        from app.models import DeepCheckDefinition

        definition = DeepCheckDefinition(
            name="cert-def-test", check_type="cert_expiry",
            cluster_id=fixture_ids["cluster"], enabled=True,
            thresholds={"warning_days": 30, "critical_days": 7},
        )
        db.add(definition)
        db.commit()
        item = _get(db, CheckMatrixItem, fixture_ids["deep"])
        cluster = _get(db, Cluster, fixture_ids["cluster"])
        try:
            res = svc.update_source_config(db, item, cluster, [
                {"group": "thresholds", "name": "warning_days", "value": "45"},
                {"group": "thresholds", "name": "critical_days", "value": ""},  # 기본값 복귀
            ])
            assert res["scope"] == "cluster"
            db.refresh(definition)
            assert definition.thresholds["warning_days"] == 45          # 문자열 → int 강제
            assert "critical_days" not in definition.thresholds          # 빈 값 = 오버라이드 제거

            # 런북에도 편집 가능 정보가 실려야 한다.
            rb = build_runbook(db, item, cluster)
            assert rb["config_editable"] is True
            assert rb["definition_scope"] == "cluster"
            assert any(f["name"] == "warning_days" for f in rb["field_specs"])
        finally:
            db.delete(definition)
            db.commit()

    def test_unknown_field_is_rejected(self, db, fixture_ids):
        from app.models import DeepCheckDefinition

        definition = DeepCheckDefinition(
            name="cert-def-test2", check_type="cert_expiry",
            cluster_id=fixture_ids["cluster"], enabled=True,
        )
        db.add(definition)
        db.commit()
        item = _get(db, CheckMatrixItem, fixture_ids["deep"])
        cluster = _get(db, Cluster, fixture_ids["cluster"])
        try:
            with pytest.raises(ValueError, match="없는 thresholds 필드"):
                svc.update_source_config(db, item, cluster, [
                    {"group": "thresholds", "name": "warning_dayz", "value": "45"},
                ])
        finally:
            db.delete(definition)
            db.commit()

    def test_addon_config_json_and_string(self, db, fixture_ids):
        from app.models import Addon

        addon = Addon(
            cluster_id=fixture_ids["cluster"], name="test-nexus", type="etcd-leader",
            config={"url": "http://old"},
        )
        db.add(addon)
        db.commit()
        item = _get(db, CheckMatrixItem, fixture_ids["addon"])
        cluster = _get(db, Cluster, fixture_ids["cluster"])
        try:
            svc.update_source_config(db, item, cluster, [
                {"group": "config", "name": "url", "value": "http://new"},
                {"group": "config", "name": "retries", "value": "3"},  # JSON 파싱 → int
            ])
            db.refresh(addon)
            assert addon.config["url"] == "http://new"
            assert addon.config["retries"] == 3
        finally:
            db.delete(addon)
            db.commit()


# ── 스키마 회귀 — deep_check_results.daily_check_log_id NOT NULL ────────────────
class TestDeepCheckResultSchema:
    """정의 단독 실행(매트릭스 셀/지금 점검)은 일일점검 회차 없이 결과를 저장한다.

    초기 스키마는 이 컬럼이 NOT NULL 이었고, create_all 은 기존 컬럼의 제약을 바꾸지
    않으므로 구버전 DB 에서는 deep_check 실행이 전부 IntegrityError(500) 로 죽었다.
    """

    def test_insert_without_daily_check_log_succeeds(self, db, fixture_ids):
        from app.models import DeepCheckResult

        row = DeepCheckResult(
            cluster_id=fixture_ids["cluster"],
            daily_check_log_id=None,   # 회차 없이 단독 실행
            definition_id=None,
            check_type="etcd_defrag",
            status=StatusEnum.healthy,
            message="standalone run",
        )
        db.add(row)
        db.commit()
        try:
            assert row.id is not None
        finally:
            db.delete(row)
            db.commit()

    def test_migration_drops_legacy_not_null(self, db, fixture_ids):
        """구버전 DB 시뮬레이션 — NOT NULL 을 다시 걸고 마이그레이션이 푸는지 확인."""
        from sqlalchemy import text
        from app.database import engine
        from app.main import _run_migrations

        def _is_nullable() -> bool:
            with engine.begin() as conn:
                return conn.execute(text(
                    "SELECT is_nullable FROM information_schema.columns "
                    "WHERE table_name='deep_check_results' AND column_name='daily_check_log_id'"
                )).scalar() == "YES"

        db.close()  # 세션이 잡은 락이 ALTER TABLE 를 막지 않도록
        with engine.begin() as conn:
            conn.execute(text(
                "ALTER TABLE deep_check_results ALTER COLUMN daily_check_log_id SET NOT NULL"
            ))
        assert not _is_nullable(), "테스트 전제 설정 실패"
        _run_migrations()
        assert _is_nullable(), "마이그레이션이 레거시 NOT NULL 을 풀지 못했다"


# ── 항목 삭제 — ORM 이 자식 FK 를 NULL 로 UPDATE 하던 회귀 ────────────────────
class TestItemDeletion:
    """`db.delete(item)` 시 SQLAlchemy 가 자식 행의 item_id 를 NULL 로 UPDATE 하려다
    NotNullViolation 이 나던 버그. FK 에 ON DELETE CASCADE 가 걸려 있으므로 정리는 DB 가
    해야 하고, 관계에는 `passive_deletes=True` 가 필요하다(코드베이스가 cluster 쪽에는
    이미 적용해 둔 패턴 — item 쪽만 빠져 있었다).
    """

    def test_delete_item_with_children_cascades(self, db, fixture_ids):
        from app.models import CheckMatrixResult, CheckMatrixSchedule

        cluster_id = fixture_ids["cluster"]
        item = CheckMatrixItem(
            name="deletable-row", source_type=CheckMatrixSourceType.deep_check,
            source_ref="cert_expiry",
        )
        db.add(item)
        db.commit()
        item_id = item.id

        # 세 자식 테이블을 모두 채운 상태에서 삭제해야 회귀를 제대로 잡는다.
        db.add(CheckMatrixRun(
            item_id=item_id, cluster_id=cluster_id,
            trigger=CheckMatrixTrigger.manual_cell, run_state=CheckMatrixRunState.success,
        ))
        db.add(CheckMatrixResult(item_id=item_id, cluster_id=cluster_id, status=StatusEnum.healthy))
        db.add(CheckMatrixSchedule(item_id=item_id, cluster_id=cluster_id, cron_expr="15 9 * * *"))
        db.commit()

        db.delete(item)
        db.commit()  # 회귀 시 NotNullViolation

        for model in (CheckMatrixRun, CheckMatrixResult, CheckMatrixSchedule):
            assert db.query(model).filter(model.item_id == item_id).count() == 0, (
                f"{model.__tablename__} 이 DB CASCADE 로 정리되지 않았다"
            )


# ── 라우터 표시명 해석 — user.full_name 오참조로 모든 수동 실행이 500 나던 회귀 ──
class TestActorResolution:
    def test_actor_uses_display_name_column(self):
        """User 모델의 표시명 컬럼은 display_name 이다 — full_name 참조는 AttributeError."""
        from app.models.user import User
        from app.routers.check_matrix import _actor

        assert _actor(User(username="hong", display_name="홍길동")) == "홍길동"
        assert _actor(User(username="hong", display_name=None)) == "hong"


# ── SC-2 대상 없는 셀 실행 ────────────────────────────────────────────────────
class TestCellRun:
    def test_missing_definition_is_skipped_not_failed(self, db, fixture_ids):
        item = _get(db, CheckMatrixItem, fixture_ids["deep"])
        cluster = _get(db, Cluster, fixture_ids["cluster"])
        result = svc.run_cell_now(db, item, cluster, triggered_by="tester")

        assert result["run_state"] == CheckMatrixRunState.skipped.value
        assert result["trigger"] == CheckMatrixTrigger.manual_cell.value
        assert result["triggered_by"] == "tester"
        assert "cert_expiry" in (result["message"] or "")
        # 판정 결과가 없으므로 status 는 비어 있어야 한다 — 추이 차트를 오염시키면 안 된다.
        assert result["status"] is None

    def test_run_detail_exposes_runbook_snapshot(self, db, fixture_ids):
        item = _get(db, CheckMatrixItem, fixture_ids["addon"])
        cluster = _get(db, Cluster, fixture_ids["cluster"])
        created = svc.run_cell_now(db, item, cluster, triggered_by="tester")

        detail = svc.get_run(db, created["id"])
        assert detail is not None
        assert detail["runbook"]["source_type"] == "addon"
        assert detail["commands"] == []          # 실제로 나간 명령 없음(대상 부재)
        assert "_runbook" not in detail["details"]  # 상세는 분해돼 최상위로 올라간다
        assert detail["item_name"] == item.name
        assert detail["cluster_name"] == cluster.name

    def test_manual_item_execution_is_skipped(self, db, fixture_ids):
        item = _get(db, CheckMatrixItem, fixture_ids["manual"])
        cluster = _get(db, Cluster, fixture_ids["cluster"])
        result = svc.run_cell_now(db, item, cluster)
        assert result["run_state"] == CheckMatrixRunState.skipped.value


# ── SC-3 수동 입력 ───────────────────────────────────────────────────────────
class TestManualEntry:
    def test_manual_entry_is_logged_with_actor(self, db, fixture_ids):
        svc.record_manual_entry(
            db, fixture_ids["manual"], fixture_ids["cluster"],
            StatusEnum.warning, 42.0, "스위치 점검 결과", triggered_by="홍길동",
        )
        listed = svc.list_runs(db, item_id=fixture_ids["manual"], cluster_id=fixture_ids["cluster"])
        assert listed["total"] == 1
        run = listed["runs"][0]
        assert run["trigger"] == CheckMatrixTrigger.manual_entry.value
        assert run["triggered_by"] == "홍길동"
        assert run["run_state"] == CheckMatrixRunState.success.value
        assert run["status"] == "warning"
        assert run["value"] == 42.0

        # 값 이력에도 같은 값이 쌓여 추이/변경 이력이 자동 점검과 동일하게 동작한다.
        history = svc.get_cell_history(db, fixture_ids["manual"], fixture_ids["cluster"])
        assert history["points"][-1]["value"] == 42.0


# ── SC-4 일괄 실행 ───────────────────────────────────────────────────────────
class TestBatchRuns:
    def test_cluster_batch_creates_run_per_auto_item(self, db, fixture_ids, monkeypatch):
        queued: list[str] = []
        monkeypatch.setattr(
            svc, "start_batch", svc.start_batch,  # 원본 유지, 큐잉만 가로챈다
        )
        import app.celery_app as celery_app

        class _FakeTask:
            @staticmethod
            def apply_async(args=None, **_kw):
                queued.append(args[0])

        monkeypatch.setattr(celery_app, "run_check_matrix_run_one", _FakeTask)

        cluster = _get(db, Cluster, fixture_ids["cluster"])
        res = svc.run_cluster_now(db, cluster, triggered_by="tester")

        # 수동 입력 항목은 자동 실행 대상이 아니므로 제외돼야 한다.
        assert res["queued"] == res["total"] == len(queued)
        assert res["errors"] == []
        made = (
            db.query(CheckMatrixRun)
            .filter(CheckMatrixRun.batch_id == uuid.UUID(res["batch_id"]))
            .all()
        )
        assert {str(r.item_id) for r in made}.isdisjoint({str(fixture_ids["manual"])})
        assert all(r.trigger == CheckMatrixTrigger.manual_cluster for r in made)
        assert all(r.run_state == CheckMatrixRunState.queued for r in made)

    def test_item_batch_covers_every_cluster(self, db, fixture_ids, monkeypatch):
        import app.celery_app as celery_app

        class _FakeTask:
            @staticmethod
            def apply_async(args=None, **_kw):
                return None

        monkeypatch.setattr(celery_app, "run_check_matrix_run_one", _FakeTask)

        item = _get(db, CheckMatrixItem, fixture_ids["deep"])
        res = svc.run_item_now(db, item, triggered_by="tester")
        assert res["total"] == db.query(Cluster).count()
        assert res["queued"] == res["total"]

    def test_queue_failure_marks_run_failed_instead_of_silently_dropping(
        self, db, fixture_ids, monkeypatch,
    ):
        """Celery 브로커가 죽어 있으면 '아무 일도 안 일어난 것'처럼 보이면 안 된다."""
        import app.celery_app as celery_app

        class _BrokenTask:
            @staticmethod
            def apply_async(args=None, **_kw):
                raise RuntimeError("broker unreachable")

        monkeypatch.setattr(celery_app, "run_check_matrix_run_one", _BrokenTask)

        cluster = _get(db, Cluster, fixture_ids["cluster"])
        res = svc.run_cluster_now(db, cluster)
        assert res["queued"] == 0
        assert res["errors"]
        made = (
            db.query(CheckMatrixRun)
            .filter(CheckMatrixRun.batch_id == uuid.UUID(res["batch_id"]))
            .all()
        )
        assert made and all(r.run_state == CheckMatrixRunState.failed for r in made)
        assert all("Celery" in (r.error or "") for r in made)


# ── 고아 수행 정리 (워커 사망 등으로 queued/running 에 갇힌 run) ────────────────
class TestStaleRunSweep:
    def test_old_queued_run_is_failed_and_fresh_one_survives(self, db, fixture_ids):
        from datetime import datetime, timedelta

        item_id, cluster_id = fixture_ids["deep"], fixture_ids["cluster"]
        stale = CheckMatrixRun(
            item_id=item_id, cluster_id=cluster_id,
            trigger=CheckMatrixTrigger.manual_cell,
            run_state=CheckMatrixRunState.running,
            queued_at=datetime.utcnow() - timedelta(minutes=45),
        )
        fresh = CheckMatrixRun(
            item_id=item_id, cluster_id=cluster_id,
            trigger=CheckMatrixTrigger.manual_cell,
            run_state=CheckMatrixRunState.queued,
            queued_at=datetime.utcnow(),
        )
        db.add_all([stale, fresh])
        db.commit()

        swept = svc._sweep_stale_runs(db)

        db.refresh(stale)
        db.refresh(fresh)
        assert swept >= 1
        assert stale.run_state == CheckMatrixRunState.failed
        assert "완료되지 않아" in (stale.error or "")
        assert fresh.run_state == CheckMatrixRunState.queued  # 최근 run 은 건드리지 않는다


# ── SC-5 실행 로그 조회 ───────────────────────────────────────────────────────
class TestRunListing:
    def test_filters_by_cell_and_trigger(self, db, fixture_ids):
        deep = _get(db, CheckMatrixItem, fixture_ids["deep"])
        addon = _get(db, CheckMatrixItem, fixture_ids["addon"])
        cluster = _get(db, Cluster, fixture_ids["cluster"])
        svc.run_cell_now(db, deep, cluster)
        svc.run_cell_now(db, addon, cluster)

        by_cluster = svc.list_runs(db, cluster_id=cluster.id)
        assert by_cluster["total"] == 2
        assert {r["item_name"] for r in by_cluster["runs"]} == {deep.name, addon.name}

        by_cell = svc.list_runs(db, item_id=deep.id, cluster_id=cluster.id)
        assert by_cell["total"] == 1

        # 트리거 필터는 Enum 컬럼 대 문자열 비교라 양쪽 방향을 모두 확인한다.
        assert svc.list_runs(
            db, cluster_id=cluster.id, trigger=CheckMatrixTrigger.manual_cell.value,
        )["total"] == 2
        assert svc.list_runs(
            db, cluster_id=cluster.id, trigger=CheckMatrixTrigger.cron.value,
        )["total"] == 0

    def test_unknown_run_id_returns_none(self, db):
        assert svc.get_run(db, uuid.uuid4()) is None
