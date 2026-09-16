"""액세스 발급 SSE 스트림의 감사 로그 계약.

핵심은 **중단 경로**다 — 사용자가 중단 버튼을 누르거나 창을 닫으면 이미 만들어진 SA·롤·
바인딩은 클러스터에 그대로 남는다. 그 실행을 감사 로그에 "success" 로 적으면 기록이
거짓말을 하게 되므로, 별도 결과("aborted")로 남아야 한다.
"""
import json

import pytest

from app.routers.k8s_rbac import provision_event_stream


class _FakeSvc:
    """provision() 만 흉내내는 최소 스텁 — K8s 도 DB 도 필요 없다."""

    def __init__(self, events=None, raises=None):
        self._events = events or []
        self._raises = raises

    def provision(self, spec):  # noqa: ARG002 — spec 은 이 스텁에서 안 쓴다
        for e in self._events:
            yield e
        if self._raises:
            raise self._raises


def _drain(gen):
    return [chunk for chunk in gen]


def test_success_run_is_recorded_as_success():
    outcomes = []
    svc = _FakeSvc([{"type": "log", "message": "시작"}, {"type": "result", "namespace": "ns"}])
    chunks = _drain(provision_event_stream(svc, {}, outcomes.append))
    assert outcomes == ["success"]
    assert json.loads(chunks[-1].removeprefix("data: ").strip())["type"] == "done"


def test_failed_run_emits_error_event_and_records_failure():
    outcomes = []
    svc = _FakeSvc([{"type": "log", "message": "시작"}], raises=ValueError("네임스페이스 없음"))
    chunks = _drain(provision_event_stream(svc, {}, outcomes.append))
    assert outcomes == ["failure"]
    error = json.loads(chunks[1].removeprefix("data: ").strip())
    assert error["type"] == "error"
    assert "네임스페이스 없음" in error["message"]


def test_interrupted_run_is_recorded_as_aborted_not_success():
    """중단 버튼/연결 끊김 — 절반만 적용된 RBAC 변경을 '성공' 으로 적으면 안 된다."""
    outcomes = []
    svc = _FakeSvc([{"type": "log", "message": f"{i}"} for i in range(10)])
    gen = provision_event_stream(svc, {}, outcomes.append)

    next(gen)  # 첫 이벤트만 받고
    gen.close()  # 클라이언트가 끊은 상황 = GeneratorExit

    assert outcomes == ["aborted"]


def test_audit_failure_does_not_break_the_stream():
    """감사 로그 기록이 실패해도 스트림 자체는 정상 종료돼야 한다."""

    def _boom(_outcome):
        raise RuntimeError("감사 로그 DB 다운")

    chunks = _drain(provision_event_stream(_FakeSvc([{"type": "log", "message": "x"}]), {}, _boom))
    assert json.loads(chunks[-1].removeprefix("data: ").strip())["type"] == "done"


def test_events_are_serialized_as_utf8_sse_lines():
    """SSE 본문은 axios 인터셉터를 안 타므로 한글이 이스케이프되지 않은 원문이어야 한다."""
    svc = _FakeSvc([{"type": "log", "message": "네임스페이스 확인"}])
    chunks = _drain(provision_event_stream(svc, {}, lambda _o: None))
    assert chunks[0].startswith("data: ")
    assert chunks[0].endswith("\n\n")
    assert "네임스페이스 확인" in chunks[0]  # \uXXXX 이스케이프가 아니어야 한다


@pytest.mark.parametrize("events", [[], [{"type": "log", "message": "only"}]])
def test_done_event_always_terminates_the_stream(events):
    chunks = _drain(provision_event_stream(_FakeSvc(events), {}, lambda _o: None))
    assert json.loads(chunks[-1].removeprefix("data: ").strip()) == {"type": "done"}
