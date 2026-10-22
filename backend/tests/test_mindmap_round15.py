"""15차 라운드(A-11·A-20) — 마인드맵 서버 계약 회귀 테스트.

- 수정 요청의 명시적 ``null`` 은 값 지우기(``model_fields_set``): 메모·색·Confluence URL·설명.
- 제목은 공백을 걷어낸 뒤 1자 이상(``null``·공백만 → 422).
- ``parent_id`` 는 같은 맵의 노드여야 하고 순환(자기 자신·자손)이면 422.
- 좌표 일괄 저장은 부분 목록을 받는다(보낸 노드만 바뀜).
- 맵·노드 삭제는 감사 기록(id·제목만)을 남긴다.
실제 DB 로 검증한다.
"""
import os
import uuid

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.database import SessionLocal, Base, engine
from app.main import _ensure_pgvector_extension, _run_migrations
from app.models.audit_log import AuditLog
from app.models.mindmap import MindMap, MindMapNode
from app.models.user import User


@pytest.fixture(scope="module")
def _schema():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    _run_migrations()


@pytest.fixture
def db(_schema):
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def world(db):
    tag = uuid.uuid4().hex[:8]
    user = User(username=f"mm-{tag}", hashed_password="x", role="operator")
    db.add(user)
    db.commit()
    m = MindMap(title=f"map-{tag}", description="desc", confluence_url="https://wiki.example/x")
    other = MindMap(title=f"other-{tag}")
    db.add_all([m, other])
    db.commit()
    root = MindMapNode(mindmap_id=m.id, label="root")
    db.add(root)
    db.commit()
    child = MindMapNode(mindmap_id=m.id, parent_id=root.id, label="child", note="memo", color="#ff0000")
    foreign = MindMapNode(mindmap_id=other.id, label="foreign")
    db.add_all([child, foreign])
    db.commit()
    grandchild = MindMapNode(mindmap_id=m.id, parent_id=child.id, label="grandchild")
    db.add(grandchild)
    db.commit()
    yield {"tag": tag, "user": user, "map": m, "other": other,
           "root": root, "child": child, "grandchild": grandchild, "foreign": foreign}

    db.rollback()
    map_ids = [r.id for r in db.query(MindMap.id).filter(MindMap.title.like(f"%{tag}%")).all()]
    if map_ids:
        db.query(MindMapNode).filter(MindMapNode.mindmap_id.in_(map_ids)).delete(synchronize_session=False)
        db.query(MindMap).filter(MindMap.id.in_(map_ids)).delete(synchronize_session=False)
    db.query(AuditLog).filter(AuditLog.actor_user_id == user.id).delete(synchronize_session=False)
    db.query(User).filter(User.id == user.id).delete(synchronize_session=False)
    db.commit()


@pytest.fixture
def client(world):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth.deps import get_current_user

    app.dependency_overrides[get_current_user] = lambda: world["user"]
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def _url(w, *parts):
    return "/".join([f"/api/v1/mindmaps/{w['map'].id}", *map(str, parts)]).rstrip("/")


# ── 맵 ──────────────────────────────────────────────────────────────────────

def test_map_update_null_clears_fields_and_omitted_fields_stay(client, world):
    r = client.put(_url(world), json={"confluence_url": None})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["confluence_url"] is None
    assert body["description"] == "desc"  # 보내지 않은 필드는 그대로
    assert body["title"] == f"map-{world['tag']}"

    r = client.put(_url(world), json={"description": None})
    assert r.status_code == 200
    assert r.json()["description"] is None


def test_map_update_empty_confluence_url_also_clears(client, world):
    r = client.put(_url(world), json={"confluence_url": "  "})
    assert r.status_code == 200
    assert r.json()["confluence_url"] is None


