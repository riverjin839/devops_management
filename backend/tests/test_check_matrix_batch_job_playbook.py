"""D-066 — 점검 매트릭스에 배치잡(SSH bash/python)·플레이북(Ansible)을 실제 카탈로그
항목으로 편입한 것에 대한 테스트.

커버하는 계약:
  BC-1  런북(build_runbook) — 인스턴스가 없으면 blocked_reason, 있으면 실행 가능 + 명령 노출.
  BC-2  등록 마법사 카탈로그(list_catalog) — 등록된 BatchJob/Playbook 이름이 항목으로 노출된다.
  BC-3  실행(run_cell_now) — 인스턴스가 없거나 비활성이면 skipped, 실행 자체가 실패하면
        failed(추이 차트를 오염시키지 않기 위해 skipped 가 아니라 failed 로 명확히 구분).
  BC-4  라우터 검증(_validate_item_body) — 존재하지 않는 이름은 거부, 존재하는 이름은 허용.
  BC-5  ops_check_service — 같은 클러스터의 배치잡/플레이북이 카탈로그에 나타나고 dispatch 된다.
  BC-6  PlaybookRun 이력 — 실행마다 append-only 로 남고 Playbook.last_result 도 하위호환 갱신.
"""
import uuid

import pytest

from app.models import (
    BatchJob,
    CheckMatrixItem,
    CheckMatrixRunState,
    CheckMatrixSourceType,
    Cluster,
    Playbook,
    PlaybookRun,
)
from app.services import check_matrix_service as svc
from app.services import ops_check_service as ops_svc
from app.services import playbook_service
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
def cluster(db):
    c = Cluster(name=f"d066-{uuid.uuid4().hex[:8]}", api_endpoint="https://127.0.0.1:65535")
    db.add(c)
    db.commit()
    yield c
    db.query(Cluster).filter(Cluster.id == c.id).delete(synchronize_session=False)
    db.commit()


def _get(db, model, pk):
    return db.query(model).filter(model.id == pk).first()


# ── BC-1 런북 ────────────────────────────────────────────────────────────────
class TestRunbook:
    def test_batch_job_without_instance_is_blocked_with_reason(self, db, cluster):
        item = CheckMatrixItem(
            name="bj-runbook-probe", source_type=CheckMatrixSourceType.batch_job,
            source_ref=f"nonexistent-job-{uuid.uuid4().hex[:8]}",
        )
        db.add(item)
        db.commit()
        try:
            rb = build_runbook(db, item, cluster)
            assert rb["runnable"] is False
            assert item.source_ref in (rb["blocked_reason"] or "")
            assert rb["config_editable"] is False
        finally:
            db.delete(item)
            db.commit()

    def test_batch_job_with_instance_is_runnable_with_ssh_command(self, db, cluster):
        name = f"cert-renew-{uuid.uuid4().hex[:8]}"
        job = BatchJob(cluster_id=cluster.id, name=name, job_type="script", execution_mode="script",
                        default_host="10.0.0.1", default_username="root")
        item = CheckMatrixItem(
            name="bj-runbook-ok", source_type=CheckMatrixSourceType.batch_job, source_ref=name,
        )
        db.add_all([job, item])
        db.commit()
        try:
            rb = build_runbook(db, item, cluster)
            assert rb["runnable"] is True
            assert rb["blocked_reason"] is None
            assert any(c["kind"] == "ssh" for c in rb["commands"])
            assert "10.0.0.1" in " ".join(c["command"] for c in rb["commands"])
        finally:
            db.delete(item)
            db.delete(job)
            db.commit()

    def test_batch_job_disabled_is_blocked_with_reason(self, db, cluster):
        name = f"disabled-job-{uuid.uuid4().hex[:8]}"
        job = BatchJob(cluster_id=cluster.id, name=name, job_type="script", enabled=False)
        item = CheckMatrixItem(
            name="bj-runbook-disabled", source_type=CheckMatrixSourceType.batch_job, source_ref=name,
        )
        db.add_all([job, item])
        db.commit()
        try:
            rb = build_runbook(db, item, cluster)
            assert rb["runnable"] is False
            assert "비활성화" in (rb["blocked_reason"] or "")
        finally:
            db.delete(item)
            db.delete(job)
            db.commit()

    def test_playbook_without_instance_is_blocked_with_reason(self, db, cluster):
        item = CheckMatrixItem(
            name="pb-runbook-probe", source_type=CheckMatrixSourceType.playbook,
            source_ref=f"nonexistent-playbook-{uuid.uuid4().hex[:8]}",
        )
        db.add(item)
        db.commit()
        try:
            rb = build_runbook(db, item, cluster)
            assert rb["runnable"] is False
            assert item.source_ref in (rb["blocked_reason"] or "")
        finally:
            db.delete(item)
            db.commit()

    def test_playbook_with_instance_is_runnable_with_ansible_command(self, db, cluster):
        name = f"deploy-fix-{uuid.uuid4().hex[:8]}"
        pb = Playbook(cluster_id=cluster.id, name=name, playbook_path="/tmp/x.yml", tags="prod")
        item = CheckMatrixItem(
            name="pb-runbook-ok", source_type=CheckMatrixSourceType.playbook, source_ref=name,
        )
        db.add_all([pb, item])
        db.commit()
        try:
            rb = build_runbook(db, item, cluster)
            assert rb["runnable"] is True
            assert any(c["kind"] == "ansible" for c in rb["commands"])
            assert "--tags prod" in " ".join(c["command"] for c in rb["commands"])
        finally:
            db.delete(item)
            db.delete(pb)
            db.commit()


