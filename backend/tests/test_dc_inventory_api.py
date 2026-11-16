"""DC 인벤토리 2단계 — 제약 검증 · 권한 · 변경 이력 · 화면 안 일괄 작업.

전체 완료 기준 중 "같은 U 중복 배치, Prefix 밖 IP, 케이블 중복 연결이 API 단에서 거부됨" 을 여기서 고정한다.
"""
import pytest

from tests.dc_inventory_helpers import API, client_as, make_rack, make_type, make_user, post, wipe

from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension  # noqa: E402
from app.models.dc_inventory import DcChangeLog, DcDevice  # noqa: E402
from app.models.user import User  # noqa: E402


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
def users(db):
    made = {role: make_user(db, role) for role in ("admin", "operator", "viewer")}
    yield made
    from app.auth.deps import get_current_user
    from app.main import app
    app.dependency_overrides.pop(get_current_user, None)
    db.rollback()
    db.query(User).filter(User.id.in_([u.id for u in made.values()])).delete(synchronize_session=False)
    db.commit()


@pytest.fixture
def op(users):
    return client_as(users["operator"])


def _device(client, hostname, rack, u, type_id, expect=201, **extra):
    return post(client, "devices", {
        "hostname": hostname, "rack_id": rack["id"], "position_u": u, "device_type_id": type_id, **extra,
    }, expect=expect)


# ── 랙 배치 ──────────────────────────────────────────────────────────────────

def test_same_u_is_rejected_with_reason(op):
    rack = make_rack(op, "R07", rack_no=7)
    server = make_type(op)
    _device(op, "node-a-0711", rack, 21, server["id"])
    body = _device(op, "node-a-0718", rack, 22, server["id"], expect=409)  # U22 가 겹친다
    assert body["code"] == "u_overlap"
    assert "node-a-0711" in body["detail"] and "U21-U22" in body["detail"]
    assert body["conflict"]["hostname"] == "node-a-0711"
    _device(op, "node-a-0712", rack, 23, server["id"])  # 바로 위는 된다


def test_move_into_occupied_u_is_rejected(op):
    rack = make_rack(op)
    server = make_type(op)
    _device(op, "n1", rack, 1, server["id"])
    second = _device(op, "n2", rack, 3, server["id"])
    r = op.put(f"{API}/devices/{second['id']}", json={"position_u": 2})
    assert r.status_code == 409 and r.json()["code"] == "u_overlap"


def test_device_must_fit_in_rack(op):
    rack = make_rack(op, u_height=42)
    server = make_type(op)
    body = _device(op, "n-top", rack, 42, server["id"], expect=422)  # 2U 가 U42~U43
    assert body["code"] == "out_of_rack"
    r = op.post(f"{API}/devices", json={"hostname": "n-nowhere", "position_u": 3})
    assert r.status_code == 422 and r.json()["code"] == "position_needs_rack"


def test_half_depth_devices_share_u_on_opposite_faces(op):
    rack = make_rack(op)
    patch = make_type(op, "Patch-24", u_height=1, full=False)
    server = make_type(op)
    _device(op, "pp-front", rack, 39, patch["id"], face="front", role="patch")
    _device(op, "pp-rear", rack, 39, patch["id"], face="rear", role="patch")       # 반깊이 앞·뒤 공유 허용
    assert _device(op, "pp-rear-2", rack, 39, patch["id"], face="rear", role="patch", expect=409)["code"] == "u_overlap"
    # 전체 깊이 장비는 면과 무관하게 충돌
    assert _device(op, "srv", rack, 38, server["id"], expect=409)["code"] == "u_overlap"


def test_rack_cannot_shrink_below_mounted_device(op):
    rack = make_rack(op)
    _device(op, "n-high", rack, 40, make_type(op)["id"])
    r = op.put(f"{API}/racks/{rack['id']}", json={"u_height": 30})
    assert r.status_code == 409 and r.json()["code"] == "rack_too_small"


def test_names_are_unique(op):
    rack = make_rack(op, "R01")
    r = op.post(f"{API}/racks", json={"row_id": rack["row_id"], "name": "R01"})
    assert r.status_code == 409 and r.json()["code"] == "duplicate"
    post(op, "devices", {"hostname": "dup-host"})
    r = op.post(f"{API}/devices", json={"hostname": "dup-host"})
    assert r.status_code == 409 and "dup-host" in r.json()["detail"]


# ── 케이블 ───────────────────────────────────────────────────────────────────

