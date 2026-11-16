"""DC 인벤토리 2단계 — 서버 단일 원본.

어느 화면(DC 인벤토리 · 노드 서버스펙 · 인프라 토폴로지)에서 고쳐도 겹치는 항목이 같은 값이 되는지,
기존 데이터 연결(미리보기 → 선택 적용)이 자동으로 값을 덮어쓰지 않는지 고정한다.
"""
import uuid

import pytest

from tests.dc_inventory_helpers import API, client_as, make_rack, make_type, make_user, post, wipe

from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension  # noqa: E402
from app.models.cluster import Cluster  # noqa: E402
from app.models.dc_inventory import DcDevice  # noqa: E402
from app.models.infra_node import InfraNode  # noqa: E402
from app.models.node_server_spec import NodeServerSpec  # noqa: E402
from app.models.user import User  # noqa: E402

SPECS = "/api/v1/node-specs"
INFRA = "/api/v1/infra-nodes"
SCOPES = {"X-API-Scopes": "infra_topology.read,infra_topology.edit,infra_topology.sync"}


@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    wipe(session)
    yield session
    wipe(session)
    session.close()


@pytest.fixture
def env(db):
    """admin 클라이언트 + 클러스터 2개. 끝나면 만든 서버스펙·인프라 노드·클러스터를 지운다."""
    admin = make_user(db, "admin")
    clusters = []
    for i in (1, 2):
        c = Cluster(name=f"dc-reg-{i}-{uuid.uuid4().hex[:6]}", api_endpoint=f"https://127.0.0.{i}:6443")
        db.add(c)
        clusters.append(c)
    db.commit()
    ids = [c.id for c in clusters]
    yield {"client": client_as(admin), "clusters": clusters, "admin": admin}
    from app.auth.deps import get_current_user
    from app.main import app
    app.dependency_overrides.pop(get_current_user, None)
    db.rollback()
    wipe(db)
    db.query(NodeServerSpec).filter(NodeServerSpec.hostname.like("reg-%")).delete(synchronize_session=False)
    db.query(InfraNode).filter(InfraNode.cluster_id.in_(ids)).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id.in_(ids)).delete(synchronize_session=False)
    db.query(User).filter(User.id == admin.id).delete(synchronize_session=False)
    db.commit()


def _spec(db, spec_id) -> NodeServerSpec:
    db.expire_all()
    return db.query(NodeServerSpec).filter(NodeServerSpec.id == spec_id).one()


def test_spec_create_registers_device_and_dc_edits_flow_back(env, db):
    c, cluster = env["client"], env["clusters"][0]
    rack = make_rack(c, "R07", rack_no=7)
    server = make_type(c)

    r = c.post(SPECS, json={"hostname": "reg-node-1", "cluster_id": str(cluster.id), "serial_number": "FAKE-SN-1"})
    assert r.status_code == 201, r.text
    spec_id, device_id = r.json()["id"], r.json()["device_id"]
    device = db.query(DcDevice).filter(DcDevice.id == device_id).one()
    assert (device.hostname, device.serial, device.cluster_id, device.rack_id) == ("reg-node-1", "FAKE-SN-1", cluster.id, None)

    # DC 인벤토리에서 랙·U·시리얼을 정하면 서버스펙의 구 컬럼이 같은 값이 된다
    r = c.put(f"{API}/devices/{device_id}", json={
        "device_type_id": server["id"], "rack_id": rack["id"], "position_u": 21, "serial": "FAKE-SN-1B"})
    assert r.status_code == 200, r.text
    spec = _spec(db, spec_id)
    assert (spec.rack, spec.rack_unit, spec.serial_number) == ("R07", "U21-U22", "FAKE-SN-1B")
    assert (spec.datacenter, spec.room) == ("DC-T", "Hall-1")

    # 랙 이름을 바꾸면 따라간다
    assert c.put(f"{API}/racks/{rack['id']}", json={"name": "R07-NEW"}).status_code == 200
    assert _spec(db, spec_id).rack == "R07-NEW"

    # DC 인벤토리에서 랙에서 빼면 서버스펙 위치도 비워진다
    assert c.put(f"{API}/devices/{device_id}", json={"rack_id": None}).status_code == 200
    spec = _spec(db, spec_id)
    assert spec.rack is None and spec.rack_unit is None

    # 연결 상태는 장비 상세에서 보인다
    detail = c.get(f"{API}/devices/{device_id}/detail").json()
    assert detail["linked"]["node_spec_ids"] == [spec_id]