# ── BC-2 등록 마법사 카탈로그 ─────────────────────────────────────────────────
class TestCatalog:
    def test_list_catalog_includes_registered_batch_jobs_and_playbooks(self, db, cluster):
        bj_name = f"catalog-job-{uuid.uuid4().hex[:8]}"
        pb_name = f"catalog-pb-{uuid.uuid4().hex[:8]}"
        job = BatchJob(cluster_id=cluster.id, name=bj_name, job_type="script")
        pb = Playbook(cluster_id=cluster.id, name=pb_name, playbook_path="/tmp/x.yml")
        db.add_all([job, pb])
        db.commit()
        try:
            catalog = svc.list_catalog(db)
            by_ref = {(i["source_type"], i["source_ref"]): i for i in catalog["items"]}
            assert ("batch_job", bj_name) in by_ref
            assert ("playbook", pb_name) in by_ref
            assert by_ref[("batch_job", bj_name)]["exec_tech"] in ("ssh_bash", "ssh_python", "k8s_api")
            assert by_ref[("playbook", pb_name)]["exec_tech"] == "ansible"
            assert "ansible" in catalog["exec_techs"]
        finally:
            db.delete(job)
            db.delete(pb)
            db.commit()


# ── BC-3 실행 ────────────────────────────────────────────────────────────────
class TestExecute:
    def test_batch_job_without_instance_is_skipped(self, db, cluster):
        item = CheckMatrixItem(
            name="bj-exec-missing", source_type=CheckMatrixSourceType.batch_job,
            source_ref=f"missing-{uuid.uuid4().hex[:8]}",
        )
        db.add(item)
        db.commit()
        try:
            result = svc.run_cell_now(db, item, cluster, triggered_by="tester")
            assert result["run_state"] == CheckMatrixRunState.skipped.value
        finally:
            db.delete(item)
            db.commit()

    def test_disabled_batch_job_is_skipped(self, db, cluster):
        name = f"disabled-exec-{uuid.uuid4().hex[:8]}"
        job = BatchJob(cluster_id=cluster.id, name=name, job_type="script", enabled=False)
        item = CheckMatrixItem(
            name="bj-exec-disabled", source_type=CheckMatrixSourceType.batch_job, source_ref=name,
        )
        db.add_all([job, item])
        db.commit()
        try:
            result = svc.run_cell_now(db, item, cluster, triggered_by="tester")
            assert result["run_state"] == CheckMatrixRunState.skipped.value
        finally:
            db.delete(item)
            db.delete(job)
            db.commit()

    def test_batch_job_with_unknown_executor_fails_run_not_silently_skips(self, db, cluster):
        """job_type 이 등록되지 않은 실행기를 가리키면(설정 오류) skipped 가 아니라 failed 로
        명확히 남아야 한다 — "대상이 없어서 실행 안 함"과 "실행하려다 실패함"은 다른 신호다."""
        name = f"unknown-type-{uuid.uuid4().hex[:8]}"
        job = BatchJob(cluster_id=cluster.id, name=name, job_type="__not_a_real_executor__")
        item = CheckMatrixItem(
            name="bj-exec-unknown", source_type=CheckMatrixSourceType.batch_job, source_ref=name,
        )
        db.add_all([job, item])
        db.commit()
        try:
            result = svc.run_cell_now(db, item, cluster, triggered_by="tester")
            assert result["run_state"] == CheckMatrixRunState.failed.value
            assert result["error"]
        finally:
            db.delete(item)
            db.delete(job)
            db.commit()

    def test_playbook_without_instance_is_skipped(self, db, cluster):
        item = CheckMatrixItem(
            name="pb-exec-missing", source_type=CheckMatrixSourceType.playbook,
            source_ref=f"missing-{uuid.uuid4().hex[:8]}",
        )
        db.add(item)
        db.commit()
        try:
            result = svc.run_cell_now(db, item, cluster, triggered_by="tester")
            assert result["run_state"] == CheckMatrixRunState.skipped.value
        finally:
            db.delete(item)
            db.commit()

    def test_playbook_without_source_fails_cleanly_and_logs_playbook_run(self, db, cluster):
        """playbook_path/playbook_file 둘 다 없는 상태(설정 미완료)로 실행하면
        ansible-playbook 을 실제로 띄우지 않고도 PlaybookResult 가 critical 로 단정된다
        (run_playbook 의 사전 검증) — 그 결과가 PlaybookRun 이력에도 남아야 한다."""
        name = f"unconfigured-pb-{uuid.uuid4().hex[:8]}"
        pb = Playbook(cluster_id=cluster.id, name=name)  # playbook_path/playbook_file_id 둘 다 None
        item = CheckMatrixItem(
            name="pb-exec-unconfigured", source_type=CheckMatrixSourceType.playbook, source_ref=name,
        )
        db.add_all([pb, item])
        db.commit()
        try:
            result = svc.run_cell_now(db, item, cluster, triggered_by="tester")
            assert result["run_state"] == CheckMatrixRunState.success.value  # 실행 자체는 완료됨(판정=critical)
            assert result["status"] == "critical"

            runs = db.query(PlaybookRun).filter(PlaybookRun.playbook_id == pb.id).all()
            assert len(runs) == 1
            assert runs[0].status == "critical"
            assert runs[0].trigger == "check_matrix"

            db.refresh(pb)
            assert pb.status == "critical"
            assert pb.last_result is not None
        finally:
            db.query(PlaybookRun).filter(PlaybookRun.playbook_id == pb.id).delete(synchronize_session=False)
            db.delete(item)
            db.delete(pb)
            db.commit()


