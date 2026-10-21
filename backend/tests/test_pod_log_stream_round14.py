"""14차 감사 D-182·D-187 — 파드 로그·클러스터 이벤트 SSE 스트림.

- 종료/오류는 로그 줄이 아니라 이름 있는 이벤트(`event: end` / `event: error`)
- 데이터가 없으면 하트비트(`: ping`) — 조용한 파드에서도 최대 시간·연결 해제를 확인
- 동시 한도 사용자당 3 + 전체 20, 초과는 429 + 한국어 detail
- 슬롯은 모든 경로(정상 종료·오류·클라이언트 해제·응답 시작 전 폐기)에서 반환
- 읽기 타임아웃이면 since_seconds 로 이어 읽고 겹친 줄은 타임스탬프로 제거
- 다운로드가 10MB 상한에 닿으면 `X-Log-Truncated: 1`

K8s 는 가짜 CoreV1Api/Watch 로 대체한다 (클러스터·DB 불필요).
"""

import os

os.environ.setdefault(
    "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test"
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

import gc
import json
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from kubernetes.client.exceptions import ApiException
from urllib3.exceptions import ReadTimeoutError

from app.routers import analyze


# ── 가짜 K8s ─────────────────────────────────────────────────────────────

class FakeResp:
    """`script` 항목: bytes → 청크, "timeout" → 읽기 타임아웃, "block" → shutdown 까지 대기."""

    def __init__(self, script):
        self.script = list(script)
        self.shut = threading.Event()
        self.closed = False

    def stream(self, amt=None, decode_content=True):
        for item in self.script:
            if item == "timeout":
                raise ReadTimeoutError(None, None, "Read timed out.")
            if item == "block":
                if not self.shut.wait(5):
                    raise AssertionError("block 이 shutdown 없이 5초를 넘었다")
                raise ConnectionError("shut down")
            yield item

    def shutdown(self):
        self.shut.set()

    def close(self):
        self.closed = True

    def release_conn(self):
        pass


class FakeV1:
    def __init__(self, responses=None, exc=None, text=None):
        self.responses = list(responses or [])
        self.exc = exc
        self.text = text
        self.calls: list[dict] = []

    def read_namespaced_pod_log(self, **kwargs):
        self.calls.append(kwargs)
        if self.exc is not None:
            raise self.exc
        if not kwargs.get("_preload_content", True):
            return self.responses.pop(0)
        return self.text


USER_A = SimpleNamespace(id="user-a", username="a")
USER_B = SimpleNamespace(id="user-b", username="b")


@pytest.fixture(autouse=True)
def _fast_stream(monkeypatch):
    monkeypatch.setattr(analyze, "_stream_limiter", analyze._StreamLimiter(3, 20))
    monkeypatch.setattr(analyze, "_LOG_STREAM_HEARTBEAT_SECONDS", 0.05)
    monkeypatch.setattr(analyze, "_require_cluster", lambda cid, db: SimpleNamespace(id=cid))
    # StreamingResponse 는 sync generator 를 스레드풀 래퍼로 감싸므로 원본 generator 를 꺼낸다.
    monkeypatch.setattr(
        analyze, "StreamingResponse",
        lambda content, media_type=None, headers=None: SimpleNamespace(
            gen=content, media_type=media_type, headers=headers,
        ),
    )


def _open_logs(monkeypatch, v1, user=USER_A, **kw):
    monkeypatch.setattr(analyze, "_get_core_v1", lambda cluster: v1)
    params = dict(
        container=None, tail_lines=200, follow=True, previous=False,
        timestamps=False, since_seconds=None,
    )
    params.update(kw)
    return analyze.stream_pod_logs(
        "c1", "ns", "pod", db=None, current_user=user, **params,
    )


def _collect(gen, limit_s=5.0):
    """end/error 이벤트까지 모은다."""
    out: list[str] = []
    t0 = time.monotonic()
    for chunk in gen:
        out.append(chunk)
        if "event: end" in chunk or "event: error" in chunk:
            break
        assert time.monotonic() - t0 < limit_s, "스트림이 끝나지 않았다"
    return "".join(out)


def _event(text: str, name: str) -> dict:
    block = text.split(f"event: {name}\n", 1)[1]
    return json.loads(block.split("\n", 1)[0][len("data: "):])


def _ts(n: int) -> str:
    return f"2026-10-21T00:00:00.{n:09d}Z"


# ── 정상 종료 / 오류 / 잘림 ──────────────────────────────────────────────

def test_eof_sends_end_event_with_bytes_and_releases_slot(monkeypatch):
    v1 = FakeV1([FakeResp([f"{_ts(1)} hello\n{_ts(2)} wor".encode(), b"ld\n"])])
    resp = _open_logs(monkeypatch, v1)
    assert resp.media_type == "text/event-stream"
    assert analyze._stream_limiter.in_use("user-a") == 1
    text = _collect(resp.gen)
    assert "data: hello\n\n" in text and "data: world\n\n" in text  # 청크 경계에서 줄이 쪼개지지 않음
    assert _event(text, "end") == {"reason": "eof", "bytes": 10}
    assert "[stream" not in text
    assert analyze._stream_limiter.in_use() == 0
    # 이어 읽기 중복 제거를 위해 K8s 에는 항상 timestamps=True + 읽기 타임아웃.
    call = v1.calls[0]
    assert call["timestamps"] is True
    assert call["_request_timeout"] == (10, 30)
    assert call["tail_lines"] == 200


def test_timestamps_option_keeps_prefix(monkeypatch):
    v1 = FakeV1([FakeResp([f"{_ts(1)} hello\n".encode()])])
    text = _collect(_open_logs(monkeypatch, v1, timestamps=True).gen)
    assert f"data: {_ts(1)} hello\n\n" in text


def test_kube_error_sends_error_event(monkeypatch):
    exc = ApiException(status=400, reason="Bad Request")
    exc.body = json.dumps({"message": "a container name must be specified"})
    v1 = FakeV1(exc=exc)
    text = _collect(_open_logs(monkeypatch, v1).gen)
    msg = _event(text, "error")["message"]
    assert "HTTP 400" in msg and "container name" in msg
    assert "data: [stream error]" not in text
    assert analyze._stream_limiter.in_use() == 0


def test_truncated_at_byte_cap(monkeypatch):
    monkeypatch.setattr(analyze, "_LOG_STREAM_MAX_BYTES", 8)
    body = "".join(f"{_ts(i)} {c * 4}\n" for i, c in enumerate("abc", start=1)).encode()
    text = _collect(_open_logs(monkeypatch, FakeV1([FakeResp([body, "block"])])).gen)
    assert "data: aaaa" in text and "data: bbbb" in text and "cccc" not in text
    assert _event(text, "end") == {"reason": "truncated", "bytes": 8}
    assert analyze._stream_limiter.in_use() == 0


def test_max_duration_ends_without_new_lines(monkeypatch):
    monkeypatch.setattr(analyze.settings, "log_stream_max_duration_seconds", 1)
    resp = FakeResp(["block"])
    t0 = time.monotonic()
    text = _collect(_open_logs(monkeypatch, FakeV1([resp])).gen)
    assert time.monotonic() - t0 < 3
    assert ": ping\n\n" in text
    assert _event(text, "end") == {"reason": "max_duration", "bytes": 0}
    assert resp.shut.wait(2), "끝나면 막힌 K8s 읽기를 깨워야 한다"
    assert analyze._stream_limiter.in_use() == 0


# ── 하트비트 / 연결 해제 / 한도 ──────────────────────────────────────────

def test_quiet_stream_heartbeat_then_client_disconnect_releases_slot(monkeypatch):
    resp = FakeResp(["block"])
    gen = _open_logs(monkeypatch, FakeV1([resp])).gen
    assert next(gen) == ": ping\n\n"
    assert next(gen) == ": ping\n\n"
    assert analyze._stream_limiter.in_use("user-a") == 1
    gen.close()  # 클라이언트 해제 → Starlette 가 generator 를 닫는다
    assert analyze._stream_limiter.in_use() == 0
    assert resp.shut.wait(2), "리더 스레드의 K8s 읽기를 shutdown 으로 깨워야 한다"


def test_per_user_limit_is_3_and_returns_korean_429(monkeypatch):
    v1 = FakeV1([FakeResp(["block"]) for _ in range(5)])
    held = [_open_logs(monkeypatch, v1) for _ in range(3)]
    with pytest.raises(HTTPException) as ei:
        _open_logs(monkeypatch, v1)
    assert ei.value.status_code == 429
    assert ei.value.detail == (
        "동시 로그 스트림 한도(사용자당 3·전체 20)를 넘었습니다. 다른 스트림을 닫고 다시 시도하세요."
    )
    # 다른 사용자는 영향 없음.
    other = _open_logs(monkeypatch, v1, user=USER_B)
    assert analyze._stream_limiter.in_use() == 4
    # 응답 시작 전에 버려진(한 번도 돌지 않은) generator 도 슬롯을 돌려준다.
    del held, other
    gc.collect()
    assert analyze._stream_limiter.in_use() == 0
    _open_logs(monkeypatch, v1)  # 다시 열 수 있다


def test_global_limit(monkeypatch):
    monkeypatch.setattr(analyze, "_stream_limiter", analyze._StreamLimiter(3, 2))
    v1 = FakeV1([FakeResp(["block"]) for _ in range(3)])
    a = _open_logs(monkeypatch, v1, user=USER_A)
    b = _open_logs(monkeypatch, v1, user=USER_B)
    with pytest.raises(HTTPException) as ei:
        _open_logs(monkeypatch, v1, user=SimpleNamespace(id="user-c", username="c"))
    assert ei.value.status_code == 429
    a.gen.close()
    b.gen.close()
    assert analyze._stream_limiter.in_use() == 0


def test_slot_release_is_idempotent():
    lim = analyze._StreamLimiter(3, 20)
    slot = lim.try_acquire("u")
    slot.release()
    slot.release()
    assert lim.in_use() == 0 and lim.in_use("u") == 0


# ── 이어 읽기 ────────────────────────────────────────────────────────────

def test_read_timeout_resumes_with_since_seconds_and_dedups(monkeypatch):
    first = FakeResp([f"{_ts(1)} one\n{_ts(2)} two\n".encode(), "timeout"])
    # 이어 읽기 창이 겹쳐 two 가 다시 오고, 같은 나노초의 다른 줄(two-b)은 새 줄이다.
    second = FakeResp([f"{_ts(1)} one\n{_ts(2)} two\n{_ts(2)} two-b\n{_ts(3)} three\n".encode()])
    v1 = FakeV1([first, second])
    text = _collect(_open_logs(monkeypatch, v1, since_seconds=60).gen)
    lines = [ln[len("data: "):] for ln in text.split("\n\n") if ln.startswith("data: ")]
    assert lines == ["one", "two", "two-b", "three"]
    assert _event(text, "end")["reason"] == "eof"
    resume = v1.calls[1]
    assert "tail_lines" not in resume
    assert resume["since_seconds"] >= 1
    assert resume["follow"] is True and resume["timestamps"] is True
    assert v1.calls[0]["since_seconds"] == 60


def test_read_timeout_without_follow_is_error(monkeypatch):
    v1 = FakeV1([FakeResp(["timeout"])])
    text = _collect(_open_logs(monkeypatch, v1, follow=False).gen)
    assert "읽기 타임아웃" in _event(text, "error")["message"]


# ── 다운로드 ─────────────────────────────────────────────────────────────

def test_download_sets_truncated_header_at_cap(monkeypatch):
    monkeypatch.setattr(analyze, "_LOG_STREAM_MAX_BYTES", 10)
    monkeypatch.setattr(analyze, "_get_core_v1", lambda cluster: FakeV1(text="x" * 10))
    resp = analyze.download_pod_logs("c1", "ns", "pod", container="app", db=None)
    assert resp.headers.get("x-log-truncated") == "1"
    assert "X-Log-Truncated" in resp.headers.get("access-control-expose-headers", "")

    v1 = FakeV1(text="short")
    monkeypatch.setattr(analyze, "_get_core_v1", lambda cluster: v1)
    resp = analyze.download_pod_logs("c1", "ns", "pod", container="app", db=None)
    assert "x-log-truncated" not in resp.headers
    assert v1.calls[0]["limit_bytes"] == 10


# ── 클러스터 이벤트 스트림 ────────────────────────────────────────────────

def _k8s_event(uid: str):
    return SimpleNamespace(
        metadata=SimpleNamespace(uid=uid, name=f"ev-{uid}", namespace="default"),
        involved_object=SimpleNamespace(kind="Pod", name="p"),
        type="Warning", reason="BackOff", message="back-off", count=1,
        first_timestamp=None, last_timestamp=None, event_time=None,
        source=None, reporting_component=None,
    )


class FakeWatchFactory:
    """`plans` 항목: ("events", [uid…], then) — then 은 "timeout" | "block" | ApiException."""

    def __init__(self, plans):
        self.plans = list(plans)
        self.calls: list[dict] = []
        self.watches: list = []

    def __call__(self):
        factory = self

        class _W:
            def __init__(self):
                self.resource_version = None
                self._stopped = threading.Event()
                factory.watches.append(self)

            def stop(self):
                self._stopped.set()

            def stream(self, func, *args, **kwargs):
                factory.calls.append(kwargs)
                if "resource_version" in kwargs:
                    self.resource_version = kwargs["resource_version"]
                uids, then = factory.plans.pop(0)
                for uid in uids:
                    self.resource_version = f"rv-{uid}"
                    yield {"type": "ADDED", "object": _k8s_event(uid)}
                if then == "timeout":
                    raise ReadTimeoutError(None, None, "Read timed out.")
                if then == "block":
                    while not self._stopped.wait(0.02):
                        pass
                    return
                if isinstance(then, Exception):
                    raise then

        return _W()


def _open_events(monkeypatch, factory, user=USER_A):
    monkeypatch.setattr(analyze, "_get_core_v1", lambda cluster: SimpleNamespace(
        list_event_for_all_namespaces=lambda **kw: None,
        list_namespaced_event=lambda *a, **kw: None,
    ))
    monkeypatch.setattr(analyze.k8s_watch, "Watch", factory)
    return analyze.stream_cluster_events("c1", namespace=None, db=None, current_user=user)


def test_events_resume_after_read_timeout_and_heartbeat_then_disconnect(monkeypatch):
    factory = FakeWatchFactory([(["1"], "timeout"), (["2"], "block")])
    gen = _open_events(monkeypatch, factory).gen
    got: list[str] = []
    t0 = time.monotonic()
    while sum(c.count("data: {") for c in got) < 2 or ": ping\n\n" not in got:
        got.append(next(gen))
        assert time.monotonic() - t0 < 5
    payloads = [json.loads(ln[len("data: "):]) for c in got for ln in c.split("\n\n") if ln.startswith("data: ")]
    assert [p["uid"] for p in payloads] == ["1", "2"]
    assert factory.calls[0]["_request_timeout"] == (10, 30)
    assert factory.calls[1]["resource_version"] == "rv-1"
    assert analyze._stream_limiter.in_use("user-a") == 1
    gen.close()
    assert analyze._stream_limiter.in_use() == 0
    assert factory.watches[-1]._stopped.wait(2)


def test_events_api_error_sends_error_event(monkeypatch):
    factory = FakeWatchFactory([([], ApiException(status=403, reason="Forbidden"))])
    text = _collect(_open_events(monkeypatch, factory).gen)
    assert "HTTP 403" in _event(text, "error")["message"]
    assert analyze._stream_limiter.in_use() == 0


def test_events_max_duration(monkeypatch):
    monkeypatch.setattr(analyze.settings, "log_stream_max_duration_seconds", 1)
    factory = FakeWatchFactory([([], "block")])
    text = _collect(_open_events(monkeypatch, factory).gen)
    assert _event(text, "end") == {"reason": "max_duration", "bytes": 0}
    assert analyze._stream_limiter.in_use() == 0


def test_events_share_limit_with_logs(monkeypatch):
    held = [_open_events(monkeypatch, FakeWatchFactory([([], "block")])) for _ in range(3)]
    with pytest.raises(HTTPException) as ei:
        _open_logs(monkeypatch, FakeV1([FakeResp(["block"])]))
    assert ei.value.status_code == 429
    for h in held:
        h.gen.close()
    assert analyze._stream_limiter.in_use() == 0