def test_map_title_is_stripped_and_required(client, world):
    tag = world["tag"]
    assert client.post("/api/v1/mindmaps/", json={"title": "   "}).status_code == 422
    assert client.post("/api/v1/mindmaps/", json={"title": ""}).status_code == 422
    r = client.post("/api/v1/mindmaps/", json={"title": f"  new-{tag}  "})
    assert r.status_code == 201
    assert r.json()["title"] == f"new-{tag}"

    assert client.put(_url(world), json={"title": "  "}).status_code == 422
    assert client.put(_url(world), json={"title": None}).status_code == 422
    r = client.put(_url(world), json={"title": f" renamed-{tag} "})
    assert r.status_code == 200
    assert r.json()["title"] == f"renamed-{tag}"


def test_map_delete_records_audit(client, world, db):
    mid = world["map"].id
    assert client.delete(_url(world)).status_code == 204
    row = db.query(AuditLog).filter(
        AuditLog.action == "mindmap.delete", AuditLog.target_id == str(mid)).first()
    assert row is not None
    assert row.target_type == "mindmap"
    assert row.details["title"] == f"map-{world['tag']}"
    assert row.details["node_count"] == 3
    assert set(row.details) <= {"title", "node_count", "request_id"}


# ── 노드 ────────────────────────────────────────────────────────────────────

def test_node_update_null_clears_memo_and_color(client, world):
    r = client.put(_url(world, "nodes", world["child"].id), json={"note": None, "color": None})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["note"] is None and body["color"] is None
    assert body["label"] == "child"


def test_node_update_rejects_null_for_required_fields(client, world):
    for field in ("label", "collapsed", "sort_order"):
        r = client.put(_url(world, "nodes", world["child"].id), json={field: None})
        assert r.status_code == 422, field


def test_node_create_rejects_parent_from_other_map_or_unknown(client, world):
    base = {"label": "n", "mindmap_id": str(world["map"].id)}
    r = client.post(_url(world, "nodes"), json={**base, "parent_id": str(world["foreign"].id)})
    assert r.status_code == 422
    r = client.post(_url(world, "nodes"), json={**base, "parent_id": str(uuid.uuid4())})
    assert r.status_code == 422
    r = client.post(_url(world, "nodes"), json={**base, "parent_id": str(world["child"].id)})
    assert r.status_code == 201
    assert r.json()["parent_id"] == str(world["child"].id)


def test_node_update_rejects_cycles_and_foreign_parent(client, world):
    root, child, grand = world["root"], world["child"], world["grandchild"]
    # 자기 자신
    assert client.put(_url(world, "nodes", child.id), json={"parent_id": str(child.id)}).status_code == 422
    # 자손(손자)을 부모로
    assert client.put(_url(world, "nodes", root.id), json={"parent_id": str(grand.id)}).status_code == 422
    assert client.put(_url(world, "nodes", child.id), json={"parent_id": str(grand.id)}).status_code == 422
    # 다른 맵 노드
    r = client.put(_url(world, "nodes", grand.id), json={"parent_id": str(world["foreign"].id)})
    assert r.status_code == 422
    # 정상 재배치 + null 은 루트로 승격
    r = client.put(_url(world, "nodes", grand.id), json={"parent_id": str(root.id)})
    assert r.status_code == 200 and r.json()["parent_id"] == str(root.id)
    r = client.put(_url(world, "nodes", grand.id), json={"parent_id": None})
    assert r.status_code == 200 and r.json()["parent_id"] is None


def test_positions_accept_partial_list(client, world, db):
    child = world["child"]
    r = client.patch(_url(world, "nodes", "positions"),
                     json=[{"id": str(child.id), "x": 11.5, "y": 22.0},
                           {"id": str(world["foreign"].id), "x": 99, "y": 99}])
    assert r.status_code == 200, r.text
    by_id = {n["id"]: n for n in r.json()}
    assert len(by_id) == 3
    assert by_id[str(child.id)]["x"] == 11.5 and by_id[str(child.id)]["y"] == 22.0
    assert by_id[str(world["root"].id)]["x"] is None  # 보내지 않은 노드는 그대로
    db.expire_all()
    assert db.get(MindMapNode, world["foreign"].id).x is None  # 다른 맵 노드는 무시


