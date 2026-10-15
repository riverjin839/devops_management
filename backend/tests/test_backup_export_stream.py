"""백업 export 스트리밍(`iter_export_json`) — 운영 DB 를 한 워커 메모리에 통째로 올려 backend 가
OOMKilled 되던 문제의 회귀 테스트.

계약:
1. 스트림을 이어 붙이면 `export_all()` 과 같은 내용의 유효한 JSON 이고, 복구(`parse_backup`)가 읽는다.
2. 출력이 여러 조각으로 나뉘어 나온다(한 번에 다 만들지 않는다).
3. 한 테이블이 중간에 실패해도 JSON 은 유효하고, 그 테이블은 errors/skipped_tables 에 남고 나머지는 이어진다.
"""
import json
import uuid

import pytest

from app.services import backup_service


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
def settings_rows(db):
    from app.models.app_setting import AppSetting

    keys = [f"stream-test-{uuid.uuid4().hex[:8]}-{i}" for i in range(40)]
    db.add_all([AppSetting(key=k, value={"i": i, "pad": "x" * 2000}) for i, k in enumerate(keys)])
    db.commit()
    yield keys
    db.query(AppSetting).filter(AppSetting.key.in_(keys)).delete(synchronize_session=False)
    db.commit()


def _collect(db, **kw) -> tuple[list[bytes], dict]:
    summary: dict = {}
    chunks = list(backup_service.iter_export_json(db, summary=summary, **kw))
    return chunks, summary


def test_stream_matches_export_all_and_is_restorable(db, settings_rows):
    chunks, summary = _collect(db)
    doc = json.loads(b"".join(chunks))
    ref = backup_service.export_all(db)

    assert doc["version"] == ref["version"]
    assert set(doc["tables"]) == set(ref["tables"])
    assert doc["counts"] == ref["counts"]
    keys = {r["key"] for r in doc["tables"]["app_settings"]}
    assert set(settings_rows) <= keys
    assert summary["bytes"] == sum(len(c) for c in chunks)
    backup_service.parse_backup(b"".join(chunks))  # 복구 경로가 그대로 읽는다


def test_stream_is_chunked(db, settings_rows, monkeypatch):
    monkeypatch.setattr(backup_service, "EXPORT_FLUSH_BYTES", 8 * 1024)
    monkeypatch.setattr(backup_service, "EXPORT_YIELD_PER", 5)
    chunks, _ = _collect(db)
    assert len(chunks) > 5  # 40행 × ~2KB 가 8KB 단위로 나뉘어 나온다
    assert max(len(c) for c in chunks) < 64 * 1024


def test_partial_table_failure_keeps_json_valid(db, settings_rows, monkeypatch):
    real = backup_service._mask_sensitive
    seen = {"n": 0}

    def flaky(table_name, row, include_sensitive):
        if table_name == "app_settings":
            seen["n"] += 1
            if seen["n"] == 3:
                raise RuntimeError("boom")
        return real(table_name, row, include_sensitive)

    monkeypatch.setattr(backup_service, "_mask_sensitive", flaky)
    chunks, summary = _collect(db)
    doc = json.loads(b"".join(chunks))

    assert "app_settings" in doc["skipped_tables"]
    assert doc["errors"]["app_settings"].startswith("partial (2 rows written)")
    assert len(doc["tables"]["app_settings"]) == 2
    assert doc["counts"]["app_settings"] == 2
    # 실패 뒤 테이블도 계속 내보낸다(rollback 후 다음 테이블 정상).
    assert "users" in doc["tables"]
    assert summary["skipped_tables"] == ["app_settings"]
