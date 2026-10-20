"""백업 JSON 파일 스트리밍 리더 — 가져오기(미리보기·적용)가 업로드 파일을 통째로 메모리에 올리지 않게 한다.

예전 가져오기는 업로드를 ``await file.read()`` 로 다 읽고 ``json.loads`` 로 전체를 파이썬 객체로 만들었다.
210MB 백업이면 바이트·문자열·객체 사본이 겹쳐 수 GiB 가 돼 backend 파드가 OOMKilled 될 수 있었다.

여기서는 업로드가 이미 디스크에 내려가 있는 임시 파일(``UploadFile.file``)을 두 번 훑는다.

1. ``index_backup`` — 처음부터 끝까지 한 번 읽으며 JSON 전체를 검증하고, 최상위 메타(version·created_at·
   options …)와 ``tables`` 안 테이블별 **배열 시작 바이트 위치·행 수**만 기록한다. 행은 읽자마자 버린다.
2. ``iter_table_rows`` — 기록한 위치로 seek 해서 그 테이블의 행을 하나씩 돌려준다. 그래서 파일 안의
   테이블 순서와 무관하게 FK 의존 순서대로 적용할 수 있다.

메모리는 "버퍼 1MB + 행 하나" 수준이다. 의존성(ijson 등)을 추가하지 않으려고 표준 ``json.JSONDecoder.raw_decode``
로 값 단위만 디코드하고, 객체·배열 구조는 직접 따라간다.
"""
from __future__ import annotations

import codecs
import json
from dataclasses import dataclass, field
from typing import IO, Any, Iterator

READ_CHUNK = 1 << 20
# 값 하나(행 하나)의 최대 크기(문자 수). 깨진 파일에서 닫히지 않는 문자열이 파일 끝까지 버퍼를 키우는 것을 막는다.
MAX_VALUE_CHARS = 128 * 1024 * 1024
_WS = " \t\r\n﻿"


@dataclass
class TableSpan:
    offset: int  # 테이블 배열 '[' 의 바이트 위치
    count: int


@dataclass
class BackupIndex:
    meta: dict[str, Any] = field(default_factory=dict)
    tables: dict[str, TableSpan] = field(default_factory=dict)


