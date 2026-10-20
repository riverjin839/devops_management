"""백업 가져오기 스트리밍 — 업로드 파일을 통째로 메모리에 올려 backend 가 OOMKilled 될 수 있던 문제의 회귀 테스트.

계약:
1. ``index_backup``/``iter_table_rows`` 는 버퍼 경계(멀티바이트 문자·숫자 중간)와 무관하게 ``json.loads`` 와 같은 값을 낸다.
2. 형식이 틀린 파일(깨진 JSON·잘린 파일·필수 키 누락·UTF-8 아님)은 ``ValueError`` — 라우터가 422 로 돌려준다.
3. 파일 소스의 미리보기(diff)는 dict envelope 경로와 같다. 레거시 issues/tasks 는 work_items 로 합쳐진다.
4. 행 오류가 많아도 응답 errors 는 상한까지만 싣고 나머지는 개수로 요약한다.
5. API: 업로드 → 미리보기 → merge 적용이 파일 경로로 동작한다.
"""
import io
import json
import uuid

import pytest

from app.services import backup_reader, backup_service
from app.services.backup_reader import index_backup, iter_table_rows


def _f(doc) -> io.BytesIO:
    raw = doc if isinstance(doc, bytes) else json.dumps(doc, ensure_ascii=False).encode("utf-8")
    return io.BytesIO(raw)


def _rows(f, idx, name):
    return list(iter_table_rows(f, idx.tables[name]))


# ── 리더 (DB 불필요) ──────────────────────────────────────────────────────

@pytest.mark.parametrize("chunk", [1, 2, 3, 7, 64, 1 << 20])
def test_reader_matches_json_loads_across_chunk_boundaries(monkeypatch, chunk):
    monkeypatch.setattr(backup_reader, "READ_CHUNK", chunk)
    doc = {
        "counts": {"a": 2},
        "tables": {
            "a": [{"id": 1, "n": 123456789, "f": -1.5e-3, "s": "한글🙂\"\\\n", "x": [1, {"y": None}]},
                  {"id": 2, "n": 0, "b": True}],
            "empty": [],
            "big": [{"id": i, "v": "가" * 50} for i in range(30)],
        },
        "version": "1.0",
        "options": {"include_logs": False},
    }
    raw = ("﻿" + json.dumps(doc, ensure_ascii=False, indent=2)).encode("utf-8")
    f = io.BytesIO(raw)
    idx = index_backup(f)
    assert idx.meta == {k: v for k, v in doc.items() if k != "tables"}
    assert {k: s.count for k, s in idx.tables.items()} == {"a": 2, "empty": 0, "big": 30}
    for name in ("a", "big"):
        assert _rows(f, idx, name) == doc["tables"][name]
    # FK 순서대로 다시 읽어도(역순 seek) 같은 결과
    assert _rows(f, idx, "big")[-1]["id"] == 29 and _rows(f, idx, "a")[0]["id"] == 1


def test_reader_trailing_number_at_buffer_end(monkeypatch):
    # 최상위 숫자 값이 버퍼 끝에서 잘려도 앞부분만 디코드하면 안 된다.
    monkeypatch.setattr(backup_reader, "READ_CHUNK", 4)
    idx = index_backup(_f(b'{"tables":{},"version":"1.0","n":1234567}'))
    assert idx.meta["n"] == 1234567


@pytest.mark.parametrize("raw, msg", [
    (b'{"tables": {"a": [{"id": 1}, {"id": 2]}, "version": "1.0"}', "파싱 실패"),
    (b'{"tables": {"a": [{"id": 1}, {"id": 2', "파싱 실패"),
    (b'{"tables": {"a": []}}', "tables 필수"),
    (b'{"version": "1.0"}', "tables 필수"),
    (b'{"tables": {"a": {}}, "version": "1.0"}', "배열"),
    (b'{"tables": {}, "version": "1.0"} {}', "데이터가 더"),
    (b'[1, 2]', "파싱 실패"),
    (b'', "파싱 실패"),
    (b'{"tables": {"a": [{"s": "\xff\xfe"}]}, "version": "1.0"}', "UTF-8"),
])
def test_reader_rejects_invalid_files(raw, msg):
    with pytest.raises(ValueError, match=msg):
        index_backup(io.BytesIO(raw))


