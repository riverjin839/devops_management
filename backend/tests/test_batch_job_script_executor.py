"""Batch Job 스크립트 라이브러리 연동(Phase 2) — ScriptExecutor + execute_job 배선 + 라우터 검증.

핵심 검증:
  - ScriptExecutor: shell/ansible_playbook 은 정상 실행, python 은 명확한 에러,
    ctx.script_kind 미설정(스크립트 삭제됨 등)도 명확한 에러로 처리되는지
  - execute_job(): job.execution_mode="script" 일 때 script_version_id 가 없으면
    (항상 최신) script.current_version 을, 있으면(고정) 그 특정 버전을 로드해
    ctx 에 주입하고 BatchJobRun.script_version_id 로 스냅샷하는지
  - 라우터: execution_mode="script" 생성 시 kind=python 거부, job_type 이 "script"
    로 강제되는지
"""
import os
import uuid

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from fastapi import HTTPException  # noqa: E402

from app.database import SessionLocal, Base, engine  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations  # noqa: E402
from app.models.batch_job import BatchJob  # noqa: E402
from app.models.cluster import Cluster  # noqa: E402
from app.models.executable_script import ExecutableScript  # noqa: E402
from app.routers import batch_jobs as batch_jobs_router  # noqa: E402
from app.routers import scripts as scripts_router  # noqa: E402
from app.schemas.batch_job import BatchJobCreate  # noqa: E402
from app.schemas.executable_script import ExecutableScriptCreate  # noqa: E402
from app.services.batch_job_service import execute_job  # noqa: E402
from app.services.batch_jobs.base import ExecutionContext  # noqa: E402
from app.services.batch_jobs.script_executor import ScriptExecutor  # noqa: E402


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


class _User:
    def __init__(self, role: str = "operator"):
        self.id = uuid.uuid4()
        self.username = f"tester-{uuid.uuid4().hex[:10]}"
        self.role = role


def _make_cluster(db) -> Cluster:
    cluster = Cluster(name=f"c-{uuid.uuid4().hex[:8]}", api_endpoint="https://10.0.0.1:6443")
    db.add(cluster)
    db.commit()
    db.refresh(cluster)
    return cluster


def _make_script(db, user, **overrides) -> ExecutableScript:
    payload = {"name": f"s-{uuid.uuid4().hex[:8]}", "kind": "shell", "content": "echo hi", "changelog": "init"}
    payload.update(overrides)
    return scripts_router.create_script(ExecutableScriptCreate(**payload), request=None, db=db, actor=user)


# ── ScriptExecutor (DB-free) ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_script_executor_rejects_python_kind():
    ctx = ExecutionContext(host="10.0.0.5", script_kind="python", script_content="print(1)", timeout=10)
    result = await ScriptExecutor().run(ctx)
    assert result.status == "error"
    assert "Python 스크립트" in result.error


@pytest.mark.asyncio
async def test_script_executor_fails_clearly_when_content_missing():
    """ctx.script_kind 가 없으면(스크립트가 실행 시점에 삭제된 경우 등) 명확히 실패해야 한다."""
    ctx = ExecutionContext(host="10.0.0.5", timeout=10)
    result = await ScriptExecutor().run(ctx)
    assert result.status == "error"
    assert "불러오지 못했습니다" in result.error


@pytest.mark.asyncio
async def test_script_executor_shell_success(monkeypatch):
    from app.services.ssh_runner import SSHResult

    async def _fake_run_bulk(targets, **kwargs):
        return [SSHResult(host=targets[0].host, status="ok", exit_code=0, stdout="hi\n", stderr="", duration_ms=5, error=None)]

    monkeypatch.setattr("app.services.batch_jobs.script_executor.run_bulk", _fake_run_bulk)

    ctx = ExecutionContext(host="10.0.0.5", username="root", password="x", script_kind="shell", script_content="echo hi", timeout=10)
    result = await ScriptExecutor().run(ctx)

    assert result.status == "ok"
    assert result.stdout == "hi\n"
    assert result.executed_command == "bash -lc 'echo hi'"
    step_ids = [s["id"] for s in result.steps]
    assert step_ids == ["load_script", "execute"]
    assert result.commands[0]["kind"] == "ssh"


@pytest.mark.asyncio
async def test_script_executor_ansible_success(monkeypatch):
    class _FakeResult:
        status = "healthy"
        message = "ok"
        duration_ms = 42
        raw_output = "PLAY RECAP"

    def _fake_run_playbook(**kwargs):
        return _FakeResult()

    monkeypatch.setattr("app.services.batch_jobs.script_executor.run_playbook", _fake_run_playbook)

    ctx = ExecutionContext(
        host="10.0.0.5", username="root", password="x",
        script_kind="ansible_playbook", script_content="- hosts: all\n  tasks: []", timeout=10,
    )
    result = await ScriptExecutor().run(ctx)

    assert result.status == "ok"
    assert result.commands[0]["kind"] == "ansible"


# ── 라우터: execution_mode="script" 생성 검증 ─────────────────────────────────

