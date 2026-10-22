"""R-4 15차 A-3·A-13·A-15 — 서비스 아키텍처 문서 권한, 조회 무생성, 배치 id 필터, LLM 실패 사유.

- 목록: cluster_id 없으면 admin 만(그 외 422 + 한국어 사유), 있으면 그 클러스터 read.
- 조회(문서·감사) = read, 동기화·재생성·편집 = operator + operate, schedule PUT = admin.
- GET 문서는 행을 만들지 않는다 — 없으면 has_doc=False 빈 문서.
- layout PATCH 는 문서 노드(auto·manual)가 아닌 id 를 버린다.
- llm_status: offline(연결 불가)/error(그 외 실패, 사유 llm_error)/failed(노드 없음), pending 10분 초과 → error.
- LLM 호출은 클러스터 소유 테넌트 라우팅 컨텍스트 안에서 나간다.
"""
import os
import uuid
from datetime import datetime, timedelta
from types import SimpleNamespace as NS

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.auth.deps import get_current_user  # noqa: E402
from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations, app  # noqa: E402
from app.models import LakeService  # noqa: E402
from app.models.audit_log import AuditLog  # noqa: E402
from app.models.cluster import Cluster  # noqa: E402
from app.models.service_arch_doc import ServiceArchDoc  # noqa: E402
from app.models.tenant import ClusterBinding, Tenant, TenantMember  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services import architecture_doc_service as ads  # noqa: E402
from app.services.llm.base import LLMResult  # noqa: E402
from app.services.llm import service as llm_mod  # noqa: E402


@pytest.fixture(scope="module")
def _schema():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    _run_migrations()


@pytest.fixture
def db(_schema):
    s = SessionLocal()
    yield s
    s.rollback()
    s.close()


@pytest.fixture
def world(db):
    tag = uuid.uuid4().hex[:8]
    roles = {"admin": "admin", "op_member": "operator", "op_read": "operator",
             "outsider": "operator", "reader": "viewer", "viewer": "viewer"}
    users = {k: User(username=f"{k}-{tag}", hashed_password="x", role=r) for k, r in roles.items()}
    t_op = Tenant(name=f"arch-op-{tag}", llm_routing={"arch_doc": {"primary": "p-tenant"}})
    t_ro = Tenant(name=f"arch-ro-{tag}")
    bound = Cluster(name=f"arch-b-{tag}", api_endpoint="https://b:6443")
    free = Cluster(name=f"arch-f-{tag}", api_endpoint="https://f:6443")
    db.add_all([t_op, t_ro, bound, free, *users.values()])
    db.commit()
    svc_b = LakeService(cluster_id=bound.id, service_type="airflow", name=f"af-{tag}",
                        endpoint_url="http://af:8080", namespace="ns1")
    svc_f = LakeService(cluster_id=free.id, service_type="trino", name=f"tr-{tag}",
                        endpoint_url="http://tr:8080", namespace="ns2")
    db.add_all([
        svc_b, svc_f,
        TenantMember(tenant_id=t_op.id, user_id=users["op_member"].id),
        TenantMember(tenant_id=t_ro.id, user_id=users["op_read"].id),
        TenantMember(tenant_id=t_ro.id, user_id=users["reader"].id),
        ClusterBinding(tenant_id=t_op.id, cluster_id=bound.id, access="operate"),
        ClusterBinding(tenant_id=t_ro.id, cluster_id=bound.id, access="read"),
    ])
    db.commit()
    snap = {k: NS(id=u.id, username=u.username, role=u.role) for k, u in users.items()}
    yield {"tag": tag, "bound": bound.id, "free": free.id, "t_op": t_op.id,
           "svc_b": svc_b.id, "svc_f": svc_f.id, **snap}

    db.rollback()
    uids = [u.id for u in snap.values()]
    db.query(AuditLog).filter(AuditLog.actor_user_id.in_(uids)).delete(synchronize_session=False)
    db.query(ClusterBinding).filter(ClusterBinding.cluster_id == bound.id).delete(synchronize_session=False)
    db.query(TenantMember).filter(TenantMember.user_id.in_(uids)).delete(synchronize_session=False)
    db.query(Tenant).filter(Tenant.name.like(f"%{tag}%")).delete(synchronize_session=False)
    # lake_services·service_arch_docs·topology_audit_logs 는 clusters FK ON DELETE CASCADE
    db.query(Cluster).filter(Cluster.id.in_([bound.id, free.id])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(uids)).delete(synchronize_session=False)
    db.commit()