def test_reader_caps_runaway_value(monkeypatch):
    monkeypatch.setattr(backup_reader, "READ_CHUNK", 16)
    monkeypatch.setattr(backup_reader, "MAX_VALUE_CHARS", 1000)
    raw = b'{"version": "1.0", "tables": {"a": [{"s": "' + b"x" * 5000  # 닫히지 않는 문자열
    with pytest.raises(ValueError, match="넘습니다"):
        index_backup(io.BytesIO(raw))


def test_legacy_issues_tasks_merge_into_work_items():
    doc = {
        "version": "1.0",
        "tables": {
            "issues": [{"id": "i1", "issue_content": "장애", "resolved_at": "2026-01-01T00:00:00"}],
            "work_items": [{"id": "w1", "type": "task"}],
            "tasks": [{"id": "t1", "task_content": "작업", "issue_id": "i1"}],
        },
    }
    for src in (backup_service.open_backup_file(_f(doc)), backup_service.EnvelopeSource(doc)):
        rows = list(src.rows("work_items"))
        assert [r["id"] for r in rows] == ["w1", "i1", "t1"]
        assert rows[1]["content"] == "장애" and rows[1]["kanban_status"] == "done"
        assert rows[2]["related_work_item_id"] == "i1"


def test_error_log_caps_entries():
    log = backup_service._ErrorLog(3)
    for i in range(10):
        log.add(f"e{i}")
    out = log.finish()
    assert out[:3] == ["e0", "e1", "e2"] and "7건 생략" in out[3] and len(out) == 4


# ── DB 경로 ───────────────────────────────────────────────────────────────

@pytest.fixture
def db():
    from app.database import SessionLocal, engine, Base
    from app.main import _ensure_pgvector_extension

    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


@pytest.fixture
def keys(db):
    from app.models.app_setting import AppSetting

    ks = [f"import-stream-{uuid.uuid4().hex[:8]}-{i}" for i in range(20)]
    db.add_all([AppSetting(key=k, value={"i": i}) for i, k in enumerate(ks)])
    db.commit()
    yield {k: str(db.query(AppSetting.id).filter(AppSetting.key == k).scalar()) for k in ks}
    db.query(AppSetting).filter(AppSetting.key.like("import-stream-%")).delete(synchronize_session=False)
    db.commit()


def test_file_source_diff_matches_envelope(db, keys):
    raw = b"".join(backup_service.iter_export_json(db))
    env = json.loads(raw)
    by_file = backup_service.compute_diff(db, backup_service.open_backup_file(io.BytesIO(raw)), include_logs=False)
    by_dict = backup_service.compute_diff(db, env, include_logs=False)
    assert by_file == by_dict
    app = next(t for t in by_file["tables"] if t["name"] == "app_settings")
    assert app["incoming"] == app["existing"] == app["update_count"] and app["insert_count"] == 0


def test_file_source_merge_apply_inserts_and_updates(db, keys):
    from app.models.app_setting import AppSetting

    k0 = next(iter(keys))
    new_key, new_id = f"import-stream-{uuid.uuid4().hex[:8]}-new", str(uuid.uuid4())
    doc = {
        "version": "1.0",
        "tables": {"app_settings": [
            {"id": keys[k0], "key": k0, "value": {"i": "changed"}},
            {"id": new_id, "key": new_key, "value": {"i": "new"}},
        ]},
    }
    res = backup_service.apply_import(db, backup_service.open_backup_file(_f(doc)), mode="merge")
    assert res["inserted"] == 1 and res["updated"] == 1 and res["errors"] == []
    db.expire_all()
    assert db.get(AppSetting, uuid.UUID(keys[k0])).value == {"i": "changed"}
    assert db.get(AppSetting, uuid.UUID(new_id)).value == {"i": "new"}


