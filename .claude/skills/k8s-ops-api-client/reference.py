"""API client layer — KM(K8s Manager) 클라이언트 계층 패턴: 리소스 경로 객체, 읽기/쓰기 속성 구분,
오류 정규화, 최소 API 버전 게이트, 일괄 실행(전체 롤백).

차용 포인트
1. Resource(경로) 객체가 HTTP 동사를 감싸고, 도메인 객체는 `_path()` 만 정의 → 엔드포인트 추가가 한 줄.
2. 읽기/쓰기 속성 vs 읽기 전용 속성: 직렬화 시 읽기 전용 필드는 보내지 않는다(서버 계산 필드 덮어쓰기 방지).
3. 재시도는 *멱등(GET) + 타임아웃* 일 때만. 변경(POST/PUT/DELETE)은 자동 재시도하지 않는다.
4. 서버 오류 본문이 JSON 이면 message 를 꺼내 사람이 읽을 예외로 정규화.
5. 최소 API 버전 게이트(check_api_version): 대상 서버(K8s minor) 가 기능을 지원하는지 호출 전에 막는다.
6. Batch: 여러 변경을 하나로 — 하나라도 실패하면 이미 적용된 것을 보상(rollback)한다.

K8s 에서는 서버가 트랜잭션을 주지 않으므로 6 은 *보상 트랜잭션*(saga) 으로 구현한다.
"""
from __future__ import annotations

import functools
import json
import time
from dataclasses import dataclass, fields
from typing import Any, Callable


class ApiError(Exception):
    def __init__(self, status: int, message: str, body: str = ""):
        super().__init__(f"{status}: {message}")
        self.status, self.message, self.body = status, message, body

    @classmethod
    def from_response(cls, status: int, body: str) -> "ApiError":
        msg = body
        try:
            j = json.loads(body)
            # KM: {"message": ...} / K8s Status: {"kind":"Status","message":...,"reason":...}
            msg = j.get("message") or j.get("reason") or body
        except (ValueError, AttributeError):
            pass
        return cls(status, (msg or "").strip()[:500], body)

    @property
    def retryable(self) -> bool:
        return self.status in (429, 503, 504)


def retry_idempotent(retries: int = 3, sleep: float = 1.0, retry_on=(TimeoutError, ConnectionError)):
    """GET 전용 데코레이터. 429/503/504 와 타임아웃만 재시도, 지수 백오프."""
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*a, **kw):
            for attempt in range(retries + 1):
                try:
                    return fn(*a, **kw)
                except ApiError as e:
                    if not e.retryable or attempt == retries:
                        raise
                except retry_on:
                    if attempt == retries:
                        raise
                time.sleep(sleep * (2 ** attempt))
        return wrapper
    return deco


class VersionError(Exception):
    pass


def requires(min_version: tuple[int, int]):
    """`self.server_version` (major, minor) 가 낮으면 호출 전에 실패. 예: @requires((1, 29))."""
    def deco(fn):
        @functools.wraps(fn)
        def wrapper(self, *a, **kw):
            if self.server_version < min_version:
                raise VersionError(f"{fn.__name__} requires server >= {min_version}, got {self.server_version}")
            return fn(self, *a, **kw)
        return wrapper
    return deco


# ── 타입 모델: 읽기 전용 속성을 dataclass metadata 로 ──
def ro(default=None):
    from dataclasses import field
    return field(default=default, metadata={"ro": True})


def to_payload(obj) -> dict:
    """RO 필드와 None 을 뺀 쓰기용 dict."""
    return {f.name: getattr(obj, f.name) for f in fields(obj)
            if not f.metadata.get("ro") and getattr(obj, f.name) is not None}


def from_dict(cls, d: dict):
    names = {f.name for f in fields(cls)}
    return cls(**{k: v for k, v in d.items() if k in names})  # 모르는 필드는 버린다(서버 버전 차 허용)


# ── Batch with compensation ──
@dataclass
class BatchElement:
    label: str
    do: Callable[[], Any]
    undo: Callable[[Any], None] | None = None  # do 결과를 받아 되돌림. None 이면 되돌릴 수 없음


@dataclass
class BatchResult:
    success: bool
    results: list[dict]


def run_batch(elements: list[BatchElement], log: Callable[[str], None] = print) -> BatchResult:
    """KM 일괄 실행: 하나라도 실패하면 전체 롤백 + 이후 요소 무시."""
    done: list[tuple[BatchElement, Any]] = []
    results: list[dict] = []
    for el in elements:
        try:
            out = el.do()
            done.append((el, out))
            results.append({"label": el.label, "status": "ok"})
            log(f"ok   {el.label}")
        except Exception as e:
            results.append({"label": el.label, "status": "failed", "error": str(e)})
            log(f"FAIL {el.label}: {e} — rolling back {len(done)} element(s)")
            for prev, prev_out in reversed(done):
                if prev.undo is None:
                    results.append({"label": prev.label, "status": "rollback_unsupported"})
                    log(f"  !! cannot undo {prev.label}")
                    continue
                try:
                    prev.undo(prev_out)
                    results.append({"label": prev.label, "status": "rolled_back"})
                    log(f"  undo {prev.label}")
                except Exception as ue:
                    results.append({"label": prev.label, "status": "rollback_failed", "error": str(ue)})
                    log(f"  !! undo failed {prev.label}: {ue}")
            skipped = elements[len(done) + 1:]
            results += [{"label": s.label, "status": "skipped"} for s in skipped]
            return BatchResult(False, results)
    return BatchResult(True, results)