def test_spec_edits_reach_device_and_conflicts_are_refused(env, db):
    c, cluster = env["client"], env["clusters"][0]
    rack = make_rack(c, "R08", rack_no=8)
    server = make_type(c)
    post(c, "devices", {"hostname": "occupier", "device_type_id": server["id"], "rack_id": rack["id"], "position_u": 21})

    spec = c.post(SPECS, json={"hostname": "reg-node-2", "cluster_id": str(cluster.id)}).json()
    device_id = spec["device_id"]
    c.put(f"{API}/devices/{device_id}", json={"device_type_id": server["id"]})

    # 서버스펙 화면에서 랙·U 를 적으면 장비가 그 자리로 간다
    r = c.put(f"{SPECS}/{spec['id']}", json={"rack": "R08", "rack_unit": "U11-U12", "serial_number": "FAKE-SN-2"})
    assert r.status_code == 200, r.text
    db.expire_all()
    device = db.query(DcDevice).filter(DcDevice.id == device_id).one()
    assert (str(device.rack_id), device.position_u, device.serial) == (rack["id"], 11, "FAKE-SN-2")

    # 이미 찬 U 로는 못 옮긴다 — 사유와 함께 거부, 서버스펙 값도 그대로
    r = c.put(f"{SPECS}/{spec['id']}", json={"rack_unit": "U22"})
    assert r.status_code == 409 and "occupier" in r.json()["detail"]
    assert _spec(db, spec["id"]).rack_unit == "U11-U12"

    # DC 인벤토리에 없는 랙 이름은 예전처럼 자유 입력으로 남는다(장비 배치는 그대로)
    r = c.put(f"{SPECS}/{spec['id']}", json={"rack": "창고-3"})
    assert r.status_code == 200
    db.expire_all()
    assert db.query(DcDevice).filter(DcDevice.id == device_id).one().position_u == 11

    # 호스트명 변경도 장비까지 간다
    assert c.put(f"{SPECS}/{spec['id']}", json={"hostname": "reg-node-2b"}).status_code == 200
    db.expire_all()
    assert db.query(DcDevice).filter(DcDevice.id == device_id).one().hostname == "reg-node-2b"


def test_all_three_tables_agree_whichever_screen_edits(env, db):
    """서버스펙 ↔ 장비 ↔ 인프라 노드: 같은 서버의 랙 이름이 세 곳에서 같다."""
    c, cluster = env["client"], env["clusters"][0]
    make_rack(c, "R01", rack_no=1)
    rack2 = make_rack(c, "R02", rack_no=2)
    spec = c.post(SPECS, json={"hostname": "reg-node-3", "cluster_id": str(cluster.id), "rack": "R01",
                               "rack_unit": "U5"}).json()
    node = c.post(INFRA, headers=SCOPES, json={"hostname": "reg-node-3", "cluster_id": str(cluster.id)})
    assert node.status_code == 201, node.text
    node = node.json()
    assert node["device_id"] == spec["device_id"], "같은 호스트명 · 같은 클러스터면 같은 장비에 연결된다"
    assert node["rack_name"] == "R01"                                # 장비 값이 인프라 노드로 미러

    # ① 인프라 토폴로지에서 랙을 바꾸면
    r = c.put(f"{INFRA}/{node['id']}", headers=SCOPES, json={"rack_name": "R02", "version": node["version"]})
    assert r.status_code == 200, r.text
    db.expire_all()
    device = db.query(DcDevice).filter(DcDevice.id == spec["device_id"]).one()
    assert str(device.rack_id) == rack2["id"] and device.position_u is None   # U 는 모르므로 비운다
    assert _spec(db, spec["id"]).rack == "R02"

    # ② 서버스펙에서 다시 바꾸면
    assert c.put(f"{SPECS}/{spec['id']}", json={"rack": "R01", "rack_unit": "U7"}).status_code == 200
    db.expire_all()
    assert db.query(InfraNode).filter(InfraNode.id == node["id"]).one().rack_name == "R01"

    # ③ DC 인벤토리에서 바꾸면
    assert c.put(f"{API}/devices/{spec['device_id']}", json={"rack_id": rack2["id"], "position_u": 9}).status_code == 200
    db.expire_all()
    assert _spec(db, spec["id"]).rack == "R02" and _spec(db, spec["id"]).rack_unit == "U9"
    assert db.query(InfraNode).filter(InfraNode.id == node["id"]).one().rack_name == "R02"


