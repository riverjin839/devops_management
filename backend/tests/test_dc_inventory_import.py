"""DC 인벤토리 2단계 — Excel/CSV 일괄 등록(미리보기 → 검증 오류 → 확정)과 내보내기 왕복.

전체 완료 기준 중 "Excel 샘플을 import 한 결과가 원본과 행 단위로 일치(검증 스크립트 포함)" 를 여기서 고정한다.
"""
import io

import pytest
from openpyxl import Workbook, load_workbook

from tests.dc_inventory_helpers import API, client_as, load_seed_module, load_verify_module, make_user, wipe

from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension  # noqa: E402
from app.models.dc_inventory import DcCable, DcChangeLog, DcDevice, DcInterface, DcRack  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.dc_inventory.exporter import SHEETS  # noqa: E402

seed = load_seed_module()
verify = load_verify_module()
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


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


def _preview(client, content: bytes, name: str = "seed.xlsx", **form):
    r = client.post(f"{API}/import/preview", files={"file": (name, content, XLSX)}, data=form)
    assert r.status_code == 200, r.text
    return r.json()


def _apply(client, content: bytes, sha: str, name: str = "seed.xlsx", **form):
    return client.post(f"{API}/import/apply", files={"file": (name, content, XLSX)}, data={"sha256": sha, **form})


def _sheet(result: dict, name: str) -> dict:
    return next(s for s in result["sheets"] if s["name"] == name)


def _book(sheets: dict[str, list[list]]) -> bytes:
    wb = Workbook()
    wb.remove(wb.active)
    for name, lines in sheets.items():
        ws = wb.create_sheet(name)
        for line in lines:
            ws.append(line)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_seed_columns_match_import_sheets():
    """시드·검증 스크립트의 시트/열/키 정의가 서버 양식과 어긋나면 왕복 검증이 의미를 잃는다."""
    assert list(seed.COLUMNS) == [s.name for s in SHEETS]
    for sheet in SHEETS:
        assert seed.COLUMNS[sheet.name] == list(sheet.column_names), sheet.name
        assert verify.KEYS[sheet.name] == sheet.key, sheet.name


def test_template_has_every_sheet_and_guide(op):
    r = op.get(f"{API}/import/template.xlsx")
    assert r.status_code == 200
    wb = load_workbook(io.BytesIO(r.content))
    assert wb.sheetnames == [s.name for s in SHEETS] + ["설명"]
    assert [c.value for c in wb["devices"][1]] == list(seed.COLUMNS["devices"])
    assert wb["devices"].max_row == 1


def test_import_preview_apply_and_row_level_round_trip(op, db):
    rows = seed.build(racks=2)
    content = seed.to_xlsx_bytes(rows)
    expected = {name: len(items) for name, items in rows.items()}

    preview = _preview(op, content)
    assert preview["ok"] and not preview["applied"]
    assert preview["summary"] == {"insert": sum(expected.values()), "update": 0, "skip": 0, "error": 0}
    assert db.query(DcDevice).count() == 0, "미리보기는 DB 를 바꾸지 않는다"

    applied = _apply(op, content, preview["sha256"])
    assert applied.status_code == 200, applied.text
    body = applied.json()
    assert body["applied"] and body["batch_id"]
    assert db.query(DcRack).count() == 2 and db.query(DcDevice).count() == 40
    assert db.query(DcCable).count() == 160 and db.query(DcInterface).count() == expected["interfaces"]
    # 변경 이력이 한 묶음(batch)으로 남는다
    assert db.query(DcChangeLog).filter(DcChangeLog.batch_id == body["batch_id"],
                                        DcChangeLog.object_type == "device").count() == 40

    # 원본 ↔ 내보내기 행 단위 일치 (검증 스크립트와 같은 비교)
    exported = op.get(f"{API}/export.xlsx")
    assert exported.status_code == 200
    ok, lines = verify.compare(verify.load(content), verify.load(exported.content), strict=True)
    assert ok, "\n".join(lines)

    # 내보낸 파일을 다시 올리면 전부 "변경 없음"
    again = _preview(op, exported.content, "export.xlsx")
    assert again["ok"] and again["summary"]["skip"] == sum(expected.values())
    assert again["summary"]["insert"] == 0 and again["summary"]["update"] == 0


