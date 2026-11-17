"""DC 인벤토리 토폴로지 — 구간·클러스터 연결, 패브릭 계층(FA 코어 → super-spine → spine → leaf → 랙), 위치 저장."""
import uuid

import pytest

from tests.dc_inventory_helpers import API, client_as, make_rack, make_user, post, wipe

from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension  # noqa: E402
from app.models.cluster import Cluster  # noqa: E402
from app.models.dc_inventory import DcCanvasPosition, DcLink, DcZoneCluster  # noqa: E402
from app.models.user import User  # noqa: E402


def _wipe_topology(db):
    db.rollback()
    for model in (DcCanvasPosition, DcLink, DcZoneCluster):
        db.query(model).delete(synchronize_session=False)
    db.commit()
    wipe(db)


@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    _wipe_topology(session)
    yield session
    _wipe_topology(session)
    session.close()


@pytest.fixture
def env(db):
    users = {role: make_user(db, role) for role in ("operator", "viewer")}
    cluster = Cluster(name=f"dc-topo-{uuid.uuid4().hex[:6]}", api_endpoint="https://127.0.0.9:6443")
    db.add(cluster)
    db.commit()
    yield {"op": client_as(users["operator"]), "users": users, "cluster": cluster}
    from app.auth.deps import get_current_user
    from app.main import app
    app.dependency_overrides.pop(get_current_user, None)
    _wipe_topology(db)
    db.query(Cluster).filter(Cluster.id == cluster.id).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_([u.id for u in users.values()])).delete(synchronize_session=False)
    db.commit()


def _fabric(op):
    """FA 코어 1 · super-spine 1 · spine 1 · leaf 1(R01 의 ToR) + 서버 1."""
    rack = make_rack(op, "R01", rack_no=1)
    core = post(op, "devices", {"hostname": "fa-core-1", "role": "fa-core"})
    ss = post(op, "devices", {"hostname": "ss-1", "role": "super-spine"})
    spine = post(op, "devices", {"hostname": "spine-1", "role": "spine"})
    leaf = post(op, "devices", {"hostname": "leaf-r01-a", "role": "leaf", "rack_id": rack["id"], "position_u": 42})
    server = post(op, "devices", {"hostname": "node-1", "rack_id": rack["id"], "position_u": 1})
    return rack, core, ss, spine, leaf, server


def test_zone_definition_and_cluster_links(env, db):
    op, cluster = env["op"], env["cluster"]
    site = post(op, "sites", {"name": "DC1"})
    zone = post(op, "halls", {"site_id": site["id"], "name": "A 구간", "zone_no": 1, "description": "1층 동쪽"})
    link = post(op, "zone-clusters", {"hall_id": zone["id"], "cluster_id": str(cluster.id), "note": "운영"})
    dup = op.post(f"{API}/zone-clusters", json={"hall_id": zone["id"], "cluster_id": str(cluster.id)})
    assert dup.status_code == 409 and dup.json()["detail"] == "이미 연결돼 있습니다"
    bad = op.post(f"{API}/zone-clusters", json={"hall_id": zone["id"], "cluster_id": str(uuid.uuid4())})
    assert bad.status_code == 422

    topo = op.get(f"{API}/topology").json()
    z = next(x for x in topo["zones"] if x["id"] == zone["id"])
    assert (z["zone_no"], z["name"], z["description"]) == (1, "A 구간", "1층 동쪽")
    assert z["clusters"] == [{"link_id": link["id"], "cluster_id": str(cluster.id), "name": cluster.name,
                              "status": z["clusters"][0]["status"], "note": "운영"}]
    assert {"source": zone["id"], "type": "hosts", "target": str(cluster.id)} in topo["ontology"]["relationships"]
    assert {"source": site["id"], "type": "contains", "target": zone["id"]} in topo["ontology"]["relationships"]

    assert op.put(f"{API}/halls/{zone['id']}", json={"zone_no": 2, "name": "B 구간"}).status_code == 200
    assert op.delete(f"{API}/zone-clusters/{link['id']}").status_code == 204
    z = next(x for x in op.get(f"{API}/topology").json()["zones"] if x["id"] == zone["id"])
    assert (z["zone_no"], z["name"], z["clusters"]) == (2, "B 구간", [])


