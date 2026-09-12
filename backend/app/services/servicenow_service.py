"""ServiceNowService — 사내에 구축된 ServiceNow ITSM(REST Table API) 실패내성 클라이언트.

`jira_service.JiraService` / `confluence_service.ConfluenceService` 와 동일 패턴:
 - async httpx 사용
 - **모든 예외를 잡아** 구조화된 `{"status": "ok|offline|error", ...}` dict 반환 — 절대 raise 안 함
 - 자체서명 TLS 대비 `verify` 옵션
 - 인증 (`auth_type`):
     · `sso`/`cookie` → `Cookie: <세션 쿠키 문자열>` — 1차 구현은 전용 ServiceNow 인증 UI가 없어
       사용자의 Jira/SSO 세션 쿠키를 그대로 재사용한다(호출부 `routers/servicenow.py` 참고).
     · `basic` → `Authorization: Basic <base64>` — 스키마만 남겨두고 1차 구현에서는 미사용
       (전용 자격증명 UI 추가 시 확장 지점).

실제 내부 ServiceNow 인스턴스의 정확한 테이블명/필드명은 확인되지 않았다 — 표준 Table API
(`/api/now/table/<table>`)를 가정하고, 테이블명·필드 매핑은 AppSetting(key=
`servicenow_integration`)에서 관리자가 UI로 조정할 수 있게 해 실제 스펙 확인 후에도 코드
수정 없이 대응 가능하도록 설계했다(UI-First 원칙).
"""
from __future__ import annotations

import base64
import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)


class ServiceNowService:
    """사용자별 세션 쿠키(1차 구현) 또는 Basic 인증으로 인스턴스화되는 ServiceNow 프록시."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        token: Optional[str] = None,
        *,
        auth_type: str = "sso",
        verify: bool = True,
        timeout: int = 30,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ):
        self.base_url = (base_url or "").rstrip("/")
        self.token = token or ""
        self.auth_type = (auth_type or "sso").strip().lower()
        self.verify = verify
        self.timeout = timeout
        # 테스트에서 httpx.MockTransport 를 주입하기 위한 훅 (jira_service 와 동일 패턴).
        # 운영 경로에서는 None 이라 httpx 기본 전송을 그대로 쓴다.
        self.transport = transport

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.token)

    def _client(self, *, timeout: Optional[int] = None) -> httpx.AsyncClient:
        kwargs: dict = {"timeout": timeout or self.timeout, "verify": self.verify}
        if self.transport is not None:
            kwargs["transport"] = self.transport
        return httpx.AsyncClient(**kwargs)

    def _headers(self) -> dict:
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if self.auth_type in ("cookie", "sso"):
            headers["Cookie"] = self.token
            headers["X-UserToken"] = "no-check"  # ServiceNow XSRF 토큰 요구 인스턴스 대비 무해한 힌트 헤더
        elif self.auth_type == "basic":
            headers["Authorization"] = f"Basic {base64.b64encode(self.token.encode()).decode()}"
        else:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    async def current_user(self) -> dict:
        """세션/자격증명 확인 — `sys_user` 테이블에 대한 경량 조회로 인증 유효성만 판별한다.

        ServiceNow Table API 에는 Confluence 의 `/rest/api/user/current` 같은 전용
        "현재 사용자" 엔드포인트가 표준으로 없어, 가장 흔한 시스템 테이블(sys_user)에 대해
        1건 제한 조회를 날려 200/401 여부로만 세션 유효성을 확인한다."""
        if not self.configured:
            return {"status": "offline", "detail": "ServiceNow URL 또는 세션이 설정되지 않았습니다."}
        try:
            async with self._client(timeout=10) as client:
                resp = await client.get(
                    f"{self.base_url}/api/now/table/sys_user",
                    headers=self._headers(),
                    params={"sysparm_limit": 1, "sysparm_fields": "sys_id,user_name,name"},
                )
                if resp.status_code == 401:
                    return {"status": "error", "detail": "인증 실패 — 세션이 만료됐습니다 (401).",
                            "auth_failed": True}
                if resp.status_code == 403:
                    return {"status": "error", "detail": "권한 없음 (403)."}
                if resp.status_code != 200:
                    return {"status": "error", "detail": f"HTTP {resp.status_code}"}
                data = resp.json()
                results = data.get("result") or []
                display_name = (results[0].get("name") if results else "") or ""
                return {"status": "ok", "display_name": display_name}
        except httpx.ConnectError:
            logger.warning("ServiceNow connect error — 도달 불가 (%s)", self.base_url)
            return {"status": "offline", "detail": "ServiceNow 서버에 연결할 수 없습니다 (네트워크/도메인 확인)."}
        except httpx.TimeoutException:
            return {"status": "offline", "detail": "ServiceNow 응답 시간 초과."}
        except Exception as exc:  # noqa: BLE001
            logger.exception("ServiceNow current_user error: %s", exc)
            return {"status": "offline", "detail": str(exc)[:200]}

    async def create_record(self, table: str, fields: dict) -> dict:
        """레코드 생성 (`POST /api/now/table/{table}`) — 성공 시 sys_id/number/url 반환."""
        if not self.configured:
            return {"status": "offline", "detail": "ServiceNow 미설정"}
        table_name = (table or "").strip()
        if not table_name:
            return {"status": "error", "detail": "테이블명이 설정되지 않았습니다."}
        try:
            async with self._client() as client:
                resp = await client.post(
                    f"{self.base_url}/api/now/table/{table_name}",
                    headers=self._headers(),
                    json=fields,
                )
                if resp.status_code == 401:
                    return {"status": "error", "detail": "인증 실패 (401) — 세션이 만료됐습니다.",
                            "auth_failed": True}
                if resp.status_code == 403:
                    return {"status": "error", "detail": "권한 없음 (403) — 이 테이블에 쓰기 권한이 없습니다."}
                if resp.status_code not in (200, 201):
                    detail = ""
                    try:
                        body = resp.json()
                        detail = ((body.get("error") or {}).get("message")
                                  or body.get("error") or "")
                    except Exception:  # noqa: BLE001
                        detail = resp.text[:200]
                    return {"status": "error", "detail": detail or f"HTTP {resp.status_code}"}
                result = resp.json().get("result") or {}
                sys_id = str(result.get("sys_id", ""))
                number = str(result.get("number", ""))
                url = f"{self.base_url}/{table_name}.do?sys_id={sys_id}" if sys_id else ""
                return {"status": "ok", "sys_id": sys_id, "number": number, "url": url}
        except httpx.ConnectError:
            return {"status": "offline", "detail": "ServiceNow 연결 불가"}
        except httpx.TimeoutException:
            return {"status": "offline", "detail": "ServiceNow 응답 시간 초과"}
        except Exception as exc:  # noqa: BLE001
            logger.exception("ServiceNow create_record error: %s", exc)
            return {"status": "offline", "detail": str(exc)[:200]}
