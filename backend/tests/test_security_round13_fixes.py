"""13차 보안 리뷰 후속 수정 회귀.

1. cilium-dbg 읽기 전용 allowlist 우회 차단 — 하위 명령 앞 플래그·``--config``/``-H``/``--host``·목록 밖
   명령 + ``-h``·허용 목록 밖 플래그·``debuginfo`` 파일 쓰기.
2. k9s: 보호(guarded) 운영레벨 클러스터는 admin 이 아니면 서버가 ``--readonly`` 강제.
3. 클러스터 수정: 보호 레벨로/에서 바꾸는 operation_level 변경은 admin 만.
4. k8s pod exec 감사 details 의 command·error 마스킹.
"""
import json
import os
import tempfile
import uuid
from urllib.parse import quote

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from starlette.websockets import WebSocketDisconnect  # noqa: E402

from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension  # noqa: E402
from app.models.app_setting import AppSetting  # noqa: E402
from app.models.audit_log import AuditLog  # noqa: E402
from app.models.cluster import Cluster  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.cilium_trace_service import is_cilium_readonly_command  # noqa: E402

HOST = "10.9.73.1"


# ── 1. cilium-dbg allowlist ──────────────────────────────────────────────────

@pytest.mark.parametrize("cmd", [
    # 보고된 우회 2건
    "--config status endpoint delete 123",
    "endpoint delete 123 --config -h",
    # agent 전환·설정 파일 플래그는 어디에 있든 거부
    "--host=x status",
    "--host x status",
    "-H unix:///var/run/x.sock status",
    "-Hunix:///x status",
    "status --config /etc/x",
    "status --config=/etc/x",
    "status --host=tcp://1.2.3.4:1234",
    "endpoint list -H x",
    "status -o --config",
    # 하위 명령 앞 플래그 불가
    "-o json service list",
    "-v endpoint delete 1",
    "--debug status",
    # 목록 밖 명령 + 도움말
    "endpoint delete 12 --help",
    "bpf ct flush global -h",
    "-h",
    "--help",
    # 허용 목록 밖 플래그
    "status --brief",
    "endpoint list --unknown",
    "status -- endpoint delete 1",
    "endpoint list -o",
    "endpoint list -n",
    "bpf -o ct list",
    # debuginfo 파일 쓰기
    "debuginfo -f /x",
    "debuginfo --file=/x",
    "debuginfo --file /x",
    "debuginfo --file-per-command",
    "debuginfo --file-per-command=true",
    "debuginfo -f/x",
    # config 쓰기·기존 차단 유지
    "config Debug=true",
    "config -o json Debug=true",
    "bpf ct flush global",
    "endpoint delete 123",
    "cleanup --all-state",
    "",
    "'unterminated",
])
def test_cilium_bypass_rejected(cmd):
    assert not is_cilium_readonly_command(cmd)


@pytest.mark.parametrize("cmd", [
    "status", "cilium-dbg status", "status --verbose", "status -v", "status -h", "status --help",
    "status --all-controllers --all-health", "version",
    "endpoint list -o json", "endpoint list --output json", "endpoint list --output=json",
    "endpoint get 1234 -o yaml", "bpf ct list global", "bpf policy get 1234", "bpf fs show",
    "bpf lb list -o json", "service list", "identity get 1234", "config", "config -o json",
    "fqdn cache list", "help", "help endpoint", "debuginfo", "debuginfo -o json",
    "kvstore get foo -n kube-system", "endpoint list -h",
])
def test_cilium_legit_reads_pass(cmd):
    assert is_cilium_readonly_command(cmd)


# ── 공용 픽스처 ──────────────────────────────────────────────────────────────

@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def levels(db):
    """운영레벨 설정을 알려진 값으로 고정했다가 원복한다."""
    from app.routers.ui_settings import OPERATION_LEVELS_KEY
    row = db.query(AppSetting).filter(AppSetting.key == OPERATION_LEVELS_KEY).first()
    had_row = row is not None
    old = row.value if had_row else None
    if not had_row:
        row = AppSetting(key=OPERATION_LEVELS_KEY, value={})
        db.add(row)
    row.value = {"levels": [
        {"value": "production", "label": "운영", "color": "red", "guarded": True},
        {"value": "staging", "label": "스테이징", "color": "amber", "guarded": False},
        {"value": "dev", "label": "개발", "color": "blue", "guarded": False},
        {"value": "xguard", "label": "보호", "color": "red", "guarded": True},
        {"value": "dr", "label": "DR", "color": "purple"},  # 구버전 데이터 — guarded 없음
    ]}
    db.commit()
    yield
    row = db.query(AppSetting).filter(AppSetting.key == OPERATION_LEVELS_KEY).first()
    if had_row:
        row.value = old
    else:
        db.delete(row)
    db.commit()