def test_json_secret_key_masked_and_preserved_on_merge(db, keys):
    """AppSetting 안의 OIDC client secret 은 기본 export 에서 그 키만 가리고, merge 시 기존 값을 지킨다."""
    from app.models.app_setting import AppSetting

    k0 = next(iter(keys))
    row = db.get(AppSetting, uuid.UUID(keys[k0]))
    row.value = {"issuer": "https://idp", "client_secret_encrypted": "CIPHER"}
    db.commit()

    env = json.loads(b"".join(backup_service.iter_export_json(db)))
    exported = next(r for r in env["tables"]["app_settings"] if r["key"] == k0)
    assert exported["value"] == {"issuer": "https://idp", "client_secret_encrypted": backup_service.MASKED_SENTINEL}
    assert "CIPHER" not in json.dumps(env)

    exported["value"]["issuer"] = "https://idp2"
    doc = {"version": "1.0", "tables": {"app_settings": [exported]}}
    res = backup_service.apply_import(db, backup_service.open_backup_file(_f(doc)), mode="merge")
    assert res["errors"] == []
    db.expire_all()
    assert db.get(AppSetting, uuid.UUID(keys[k0])).value == {"issuer": "https://idp2", "client_secret_encrypted": "CIPHER"}

    # 원본 행이 없는 곳에 들어가면 비운다 — 센티널이 secret 으로 저장되면 안 된다.
    new_id = str(uuid.uuid4())
    doc = {"version": "1.0", "tables": {"app_settings": [
        {"id": new_id, "key": f"import-stream-{uuid.uuid4().hex[:8]}-oidc", "value": exported["value"]},
    ]}}
    backup_service.apply_import(db, backup_service.open_backup_file(_f(doc)), mode="merge")
    db.expire_all()
    assert db.get(AppSetting, uuid.UUID(new_id)).value["client_secret_encrypted"] is None


def test_apply_caps_row_errors(db, monkeypatch):
    monkeypatch.setattr(backup_service, "IMPORT_ERRORS_LIMIT", 5)
    doc = {"version": "1.0", "tables": {"app_settings": [{"value": {"i": i}} for i in range(12)]}}  # PK 없음
    res = backup_service.apply_import(db, backup_service.open_backup_file(_f(doc)), mode="merge")
    assert len(res["errors"]) == 6 and "7건 생략" in res["errors"][-1]


# ── API ───────────────────────────────────────────────────────────────────

@pytest.fixture
def admin_client(db):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth.deps import get_current_user
    from app.models.audit_log import AuditLog
    from app.models.user import User

    u = User(username=f"admin-{uuid.uuid4().hex[:8]}", hashed_password="x", role="admin")
    db.add(u)
    db.commit()
    db.refresh(u)
    app.dependency_overrides[get_current_user] = lambda: u
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        db.query(AuditLog).filter(AuditLog.actor_user_id == u.id).delete(synchronize_session=False)
        db.query(User).filter(User.id == u.id).delete(synchronize_session=False)
        db.commit()


def test_api_preview_and_apply_from_upload(admin_client, db, keys):
    from app.models.app_setting import AppSetting

    k1 = list(keys)[1]
    new_key, new_id = f"import-stream-{uuid.uuid4().hex[:8]}-api", str(uuid.uuid4())
    raw = json.dumps({
        "version": "1.0",
        "tables": {"app_settings": [
            {"id": keys[k1], "key": k1, "value": {"api": 1}},
            {"id": new_id, "key": new_key, "value": {"api": 2}},
        ]},
    }).encode()

    r = admin_client.post("/api/v1/backup/import/preview", files={"file": ("b.json", raw)}, data={"mode": "merge"})
    assert r.status_code == 200, r.text
    app = next(t for t in r.json()["diff"]["tables"] if t["name"] == "app_settings")
    assert app["incoming"] == 2 and app["insert_count"] == 1

    r = admin_client.post("/api/v1/backup/import", files={"file": ("b.json", raw)}, data={"mode": "merge"})
    assert r.status_code == 200, r.text
    assert r.json()["inserted"] == 1 and r.json()["updated"] == 1
    db.expire_all()
    assert db.get(AppSetting, uuid.UUID(new_id)).value == {"api": 2}


def test_api_rejects_broken_file_with_422(admin_client):
    r = admin_client.post(
        "/api/v1/backup/import/preview", files={"file": ("b.json", b'{"version": "1.0", "tables": {"a": [')},
        data={"mode": "merge"},
    )
    assert r.status_code == 422
    assert "파싱 실패" in r.json()["detail"]