# ── BC-4 라우터 검증 ─────────────────────────────────────────────────────────
class TestRouterValidation:
    def test_unknown_batch_job_name_is_rejected(self, db):
        from fastapi import HTTPException
        from app.routers.check_matrix import ItemIn, _validate_item_body

        body = ItemIn(
            name="x", source_type=CheckMatrixSourceType.batch_job,
            source_ref=f"nope-{uuid.uuid4().hex[:8]}",
        )
        with pytest.raises(HTTPException) as exc_info:
            _validate_item_body(body, db)
        assert exc_info.value.status_code == 400

    def test_known_batch_job_name_is_accepted(self, db, cluster):
        from app.routers.check_matrix import ItemIn, _validate_item_body

        name = f"valid-job-{uuid.uuid4().hex[:8]}"
        job = BatchJob(cluster_id=cluster.id, name=name, job_type="script")
        db.add(job)
        db.commit()
        try:
            body = ItemIn(name="x", source_type=CheckMatrixSourceType.batch_job, source_ref=name)
            _validate_item_body(body, db)  # raises on failure
        finally:
            db.delete(job)
            db.commit()

    def test_unknown_playbook_name_is_rejected(self, db):
        from fastapi import HTTPException
        from app.routers.check_matrix import ItemIn, _validate_item_body

        body = ItemIn(
            name="x", source_type=CheckMatrixSourceType.playbook,
            source_ref=f"nope-{uuid.uuid4().hex[:8]}",
        )
        with pytest.raises(HTTPException) as exc_info:
            _validate_item_body(body, db)
        assert exc_info.value.status_code == 400