def test_errors_are_listed_and_nothing_is_applied(op, db):
    rows = seed.build(racks=1)
    rows["devices"][5]["position_u"] = rows["devices"][4]["position_u"]          # U 겹침 (같은 파일의 앞 행과)
    rows["devices"][7]["rack"] = "R99"                                           # 없는 랙
    rows["devices"][8]["role"] = "router"                                        # 허용값 아님
    rows["cables"][3]["b_interface"] = rows["cables"][0]["b_interface"]          # 이미 쓰인 포트
    rows["ip_addresses"][0]["address"] = "10.99.0.5"                             # 어느 Prefix 에도 없음
    content = seed.to_xlsx_bytes(rows)

    preview = _preview(op, content)
    assert not preview["ok"]
    devices = _sheet(preview, "devices")
    errors = {r["key"]: r["errors"][0] for r in devices["rows"] if r["action"] == "error"}
    assert errors[rows["devices"][5]["hostname"]]["code"] == "u_overlap"
    assert rows["devices"][4]["hostname"] in errors[rows["devices"][5]["hostname"]]["message"]
    assert "R99" in errors[rows["devices"][7]["hostname"]]["message"]
    assert errors[rows["devices"][8]["hostname"]]["column"] == "role"
    assert devices["rows"][0]["action"] == "error", "오류 행이 맨 위에 온다"
    cable_errors = [r for r in _sheet(preview, "cables")["rows"] if r["action"] == "error"]
    assert any(e["errors"][0]["code"] == "interface_in_use" for e in cable_errors)
    ip_errors = [r for r in _sheet(preview, "ip_addresses")["rows"] if r["action"] == "error"]
    assert ip_errors[0]["errors"][0]["code"] == "ip_out_of_prefix"
    # 오류 장비에 딸린 인터페이스·케이블 행도 "장비 없음" 으로 함께 걸린다 — 건수는 최소 5
    assert preview["summary"]["error"] >= 5

    r = _apply(op, content, preview["sha256"])
    assert r.status_code == 200 and r.json()["applied"] is False
    assert db.query(DcRack).count() == 0 and db.query(DcDevice).count() == 0, "오류가 하나라도 있으면 전부 되돌린다"
    assert db.query(DcChangeLog).count() == 0


def test_upsert_changes_only_listed_columns_and_never_deletes(op, db):
    rows = seed.build(racks=1)
    content = seed.to_xlsx_bytes(rows)
    assert _apply(op, content, _preview(op, content)["sha256"]).json()["applied"]
    target = rows["devices"][4]["hostname"]                                       # 첫 서버 (U1-U2)
    serial_before = db.query(DcDevice).filter(DcDevice.hostname == target).one().serial

    # 열이 3개뿐인 devices 시트 하나 — 위치와 상태만 바꾼다
    partial = _book({"devices": [["hostname", "position_u", "status"], [target, 35, "maintenance"],
                                 [rows["devices"][5]["hostname"], rows["devices"][5]["position_u"], "active"]]})
    preview = _preview(op, partial, "partial.xlsx")
    sheet = _sheet(preview, "devices")
    assert (sheet["update"], sheet["skip"], sheet["insert"]) == (1, 1, 0)
    assert sheet["rows"][0]["changes"] == [{"column": "position_u", "old": 1, "new": 35},
                                           {"column": "status", "old": "active", "new": "maintenance"}]
    assert _apply(op, partial, preview["sha256"], "partial.xlsx").json()["applied"]
    db.expire_all()
    moved = db.query(DcDevice).filter(DcDevice.hostname == target).one()
    assert (moved.position_u, moved.status, moved.serial) == (35, "maintenance", serial_before)
    assert db.query(DcDevice).count() == 20, "파일에 없는 행은 지우지 않는다"

    # 빈 칸은 그 값을 지운다
    clear = _book({"devices": [["hostname", "serial"], [target, None]]})
    assert _apply(op, clear, _preview(op, clear, "clear.xlsx")["sha256"], "clear.xlsx").json()["applied"]
    db.expire_all()
    assert db.query(DcDevice).filter(DcDevice.hostname == target).one().serial is None


