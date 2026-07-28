"""ConfluenceService — 폐쇄망 Confluence (Server/Data Center, REST API) 실패내성 클라이언트.

`jira_service.JiraService` 와 동일 패턴:
 - async httpx 사용
 - **모든 예외를 잡아** 구조화된 `{"status": "ok|offline|error", ...}` dict 반환 — 절대 raise 안 함
 - 자체서명 TLS 대비 `verify` 옵션
 - 인증 (`auth_type`):
     · `sso`/`cookie` → `Cookie: <세션 쿠키 문자열>` — 파드 내 SSO 폼 로그인
       (`jira_sso_http.sso_login_products`)이 캡처한 세션을 재사용. POST 대비
       `X-Atlassian-Token: no-check` 동봉.
     · `pat` → `Authorization: Bearer <token>` (DC 7.9+, PAT 발급 가능한 환경용)
"""
from __future__ import annotations

import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)


class ConfluenceService:
    """사용자별 세션 쿠키(또는 PAT)로 인스턴스화되는 Confluence 프록시."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        token: Optional[str] = None,
        *,
        auth_type: str = "sso",
        verify: bool = True,
        timeout: int = 30,
    ):
        self.base_url = (base_url or "").rstrip("/")
        self.token = token or ""
        self.auth_type = (auth_type or "sso").strip().lower()
        self.verify = verify
        self.timeout = timeout

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.token)

    def _headers(self) -> dict:
        headers = {"Accept": "application/json"}
        if self.auth_type in ("cookie", "sso"):
            headers["Cookie"] = self.token
            headers["X-Atlassian-Token"] = "no-check"
        else:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    async def current_user(self) -> dict:
        """연결 + 세션 확인 (`GET /rest/api/user/current`). 성공 시 displayName 반환."""
        if not self.configured:
            return {"status": "offline", "detail": "Confluence URL 또는 세션이 설정되지 않았습니다."}
        try:
            async with httpx.AsyncClient(timeout=10, verify=self.verify) as client:
                resp = await client.get(
                    f"{self.base_url}/rest/api/user/current", headers=self._headers()
                )
                if resp.status_code == 401:
                    return {"status": "error", "detail": "인증 실패 — 세션이 만료됐습니다 (401).",
                            "auth_failed": True}
                if resp.status_code == 403:
                    return {"status": "error", "detail": "권한 없음 (403)."}
                if resp.status_code != 200:
                    return {"status": "error", "detail": f"HTTP {resp.status_code}"}
                data = resp.json()
                # 익명 응답(type=anonymous)은 200 이어도 세션 없음 — 만료로 취급.
                if (data.get("type") or "").lower() == "anonymous":
                    return {"status": "error", "detail": "세션이 만료돼 익명 사용자로 응답했습니다.",
                            "auth_failed": True}
                return {
                    "status": "ok",
                    "display_name": data.get("displayName") or data.get("username", ""),
                    "account": data.get("username") or data.get("userKey", ""),
                }
        except httpx.ConnectError:
            logger.warning("Confluence connect error — 도달 불가 (%s)", self.base_url)
            return {"status": "offline", "detail": "Confluence 서버에 연결할 수 없습니다 (네트워크/도메인 확인)."}
        except httpx.TimeoutException:
            return {"status": "offline", "detail": "Confluence 응답 시간 초과."}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Confluence current_user error: %s", exc)
            return {"status": "offline", "detail": str(exc)[:200]}

    async def search(self, cql: str, *, limit: int = 25) -> dict:
        """CQL 검색 (`GET /rest/api/content/search`) — 페이지/블로그 등 콘텐츠 검색.

        예: `text ~ "장애" and type = page`. 결과는 [{id,title,type,space_key,url,updated}]."""
        if not self.configured:
            return {"status": "offline", "items": [], "detail": "Confluence 미설정"}
        if not (cql or "").strip():
            return {"status": "error", "items": [], "detail": "CQL 을 입력하세요."}
        try:
            async with httpx.AsyncClient(timeout=self.timeout, verify=self.verify) as client:
                resp = await client.get(
                    f"{self.base_url}/rest/api/content/search",
                    headers=self._headers(),
                    params={"cql": cql, "limit": max(1, min(int(limit), 100)),
                            "expand": "space,version"},
                )
                if resp.status_code == 400:
                    detail = ""
                    try:
                        detail = resp.json().get("message", "")
                    except Exception:  # noqa: BLE001
                        detail = resp.text[:200]
                    return {"status": "error", "items": [], "detail": f"CQL 오류: {detail or 'HTTP 400'}"}
                if resp.status_code == 401:
                    return {"status": "error", "items": [], "detail": "인증 실패 (401)", "auth_failed": True}
                if resp.status_code != 200:
                    return {"status": "error", "items": [], "detail": f"HTTP {resp.status_code}"}
                data = resp.json()
                items = []
                for r in data.get("results", []):
                    webui = ((r.get("_links") or {}).get("webui") or "")
                    items.append({
                        "id": str(r.get("id", "")),
                        "title": r.get("title", ""),
                        "type": r.get("type", ""),
                        "space_key": ((r.get("space") or {}).get("key") or ""),
                        "url": f"{self.base_url}{webui}" if webui else "",
                        "updated": (((r.get("version") or {}).get("when")) or ""),
                    })
                return {"status": "ok", "items": items, "total": data.get("totalSize", len(items))}
        except httpx.ConnectError:
            return {"status": "offline", "items": [], "detail": "Confluence 연결 불가"}
        except httpx.TimeoutException:
            return {"status": "offline", "items": [], "detail": "Confluence 응답 시간 초과"}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Confluence search error: %s", exc)
            return {"status": "offline", "items": [], "detail": str(exc)[:200]}

    async def get_page(self, page_id: str) -> dict:
        """단일 페이지 조회 (`GET /rest/api/content/{id}`) — storage 본문 포함."""
        if not self.configured:
            return {"status": "offline", "detail": "Confluence 미설정"}
        try:
            async with httpx.AsyncClient(timeout=self.timeout, verify=self.verify) as client:
                resp = await client.get(
                    f"{self.base_url}/rest/api/content/{page_id}",
                    headers=self._headers(),
                    params={"expand": "body.storage,version,space"},
                )
                if resp.status_code == 404:
                    return {"status": "error", "detail": f"페이지 {page_id} 없음 (404)"}
                if resp.status_code == 401:
                    return {"status": "error", "detail": "인증 실패 (401)", "auth_failed": True}
                if resp.status_code != 200:
                    return {"status": "error", "detail": f"HTTP {resp.status_code}"}
                data = resp.json()
                webui = ((data.get("_links") or {}).get("webui") or "")
                return {
                    "status": "ok",
                    "page": {
                        "id": str(data.get("id", "")),
                        "title": data.get("title", ""),
                        "space_key": ((data.get("space") or {}).get("key") or ""),
                        "body_storage": (((data.get("body") or {}).get("storage") or {}).get("value") or ""),
                        "version": ((data.get("version") or {}).get("number")),
                        "url": f"{self.base_url}{webui}" if webui else "",
                    },
                }
        except httpx.ConnectError:
            return {"status": "offline", "detail": "Confluence 연결 불가"}
        except httpx.TimeoutException:
            return {"status": "offline", "detail": "Confluence 응답 시간 초과"}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Confluence get_page error: %s", exc)
            return {"status": "offline", "detail": str(exc)[:200]}
