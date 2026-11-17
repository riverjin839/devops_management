"""DC 인벤토리 — 서버 일괄 등록(현업 엑셀 열: 서버구성 · 서버환경 · 호스트명 · 서버용도 · OS버전 · NW설정 · 이중화 ·
DC 위치 · RACK 열 · 랙 No. · 하단 위치). 파일과 붙여넣기가 같은 결과를 내는지, 위치 자동 생성·미러·검증을 고정한다."""
import io
import json

import pytest
from openpyxl import Workbook, load_workbook

from tests.dc_inventory_helpers import API, client_as, make_user, wipe

from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension  # noqa: E402
from app.models.dc_inventory import DcDevice, DcHall, DcRack, DcRackRow, DcSite  # noqa: E402
from app.models.node_server_spec import NodeServerSpec  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.dc_inventory import server_sheet  # noqa: E402

HEADER = ["서버구성", "서버환경", "호스트명", "서버용도", "OS버전", "NW설정", "이중화", "DC 위치", "RACK 열", "랙 No.", "하단 위치"]
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _row(host, u, rack="07", loc="DC1 2층 A구역", row="A", purpose="K8S 워커"):
    return ["R750 / 512G", "운영", host, purpose, "Rocky 9.4", "bond0 25G x2", "Active-Active", loc, row, rack, u]


@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    wipe(session)
    yield session
    session.rollback()
    session.query(NodeServerSpec).filter(NodeServerSpec.hostname.like("srv-%")).delete(synchronize_session=False)
    session.commit()
    wipe(session)
    session.close()


@pytest.fixture
def users(db):
    made = {role: make_user(db, role) for role in ("operator", "viewer")}
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


def _preview(client, rows=None, file=None):
    if file is not None:
        r = client.post(f"{API}/import/servers/preview", files={"file": ("servers.xlsx", file, XLSX)})
    else:
        r = client.post(f"{API}/import/servers/preview", data={"rows_json": json.dumps(rows)})
    assert r.status_code == 200, r.text
    return r.json()


def _apply(client, rows, sha):
    with client.stream("POST", f"{API}/import/servers/apply/stream",
                       data={"rows_json": json.dumps(rows), "sha256": sha}) as r:
        assert r.status_code == 200, r.read()
        events = [json.loads(line[5:]) for line in r.iter_lines() if line.startswith("data:")]
    assert events[-1]["type"] == "result", events[-1]
    return events


def _xlsx(rows):
    wb = Workbook()
    ws = wb.active
    for line in rows:
        ws.append(line)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_headers_aliases_typo_and_title_row():
    rows = [["서버 목록 (2026-11)"], ["서버 구성", "환경", "Hostname", "용도", "OS 버전", "NW 설정", "이증화",
                                      "DC위치", "랙 열", "랙번호", "하단위치", "비고"],
            ["c", "운영", "h1", "p", "o", "n", "AA", "DC1", "A", "1", "U3", "메모"]]
    info = server_sheet.interpret(rows)
    assert info["header_row"] == 2
    assert info["present"] == ["server_config", "environment", "hostname", "purpose", "os_version",
                               "network_config", "redundancy", "dc_location", "rack_row", "rack_no", "position"]
    assert next(c for c in info["columns"] if c["column"] == "이증화")["field"] == "redundancy"
    assert next(c for c in info["columns"] if c["column"] == "비고")["field"] is None
    assert info["servers"][0]["row"] == 3 and info["servers"][0]["hostname"] == "h1"


def test_location_and_unit_parsing():
    assert server_sheet.split_location("DC1 2층 A구역") == ("DC1", "2층 A구역")
    assert server_sheet.split_location("DC1   B동") == ("DC1", "B동")
    assert server_sheet.split_location("분당센터") == ("분당센터", server_sheet.DEFAULT_ZONE)
    assert server_sheet.rack_name("A", "07") == "A-07" and server_sheet.rack_name(None, "R07") == "R07"
    from app.services.dc_inventory.device_registry import parse_rack_unit
    assert [parse_rack_unit(v) for v in ("21", "U21", "21U", "U21-U22")] == [21, 21, 21, 21]


def test_paste_preview_apply_creates_locations_and_mirrors(op, db):
    rows = [HEADER, _row("srv-01", "U1"), _row("srv-02", "3"), _row("srv-03", "5", rack="08")]
    pv = _preview(op, rows)
    assert pv["ok"] and not pv["applied"]
    assert pv["summary"]["insert"] == 5            # 랙 2 + 서버 3
    assert any("A-07" in c for c in pv["created_locations"]) and len(pv["created_locations"]) == 2
    assert db.query(DcDevice).count() == 0, "미리보기는 DB 를 바꾸지 않는다"

    events = _apply(op, rows, pv["sha256"])
    assert any(e["type"] == "log" and "서버" in e["message"] for e in events)
    db.expire_all()
    site = db.query(DcSite).one()
    hall = db.query(DcHall).one()
    assert (site.name, hall.name) == ("DC1", "2층 A구역")
    assert db.query(DcRackRow).one().name == "A"
    assert sorted(r.name for r in db.query(DcRack).all()) == ["A-07", "A-08"]
    d = db.query(DcDevice).filter(DcDevice.hostname == "srv-02").one()
    assert (d.position_u, d.role, d.environment, d.purpose, d.os_version, d.network_config, d.redundancy,
            d.server_config) == (3, "server", "운영", "K8S 워커", "Rocky 9.4", "bond0 25G x2", "Active-Active", "R750 / 512G")

    again = _preview(op, rows)
    assert again["summary"]["insert"] == 0 and again["summary"]["update"] == 0, "같은 내용이면 전부 변경 없음"