@pytest.fixture
def as_user():
    client = TestClient(app)

    def _set(user):
        app.dependency_overrides[get_current_user] = lambda: user
        return client

    yield _set
    app.dependency_overrides.pop(get_current_user, None)


def _graph():
    return {"nodes": [
        {"id": "Deployment/ns1/web", "kind": "Deployment", "name": "web", "namespace": "ns1", "status": "healthy"},
        {"id": "Service/ns1/websvc", "kind": "Service", "name": "websvc", "namespace": "ns1", "status": "healthy"},
    ], "edges": [], "warnings": [], "truncated": False}


def _make_doc(db, service_id, *, graph=True, **fields) -> ServiceArchDoc:
    service = db.query(LakeService).filter(LakeService.id == service_id).one()
    doc = ads.get_or_create_doc(db, service)
    if graph:
        doc.auto_graph = _graph()
    for k, v in fields.items():
        setattr(doc, k, v)
    db.commit()
    db.refresh(doc)
    return doc


BASE = "/api/v1/architecture-docs"


# ── 목록 ─────────────────────────────────────────────────────────────────────

def test_list_without_cluster_is_admin_only(world, as_user):
    r = as_user(world["op_member"]).get(BASE)
    assert r.status_code == 422
    assert "cluster_id" in r.json()["detail"] and "관리자" in r.json()["detail"]
    r = as_user(world["admin"]).get(BASE)
    assert r.status_code == 200
    assert {str(world["svc_b"]), str(world["svc_f"])} <= {x["service_id"] for x in r.json()}


def test_list_with_cluster_requires_read(world, as_user):
    assert as_user(world["outsider"]).get(BASE, params={"cluster_id": str(world["bound"])}).status_code == 403
    r = as_user(world["reader"]).get(BASE, params={"cluster_id": str(world["bound"])})
    assert r.status_code == 200
    assert [x["service_id"] for x in r.json()] == [str(world["svc_b"])]


# ── 조회: 권한 + 행 무생성 ─────────────────────────────────────────────────────