def _two_devices_with_ports(op):
    a = post(op, "devices", {"hostname": "srv-1"})
    b = post(op, "devices", {"hostname": "leaf-1", "role": "leaf"})
    eth0 = post(op, "interfaces", {"device_id": a["id"], "name": "eth0", "speed": "25G"})
    eth1 = post(op, "interfaces", {"device_id": a["id"], "name": "eth1", "speed": "25G"})
    p1 = post(op, "interfaces", {"device_id": b["id"], "name": "Ethernet1/1", "speed": "25G"})
    p2 = post(op, "interfaces", {"device_id": b["id"], "name": "Ethernet1/49", "speed": "100G"})
    return a, b, eth0, eth1, p1, p2


def test_interface_takes_only_one_cable(op):
    _, _, eth0, eth1, p1, p2 = _two_devices_with_ports(op)
    post(op, "cables", {"a_interface_id": eth0["id"], "b_interface_id": p1["id"], "label": "C-1"})
    # 같은 포트를 A 쪽으로 다시
    r = op.post(f"{API}/cables", json={"a_interface_id": eth0["id"], "b_interface_id": p2["id"]})
    assert r.status_code == 409 and r.json()["code"] == "interface_in_use"
    # 이미 B 쪽인 포트를 A 쪽으로(컬럼별 UNIQUE 로는 못 잡는 교차 중복)
    r = op.post(f"{API}/cables", json={"a_interface_id": p1["id"], "b_interface_id": eth1["id"]})
    assert r.status_code == 409 and "C-1" in r.json()["detail"]
    r = op.post(f"{API}/cables", json={"a_interface_id": eth1["id"], "b_interface_id": eth1["id"]})
    assert r.status_code == 422 and r.json()["code"] == "same_interface"
    # 케이블이 걸린 포트는 지울 수 없다
    assert op.delete(f"{API}/interfaces/{eth0['id']}").status_code == 409


def test_speed_mismatch_is_a_warning_not_an_error(op):
    _, _, eth0, eth1, p1, p2 = _two_devices_with_ports(op)
    ok = post(op, "cables", {"a_interface_id": eth0["id"], "b_interface_id": p1["id"], "label": "same"})
    assert ok["warnings"] == [] and ok["speed_mismatch"] is False
    odd = post(op, "cables", {"a_interface_id": eth1["id"], "b_interface_id": p2["id"], "label": "odd"})
    assert odd["speed_mismatch"] is True
    assert any("속도 불일치" in w for w in odd["warnings"])


def test_speed_labels_round_trip(op):
    dev = post(op, "devices", {"hostname": "sw"})
    for label, mbps in (("25G", 25000), ("100g", 100000), ("400G", 400000), ("1000M", 1000)):
        row = post(op, "interfaces", {"device_id": dev["id"], "name": f"p-{label}", "speed": label})
        assert row["speed_mbps"] == mbps
    assert post(op, "interfaces", {"device_id": dev["id"], "name": "p50", "speed_mbps": 50000})["speed"] == "50G"
    r = op.post(f"{API}/interfaces", json={"device_id": dev["id"], "name": "bad", "speed": "fast"})
    assert r.status_code == 422 and r.json()["code"] == "bad_speed"


def test_patch_panel_pairing_is_symmetric(op):
    pp = post(op, "devices", {"hostname": "pp-1", "role": "patch"})
    front = post(op, "interfaces", {"device_id": pp["id"], "name": "P01-front", "purpose": "patch"})
    rear = post(op, "interfaces", {"device_id": pp["id"], "name": "P01-rear", "purpose": "patch",
                                   "paired_interface_id": front["id"]})
    assert rear["paired_interface_name"] == "P01-front"
    assert op.get(f"{API}/interfaces/{front['id']}").json()["paired_interface_id"] == rear["id"]
    other = post(op, "devices", {"hostname": "pp-2", "role": "patch"})
    r = op.post(f"{API}/interfaces", json={"device_id": other["id"], "name": "X", "paired_interface_id": front["id"]})
    assert r.status_code == 422 and r.json()["code"] == "other_device"


# ── IPAM ─────────────────────────────────────────────────────────────────────

def _prefix(op, cidr="10.10.7.0/26", **extra):
    vrf = post(op, "vrfs", {"name": f"VRF-{cidr}"})
    return vrf, post(op, "prefixes", {"vrf_id": vrf["id"], "cidr": cidr, **extra})