class _Reader:
    """바이너리 파일 위의 증분 JSON 리더. 소비한 바이트 위치를 추적한다."""

    def __init__(self, fobj: IO[bytes], start: int = 0):
        fobj.seek(start)
        self._f = fobj
        self._dec = codecs.getincrementaldecoder("utf-8")()
        self._json = json.JSONDecoder()
        self._buf = ""
        self._pos = 0
        self._base = start  # _buf[0] 의 바이트 위치
        self._eof = False

    def offset(self) -> int:
        return self._base + len(self._buf[: self._pos].encode("utf-8"))

    def _fill(self, want: int = READ_CHUNK) -> bool:
        if self._eof:
            return False
        if self._pos:
            self._base += len(self._buf[: self._pos].encode("utf-8"))
            self._buf = self._buf[self._pos:]
            self._pos = 0
        chunk = self._f.read(max(want, READ_CHUNK))
        try:
            if not chunk:
                self._eof = True
                tail = self._dec.decode(b"", final=True)
                self._buf += tail
                return bool(tail)
            self._buf += self._dec.decode(chunk)
        except UnicodeDecodeError as e:
            raise ValueError(f"백업 파일이 UTF-8 이 아닙니다 (byte ~{self._base + len(self._buf)}): {e.reason}") from e
        return True

    def peek(self) -> str:
        """공백을 건너뛰고 다음 문자를 돌려준다(소비하지 않음). 파일 끝이면 빈 문자열."""
        while True:
            while self._pos < len(self._buf) and self._buf[self._pos] in _WS:
                self._pos += 1
            if self._pos < len(self._buf):
                return self._buf[self._pos]
            if not self._fill():
                return ""

    def expect(self, ch: str) -> None:
        got = self.peek()
        if got != ch:
            raise ValueError(
                f"백업 파일 JSON 파싱 실패: '{ch}' 가 와야 할 자리에 {got or '파일 끝'!r} (byte ~{self.offset()})"
            )
        self._pos += 1

    def value(self) -> Any:
        """다음 JSON 값 하나를 디코드한다. 버퍼 경계에서 잘린 값이면 더 읽고 다시 시도한다."""
        if not self.peek():
            raise ValueError("백업 파일 JSON 파싱 실패: 파일이 중간에 끝났습니다.")
        while True:
            try:
                obj, end = self._json.raw_decode(self._buf, self._pos)
            except json.JSONDecodeError as e:
                pending = len(self._buf) - self._pos
                if pending > MAX_VALUE_CHARS:
                    raise ValueError(
                        f"백업 파일 JSON 파싱 실패: 값 하나가 {MAX_VALUE_CHARS // (1024 * 1024)}MB 를 넘습니다 "
                        f"(byte ~{self.offset()})"
                    ) from e
                # 아직 덜 읽었을 수 있다 — 지금까지 쌓인 만큼 더 읽어(기하급수) 재시도 횟수를 줄인다.
                if self._fill(pending):
                    continue
                raise ValueError(f"백업 파일 JSON 파싱 실패: {e.msg} (byte ~{self.offset()})") from e
            # 숫자 같은 값은 버퍼 끝에서 잘려도 성공으로 디코드된다 — 끝에 딱 닿았으면 더 읽고 다시 본다.
            if end == len(self._buf) and self._fill():
                continue
            self._pos = end
            return obj

    def separator(self, close: str) -> bool:
        """',' 면 True(다음 항목), ``close`` 면 False(끝)."""
        c = self.peek()
        if c == ",":
            self._pos += 1
            return True
        if c == close:
            self._pos += 1
            return False
        raise ValueError(
            f"백업 파일 JSON 파싱 실패: ',' 또는 '{close}' 가 와야 할 자리에 {c or '파일 끝'!r} (byte ~{self.offset()})"
        )

    def array_items(self) -> Iterator[Any]:
        self.expect("[")
        if self.peek() == "]":
            self._pos += 1
            return
        while True:
            yield self.value()
            if not self.separator("]"):
                return

    def key(self) -> str:
        k = self.value()
        if not isinstance(k, str):
            raise ValueError(f"백업 파일 JSON 파싱 실패: 객체 키가 문자열이 아닙니다 (byte ~{self.offset()})")
        self.expect(":")
        return k


def index_backup(fobj: IO[bytes]) -> BackupIndex:
    """파일 전체를 한 번 훑어 검증하고 메타·테이블 위치를 기록한다. 형식이 틀리면 ``ValueError``."""
    r = _Reader(fobj)
    idx = BackupIndex()
    seen_tables = False
    r.expect("{")
    if r.peek() == "}":
        r.expect("}")
    else:
        while True:
            k = r.key()
            if k == "tables":
                seen_tables = True
                idx.tables = {}
                r.expect("{")
                if r.peek() == "}":
                    r.expect("}")
                else:
                    while True:
                        name = r.key()
                        if r.peek() != "[":
                            raise ValueError(f"백업 파일 형식 오류: tables.{name} 는 배열이어야 합니다.")
                        offset = r.offset()
                        n = sum(1 for _ in r.array_items())
                        idx.tables[name] = TableSpan(offset=offset, count=n)  # 중복 키는 json.loads 처럼 마지막이 이긴다
                        if not r.separator("}"):
                            break
            else:
                idx.meta[k] = r.value()
            if not r.separator("}"):
                break
    if r.peek():
        raise ValueError(f"백업 파일 JSON 파싱 실패: 최상위 객체 뒤에 데이터가 더 있습니다 (byte ~{r.offset()})")
    if "version" not in idx.meta or not seen_tables:
        raise ValueError("유효한 백업 파일이 아닙니다 (version + tables 필수).")
    return idx


def iter_table_rows(fobj: IO[bytes], span: TableSpan) -> Iterator[Any]:
    """``index_backup`` 이 기록한 위치에서 그 테이블의 행을 하나씩 읽는다."""
    yield from _Reader(fobj, span.offset).array_items()
