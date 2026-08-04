"""JiraService.create_issue — 401 처리 회귀 테스트.

프로비저닝(업무 → Jira+Confluence 동시 생성)이 실패 원인을 "내 인증 문제"로 정확히
구분하려면 create_issue 가 401 을 auth_failed 플래그와 함께 알려야 한다 —
myself()/search() 등 다른 메서드는 이미 그렇게 하는데 create_issue 만 빠져 있었다.
DB/실제 네트워크 없이 httpx.MockTransport 로 검증한다.
"""
import httpx
import pytest

from app.services.jira_service import JiraService

BASE = "https://jira.example.com"


def _svc(handler) -> JiraService:
    return JiraService(BASE, "tok", transport=httpx.MockTransport(handler))


async def test_create_issue_401_flags_auth_failed():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"errorMessages": ["Unauthorized"]})

    res = await _svc(handler).create_issue("OPS", "제목")
    assert res["status"] == "error"
    assert res.get("auth_failed") is True


async def test_create_issue_400_does_not_flag_auth_failed():
    """400(필드 스킴 오류)은 인증 문제가 아니다 — auth_failed 오탐 방지 회귀."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(400, json={"errorMessages": ["field error"]})

    res = await _svc(handler).create_issue("OPS", "제목", priority="High")
    assert res["status"] == "error"
    assert not res.get("auth_failed")
    assert calls["n"] == 2  # 선택 필드 제외 1회 재시도까지 소진


async def test_create_issue_success_unaffected():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"key": "OPS-1", "id": "10001"})

    res = await _svc(handler).create_issue("OPS", "제목")
    assert res["status"] == "ok"
    assert res["key"] == "OPS-1"