@pytest.fixture
def world(db):
    tag = uuid.uuid4().hex[:8]
    guarded = Cluster(name=f"r13g-{tag}", api_endpoint="https://g:6443",
                      node_ips=json.dumps([HOST]), operation_level="production")
    free = Cluster(name=f"r13f-{tag}", api_endpoint="https://f:6443", operation_level="staging")
    users = {
        key: User(username=f"r13{key}-{tag}", hashed_password="x", role=role, is_active=True)
        for key, role in (("admin", "admin"), ("operator", "operator"))
    }
    db.add_all([guarded, free, *users.values()])
    db.commit()
    yield {"guarded": guarded, "free": free, **users}
    uids = [u.id for u in users.values()]
    db.query(AuditLog).filter(AuditLog.actor_user_id.in_(uids)).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id.in_([guarded.id, free.id])).delete(synchronize_session=False)
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


def _token(user):
    from app.auth.security import create_access_token
    return create_access_token(user.username, role=user.role)


def _audits(db, user, action):
    db.expire_all()
    return (db.query(AuditLog)
            .filter(AuditLog.actor_user_id == user.id, AuditLog.action == action)
            .order_by(AuditLog.created_at.asc()).all())


# ── 2. k9s 보호 레벨 readonly 강제 ───────────────────────────────────────────

def test_operation_level_guarded_resolution(db, levels):
    from app.routers.k9s_ssh import is_operation_level_guarded
    assert is_operation_level_guarded(db, "production")
    assert is_operation_level_guarded(db, "xguard")
    assert is_operation_level_guarded(db, "dr")  # guarded 없음 → default_guarded
    assert not is_operation_level_guarded(db, "staging")
    assert not is_operation_level_guarded(db, "dev")
    assert not is_operation_level_guarded(db, "")
    assert not is_operation_level_guarded(db, None)
    assert not is_operation_level_guarded(db, "unknown-level")


def test_k9s_effective_readonly_helper():
    from app.routers.k9s_ssh import k9s_effective_readonly
    op = User(username="o", role="operator")
    admin = User(username="a", role="admin")
    assert k9s_effective_readonly(False, op, guarded=True) is True
    assert k9s_effective_readonly(False, admin, guarded=True) is False
    assert k9s_effective_readonly(True, admin, guarded=True) is True
    assert k9s_effective_readonly(False, op, guarded=False) is False
    assert k9s_effective_readonly(True, op, guarded=False) is True


def _k9s_session(monkeypatch, user, cluster, init_extra=None):
    """bridge_pty 를 모킹해 실제로 조립된 k9s 명령을 돌려받는다."""
    from fastapi.testclient import TestClient

    import app.routers.k9s_ssh as mod
    from app.main import app
    seen = {}

    async def _bridge(websocket, init, *, command=None, on_open=None, **kw):
        seen["command"] = command
        if on_open:
            on_open()
        return 0.1

    monkeypatch.setattr(mod, "bridge_pty", _bridge)
    client = TestClient(app)
    with client.websocket_connect(f"/api/v1/k8s/{cluster.id}/k9s?token={_token(user)}") as ws:
        ws.send_text(json.dumps({"type": "init", "host": HOST, "password": "pw", "readonly": False,
                                 **(init_extra or {})}))
        with pytest.raises(WebSocketDisconnect):
            for _ in range(5):
                ws.receive_text()
    return seen.get("command") or ""


def test_k9s_guarded_cluster_forces_readonly_for_operator(monkeypatch, db, levels, world):
    cmd = _k9s_session(monkeypatch, world["operator"], world["guarded"])
    assert "--readonly" in cmd
    rows = _audits(db, world["operator"], "k9s.ssh.open")
    assert rows and rows[-1].details["readonly"] is True
    assert rows[-1].details.get("readonly_forced") == "guarded_level"


def test_k9s_guarded_cluster_admin_may_disable_readonly(monkeypatch, db, levels, world):
    cmd = _k9s_session(monkeypatch, world["admin"], world["guarded"])
    assert cmd and "--readonly" not in cmd