def test_fabric_hierarchy_links_only_go_downward(env):
    op = env["op"]
    rack, core, ss, spine, leaf, server = _fabric(op)
    post(op, "links", {"upper_device_id": core["id"], "lower_device_id": ss["id"]})
    post(op, "links", {"upper_device_id": ss["id"], "lower_device_id": spine["id"]})
    l3 = post(op, "links", {"upper_device_id": spine["id"], "lower_device_id": leaf["id"], "note": "2x100G"})

    up = op.post(f"{API}/links", json={"upper_device_id": leaf["id"], "lower_device_id": spine["id"]})
    assert up.status_code == 422 and up.json()["code"] == "tier_order"
    same = op.post(f"{API}/links", json={"upper_device_id": spine["id"], "lower_device_id": spine["id"]})
    assert same.status_code == 422
    srv = op.post(f"{API}/links", json={"upper_device_id": leaf["id"], "lower_device_id": server["id"]})
    assert srv.status_code == 422 and srv.json()["code"] == "not_fabric"
    again = op.post(f"{API}/links", json={"upper_device_id": spine["id"], "lower_device_id": leaf["id"]})
    assert again.status_code == 409

    topo = op.get(f"{API}/topology").json()
    assert {(f["hostname"], f["tier"]) for f in topo["fabric"]} == {
        ("fa-core-1", 0), ("ss-1", 1), ("spine-1", 2), ("leaf-r01-a", 3)}
    assert next(f for f in topo["fabric"] if f["hostname"] == "leaf-r01-a")["rack_name"] == "R01"
    edges = {(e["upper_id"], e["lower_id"]): e for e in topo["edges"]}
    assert set(edges) == {(core["id"], ss["id"]), (ss["id"], spine["id"]), (spine["id"], leaf["id"])}
    assert edges[(spine["id"], leaf["id"])] == {
        "upper_id": spine["id"], "lower_id": leaf["id"], "link_id": l3["id"], "note": "2x100G",
        "cable_count": 0, "kind": "logical"}
    # 랙 박스: ToR(leaf)이 맨 위, 서버가 U 순서대로
    box = next(r for r in topo["racks"] if r["id"] == rack["id"])
    assert [(d["hostname"], d["role"], d["u_range"]) for d in box["devices"]] == [
        ("leaf-r01-a", "leaf", "U42"), ("node-1", "server", "U1")]
    rels = topo["ontology"]["relationships"]
    assert {"source": spine["id"], "type": "uplink_to", "target": leaf["id"]} in rels
    assert {"source": rack["id"], "type": "contains", "target": server["id"]} in rels
    assert {e["type"] for e in topo["ontology"]["entities"]} >= {"site", "zone", "rack", "fa-core", "leaf", "server"}


def test_cables_between_fabric_devices_show_as_edges(env):
    op = env["op"]
    _, _, _, spine, leaf, _ = _fabric(op)
    a = post(op, "interfaces", {"device_id": leaf["id"], "name": "Ethernet1/49", "speed": "100G"})
    b = post(op, "interfaces", {"device_id": spine["id"], "name": "Ethernet1/1", "speed": "100G"})
    post(op, "cables", {"a_interface_id": a["id"], "b_interface_id": b["id"], "label": "UP-1"})
    edge = next(e for e in op.get(f"{API}/topology").json()["edges"] if e["lower_id"] == leaf["id"])
    assert (edge["upper_id"], edge["kind"], edge["cable_count"], edge["link_id"]) == (spine["id"], "cable", 1, None)
    link = post(op, "links", {"upper_device_id": spine["id"], "lower_device_id": leaf["id"]})
    edge = next(e for e in op.get(f"{API}/topology").json()["edges"] if e["lower_id"] == leaf["id"])
    assert (edge["kind"], edge["link_id"]) == ("both", link["id"])


def test_positions_persist_and_reset(env, db):
    op = env["op"]
    rack, core, *_ = _fabric(op)
    topo = op.get(f"{API}/topology").json()
    assert all(f["pinned"] is False and f["x"] is None for f in topo["fabric"])
    r = op.put(f"{API}/topology/positions", json={"positions": [
        {"object_type": "device", "object_id": core["id"], "x": 420.5, "y": 40},
        {"object_type": "rack", "object_id": rack["id"], "x": 100, "y": 600}]})
    assert r.status_code == 200 and r.json()["saved"] == 2
    op.put(f"{API}/topology/positions", json={"positions": [
        {"object_type": "device", "object_id": core["id"], "x": 500, "y": 60}]})          # 같은 노드는 덮어쓴다
    topo = op.get(f"{API}/topology").json()
    moved = next(f for f in topo["fabric"] if f["id"] == core["id"])
    assert (moved["x"], moved["y"], moved["pinned"]) == (500, 60, True)
    assert next(x for x in topo["racks"] if x["id"] == rack["id"])["pinned"] is True
    assert db.query(DcCanvasPosition).count() == 2

    viewer = client_as(env["users"]["viewer"])
    assert viewer.get(f"{API}/topology").status_code == 200
    assert viewer.put(f"{API}/topology/positions", json={"positions": []}).status_code == 403
    assert viewer.post(f"{API}/links", json={"upper_device_id": core["id"], "lower_device_id": core["id"]}).status_code == 403
    client_as(env["users"]["operator"])
    assert op.delete(f"{API}/topology/positions").json()["removed"] == 2
    assert all(f["pinned"] is False for f in op.get(f"{API}/topology").json()["fabric"])


def test_changes_are_logged_and_cluster_delete_policy_holds(env, db):
    op = env["op"]
    _, core, ss, *_ = _fabric(op)
    link = post(op, "links", {"upper_device_id": core["id"], "lower_device_id": ss["id"]})
    logs = op.get(f"{API}/changes", params={"object_type": "link", "object_id": link["id"]}).json()["items"]
    assert [x["action"] for x in logs] == ["create"]
    from app.services.cluster_purge import KEEP_ROWS, cluster_ref_tables, purge_order
    assert "dc_zone_clusters" in cluster_ref_tables()
    assert "dc_zone_clusters" in purge_order() and "dc_zone_clusters" not in KEEP_ROWS   # 연결 행은 클러스터와 함께 삭제