def test_infra_node_switch_name_follows_cables(env, db):
    c, cluster = env["client"], env["clusters"][0]
    node = c.post(INFRA, headers=SCOPES, json={"hostname": "reg-node-4", "cluster_id": str(cluster.id)}).json()
    device_id = node["device_id"]
    leaf = post(c, "devices", {"hostname": "leaf-reg-a", "role": "leaf"})
    eth0 = post(c, "interfaces", {"device_id": device_id, "name": "eth0"})
    port = post(c, "interfaces", {"device_id": leaf["id"], "name": "Ethernet1/1"})
    post(c, "cables", {"a_interface_id": eth0["id"], "b_interface_id": port["id"], "label": "REG-1"})
    c.put(f"{API}/devices/{device_id}", json={"description": "미러 유도"})
    db.expire_all()
    assert db.query(InfraNode).filter(InfraNode.id == node["id"]).one().switch_name == "leaf-reg-a"


def test_same_hostname_in_two_clusters_is_not_auto_merged(env, db):
    c = env["client"]
    a, b = env["clusters"]
    first = c.post(SPECS, json={"hostname": "reg-dup", "cluster_id": str(a.id)}).json()
    second = c.post(SPECS, json={"hostname": "reg-dup", "cluster_id": str(b.id)})
    assert second.status_code == 201, second.text
    assert first["device_id"] is not None and second.json()["device_id"] is None
    preview = c.get(f"{API}/devices/link/preview").json()
    item = next(i for i in preview["items"] if i["hostname"] == "reg-dup")
    assert item["category"] == "duplicate_hostname"
    result = c.post(f"{API}/devices/link/apply", json={"items": [{"hostname": "reg-dup"}]}).json()
    assert result["linked"] == 0 and result["failed"] == 1
    assert "여러 클러스터" in result["results"][0]["error"]
    db.expire_all()
    assert db.query(NodeServerSpec).filter(NodeServerSpec.id == second.json()["id"]).one().device_id is None


def test_link_preview_classifies_and_apply_respects_choice(env, db):
    """연결 전 데이터(device_id 없음)를 직접 넣고 4분류와 선택 적용을 확인한다."""
    c, cluster = env["client"], env["clusters"][0]
    rack = make_rack(c, "R05", rack_no=5)
    post(c, "devices", {"hostname": "reg-link-same", "serial": "S-SAME"})
    post(c, "devices", {"hostname": "reg-link-diff", "serial": "S-DEVICE", "rack_id": rack["id"]})
    db.add_all([
        NodeServerSpec(hostname="reg-link-new", cluster_id=cluster.id, serial_number="S-NEW", rack="R05", rack_unit="U3"),
        NodeServerSpec(hostname="reg-link-same", cluster_id=cluster.id, serial_number="S-SAME"),
        NodeServerSpec(hostname="reg-link-diff", cluster_id=cluster.id, serial_number="S-SPEC", rack="R05"),
        NodeServerSpec(hostname="reg-link-keep", cluster_id=cluster.id, serial_number="S-KEEP-SPEC"),
    ])
    db.commit()
    post(c, "devices", {"hostname": "reg-link-keep", "serial": "S-KEEP-DEVICE"})

    preview = c.get(f"{API}/devices/link/preview").json()
    by = {i["hostname"]: i for i in preview["items"]}
    assert by["reg-link-new"]["category"] == "create"
    assert by["reg-link-same"]["category"] == "linkable"
    assert by["reg-link-diff"]["category"] == "mismatch"
    assert by["reg-link-diff"]["diffs"] == [{"field": "시리얼", "existing": "S-SPEC", "device": "S-DEVICE"}]
    assert by["reg-link-diff"]["default_prefer"] == "existing"
    assert db.query(NodeServerSpec).filter(NodeServerSpec.hostname.like("reg-link-%"),
                                           NodeServerSpec.device_id.isnot(None)).count() == 0, "미리보기는 읽기 전용"

    result = c.post(f"{API}/devices/link/apply", json={"items": [
        {"hostname": "reg-link-new"},
        {"hostname": "reg-link-same"},
        {"hostname": "reg-link-diff", "prefer": "existing"},
        {"hostname": "reg-link-keep", "prefer": "device"},
    ]})
    assert result.status_code == 200, result.text
    assert result.json()["linked"] == 4 and result.json()["failed"] == 0
    db.expire_all()
    devices = {d.hostname: d for d in db.query(DcDevice).filter(DcDevice.hostname.like("reg-link-%")).all()}
    specs = {s.hostname: s for s in db.query(NodeServerSpec).filter(NodeServerSpec.hostname.like("reg-link-%")).all()}
    assert all(specs[h].device_id == devices[h].id for h in specs)
    assert (str(devices["reg-link-new"].rack_id), devices["reg-link-new"].position_u) == (rack["id"], 3)
    assert devices["reg-link-diff"].serial == "S-SPEC"               # 기존 값 선택 → 장비가 따라간다
    assert devices["reg-link-keep"].serial == "S-KEEP-DEVICE"        # 장비 값 선택 → 서버스펙이 따라간다
    assert specs["reg-link-keep"].serial_number == "S-KEEP-DEVICE"
    assert c.get(f"{API}/devices/link/preview").json()["items"] == []