def test_ip_outside_prefix_is_rejected(op):
    _, prefix = _prefix(op, gateway="10.10.7.1")
    assert post(op, "ip-addresses", {"prefix_id": prefix["id"], "address": "10.10.7.21"})["address"] == "10.10.7.21"
    r = op.post(f"{API}/ip-addresses", json={"prefix_id": prefix["id"], "address": "10.10.8.5"})
    assert r.status_code == 422 and r.json()["code"] == "ip_out_of_prefix"
    assert "10.10.7.0/26" in r.json()["detail"]
    for reserved in ("10.10.7.0", "10.10.7.63"):  # 네트워크·브로드캐스트
        r = op.post(f"{API}/ip-addresses", json={"prefix_id": prefix["id"], "address": reserved})
        assert r.status_code == 422 and r.json()["code"] == "ip_reserved"
    r = op.post(f"{API}/ip-addresses", json={"prefix_id": prefix["id"], "address": "10.10.7.21"})
    assert r.status_code == 409 and r.json()["code"] == "duplicate"


def test_prefix_rules(op):
    vrf, prefix = _prefix(op)
    for overlapping in ("10.10.7.0/25", "10.10.7.32/27", "10.10.7.0/26"):
        r = op.post(f"{API}/prefixes", json={"vrf_id": vrf["id"], "cidr": overlapping})
        assert r.status_code == 409, overlapping
    post(op, "prefixes", {"vrf_id": vrf["id"], "cidr": "10.10.7.64/26"})                   # 인접은 된다
    other_vrf = post(op, "vrfs", {"name": "OTHER"})
    post(op, "prefixes", {"vrf_id": other_vrf["id"], "cidr": "10.10.7.0/26"})              # 다른 VRF 는 겹쳐도 된다
    r = op.post(f"{API}/prefixes", json={"vrf_id": vrf["id"], "cidr": "10.10.9.5/26"})     # 호스트 비트가 선 CIDR
    assert r.status_code == 422 and r.json()["code"] == "bad_cidr"
    r = op.post(f"{API}/prefixes", json={"vrf_id": vrf["id"], "cidr": "10.10.9.0/26", "gateway": "10.10.8.1"})
    assert r.status_code == 422 and r.json()["code"] == "gateway_out_of_prefix"
    post(op, "ip-addresses", {"prefix_id": prefix["id"], "address": "10.10.7.40"})
    r = op.put(f"{API}/prefixes/{prefix['id']}", json={"cidr": "10.10.7.0/27"})            # 배정된 주소가 밀려남
    assert r.status_code == 409 and r.json()["code"] == "ip_out_of_prefix"
    assert op.delete(f"{API}/prefixes/{prefix['id']}").status_code == 409                  # 주소가 남아 있음


def test_asn_target_must_match_type(op):
    rack = make_rack(op)
    post(op, "asns", {"number": 4200001001, "target_type": "rack", "rack_id": rack["id"]})
    r = op.post(f"{API}/asns", json={"number": 4200001002, "target_type": "rack"})
    assert r.status_code == 422 and r.json()["code"] == "target_missing"
    r = op.post(f"{API}/asns", json={"number": 4200001003, "target_type": "fabric_tier", "fabric_tier": "spine",
                                    "rack_id": rack["id"]})
    assert r.status_code == 422 and r.json()["code"] == "target_mixed"
    r = op.post(f"{API}/asns", json={"number": 4200001001, "target_type": "fabric_tier", "fabric_tier": "leaf"})
    assert r.status_code == 409
    assert op.post(f"{API}/asns", json={"number": 0, "target_type": "fabric_tier", "fabric_tier": "leaf"}).status_code == 422


# ── 수정 · 삭제 · 이력 · 권한 ────────────────────────────────────────────────

def test_optimistic_lock_and_change_log(op, db, users):
    rack = make_rack(op)
    dev = _device(op, "node-x", rack, 5, make_type(op)["id"])
    r = op.put(f"{API}/devices/{dev['id']}", json={"position_u": 7, "version": dev["version"]})
    assert r.status_code == 200 and r.json()["version"] == dev["version"] + 1
    stale = op.put(f"{API}/devices/{dev['id']}", json={"position_u": 9, "version": dev["version"]})
    assert stale.status_code == 409 and stale.json()["code"] == "version_conflict"
    # 값이 같으면 버전도 이력도 늘지 않는다
    same = op.put(f"{API}/devices/{dev['id']}", json={"position_u": 7})
    assert same.json()["version"] == dev["version"] + 1

    logs = op.get(f"{API}/changes", params={"object_type": "device", "object_id": dev["id"]}).json()["items"]
    assert [entry["action"] for entry in logs] == ["update", "create"]
    update = logs[0]
    assert update["changed_fields"] == ["position_u"]
    assert update["before"]["position_u"] == 5 and update["after"]["position_u"] == 7
    assert update["actor_username"] == users["operator"].username and update["source"] == "ui"