def test_swap_positions_in_one_file_is_reported_not_silently_broken(op, db):
    """한 파일에서 두 장비의 U 를 맞바꾸면 행 순서상 첫 행이 겹친다 — 조용히 틀어지지 않고 오류로 알린다."""
    rows = seed.build(racks=1)
    content = seed.to_xlsx_bytes(rows)
    assert _apply(op, content, _preview(op, content)["sha256"]).json()["applied"]
    a, b = rows["devices"][4], rows["devices"][5]
    swap = _book({"devices": [["hostname", "position_u"], [a["hostname"], b["position_u"]],
                              [b["hostname"], a["position_u"]]]})
    preview = _preview(op, swap, "swap.xlsx")
    assert not preview["ok"] and _sheet(preview, "devices")["rows"][0]["errors"][0]["code"] == "u_overlap"


def test_csv_single_sheet_and_duplicate_keys(op, db):
    csv_body = "name,row,rack_no,u_height\nR01,A,1,42\nR02,A,2,48\nR01,A,3,42\n".encode("utf-8-sig")
    preview = _preview(op, csv_body, "racks.csv")
    sheet = _sheet(preview, "racks")
    assert (sheet["insert"], sheet["error"]) == (2, 1)
    assert next(r for r in sheet["rows"] if r["action"] == "error")["errors"][0]["code"] == "duplicate_in_file"
    assert set(preview["implicit_created"]) >= {"사이트 DC", "홀 Hall-1", "랙 열 A"}

    good = "name,row,rack_no,u_height\nR01,A,1,42\nR02,A,2,48\n".encode()
    pv = _preview(op, good, "anything.csv", sheet="racks")                       # 파일 이름 대신 시트 지정
    assert _apply(op, good, pv["sha256"], "anything.csv", sheet="racks").json()["applied"]
    assert {r.name: r.u_height for r in db.query(DcRack).all()} == {"R01": 42, "R02": 48}
    assert op.post(f"{API}/import/preview", files={"file": ("mystery.csv", good, "text/csv")}).status_code == 422


def test_apply_requires_same_file_and_operator(op, users, db):
    content = seed.to_xlsx_bytes(seed.build(racks=1))
    preview = _preview(op, content)
    other = seed.to_xlsx_bytes(seed.build(racks=2))
    r = _apply(op, other, preview["sha256"])
    assert r.status_code == 422 and r.json()["code"] == "sha_mismatch"
    viewer = client_as(users["viewer"])
    assert _preview(viewer, content)["ok"]                                        # 미리보기는 읽기 전용
    assert _apply(viewer, content, preview["sha256"]).status_code == 403
    assert db.query(DcDevice).count() == 0


def test_bad_files_are_rejected_with_reason(op):
    r = op.post(f"{API}/import/preview", files={"file": ("x.txt", b"hello", "text/plain")})
    assert r.status_code == 422 and ".xlsx" in r.json()["detail"]
    r = op.post(f"{API}/import/preview", files={"file": ("x.xlsx", b"not a zip", XLSX)})
    assert r.status_code == 422 and r.json()["code"] == "bad_file"
    no_key = _book({"devices": [["role", "status"], ["server", "active"]]})
    r = op.post(f"{API}/import/preview", files={"file": ("x.xlsx", no_key, XLSX)})
    assert r.status_code == 422 and "hostname" in r.json()["detail"]
    unknown = _book({"devices": [["hostname", "favourite_colour"], ["h1", "blue"]]})
    pv = _preview(op, unknown, "u.xlsx")
    assert pv["ok"] and any("favourite_colour" in w for w in pv["warnings"])


def test_apply_stream_emits_logs_and_result(op, db):
    content = seed.to_xlsx_bytes(seed.build(racks=1))
    preview = _preview(op, content)
    with op.stream("POST", f"{API}/import/apply/stream", files={"file": ("seed.xlsx", content, XLSX)},
                   data={"sha256": preview["sha256"]}) as r:
        assert r.status_code == 200
        text = "".join(r.iter_text())
    assert '"type": "log"' in text and "devices" in text
    assert '"type": "step"' in text and '"type": "result"' in text
    assert text.rstrip().splitlines()[-1].startswith('data: {"type": "result"')
    assert db.query(DcDevice).count() == 20