def test_blank_unit_on_existing_row_does_not_wipe_device_position(env, db):
    """기존 행에 U 가 비어 있으면 '모름' 이다 — 연결·수정 때 장비가 아는 U 를 지우면 안 된다."""
    c, cluster = env["client"], env["clusters"][0]
    rack = make_rack(c, "R06", rack_no=6)
    other = make_rack(c, "R09", rack_no=9)
    server = make_type(c)
    dev = post(c, "devices", {"hostname": "reg-keep-u", "device_type_id": server["id"], "rack_id": rack["id"],
                              "position_u": 3})
    db.add(NodeServerSpec(hostname="reg-keep-u", cluster_id=cluster.id, rack="R06"))   # U 없음
    db.commit()
    assert c.post(f"{API}/devices/link/apply", json={"items": [{"hostname": "reg-keep-u"}]}).json()["linked"] == 1
    db.expire_all()
    assert db.query(DcDevice).filter(DcDevice.id == dev["id"]).one().position_u == 3
    spec = db.query(NodeServerSpec).filter(NodeServerSpec.hostname == "reg-keep-u").one()
    assert spec.rack_unit == "U3-U4", "장비 값이 기존 행으로 미러된다"

    # 서버스펙에서 다른 항목만 고쳐도 U 는 그대로
    assert c.put(f"{SPECS}/{spec.id}", json={"rack": "R06", "serial_number": "S-KEEP"}).status_code == 200
    db.expire_all()
    assert db.query(DcDevice).filter(DcDevice.id == dev["id"]).one().position_u == 3
    # U 를 직접 비우면 장비의 U 도 비워진다
    assert c.put(f"{SPECS}/{spec.id}", json={"rack_unit": None}).status_code == 200
    db.expire_all()
    assert db.query(DcDevice).filter(DcDevice.id == dev["id"]).one().position_u is None
    # U 를 모르는 채로 랙만 바꾸면 새 랙의 위치 미정 장비가 된다
    assert c.put(f"{SPECS}/{spec.id}", json={"rack": "R09"}).status_code == 200
    db.expire_all()
    moved = db.query(DcDevice).filter(DcDevice.id == dev["id"]).one()
    assert (str(moved.rack_id), moved.position_u) == (other["id"], None)


def test_deleting_device_keeps_existing_rows(env, db):
    c, cluster = env["client"], env["clusters"][0]
    spec = c.post(SPECS, json={"hostname": "reg-node-9", "cluster_id": str(cluster.id), "serial_number": "S9"}).json()
    assert c.delete(f"{API}/devices/{spec['device_id']}").status_code == 204
    row = _spec(db, spec["id"])
    assert row.device_id is None and row.serial_number == "S9" and row.hostname == "reg-node-9"


def test_cluster_purge_policy_keeps_dc_assets():
    from app.services.cluster_purge import KEEP_ROWS, cluster_ref_tables, purge_order
    refs = cluster_ref_tables()
    assert "dc_devices" in refs and "dc_asns" in refs
    assert "dc_devices" in KEEP_ROWS and "dc_asns" in KEEP_ROWS
    assert "dc_devices" not in purge_order()
