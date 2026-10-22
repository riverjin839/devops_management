"""R-4 15차 A-1·A-2·A-17 — 온톨로지 쓰기·영향 분석 권한, 이름 검증, 영향 분석 기록 분류, RAG 필터.

- 엔티티·관계 생성: operator 이상 + 본문 cluster_id 에 operate. 감사 ontology.entity/relationship.create.
- 영향 분석: 본문 cluster_id 에 read. 항상 category="impact_simulation", severity="info" 로 기록.
- 이름·버전·외부 ID·관계 유형에 '<' '>' 제어문자 금지(422).
- RAG 온톨로지 이벤트 검색: impact_simulation 제외 + 클러스터 가시 범위 필터.
실제 Postgres(pgvector)로 검증한다.
"""
import os
import uuid
from types import SimpleNamespace as NS

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from fastapi.testclient import TestClient  # noqa: E402

from app.auth.deps import get_current_user  # noqa: E402
from app.config import settings  # noqa: E402
from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations, app  # noqa: E402
from app.models.audit_log import AuditLog  # noqa: E402
from app.models.cluster import Cluster  # noqa: E402
from app.models.ontology import OntologyEntity, OntologyEntityType, OntologyEvent  # noqa: E402
from app.models.tenant import ClusterBinding, Tenant, TenantMember  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services import rag_service  # noqa: E402
from app.services.cluster_access import ClusterScope  # noqa: E402
from app.services.llm import service as llm_service_module  # noqa: E402
from app.services.llm.service import llm_tenant_context  # noqa: E402


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
    """bound: 테넌트 T 에 바인딩된 클러스터. free: 바인딩 없는 클러스터.

    reader = T 의 read 멤버(viewer), op_read = read 바인딩만 가진 operator,
    op_member = operate 바인딩 operator, outsider = 비멤버 operator, viewer = 비멤버 viewer.
    """
    tag = uuid.uuid4().hex[:8]
    roles = {"admin": "admin", "op_member": "operator", "op_read": "operator",
             "outsider": "operator", "reader": "viewer", "viewer": "viewer"}
    users = {k: User(username=f"{k}-{tag}", hashed_password="x", role=r) for k, r in roles.items()}
    t_op = Tenant(name=f"onto-op-{tag}")
    t_ro = Tenant(name=f"onto-ro-{tag}")
    bound = Cluster(name=f"onto-b-{tag}", api_endpoint="https://b:6443")
    free = Cluster(name=f"onto-f-{tag}", api_endpoint="https://f:6443")
    db.add_all([t_op, t_ro, bound, free, *users.values()])
    db.commit()
    db.add_all([
        TenantMember(tenant_id=t_op.id, user_id=users["op_member"].id),
        TenantMember(tenant_id=t_ro.id, user_id=users["op_read"].id),
        TenantMember(tenant_id=t_ro.id, user_id=users["reader"].id),
        ClusterBinding(tenant_id=t_op.id, cluster_id=bound.id, access="operate"),
        ClusterBinding(tenant_id=t_ro.id, cluster_id=bound.id, access="read"),
    ])
    db.commit()
    snap = {k: NS(id=u.id, username=u.username, role=u.role) for k, u in users.items()}
    yield {"tag": tag, "bound": bound.id, "free": free.id, "t_op": t_op.id, **snap}

    db.rollback()
    uids = [u.id for u in snap.values()]
    db.query(AuditLog).filter(AuditLog.actor_user_id.in_(uids)).delete(synchronize_session=False)
    db.query(ClusterBinding).filter(ClusterBinding.cluster_id == bound.id).delete(synchronize_session=False)
    db.query(TenantMember).filter(TenantMember.user_id.in_(uids)).delete(synchronize_session=False)
    db.query(Tenant).filter(Tenant.name.like(f"%{tag}%")).delete(synchronize_session=False)
    # 엔티티·관계·이벤트는 clusters FK ON DELETE CASCADE
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