def test_create_job_rejects_python_kind_script(db):
    user = _User()
    cluster = _make_cluster(db)
    py_script = _make_script(db, user, kind="python", content="print(1)")

    with pytest.raises(HTTPException) as exc_info:
        batch_jobs_router.create_job(
            BatchJobCreate(
                cluster_id=cluster.id, name="py job", job_type="whatever",
                execution_mode="script", script_id=py_script.id,
            ),
            request=None, db=db, actor=user,
        )
    assert exc_info.value.status_code == 422


def test_create_job_forces_job_type_to_script(db):
    user = _User()
    cluster = _make_cluster(db)
    script = _make_script(db, user, kind="shell")

    resp = batch_jobs_router.create_job(
        BatchJobCreate(
            cluster_id=cluster.id, name="shell job", job_type="ignored-by-server",
            execution_mode="script", script_id=script.id,
        ),
        request=None, db=db, actor=user,
    )
    assert resp["job_type"] == "script"
    assert resp["script_id"] == script.id
    assert resp["script_kind"] == "shell"
    assert resp["script_name"] == script.name


def test_create_job_rejects_missing_script_id(db):
    user = _User()
    cluster = _make_cluster(db)
    with pytest.raises(HTTPException) as exc_info:
        batch_jobs_router.create_job(
            BatchJobCreate(cluster_id=cluster.id, name="no script", job_type="x", execution_mode="script"),
            request=None, db=db, actor=user,
        )
    assert exc_info.value.status_code == 422


# ── execute_job(): 스크립트 로드 배선 ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_execute_job_loads_current_version_when_unpinned(db, monkeypatch):
    from app.services.ssh_runner import SSHResult

    captured = {}

    async def _fake_run_bulk(targets, *, command, **kwargs):
        captured["command"] = command
        return [SSHResult(host=targets[0].host, status="ok", exit_code=0, stdout="v1 out", stderr="", duration_ms=3, error=None)]

    monkeypatch.setattr("app.services.batch_jobs.script_executor.run_bulk", _fake_run_bulk)

    user = _User()
    cluster = _make_cluster(db)
    script = _make_script(db, user, kind="shell", content="echo v1")
    job = BatchJob(
        cluster_id=cluster.id, name="unpinned", job_type="script", execution_mode="script",
        script_id=script.id, script_version_id=None, default_host="10.0.0.5",
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    run, result = await execute_job(
        db, job, host="10.0.0.5", username="root", password="x", timeout=10, trigger="manual",
    )

    assert result.status == "ok"
    assert "echo v1" in captured["command"]
    assert run.script_version_id == script.current_version_id


@pytest.mark.asyncio
async def test_execute_job_loads_pinned_version_even_after_script_updated(db, monkeypatch):
    from app.services.ssh_runner import SSHResult

    captured = {}

    async def _fake_run_bulk(targets, *, command, **kwargs):
        captured["command"] = command
        return [SSHResult(host=targets[0].host, status="ok", exit_code=0, stdout="", stderr="", duration_ms=3, error=None)]

    monkeypatch.setattr("app.services.batch_jobs.script_executor.run_bulk", _fake_run_bulk)

    user = _User()
    cluster = _make_cluster(db)
    script = _make_script(db, user, kind="shell", content="echo v1")
    v1_id = script.current_version_id

    from app.schemas.executable_script import ExecutableScriptVersionCreate
    scripts_router.create_version(
        script.id, ExecutableScriptVersionCreate(content="echo v2"), request=None, db=db, actor=user,
    )

    # v1 에 고정된 job — 스크립트가 v2 로 갱신됐어도 계속 v1 을 실행해야 한다.
    job = BatchJob(
        cluster_id=cluster.id, name="pinned", job_type="script", execution_mode="script",
        script_id=script.id, script_version_id=v1_id, default_host="10.0.0.5",
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    run, result = await execute_job(
        db, job, host="10.0.0.5", username="root", password="x", timeout=10, trigger="manual",
    )

    assert result.status == "ok"
    assert "echo v1" in captured["command"]
    assert run.script_version_id == v1_id


@pytest.mark.asyncio
async def test_execute_job_fails_gracefully_when_script_id_unresolvable(db):
    """script_id 가 비어있거나(방어 코드 경로) 참조 스크립트를 못 찾으면 ScriptExecutor
    가 명확한 에러로 실패해야 한다 — 500 이 아니라. (스크립트가 실제로 참조된 채
    삭제되는 경우는 batch_jobs_script_id_fkey + scripts 라우터의 409 가드로 이제
    DB 레벨에서부터 막혀 있어 재현 불가 — 여기서는 script_id 자체가 비정상인
    방어적 케이스만 검증한다.)"""
    user = _User()
    cluster = _make_cluster(db)
    job = BatchJob(
        cluster_id=cluster.id, name="orphaned", job_type="script", execution_mode="script",
        script_id=None, default_host="10.0.0.5",
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    run, result = await execute_job(
        db, job, host="10.0.0.5", username="root", password="x", timeout=10, trigger="manual",
    )

    assert result.status == "error"
    assert "불러오지 못했습니다" in result.error
    assert run.script_version_id is None