def test_delete_rules_and_history_survives(op, users, db):
    rack = make_rack(op)
    dev = _device(op, "node-del", rack, 1, make_type(op)["id"])
    assert op.delete(f"{API}/racks/{rack['id']}").status_code == 409          # 장비가 남은 랙
    assert op.delete(f"{API}/devices/{dev['id']}").status_code == 403         # 장비 삭제는 admin 만
    assert op.put(f"{API}/devices/{dev['id']}", json={"status": "decommission"}).status_code == 200
    admin = client_as(users["admin"])
    assert admin.delete(f"{API}/devices/{dev['id']}").status_code == 204
    assert db.query(DcDevice).filter(DcDevice.id == dev["id"]).first() is None
    last = db.query(DcChangeLog).filter(DcChangeLog.object_id == dev["id"]).order_by(
        DcChangeLog.created_at.desc()).first()
    assert last.action == "delete" and last.object_repr == "node-del" and last.before["hostname"] == "node-del"
    assert admin.delete(f"{API}/racks/{rack['id']}").status_code == 204


def test_viewer_can_read_but_not_write(users, op):
    make_rack(op)
    viewer = client_as(users["viewer"])
    assert viewer.get(f"{API}/racks").status_code == 200
    assert viewer.get(f"{API}/overview").json()["racks"] == 1
    assert viewer.get(f"{API}/export.xlsx").status_code == 200
    assert viewer.post(f"{API}/sites", json={"name": "nope"}).status_code == 403
    assert viewer.post(f"{API}/devices/bulk", json={"pattern": "x{1..2}"}).status_code == 403
    assert viewer.post(f"{API}/devices/link/apply", json={"items": [{"hostname": "h"}]}).status_code == 403
    assert client_as(users["operator"]).post(
        f"{API}/devices/link/apply", json={"items": [{"hostname": "h"}]}).status_code == 403  # admin 전용


def test_unknown_reference_and_bad_enum_are_422(op):
    r = op.post(f"{API}/devices", json={"hostname": "ghost", "rack_id": "00000000-0000-0000-0000-000000000001",
                                       "position_u": 1})
    assert r.status_code == 422
    assert op.post(f"{API}/devices", json={"hostname": "bad-role", "role": "router"}).status_code == 422
    assert op.get(f"{API}/devices/00000000-0000-0000-0000-000000000001").status_code == 404


def test_templates_create_interfaces_and_detail_shows_cables(op):
    leaf_type = make_type(op, "Leaf", u_height=1, templates=[
        {"pattern": "Ethernet1/{n}", "start": 1, "count": 4, "speed_mbps": 25000, "purpose": "other"},
        {"pattern": "Ethernet1/{n}", "start": 49, "count": 2, "speed_mbps": 100000, "purpose": "uplink"}])
    leaf = post(op, "devices", {"hostname": "leaf-t", "role": "leaf", "device_type_id": leaf_type["id"],
                                "create_interfaces_from_template": True})
    srv = post(op, "devices", {"hostname": "srv-t"})
    eth0 = post(op, "interfaces", {"device_id": srv["id"], "name": "eth0", "speed": "25G", "purpose": "private-a"})
    ports = op.get(f"{API}/interfaces", params={"device_id": leaf["id"]}).json()["items"]
    assert len(ports) == 6
    assert {p["name"]: p["speed"] for p in ports}["Ethernet1/49"] == "100G"
    first = next(p for p in ports if p["name"] == "Ethernet1/1")
    post(op, "cables", {"a_interface_id": eth0["id"], "b_interface_id": first["id"], "label": "T-1"})
    detail = op.get(f"{API}/devices/{srv['id']}/detail").json()
    cable = detail["interfaces"][0]["cable"]
    assert cable["label"] == "T-1" and cable["peer_device_hostname"] == "leaf-t"
    assert cable["peer_interface_name"] == "Ethernet1/1"
    assert op.get(f"{API}/cables", params={"device_id": leaf["id"]}).json()["total"] == 1
    assert op.get(f"{API}/overview").json()["unconnected_interfaces"] == 5


# ── 화면 안 일괄 작업 ────────────────────────────────────────────────────────