def _entity(db, cluster_id, name="cfg") -> OntologyEntity:
    e = OntologyEntity(cluster_id=cluster_id, entity_type=OntologyEntityType.config_item,
                       name=name, properties={})
    db.add(e)
    db.commit()
    db.refresh(e)
    return e


def _entity_type() -> str:
    return OntologyEntityType.config_item.value


# ── A-1: 엔티티·관계 생성 권한 ──────────────────────────────────────────────────

def test_entity_create_viewer_forbidden(world, as_user):
    r = as_user(world["viewer"]).post("/api/v1/ontology/entities", json={
        "cluster_id": str(world["free"]), "entity_type": _entity_type(), "name": "x"})
    assert r.status_code == 403


def test_entity_create_outsider_forbidden_on_bound_cluster(world, as_user):
    r = as_user(world["outsider"]).post("/api/v1/ontology/entities", json={
        "cluster_id": str(world["bound"]), "entity_type": _entity_type(), "name": "x"})
    assert r.status_code == 403
    assert "권한" in r.json()["detail"]


def test_entity_create_read_member_forbidden(world, as_user):
    r = as_user(world["op_read"]).post("/api/v1/ontology/entities", json={
        "cluster_id": str(world["bound"]), "entity_type": _entity_type(), "name": "x"})
    assert r.status_code == 403


def test_entity_create_operate_member_ok_and_audited(db, world, as_user):
    r = as_user(world["op_member"]).post("/api/v1/ontology/entities", json={
        "cluster_id": str(world["bound"]), "entity_type": _entity_type(), "name": "kube-proxy"})
    assert r.status_code == 200, r.text
    db.expire_all()
    row = (db.query(AuditLog)
           .filter(AuditLog.action == "ontology.entity.create",
                   AuditLog.actor_user_id == world["op_member"].id).first())
    assert row is not None and row.details["entity_id"] == r.json()["id"]
    assert row.tenant_id == str(world["t_op"])


def test_relationship_create_permissions_and_audit(db, world, as_user):
    a = _entity(db, world["bound"], "a")
    b = _entity(db, world["bound"], "b")
    body = {"cluster_id": str(world["bound"]), "source_entity_id": str(a.id),
            "relation_type": "depends_on", "target_entity_id": str(b.id)}
    assert as_user(world["viewer"]).post("/api/v1/ontology/relationships", json=body).status_code == 403
    assert as_user(world["outsider"]).post("/api/v1/ontology/relationships", json=body).status_code == 403
    assert as_user(world["op_read"]).post("/api/v1/ontology/relationships", json=body).status_code == 403
    r = as_user(world["op_member"]).post("/api/v1/ontology/relationships", json=body)
    assert r.status_code == 200, r.text
    db.expire_all()
    assert db.query(AuditLog).filter(AuditLog.action == "ontology.relationship.create",
                                     AuditLog.actor_user_id == world["op_member"].id).count() == 1


# ── A-2: 표시 문자열 검증 ───────────────────────────────────────────────────────

@pytest.mark.parametrize("field,value", [
    ("name", "<img src=x onerror=alert(1)>"),
    ("name", "line\nbreak"),
    ("name", "   "),
    ("version", "1.0>"),
    ("external_id", "id\x00"),
])
def test_entity_display_text_rejected(world, as_user, field, value):
    body = {"cluster_id": str(world["free"]), "entity_type": _entity_type(), "name": "ok"}
    body[field] = value
    r = as_user(world["admin"]).post("/api/v1/ontology/entities", json=body)
    assert r.status_code == 422


def test_relationship_type_rejects_markup(db, world, as_user):
    a = _entity(db, world["free"], "a")
    b = _entity(db, world["free"], "b")
    r = as_user(world["admin"]).post("/api/v1/ontology/relationships", json={
        "cluster_id": str(world["free"]), "source_entity_id": str(a.id),
        "relation_type": "<b>x</b>", "target_entity_id": str(b.id)})
    assert r.status_code == 422