def test_k9s_unguarded_cluster_respects_request(monkeypatch, db, levels, world):
    cmd = _k9s_session(monkeypatch, world["operator"], world["free"])
    assert cmd and "--readonly" not in cmd


# ── 3. 클러스터 operation_level 변경 권한 ────────────────────────────────────

def test_operator_cannot_move_cluster_into_or_out_of_guarded_level(client_as, db, levels, world):
    op = client_as(world["operator"])
    r = op.put(f"/api/v1/clusters/{world['guarded'].id}", json={"operation_level": "dev"})
    assert r.status_code == 403 and "admin" in r.json()["detail"]
    r = op.put(f"/api/v1/clusters/{world['free'].id}", json={"operation_level": "xguard"})
    assert r.status_code == 403
    db.expire_all()
    assert db.get(Cluster, world["guarded"].id).operation_level == "production"
    assert db.get(Cluster, world["free"].id).operation_level == "staging"


def test_operator_may_change_between_unguarded_levels_and_keep_guarded(client_as, db, levels, world):
    op = client_as(world["operator"])
    assert op.put(f"/api/v1/clusters/{world['free'].id}", json={"operation_level": "dev"}).status_code == 200
    # 값이 바뀌지 않으면(같은 보호 레벨 재전송) 허용
    r = op.put(f"/api/v1/clusters/{world['guarded'].id}",
               json={"operation_level": "production", "description": "x"})
    assert r.status_code == 200


def test_admin_may_change_guarded_level(client_as, db, levels, world):
    admin = client_as(world["admin"])
    assert admin.put(f"/api/v1/clusters/{world['guarded'].id}",
                     json={"operation_level": "dev"}).status_code == 200
    assert admin.put(f"/api/v1/clusters/{world['free'].id}",
                     json={"operation_level": "xguard"}).status_code == 200


# ── 4. k8s pod exec 감사 마스킹 ──────────────────────────────────────────────

@pytest.fixture
def fake_kubeconfig(monkeypatch):
    import app.routers.k8s_exec as mod
    fd, path = tempfile.mkstemp(suffix=".yaml")
    os.close(fd)
    monkeypatch.setattr(mod, "ensure_kubeconfig_file", lambda c: path)
    yield mod
    os.unlink(path)


def _exec_ws(user, cluster, command):
    from fastapi.testclient import TestClient

    from app.main import app
    client = TestClient(app)
    url = (f"/api/v1/k8s/{cluster.id}/exec?namespace=default&pod=p"
           f"&command={quote(command)}&token={_token(user)}")
    with client.websocket_connect(url) as ws:
        with pytest.raises(WebSocketDisconnect):
            for _ in range(5):
                ws.receive_text()


def test_k8s_exec_failure_audit_masks_command_and_error(monkeypatch, db, world, fake_kubeconfig):
    def _boom(**kw):
        raise RuntimeError("auth failed TOKEN=abc123secret")

    monkeypatch.setattr(fake_kubeconfig.k8s_config, "new_client_from_config", _boom)
    _exec_ws(world["operator"], world["free"], "env PASSWORD=hunter2 sh")
    rows = _audits(db, world["operator"], "k8s.exec.open")
    assert rows and rows[-1].status == "failure"
    details = rows[-1].details
    assert "hunter2" not in details["command"] and "****" in details["command"]
    assert "abc123secret" not in details["error"] and "****" in details["error"]


def test_k8s_exec_success_audit_masks_command(monkeypatch, db, world, fake_kubeconfig):
    class _Resp:
        def is_open(self):
            return False

        def close(self):
            pass

    monkeypatch.setattr(fake_kubeconfig.k8s_config, "new_client_from_config", lambda **kw: object())
    class _Core:
        connect_get_namespaced_pod_exec = object()

    monkeypatch.setattr(fake_kubeconfig.k8s_client, "CoreV1Api", lambda api_client=None: _Core())
    monkeypatch.setattr(fake_kubeconfig, "k8s_stream", lambda *a, **kw: _Resp())
    _exec_ws(world["operator"], world["free"], "mysql --password=s3cr3t")
    rows = _audits(db, world["operator"], "k8s.exec.open")
    assert rows and rows[-1].status == "success"
    assert "s3cr3t" not in rows[-1].details["command"]
    assert "--password=****" in rows[-1].details["command"]
