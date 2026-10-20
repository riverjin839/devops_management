"""목록 "더 보기" 키셋 커서 — ``(received_at DESC, id DESC)`` 정렬 목록 공용.

offset 페이징은 페이지를 불러오는 사이 앞쪽 행이 필터에서 빠지면(해소·삭제·확인) 뒤쪽 행이
당겨져 경계의 행을 건너뛴다. 커서는 "마지막으로 본 행보다 뒤" 를 조건으로 걸어 그런 누락이 없다.

커서 형식: ``"<received_at ISO8601>|<id UUID>"`` (불투명 문자열로 다룬다).
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import and_, or_


def encode_cursor(received_at: datetime, row_id: UUID) -> str:
    return f"{received_at.isoformat()}|{row_id}"


def decode_cursor(cursor: str) -> tuple[datetime, UUID]:
    """잘못된 커서는 422 — 클라이언트가 만든 값이 아니면 처음부터 다시 읽게 한다."""
    try:
        ts_raw, _, id_raw = cursor.partition("|")
        return datetime.fromisoformat(ts_raw), UUID(id_raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="잘못된 목록 커서입니다 — 처음부터 다시 조회하세요.") from None


def apply_cursor(query, ts_col, id_col, cursor: Optional[str]):
    """``(ts, id) < (커서)`` 조건을 건다(정렬 ``ts DESC, id DESC`` 와 같은 키). 커서가 없으면 그대로."""
    if not cursor:
        return query
    ts, row_id = decode_cursor(cursor)
    return query.filter(or_(ts_col < ts, and_(ts_col == ts, id_col < row_id)))


def page_with_cursor(query, limit: int, ts_attr: str = "received_at") -> tuple[list, bool, Optional[str]]:
    """``limit+1`` 행을 읽어 (행, has_more, next_cursor) 를 돌려준다. query 는 정렬·커서 적용 후."""
    rows = query.limit(limit + 1).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = encode_cursor(getattr(rows[-1], ts_attr), rows[-1].id) if (has_more and rows) else None
    return rows, has_more, next_cursor
