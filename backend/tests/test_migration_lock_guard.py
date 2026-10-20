"""부팅 마이그레이션 lock 가드 — 1.59 배포 장애(CrashLoopBackOff + 전 화면 응답없음) 회귀 테스트.

이전 파드의 긴 트랜잭션이 테이블을 읽고 있는 상태에서 새 파드가 부팅해도
  - 이미 있는 컬럼·인덱스는 DDL 을 보내지 않아 lock 을 잡지 않고,
  - 없는 컬럼 추가는 lock_timeout 안에 포기해 다른 세션의 조회를 막지 않으며,
  - 포기한 추가는 미룸 목록에 남아 lock 이 풀린 뒤 적용된다.
"""
import threading
import time

import pytest
from sqlalchemy import create_engine, text

import app.main as m
from app.config import settings
from app.database import engine

TABLE = "pep_lock_guard_probe"


@pytest.fixture()
def probe_table(monkeypatch):
    monkeypatch.setattr(settings, "migration_lock_timeout_seconds", 0.5)
    with engine.begin() as conn:
        conn.execute(text(f"DROP TABLE IF EXISTS {TABLE}"))
        conn.execute(text(f"CREATE TABLE {TABLE} (id INT PRIMARY KEY, name TEXT)"))
        conn.execute(text(f"INSERT INTO {TABLE} VALUES (1, 'a')"))
    m._reset_schema_cache()
    m._pending_ddl.clear()
    other = create_engine(settings.database_url)
    yield other
    m._pending_ddl.clear()
    other.dispose()
    with engine.begin() as conn:
        conn.execute(text(f"DROP TABLE IF EXISTS {TABLE}"))


def _hold_read_lock(other_engine):
    """이전 파드의 긴 요청 흉내 — 테이블을 읽은 채 트랜잭션을 열어 둔다(AccessShareLock 유지)."""
    conn = other_engine.connect()
    conn.execute(text(f"SELECT * FROM {TABLE}")).all()
    return conn


def test_existing_column_sends_no_ddl(probe_table):
    holder = _hold_read_lock(probe_table)
    try:
        started = time.monotonic()
        m._safe_add_column(TABLE, "name", "TEXT")  # 이미 있음 — ALTER 를 보내면 lock 대기
        assert time.monotonic() - started < 0.4
        assert not m._pending_ddl
    finally:
        holder.close()


def test_missing_column_gives_up_without_blocking_readers(probe_table):
    holder = _hold_read_lock(probe_table)
    reader_elapsed: list[float] = []

    def _reader():
        time.sleep(0.2)  # ALTER 가 lock 대기열에 선 뒤에 조회
        with probe_table.connect() as c:
            t0 = time.monotonic()
            c.execute(text(f"SELECT count(*) FROM {TABLE}")).scalar()
            reader_elapsed.append(time.monotonic() - t0)

    t = threading.Thread(target=_reader)
    try:
        t.start()
        m._safe_add_column(TABLE, "password_changed_at", "TIMESTAMP")
        t.join(timeout=10)
    finally:
        holder.close()
    # 포기하고 미룸 목록에 넣었다 — 부팅은 계속된다.
    assert f"{TABLE}.password_changed_at" in m._pending_ddl
    # 대기열의 ALTER 뒤에 선 조회도 lock_timeout(0.5s) 남짓이면 풀린다(예전엔 무한 대기).
    assert reader_elapsed and reader_elapsed[0] < 3.0

    # lock 이 풀리면 미뤘던 추가가 적용된다.
    m._retry_pending_ddl_forever(interval_seconds=0, max_rounds=1)
    assert not m._pending_ddl
    with engine.connect() as c:
        cols = {r[0] for r in c.execute(text(
            "SELECT column_name FROM information_schema.columns WHERE table_name = :t"), {"t": TABLE})}
    assert "password_changed_at" in cols


def test_existing_index_is_skipped(probe_table):
    m._safe_create_index("ix_pep_lock_guard_probe_name", TABLE, "(name)")
    holder = _hold_read_lock(probe_table)
    try:
        started = time.monotonic()
        m._safe_create_index("ix_pep_lock_guard_probe_name", TABLE, "(name)")
        assert time.monotonic() - started < 0.4
    finally:
        holder.close()


def test_migration_phase_sets_and_resets_lock_timeout():
    m._migration_phase["active"] = True
    try:
        with engine.connect() as c:
            during = c.execute(text("SHOW lock_timeout")).scalar()
    finally:
        m._migration_phase["active"] = False
    with engine.connect() as c:
        after = c.execute(text("SHOW lock_timeout")).scalar()
    assert during != "0"
    assert after == "0"