# ── A-1·A-17: 영향 분석 ────────────────────────────────────────────────────────

def test_impact_requires_read_and_records_simulation(db, world, as_user, monkeypatch):
    cfg = _entity(db, world["bound"], "sysctl")
    queued: list = []
    try:
        from app import celery_app as ca
        monkeypatch.setattr(ca.compute_ontology_event_embedding, "delay", lambda *a, **k: queued.append(a))
    except Exception:  # noqa: BLE001
        pass
    body = {"cluster_id": str(world["bound"]), "config_entity_id": str(cfg.id),
            "category": "config_change", "severity": "warning", "title": "what-if"}
    assert as_user(world["viewer"]).post("/api/v1/ontology/impact", json=body).status_code == 403
    r = as_user(world["reader"]).post("/api/v1/ontology/impact", json=body)
    assert r.status_code == 200, r.text
    db.expire_all()
    ev = db.query(OntologyEvent).filter(OntologyEvent.id == r.json()["event_id"]).one()
    assert ev.category == "impact_simulation" and ev.severity == "info"
    assert ev.evidence.get("requested") == {"category": "config_change", "severity": "warning"}
    assert queued == []  # 가정 분석은 RAG 임베딩을 큐잉하지 않는다


def test_impact_category_optional(db, world, as_user):
    cfg = _entity(db, world["free"], "cm")
    r = as_user(world["viewer"]).post("/api/v1/ontology/impact", json={
        "cluster_id": str(world["free"]), "config_entity_id": str(cfg.id), "title": "what-if"})
    assert r.status_code == 200, r.text


# ── A-17: RAG 온톨로지 이벤트 필터 ─────────────────────────────────────────────

DIM = settings.embedding_dim


def _vec(axis: int) -> list[float]:
    v = [0.0] * DIM
    v[axis] = 1.0
    return v


@pytest.fixture
def rag_events(db, world, monkeypatch):
    async def _fake_embed(self, text, *, db=None):
        return _vec(7)
    monkeypatch.setattr(llm_service_module.LLMService, "embed", _fake_embed)
    sim = OntologyEvent(cluster_id=world["free"], category="impact_simulation", severity="info",
                        title=f"sim-{world['tag']}", embedding=_vec(7))
    free_ev = OntologyEvent(cluster_id=world["free"], category="config_change", severity="warning",
                            title=f"free-{world['tag']}", embedding=_vec(7))
    bound_ev = OntologyEvent(cluster_id=world["bound"], category="config_change", severity="warning",
                             title=f"bound-{world['tag']}", embedding=_vec(7))
    db.add_all([sim, free_ev, bound_ev])
    db.commit()
    return {"sim": str(sim.id), "free": str(free_ev.id), "bound": str(bound_ev.id)}


async def _ids(db, **kw) -> set[str]:
    res = await rag_service.retrieve(db, "구성 변경", k=200, source_types=["ontology_event"], **kw)
    return {c["ref_id"] for c in res}


async def test_rag_excludes_impact_simulation_and_bound_by_default(db, rag_events):
    ids = await _ids(db)
    assert rag_events["free"] in ids
    assert rag_events["sim"] not in ids
    assert rag_events["bound"] not in ids  # 사용자 맥락 없음 → fail-closed


async def test_rag_tenant_context_reveals_bound_cluster(db, world, rag_events):
    with llm_tenant_context({"id": str(world["t_op"]), "name": "t", "routing": {}}):
        ids = await _ids(db)
    assert rag_events["bound"] in ids and rag_events["sim"] not in ids


async def test_rag_cluster_scope(db, world, rag_events):
    assert rag_events["bound"] in await _ids(db, cluster_scope=ClusterScope(frozenset()))
    hidden = await _ids(db, cluster_scope=ClusterScope(frozenset({world["bound"]})))
    assert rag_events["bound"] not in hidden and rag_events["free"] in hidden