def test_file_and_paste_give_same_result(op):
    rows = [HEADER, _row("srv-11", "U1"), _row("srv-12", "U3")]
    by_paste = _preview(op, rows)
    by_file = _preview(op, file=_xlsx(rows))
    assert by_paste["summary"] == by_file["summary"]
    assert [s["insert"] for s in by_paste["sheets"]] == [s["insert"] for s in by_file["sheets"]]


def test_row_errors_are_reported_and_nothing_applied(op, db):
    rows = [HEADER,
            _row("srv-21", "U1"),
            _row("srv-22", "U1"),                                  # U 겹침
            _row("srv-23", "가운데"),                               # U 해석 불가
            _row("srv-24", "U9", loc="DC2 B구역"),                  # 같은 랙 이름이 다른 위치
            ["", "", "", "", "", "", "", "DC1", "A", "07", "U5"],  # 호스트명 없음
            _row("srv-25", "U11", rack="")]
    rows[-1][10] = "U11"
    pv = _preview(op, rows)
    assert not pv["ok"]
    errors = {r["row"]: r["errors"][0] for s in pv["sheets"] for r in s["rows"] if r["action"] == "error"}
    assert errors[3]["code"] == "u_overlap"
    assert "U 번호" in errors[4]["message"]
    assert "2행" in errors[5]["message"]
    assert errors[6]["column"] == "hostname"
    assert errors[7]["column"] == "rack_no"
    events = _apply(op, rows, pv["sha256"])
    assert events[-1]["result"]["applied"] is False
    assert db.query(DcDevice).count() == 0 and db.query(DcRack).count() == 0


def test_existing_rack_is_not_moved_and_existing_device_updates(op, db):
    rows = [HEADER, _row("srv-31", "U1")]
    _apply(op, rows, _preview(op, rows)["sha256"])
    moved = [HEADER, _row("srv-31", "U1", loc="DC9 다른구역", purpose="DB")]
    pv = _preview(op, moved)
    assert any("옮기지 않았습니다" in w for w in pv["warnings"])
    assert pv["summary"] == {"insert": 0, "update": 1, "skip": 0, "error": 0}
    _apply(op, moved, pv["sha256"])
    db.expire_all()
    assert db.query(DcSite).count() == 1 and db.query(DcDevice).one().purpose == "DB"


def test_purpose_and_os_mirror_to_node_spec(op, db):
    spec = NodeServerSpec(hostname="srv-41", status="active", current_usage="옛 용도", os_image="RHEL 8")
    db.add(spec)
    db.commit()
    from app.services.dc_inventory import device_registry
    device_registry.sync_spec(db, spec, strict=True)   # 노드 서버스펙 화면에서 저장한 것과 같은 연결
    db.commit()
    rows = [HEADER, _row("srv-41", "U1", purpose="새 용도")]
    _apply(op, rows, _preview(op, rows)["sha256"])
    db.expire_all()
    spec = db.query(NodeServerSpec).filter(NodeServerSpec.hostname == "srv-41").one()
    assert (spec.current_usage, spec.os_image, spec.rack, spec.rack_unit) == ("새 용도", "Rocky 9.4", "A-07", "U1")


def test_template_permissions_and_guards(op, users):
    t = op.get(f"{API}/import/servers/template.xlsx")
    assert t.status_code == 200
    wb = load_workbook(io.BytesIO(t.content))
    assert [c.value for c in wb["서버"][1]][:11] == HEADER and "설명" in wb.sheetnames
    rows = [HEADER, _row("srv-51", "U1")]
    viewer = client_as(users["viewer"])
    pv = _preview(viewer, rows)
    r = viewer.post(f"{API}/import/servers/apply/stream", data={"rows_json": json.dumps(rows), "sha256": pv["sha256"]})
    assert r.status_code == 403
    op_client = client_as(users["operator"])
    r = op_client.post(f"{API}/import/servers/apply/stream", data={"rows_json": json.dumps(rows), "sha256": "x"})
    assert r.status_code == 422 and r.json()["code"] == "sha_mismatch"
    r = op_client.post(f"{API}/import/servers/preview", data={"rows_json": json.dumps([["이름", "IP"], ["a", "b"]])})
    assert r.status_code == 422 and "호스트명" in r.json()["detail"]
    assert op_client.post(f"{API}/import/servers/preview").status_code == 422