# ── BC-5 ops_check_service ──────────────────────────────────────────────────
class TestOpsCheckService:
    def test_catalog_includes_cluster_batch_jobs_and_playbooks(self, db, cluster):
        bj_name = f"ops-job-{uuid.uuid4().hex[:8]}"
        pb_name = f"ops-pb-{uuid.uuid4().hex[:8]}"
        job = BatchJob(cluster_id=cluster.id, name=bj_name, job_type="script")
        pb = Playbook(cluster_id=cluster.id, name=pb_name, playbook_path="/tmp/x.yml")
        db.add_all([job, pb])
        db.commit()
        try:
            svcobj = ops_svc.OpsCheckService(db)
            catalog = svcobj.build_catalog(cluster.id)
            sources = {(c["source"], c["name"]) for c in catalog}
            assert ("batch_job", bj_name) in sources
            assert ("playbook", pb_name) in sources
        finally:
            db.delete(job)
            db.delete(pb)
            db.commit()

    def test_catalog_items_carry_exec_tech_for_badge_unification(self, db, cluster):
        """D-062 — 콘솔 카탈로그도 매트릭스의 ExecTechBadge 와 같은 배지를 쓸 수 있어야 한다."""
        bj_name = f"ops-exectech-{uuid.uuid4().hex[:8]}"
        pb_name = f"ops-exectech-pb-{uuid.uuid4().hex[:8]}"
        job = BatchJob(cluster_id=cluster.id, name=bj_name, job_type="script")
        pb = Playbook(cluster_id=cluster.id, name=pb_name, playbook_path="/tmp/x.yml")
        db.add_all([job, pb])
        db.commit()
        try:
            svcobj = ops_svc.OpsCheckService(db)
            catalog = svcobj.build_catalog(cluster.id)
            by_name = {c["name"]: c for c in catalog}
            assert by_name[pb_name]["exec_tech"] == "ansible"
            assert by_name[bj_name]["exec_tech"]  # 문자열이 채워져 있어야 함(정확한 값은 job_type 별로 갈림)
        finally:
            db.delete(job)
            db.delete(pb)
            db.commit()

    def test_run_item_dispatches_unknown_batch_job_type_as_critical_not_exception(self, db, cluster):
        from app.models import OpsCheckRunItem

        name = f"ops-unknown-{uuid.uuid4().hex[:8]}"
        job = BatchJob(cluster_id=cluster.id, name=name, job_type="__not_a_real_executor__")
        db.add(job)
        db.commit()
        try:
            item = OpsCheckRunItem(
                run_id=uuid.uuid4(), source="batch_job", item_ref_id=str(job.id),
                name=job.name, status="queued",
            )
            svcobj = ops_svc.OpsCheckService(db)
            status, message, _details, _duration = svcobj._run_batch_job(cluster, item)
            from app.models import StatusEnum
            assert status == StatusEnum.critical
            assert message
        finally:
            db.delete(job)
            db.commit()


# ── BC-6 PlaybookRun 이력 서비스 단위 ────────────────────────────────────────
class TestPlaybookService:
    def test_execute_playbook_run_without_source_persists_history_row(self, db, cluster):
        name = f"svc-pb-{uuid.uuid4().hex[:8]}"
        pb = Playbook(cluster_id=cluster.id, name=name)
        db.add(pb)
        db.commit()
        try:
            run, result = playbook_service.execute_playbook_run(
                db, pb, trigger="manual", triggered_by_username="tester",
            )
            assert result.status == "critical"
            assert run.playbook_id == pb.id
            assert run.trigger == "manual"
            assert run.triggered_by_username == "tester"
            assert run.finished_at is not None

            history = (
                db.query(PlaybookRun)
                .filter(PlaybookRun.playbook_id == pb.id)
                .order_by(PlaybookRun.started_at.desc())
                .all()
            )
            assert len(history) == 1
            assert history[0].id == run.id
        finally:
            db.query(PlaybookRun).filter(PlaybookRun.playbook_id == pb.id).delete(synchronize_session=False)
            db.delete(pb)
            db.commit()

    def test_multiple_runs_are_all_kept_not_overwritten(self, db, cluster):
        """D-066 의 핵심 — 이전에는 last_result 1행 덮어쓰기뿐이라 실행할 때마다 이전
        기록이 사라졌다. 이제는 PlaybookRun 이 append-only 로 전부 남아야 한다."""
        name = f"svc-pb-multi-{uuid.uuid4().hex[:8]}"
        pb = Playbook(cluster_id=cluster.id, name=name)
        db.add(pb)
        db.commit()
        try:
            for _ in range(3):
                playbook_service.execute_playbook_run(db, pb, trigger="manual")
            history = db.query(PlaybookRun).filter(PlaybookRun.playbook_id == pb.id).all()
            assert len(history) == 3
        finally:
            db.query(PlaybookRun).filter(PlaybookRun.playbook_id == pb.id).delete(synchronize_session=False)
            db.delete(pb)
            db.commit()
