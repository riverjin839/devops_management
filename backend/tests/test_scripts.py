"""스크립트 라이브러리(/scripts) — CRUD, 버전 관리, 권한 토글, test-run 분기.

핵심 검증:
  - 생성 시 버전 1 이 함께 만들어지고 current_version_id 가 그걸 가리키는지
  - 새 버전 생성이 자동으로 current 를 이동시키되 이전 버전은 불변으로 남는지
  - 롤백(current-version PUT)이 새 버전을 만들지 않고 포인터만 옮기는지
  - is_system 스크립트 삭제가 409 로 막히는지, 삭제 시 버전이 cascade 되는지
  - AppSetting 토글(script_library_admin_only)이 켜지면 operator 가 403 을 받는지
  - test-run: python kind 는 501, shell/ansible 은 서비스 함수로 위임되는지
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
from app.models.app_setting import AppSetting  # noqa: E402
from app.models.executable_script import ExecutableScript, ExecutableScriptVersion  # noqa: E402
from app.routers import scripts as scripts_router  # noqa: E402
from app.schemas.executable_script import (  # noqa: E402
    ExecutableScriptCreate,
    ExecutableScriptCurrentVersionUpdate,
    ExecutableScriptUpdate,
    ExecutableScriptVersionCreate,
    ScriptTestRunRequest,
    ScriptTestRunTarget,
)


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
        session.query(AppSetting).filter(AppSetting.key == "script_library_admin_only").delete()
        session.commit()
    finally:
        session.rollback()
        session.close()


class _User:
    def __init__(self, role: str = "operator"):
        self.id = uuid.uuid4()
        self.username = f"tester-{uuid.uuid4().hex[:10]}"
        self.role = role


def _create(db, user, **overrides):
    payload = {
        "name": "etcd defrag", "kind": "shell", "tags": ["etcd"],
        "content": "echo hello", "changelog": "init",
    }
    payload.update(overrides)
    return scripts_router.create_script(ExecutableScriptCreate(**payload), request=None, db=db, actor=user)


def test_create_creates_version_1_and_sets_current(db):
    user = _User()
    script = _create(db, user)

    assert script.current_version is not None
    assert script.current_version.version == 1
    assert script.current_version.content == "echo hello"
    assert script.current_version_id == script.current_version.id


def test_list_filters_by_kind_and_tag(db):
    user = _User()
    _create(db, user, name="shell one", kind="shell", tags=["etcd"])
    _create(db, user, name="ansible one", kind="ansible_playbook", tags=["backup"])

    shells = scripts_router.list_scripts(kind="shell", tag=None, q=None, db=db, _=user)
    assert "shell one" in [s.name for s in shells]
    assert "ansible one" not in [s.name for s in shells]

    etcd_tagged = scripts_router.list_scripts(kind=None, tag="etcd", q=None, db=db, _=user)
    assert "shell one" in [s.name for s in etcd_tagged]
    assert "ansible one" not in [s.name for s in etcd_tagged]


def test_get_nonexistent_script_raises_404(db):
    user = _User()
    with pytest.raises(HTTPException) as exc_info:
        scripts_router.get_script(uuid.uuid4(), db=db, _=user)
    assert exc_info.value.status_code == 404


def test_update_is_partial(db):
    user = _User()
    script = _create(db, user, name="원래 이름", description="d")

    updated = scripts_router.update_script(
        script.id, ExecutableScriptUpdate(description="바뀐 설명"), request=None, db=db, actor=user,
    )
    assert updated.name == "원래 이름"  # 안 보낸 필드는 그대로
    assert updated.description == "바뀐 설명"


def test_new_version_becomes_current_but_old_version_is_preserved(db):
    user = _User()
    script = _create(db, user)
    v1_id = script.current_version_id

    v2 = scripts_router.create_version(
        script.id, ExecutableScriptVersionCreate(content="echo v2", changelog="v2"),
        request=None, db=db, actor=user,
    )
    assert v2.version == 2

    refreshed = scripts_router.get_script(script.id, db=db, _=user)
    assert refreshed.current_version_id == v2.id
    assert refreshed.current_version.content == "echo v2"

    # 이전 버전은 불변으로 그대로 조회 가능해야 한다.
    v1 = scripts_router.get_version(script.id, 1, db=db, _=user)
    assert v1.id == v1_id
    assert v1.content == "echo hello"


def test_rollback_moves_pointer_without_new_version(db):
    user = _User()
    script = _create(db, user)
    v1_id = script.current_version_id
    scripts_router.create_version(
        script.id, ExecutableScriptVersionCreate(content="echo v2"), request=None, db=db, actor=user,
    )

    rolled_back = scripts_router.set_current_version(
        script.id, ExecutableScriptCurrentVersionUpdate(version_id=v1_id), request=None, db=db, actor=user,
    )
    assert rolled_back.current_version_id == v1_id
    assert rolled_back.current_version.version == 1

    all_versions = scripts_router.list_versions(script.id, db=db, _=user)
    assert len(all_versions) == 2  # 롤백이 버전을 새로 만들지 않았다


def test_rollback_rejects_version_from_other_script(db):
    user = _User()
    script_a = _create(db, user, name="a")
    script_b = _create(db, user, name="b")

    with pytest.raises(HTTPException) as exc_info:
        scripts_router.set_current_version(
            script_a.id, ExecutableScriptCurrentVersionUpdate(version_id=script_b.current_version_id),
            request=None, db=db, actor=user,
        )
    assert exc_info.value.status_code == 404


def test_delete_rejects_system_script(db):
    user = _User()
    script = _create(db, user)
    row = db.query(ExecutableScript).filter(ExecutableScript.id == script.id).first()
    row.is_system = True
    db.commit()

    with pytest.raises(HTTPException) as exc_info:
        scripts_router.delete_script(script.id, request=None, db=db, actor=user)
    assert exc_info.value.status_code == 409


def test_delete_cascades_versions(db):
    user = _User()
    script = _create(db, user)
    script_id = script.id
    scripts_router.create_version(script_id, ExecutableScriptVersionCreate(content="v2"), request=None, db=db, actor=user)

    scripts_router.delete_script(script_id, request=None, db=db, actor=user)

    assert db.query(ExecutableScript).filter(ExecutableScript.id == script_id).first() is None
    assert db.query(ExecutableScriptVersion).filter(ExecutableScriptVersion.script_id == script_id).count() == 0


def test_access_toggle_blocks_operator_when_admin_only(db):
    operator, admin = _User("operator"), _User("admin")

    # 기본값(토글 없음) — operator 허용.
    assert scripts_router.require_script_access(db=db, user=operator).username == operator.username

    scripts_router.update_access_settings({"admin_only": True}, request=None, db=db, actor=admin)

    with pytest.raises(HTTPException) as exc_info:
        scripts_router.require_script_access(db=db, user=operator)
    assert exc_info.value.status_code == 403

    # admin 은 토글이 켜져도 계속 허용.
    assert scripts_router.require_script_access(db=db, user=admin).username == admin.username

    scripts_router.update_access_settings({"admin_only": False}, request=None, db=db, actor=admin)
    assert scripts_router.require_script_access(db=db, user=operator).username == operator.username


@pytest.mark.asyncio
async def test_test_run_python_kind_returns_501(db):
    user = _User()
    script = _create(db, user, name="py", kind="python", content="print(1)")

    with pytest.raises(HTTPException) as exc_info:
        await scripts_router.test_run_script(
            script.id,
            ScriptTestRunRequest(content="print(1)", target=ScriptTestRunTarget(kind="cluster")),
            request=None, db=db, actor=user,
        )
    assert exc_info.value.status_code == 501


@pytest.mark.asyncio
async def test_test_run_shell_delegates_to_service_and_wraps_input_errors(db, monkeypatch):
    user = _User()
    script = _create(db, user, kind="shell", content="echo hi")

    called = {}

    async def _fake_run_shell_test(content, target):
        called["content"] = content
        called["target"] = target
        return {
            "status": "ok", "steps": [], "commands": [],
            "stdout": "hi\n", "stderr": "", "exit_code": 0, "duration_ms": 12, "error": None,
        }

    monkeypatch.setattr(scripts_router, "run_shell_test", _fake_run_shell_test)

    result = await scripts_router.test_run_script(
        script.id,
        ScriptTestRunRequest(content="echo hi", target=ScriptTestRunTarget(kind="ssh", host="10.0.0.5", password="x")),
        request=None, db=db, actor=user,
    )
    assert result.status == "ok"
    assert result.stdout == "hi\n"
    assert called["content"] == "echo hi"

    # 서비스가 입력 오류(ScriptTestRunError)를 던지면 400 으로 변환돼야 한다.
    async def _raise_input_error(content, target):
        from app.services.script_test_run import ScriptTestRunError
        raise ScriptTestRunError("host 가 필요합니다")

    monkeypatch.setattr(scripts_router, "run_shell_test", _raise_input_error)
    with pytest.raises(HTTPException) as exc_info:
        await scripts_router.test_run_script(
            script.id,
            ScriptTestRunRequest(content="echo hi", target=ScriptTestRunTarget(kind="ssh")),
            request=None, db=db, actor=user,
        )
    assert exc_info.value.status_code == 400


def test_delete_blocked_when_referenced_by_batch_job(db):
    """Phase 2 — BatchJob.script_id 가 이 스크립트를 참조하면 삭제가 409 로 막혀야 한다."""
    from app.models.batch_job import BatchJob
    from app.models.cluster import Cluster

    user = _User()
    script = _create(db, user)
    cluster = Cluster(name=f"c-{uuid.uuid4().hex[:8]}", api_endpoint="https://10.0.0.1:6443")
    db.add(cluster)
    db.commit()
    job = BatchJob(
        cluster_id=cluster.id, name="uses script", job_type="script", execution_mode="script",
        script_id=script.id,
    )
    db.add(job)
    db.commit()

    refreshed = scripts_router.get_script(script.id, db=db, _=user)
    assert refreshed.used_by_count == 1

    with pytest.raises(HTTPException) as exc_info:
        scripts_router.delete_script(script.id, request=None, db=db, actor=user)
    assert exc_info.value.status_code == 409

    db.delete(job)
    db.commit()
    scripts_router.delete_script(script.id, request=None, db=db, actor=user)  # 이제는 성공해야 한다