def test_node_delete_cascades_and_records_audit(client, world, db):
    child_id, map_id = world["child"].id, world["map"].id
    assert client.delete(_url(world, "nodes", child_id)).status_code == 204
    db.expire_all()
    remaining = {n.label for n in db.query(MindMapNode).filter(MindMapNode.mindmap_id == map_id)}
    assert remaining == {"root"}
    row = db.query(AuditLog).filter(
        AuditLog.action == "mindmap.node.delete", AuditLog.target_id == str(child_id)).first()
    assert row is not None
    assert row.target_type == "mindmap_node"
    assert row.details["label"] == "child"
    assert row.details["mindmap_id"] == str(map_id)
    assert row.details["deleted_count"] == 2
    assert "note" not in row.details and "color" not in row.details


# ── Confluence URL 스킴 ───────────────────────────────────────────────────────

@pytest.mark.parametrize("bad", ["javascript:alert(1)", "data:text/html,x", "ftp://wiki.example/x", "wiki.example/x"])
def test_confluence_url_must_be_http_or_empty(client, world, bad):
    assert client.put(_url(world), json={"confluence_url": bad}).status_code == 422
    assert client.post("/api/v1/mindmaps/", json={"title": f"x-{world['tag']}", "confluence_url": bad}).status_code == 422
    r = client.put(_url(world), json={"confluence_url": " https://wiki.example/p "})
    assert r.status_code == 200 and r.json()["confluence_url"] == "https://wiki.example/p"
    r = client.post("/api/v1/mindmaps/", json={"title": f"y-{world['tag']}", "confluence_url": ""})
    assert r.status_code == 201 and r.json()["confluence_url"] is None


# ── 동시 부모 변경 — 맵 행 잠금 ──────────────────────────────────────────────

def test_concurrent_reparent_waits_for_map_lock_and_rejects_cycle(client, world, db):
    """다른 트랜잭션이 맵을 잠근 채 P→Q 를 저장하는 동안 Q→P 요청은 기다렸다가, 커밋된 P→Q 를 보고 422."""
    import threading
    from fastapi.testclient import TestClient
    from app.main import app

    p = MindMapNode(mindmap_id=world["map"].id, label="P")
    q = MindMapNode(mindmap_id=world["map"].id, label="Q")
    db.add_all([p, q])
    db.commit()

    other = SessionLocal()
    try:
        other.query(MindMap).filter(MindMap.id == world["map"].id).with_for_update().one()
        other.query(MindMapNode).filter(MindMapNode.id == p.id).update({"parent_id": q.id})
        other.flush()

        result = {}

        def _put():
            result["status"] = TestClient(app).put(_url(world, "nodes", q.id), json={"parent_id": str(p.id)}).status_code

        t = threading.Thread(target=_put)
        t.start()
        t.join(timeout=1.0)
        assert t.is_alive(), "맵 잠금 없이 부모 검증이 먼저 끝났다"
        other.commit()
        t.join(timeout=15)
        assert not t.is_alive()
    finally:
        other.rollback()
        other.close()
    assert result["status"] == 422
    db.expire_all()
    assert db.get(MindMapNode, q.id).parent_id is None


def test_node_create_locks_map_row(client, world, db):
    """노드 생성도 맵 잠금을 기다린다(부모 검증과 저장 사이에 다른 재배치가 끼지 않게)."""
    import threading
    from fastapi.testclient import TestClient
    from app.main import app

    other = SessionLocal()
    try:
        # FOR NO KEY UPDATE — 노드 INSERT 의 FK 검사(KEY SHARE)와는 충돌하지 않고 라우터의 FOR UPDATE 와만
        # 충돌하므로, 요청이 기다린다면 그건 맵 잠금 때문이다.
        other.query(MindMap).filter(MindMap.id == world["map"].id).with_for_update(key_share=True).one()  # FOR NO KEY UPDATE
        result = {}

        def _post():
            result["status"] = TestClient(app).post(_url(world, "nodes"), json={
                "mindmap_id": str(world["map"].id), "label": "n", "parent_id": str(world["root"].id)}).status_code

        t = threading.Thread(target=_post)
        t.start()
        t.join(timeout=1.0)
        assert t.is_alive()
        other.commit()
        t.join(timeout=15)
    finally:
        other.rollback()
        other.close()
    assert result["status"] == 201
