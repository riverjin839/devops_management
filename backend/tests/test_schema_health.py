"""스키마 드리프트 점검·복구 테스트.

배경: Alembic 없이 `create_all` + 경량 마이그레이션으로 운영하므로, 이미 존재하는
테이블의 컬럼/제약은 자동으로 갱신되지 않는다. 그래서 오래된 DB 는 모델과 어긋나고
해당 컬럼을 쓰는 요청에서만 500 으로 드러난다(실제 사례: deep_check_results.status,
deep_check_results.daily_check_log_id 의 레거시 NOT NULL, daily_check_logs.ai_* 누락).
이 테스트는 그 드리프트를 인위적으로 만들어 감지·복구를 검증한다.
"""
import pytest
from sqlalchemy import text

from app.database import Base, engine
from app.services import schema_health


@pytest.fixture(autouse=True)
def _schema_ready():
    from app.main import _ensure_pgvector_extension

    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    yield
    # 어떤 테스트가 실패해도 다음 테스트가 깨끗한 스키마에서 시작하도록 복구.
    schema_health.repair_drift()


def _exec(sql: str) -> None:
    with engine.begin() as conn:
        conn.execute(text(sql))


def _is_nullable(table: str, column: str) -> bool:
    with engine.begin() as conn:
        return conn.execute(text(
            "SELECT is_nullable FROM information_schema.columns "
            "WHERE table_name=:t AND column_name=:c"
        ), {"t": table, "c": column}).scalar() == "YES"


def _has_column(table: str, column: str) -> bool:
    with engine.begin() as conn:
        return conn.execute(text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name=:t AND column_name=:c"
        ), {"t": table, "c": column}).scalar() is not None


class TestInspectDrift:
    def test_clean_schema_reports_healthy(self):
        report = schema_health.inspect_drift()
        assert report["healthy"], f"기준 스키마에 드리프트가 있다: {report['issues']}"
        # 전 테이블/컬럼을 훑는지 — 특정 테이블만 보는 반쪽 점검이면 의미가 없다.
        assert report["checked_tables"] > 30
        assert report["checked_columns"] > 300

    def test_detects_missing_column(self):
        """실제로 났던 사례: daily_check_logs.ai_status 누락 → 일일점검 저장 500."""
        _exec("ALTER TABLE daily_check_logs DROP COLUMN IF EXISTS ai_status")
        issues = schema_health.inspect_drift()["issues"]
        hit = [i for i in issues
               if i["kind"] == "missing_column"
               and i["table"] == "daily_check_logs" and i["column"] == "ai_status"]
        assert hit and hit[0]["repairable"] is True

    def test_detects_not_null_drift(self):
        """모델은 nullable 인데 DB 에 NOT NULL 이 남은 경우."""
        _exec("ALTER TABLE deep_check_results ALTER COLUMN daily_check_log_id SET NOT NULL")
        issues = schema_health.inspect_drift()["issues"]
        hit = [i for i in issues
               if i["kind"] == "not_null_drift"
               and i["table"] == "deep_check_results" and i["column"] == "daily_check_log_id"]
        assert hit and hit[0]["repairable"] is True

    def test_model_not_null_with_nullable_db_is_not_flagged(self):
        """반대 방향은 감지 대상이 아니다 — backfill 판단이 필요해 자동 처리하면 안 된다."""
        _exec("ALTER TABLE check_matrix_items ALTER COLUMN name DROP NOT NULL")
        try:
            issues = schema_health.inspect_drift()["issues"]
            assert not [i for i in issues
                        if i["table"] == "check_matrix_items" and i["column"] == "name"]
        finally:
            _exec("ALTER TABLE check_matrix_items ALTER COLUMN name SET NOT NULL")

    def test_detects_orphan_not_null_column(self):
        """실사례: deep_check_results.ai_status — 모델에는 존재한 적도 없는 컬럼이
        운영 DB 에만 NOT NULL + 기본값 없음으로 남아 deep check 실행을 전부 막았다.
        위 두 드리프트 종류는 '모델 → DB' 단방향 비교라 이 케이스를 놓친다 —
        모델에 없는 컬럼을 별도로 스캔해야 잡힌다.
        """
        _exec("ALTER TABLE deep_check_results ADD COLUMN legacy_orphan_col VARCHAR(20)")
        try:
            _exec("UPDATE deep_check_results SET legacy_orphan_col = 'x'")
            _exec("ALTER TABLE deep_check_results ALTER COLUMN legacy_orphan_col SET NOT NULL")
            issues = schema_health.inspect_drift()["issues"]
            hit = [i for i in issues
                   if i["kind"] == "orphan_not_null_column"
                   and i["table"] == "deep_check_results" and i["column"] == "legacy_orphan_col"]
            assert hit and hit[0]["repairable"] is True
        finally:
            _exec("ALTER TABLE deep_check_results DROP COLUMN IF EXISTS legacy_orphan_col")

    def test_orphan_column_with_db_default_is_not_flagged(self):
        """DB 기본값이 있으면 ORM 이 값을 안 줘도 INSERT 가 죽지 않으므로 문제가 아니다."""
        _exec("ALTER TABLE deep_check_results ADD COLUMN legacy_orphan_col VARCHAR(20) "
              "NOT NULL DEFAULT 'x'")
        try:
            issues = schema_health.inspect_drift()["issues"]
            assert not [i for i in issues
                        if i["table"] == "deep_check_results" and i["column"] == "legacy_orphan_col"]
        finally:
            _exec("ALTER TABLE deep_check_results DROP COLUMN IF EXISTS legacy_orphan_col")

    def test_orphan_nullable_column_is_not_flagged(self):
        """nullable 이면 ORM 이 안 채워도 NULL 로 들어가므로 문제가 아니다."""
        _exec("ALTER TABLE deep_check_results ADD COLUMN legacy_orphan_col VARCHAR(20)")
        try:
            issues = schema_health.inspect_drift()["issues"]
            assert not [i for i in issues
                        if i["table"] == "deep_check_results" and i["column"] == "legacy_orphan_col"]
        finally:
            _exec("ALTER TABLE deep_check_results DROP COLUMN IF EXISTS legacy_orphan_col")