def test_bulk_devices_dry_run_then_apply_and_all_or_nothing(op, db):
    rack = make_rack(op, "R07", rack_no=7)
    server = make_type(op, templates=[{"name": "eth0", "speed_mbps": 25000, "purpose": "private-a"}])
    body = {"pattern": "node-a-07{01..04}", "device_type_id": server["id"], "rack_id": rack["id"], "start_u": 1}
    dry = post(op, "devices/bulk", {**body, "dry_run": True}, expect=200)
    assert dry["ok"] and not dry["applied"] and [i["u_range"] for i in dry["items"]] == ["U1-U2", "U3-U4", "U5-U6", "U7-U8"]
    assert db.query(DcDevice).count() == 0
    done = post(op, "devices/bulk", body, expect=200)
    assert done["applied"] and db.query(DcDevice).count() == 4
    assert op.get(f"{API}/interfaces").json()["total"] == 4                    # 템플릿 포트가 함께 생긴다
    assert db.query(DcChangeLog).filter(DcChangeLog.batch_id == done["batch_id"]).count() == 8

    # 05~08 중 U7 은 이미 찼다 → 하나라도 실패하면 전부 거부
    clash = post(op, "devices/bulk", {**body, "pattern": "node-a-07{05..08}", "start_u": 7}, expect=200)
    assert not clash["ok"] and not clash["applied"] and clash["errors"] == 1
    assert clash["items"][0]["code"] == "u_overlap" and clash["items"][1]["status"] == "ok"
    assert db.query(DcDevice).count() == 4


def test_bulk_interface_speed_cable_range_and_ip_assignment(op):
    leaf_type = make_type(op, "Leaf", u_height=1, templates=[
        {"pattern": "Ethernet1/{n}", "start": 1, "count": 8, "speed_mbps": 25000, "purpose": "other"}])
    leaf = post(op, "devices", {"hostname": "leaf-b", "role": "leaf", "device_type_id": leaf_type["id"],
                                "create_interfaces_from_template": True})
    changed = post(op, "interfaces/bulk-update", {
        "device_id": leaf["id"], "ports": "Ethernet1/5-8", "speed": "100G", "purpose": "uplink"}, expect=200)
    assert changed["applied"] and changed["total"] == 4
    speeds = {p["name"]: p["speed"] for p in op.get(f"{API}/interfaces", params={"device_id": leaf["id"]}).json()["items"]}
    assert speeds["Ethernet1/4"] == "25G" and speeds["Ethernet1/5"] == "100G"
    missing = op.post(f"{API}/interfaces/bulk-update", json={"device_id": leaf["id"], "ports": "Ethernet1/9-10", "speed": "1G"})
    assert missing.status_code == 422 and missing.json()["code"] == "port_not_found"

    servers, eths = [], []
    for i in (1, 2, 3):
        s = post(op, "devices", {"hostname": f"srv-b{i}"})
        servers.append(s)
        eths.append(post(op, "interfaces", {"device_id": s["id"], "name": "eth0", "speed": "25G"}))
    cabled = post(op, "cables/bulk", {
        "a_device_id": leaf["id"], "a_ports": "Ethernet1/1-3", "b_device_ids": [s["id"] for s in servers],
        "b_interface": "eth0", "label_pattern": "R-{host}-PA"}, expect=200)
    assert cabled["applied"] and [i["label"] for i in cabled["items"]] == ["R-srv-b1-PA", "R-srv-b2-PA", "R-srv-b3-PA"]
    again = post(op, "cables/bulk", {
        "a_device_id": leaf["id"], "a_ports": "Ethernet1/1-3", "b_device_ids": [s["id"] for s in servers],
        "b_interface": "eth0"}, expect=200)
    assert not again["ok"] and again["errors"] == 3 and again["items"][0]["code"] == "interface_in_use"

    vrf = post(op, "vrfs", {"name": "BULK"})
    prefix = post(op, "prefixes", {"vrf_id": vrf["id"], "cidr": "10.10.7.0/29", "gateway": "10.10.7.1"})
    ips = post(op, "ip-addresses/bulk", {"prefix_id": prefix["id"], "interface_ids": [e["id"] for e in eths]}, expect=200)
    assert [i["address"] for i in ips["items"]] == ["10.10.7.2", "10.10.7.3", "10.10.7.4"]  # 게이트웨이 .1 은 건너뜀
    full = post(op, "ip-addresses/bulk", {"prefix_id": prefix["id"],
                                          "interface_ids": [e["id"] for e in eths] + [eths[0]["id"]]}, expect=200)
    assert not full["ok"] and full["items"][-1]["code"] == "prefix_full"       # /29 에 남은 주소는 2개(.5 .6)