def test_get_doc_does_not_create_row(db, world, as_user):
    r = as_user(world["viewer"]).get(f"{BASE}/{world['svc_f']}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["has_doc"] is False and body["id"] is None and body["updated_at"] is None
    assert body["service_id"] == str(world["svc_f"]) and body["cluster_id"] == str(world["free"])
    assert body["llm_status"] == "none" and body["llm_error"] is None
    assert body["last_sync_status"] == "pending" and body["manual_nodes"] == []
    db.expire_all()
    assert db.query(ServiceArchDoc).filter(ServiceArchDoc.lake_service_id == world["svc_f"]).count() == 0


def test_get_doc_and_audit_require_read(db, world, as_user):
    _make_doc(db, world["svc_b"])
    assert as_user(world["outsider"]).get(f"{BASE}/{world['svc_b']}").status_code == 403
    assert as_user(world["outsider"]).get(f"{BASE}/{world['svc_b']}/audit").status_code == 403
    r = as_user(world["reader"]).get(f"{BASE}/{world['svc_b']}")
    assert r.status_code == 200 and r.json()["has_doc"] is True
    assert as_user(world["reader"]).get(f"{BASE}/{world['svc_b']}/audit").status_code == 200


# ── 쓰기: operator + operate ───────────────────────────────────────────────────

def test_writes_require_operator_and_operate(db, world, as_user):
    sid = world["svc_b"]
    writes = [
        ("post", f"{BASE}/{sid}/sync", None),
        ("post", f"{BASE}/{sid}/llm-regenerate", None),
        ("patch", f"{BASE}/{sid}", {"summary_override": "x"}),
        ("patch", f"{BASE}/{sid}/layout", {"view": "architecture", "positions": []}),
        ("post", f"{BASE}/{sid}/manual-nodes", {"label": "외부 DB", "kind": "database"}),
        ("post", f"{BASE}/{sid}/manual-edges", {"source_id": "a", "target_id": "b"}),
    ]
    for who in ("reader", "viewer", "outsider", "op_read"):
        c = as_user(world[who])
        for method, url, body in writes:
            r = getattr(c, method)(url, json=body) if body is not None else getattr(c, method)(url)
            assert r.status_code == 403, (who, method, url, r.status_code)
    db.expire_all()
    # 거부된 쓰기는 문서 행도 만들지 않는다
    assert db.query(ServiceArchDoc).filter(ServiceArchDoc.lake_service_id == sid).count() == 0

    r = as_user(world["op_member"]).post(f"{BASE}/{sid}/manual-nodes", json={"label": "외부 DB"})
    assert r.status_code == 201, r.text


def test_schedule_put_is_admin_only_and_audited(db, world, as_user):
    body = {"enabled": True, "cron": "15 4 * * *"}
    assert as_user(world["op_member"]).put(f"{BASE}/schedule", json=body).status_code == 403
    assert as_user(world["viewer"]).get(f"{BASE}/schedule").status_code == 200
    prev = as_user(world["admin"]).get(f"{BASE}/schedule").json()
    try:
        r = as_user(world["admin"]).put(f"{BASE}/schedule", json=body)
        assert r.status_code == 200 and r.json()["cron"] == "15 4 * * *"
        db.expire_all()
        row = (db.query(AuditLog).filter(AuditLog.action == "arch_doc.schedule.update",
                                         AuditLog.actor_user_id == world["admin"].id).first())
        assert row is not None and row.details["after"]["cron"] == "15 4 * * *"
    finally:
        ads.set_schedule(db, prev["enabled"], prev["cron"])


# ── A-13: layout id 필터 ──────────────────────────────────────────────────────

def test_layout_drops_unknown_node_ids(db, world, as_user):
    _make_doc(db, world["svc_f"])
    c = as_user(world["op_member"])
    node = c.post(f"{BASE}/{world['svc_f']}/manual-nodes", json={"label": "ext"}).json()
    r = c.patch(f"{BASE}/{world['svc_f']}/layout", json={"view": "flow", "positions": [
        {"id": "Deployment/ns1/web", "x": 1, "y": 2},
        {"id": node["node_id"], "x": 3, "y": 4},
        {"id": "Deployment/other-module/api", "x": 9, "y": 9},
    ]})
    assert r.status_code == 200, r.text
    assert r.json()["layout"]["flow"] == {
        "Deployment/ns1/web": {"x": 1.0, "y": 2.0},
        node["node_id"]: {"x": 3.0, "y": 4.0},
    }


# ── A-15: LLM 상태·사유 ──────────────────────────────────────────────────────

def _fake_llm(monkeypatch, result: LLMResult, seen: list | None = None):
    async def _chat(purpose, prompt, **kw):
        if seen is not None:
            seen.append((purpose, llm_mod.current_llm_tenant()))
        return result
    # 클래스가 아니라 싱글톤 인스턴스에 건다 — 다른 테스트의 monkeypatch 원복이 인스턴스 속성(bound method)을
    # 남기면 클래스 패치가 가려져 실제 LLM 경로로 빠진다(전체 실행에서만 실패하던 순서 의존).
    monkeypatch.setattr(llm_mod.llm_service, "chat_for_purpose", _chat)


@pytest.mark.parametrize("error,status,needle", [
    ("timeout_60s", "error", "시간 초과"),
    ("http_429", "error", "429"),
    ("auth_failed", "error", "인증"),
    ("connect_error", "offline", "연결할 수 없습니다"),
])
def test_llm_failure_status_and_reason(db, world, as_user, monkeypatch, error, status, needle):
    _make_doc(db, world["svc_f"])
    _fake_llm(monkeypatch, LLMResult(status="offline" if "timeout" in error or "connect" in error else "error",
                                     error=error, profile="p1", model="m1"))
    r = as_user(world["op_member"]).post(f"{BASE}/{world['svc_f']}/llm-regenerate")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["llm_status"] == status
    assert needle in body["llm_error"] and error in body["llm_error"]
    # 조회에서도 같은 사유
    again = as_user(world["viewer"]).get(f"{BASE}/{world['svc_f']}").json()
    assert again["llm_status"] == status and again["llm_error"] == body["llm_error"]


def test_llm_ok_clears_error_and_keeps_failed_no_nodes_reason(db, world, as_user, monkeypatch):
    _make_doc(db, world["svc_f"], graph=False)
    c = as_user(world["op_member"])
    body = c.post(f"{BASE}/{world['svc_f']}/llm-regenerate").json()
    assert body["llm_status"] == "failed" and "동기화" in body["llm_error"]

    _make_doc(db, world["svc_f"])
    _fake_llm(monkeypatch, LLMResult(status="ok", text='{"summary": "요약"}', model="m1", profile="p1"))
    body = c.post(f"{BASE}/{world['svc_f']}/llm-regenerate").json()
    assert body["llm_status"] == "ok" and body["llm_error"] is None
    assert body["llm_content"]["summary"] == "요약"


def test_llm_preserves_previous_content_on_failure(db, world, as_user, monkeypatch):
    _make_doc(db, world["svc_f"], llm_content={"summary": "이전", "components": [], "flow_steps": []},
              llm_status="ok")
    _fake_llm(monkeypatch, LLMResult(status="error", error="http_500", profile="p1"))
    body = as_user(world["op_member"]).post(f"{BASE}/{world['svc_f']}/llm-regenerate").json()
    assert body["llm_status"] == "error" and body["llm_content"]["summary"] == "이전"


def test_stale_pending_becomes_error_on_read(db, world, as_user):
    doc = _make_doc(db, world["svc_f"], llm_status="pending")
    db.execute(text("UPDATE service_arch_docs SET updated_at = :t WHERE id = :id"),
               {"t": datetime.utcnow() - timedelta(minutes=11), "id": doc.id})
    db.commit()
    # 목록은 표시만 error
    lst = as_user(world["viewer"]).get(BASE, params={"cluster_id": str(world["free"])}).json()
    assert next(x for x in lst if x["service_id"] == str(world["svc_f"]))["llm_status"] == "error"
    body = as_user(world["viewer"]).get(f"{BASE}/{world['svc_f']}").json()
    assert body["llm_status"] == "error" and "10분" in body["llm_error"]
    db.expire_all()
    assert db.query(ServiceArchDoc).filter(ServiceArchDoc.id == doc.id).one().llm_status == "error"


def test_fresh_pending_stays_pending(db, world, as_user):
    _make_doc(db, world["svc_f"], llm_status="pending")
    body = as_user(world["viewer"]).get(f"{BASE}/{world['svc_f']}").json()
    assert body["llm_status"] == "pending" and body["llm_error"] is None


def test_llm_runs_in_owner_tenant_context(db, world, as_user, monkeypatch):
    _make_doc(db, world["svc_b"])
    seen: list = []
    _fake_llm(monkeypatch, LLMResult(status="ok", text='{"summary": "s"}', model="m"), seen)
    r = as_user(world["admin"]).post(f"{BASE}/{world['svc_b']}/llm-regenerate")
    assert r.status_code == 200, r.text
    assert seen and seen[0][0] == "arch_doc"
    assert seen[0][1]["id"] == str(world["t_op"])
    assert seen[0][1]["routing"] == {"arch_doc": {"primary": "p-tenant"}}


def test_describe_llm_error_messages():
    assert "시간 초과" in ads.describe_llm_error("timeout_30s", profile="p")
    assert "프로필" in ads.describe_llm_error("no_enabled_profile")
    assert "[unknown]" in ads.describe_llm_error(None)