class TestRepairDrift:
    def test_repairs_both_kinds_and_converges(self):
        _exec("ALTER TABLE daily_check_logs DROP COLUMN IF EXISTS ai_status")
        _exec("ALTER TABLE deep_check_results ALTER COLUMN daily_check_log_id SET NOT NULL")

        result = schema_health.repair_drift()
        assert result["errors"] == []
        assert len(result["applied"]) >= 2
        assert result["remaining"] == 0
        assert _has_column("daily_check_logs", "ai_status")
        assert _is_nullable("deep_check_results", "daily_check_log_id")

    def test_added_column_is_always_nullable(self):
        """기존 행의 backfill 값을 모르므로 NOT NULL 로 추가하면 안 된다."""
        _exec("ALTER TABLE daily_check_logs DROP COLUMN IF EXISTS ai_status")
        schema_health.repair_drift()
        assert _is_nullable("daily_check_logs", "ai_status")

    def test_dry_run_reports_sql_without_executing(self):
        _exec("ALTER TABLE daily_check_logs DROP COLUMN IF EXISTS ai_status")
        result = schema_health.repair_drift(dry_run=True)
        assert result["dry_run"] is True
        assert result["remaining"] is None
        assert any("ai_status" in (a.get("sql") or "") for a in result["applied"])
        assert all(a["executed"] is False for a in result["applied"])
        assert not _has_column("daily_check_logs", "ai_status"), "dry_run 이 실제로 실행했다"

    def test_repair_is_idempotent(self):
        assert schema_health.repair_drift()["applied"] == []
        assert schema_health.inspect_drift()["healthy"]

    def test_repairs_orphan_column_by_relaxing_not_dropping(self):
        """orphan 컬럼은 존재 자체는 그대로 두고 NOT NULL 제약만 푼다 — DROP COLUMN 은
        데이터 손실 위험이 있어 자동으로 하지 않는다."""
        _exec("ALTER TABLE deep_check_results ADD COLUMN legacy_orphan_col VARCHAR(20)")
        try:
            _exec("UPDATE deep_check_results SET legacy_orphan_col = 'x'")
            _exec("ALTER TABLE deep_check_results ALTER COLUMN legacy_orphan_col SET NOT NULL")

            result = schema_health.repair_drift()

            assert result["errors"] == []
            assert _has_column("deep_check_results", "legacy_orphan_col"), "컬럼이 삭제됐다 — DROP 금지 위반"
            assert _is_nullable("deep_check_results", "legacy_orphan_col")
        finally:
            _exec("ALTER TABLE deep_check_results DROP COLUMN IF EXISTS legacy_orphan_col")

    def test_orphan_column_no_longer_blocks_insert(self):
        """실제 버그 재현 — deep_check_results 에 모델 밖 NOT NULL 컬럼이 있으면 모든
        저장이 NotNullViolation 으로 죽었다. 복구 후에는 정상 저장돼야 한다."""
        import uuid as _uuid
        from app.database import SessionLocal
        from app.models import Cluster, DeepCheckResult, StatusEnum

        _exec("ALTER TABLE deep_check_results ADD COLUMN legacy_orphan_col VARCHAR(20)")
        db = SessionLocal()
        cluster = None
        try:
            _exec("UPDATE deep_check_results SET legacy_orphan_col = 'x'")
            _exec("ALTER TABLE deep_check_results ALTER COLUMN legacy_orphan_col SET NOT NULL")

            cluster = Cluster(name=f"orphan-{_uuid.uuid4().hex[:8]}", api_endpoint="https://127.0.0.1:65535")
            db.add(cluster)
            db.commit()

            row = DeepCheckResult(
                cluster_id=cluster.id, check_type="cert_expiry",
                status=StatusEnum.healthy, message="pre-repair",
            )
            db.add(row)
            with pytest.raises(Exception, match="not-null constraint|NotNullViolation"):
                db.commit()
            db.rollback()

            schema_health.repair_drift()

            row2 = DeepCheckResult(
                cluster_id=cluster.id, check_type="cert_expiry",
                status=StatusEnum.healthy, message="post-repair",
            )
            db.add(row2)
            db.commit()  # 회귀 시 여기서 다시 NotNullViolation
            assert row2.id is not None
        finally:
            db.rollback()
            if cluster is not None:
                db.query(DeepCheckResult).filter(DeepCheckResult.cluster_id == cluster.id).delete()
                db.query(Cluster).filter(Cluster.id == cluster.id).delete()
                db.commit()
            db.close()
            _exec("ALTER TABLE deep_check_results DROP COLUMN IF EXISTS legacy_orphan_col")


class TestBootSafetyNet:
    def test_relax_not_null_drift_fixes_legacy_constraint(self):
        """부팅 시 자동 완화 — 재시작만으로 복구되는 경로."""
        _exec("ALTER TABLE deep_check_results ALTER COLUMN daily_check_log_id SET NOT NULL")
        assert not _is_nullable("deep_check_results", "daily_check_log_id")

        relaxed = schema_health.relax_not_null_drift()

        assert relaxed >= 1
        assert _is_nullable("deep_check_results", "daily_check_log_id")

    def test_relax_is_noop_on_clean_schema(self):
        assert schema_health.relax_not_null_drift() == 0

    def test_relax_also_covers_orphan_columns(self):
        """부팅 안전망(재시작만으로 복구)이 orphan 컬럼까지 커버해야 한다 — 이게 빠지면
        `daily_check_log_id` 류는 재시작으로 낫는데 `ai_status` 류는 화면에서 수동
        복구해야 하는 비일관성이 생긴다."""
        _exec("ALTER TABLE deep_check_results ADD COLUMN legacy_orphan_col VARCHAR(20)")
        try:
            _exec("UPDATE deep_check_results SET legacy_orphan_col = 'x'")
            _exec("ALTER TABLE deep_check_results ALTER COLUMN legacy_orphan_col SET NOT NULL")

            relaxed = schema_health.relax_not_null_drift()

            assert relaxed >= 1
            assert _is_nullable("deep_check_results", "legacy_orphan_col")
        finally:
            _exec("ALTER TABLE deep_check_results DROP COLUMN IF EXISTS legacy_orphan_col")
