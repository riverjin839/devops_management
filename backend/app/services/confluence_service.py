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

    async def find_page(self, space_key: str, title: str) -> dict:
        """스페이스 안에서 제목이 정확히 일치하는 페이지 찾기 — 주간보고 갱신 대상 판별용."""
        if not self.configured:
            return {"status": "offline", "detail": "Confluence 미설정"}
        try:
            async with httpx.AsyncClient(timeout=self.timeout, verify=self.verify) as client:
                resp = await client.get(
                    f"{self.base_url}/rest/api/content",
                    headers=self._headers(),
                    params={"spaceKey": space_key, "title": title, "expand": "version", "limit": 5},
                )
                if resp.status_code == 401:
                    return {"status": "error", "detail": "인증 실패 (401)", "auth_failed": True}
                if resp.status_code != 200:
                    return {"status": "error", "detail": f"HTTP {resp.status_code}"}
                results = resp.json().get("results", [])
                if not results:
                    return {"status": "ok", "found": False}
                page = results[0]
                return {
                    "status": "ok", "found": True, "id": str(page.get("id", "")),
                    "version": ((page.get("version") or {}).get("number") or 1),
                }
        except httpx.ConnectError:
            return {"status": "offline", "detail": "Confluence 연결 불가"}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Confluence find_page error: %s", exc)
            return {"status": "offline", "detail": str(exc)[:200]}

    async def upsert_page(
        self, space_key: str, title: str, body_html: str, *, parent_id: str = "",
    ) -> dict:
        """제목이 같은 페이지가 있으면 새 버전으로 갱신, 없으면 생성한다.

        주간보고를 매주 같은 제목으로 올리면 갱신되고, 제목에 주차를 넣으면 매주 새로 생긴다
        — 어느 쪽이든 호출부가 제목 규칙으로 결정한다."""
        if not self.configured:
            return {"status": "offline", "detail": "Confluence 미설정"}
        if not (space_key and title):
            return {"status": "error", "detail": "스페이스 키와 제목은 필수입니다."}
        found = await self.find_page(space_key, title)
        if found.get("status") not in ("ok",):
            return found
        body = {
            "type": "page",
            "title": title,
            "space": {"key": space_key},
            "body": {"storage": {"value": body_html, "representation": "storage"}},
        }
        if parent_id:
            body["ancestors"] = [{"id": str(parent_id)}]
        try:
            async with httpx.AsyncClient(timeout=self.timeout, verify=self.verify) as client:
                if found.get("found"):
                    page_id = found["id"]
                    body["version"] = {"number": int(found.get("version", 1)) + 1}
                    resp = await client.put(
                        f"{self.base_url}/rest/api/content/{page_id}",
                        headers={**self._headers(), "Content-Type": "application/json"},
                        json=body,
                    )
                    action = "updated"
                else:
                    resp = await client.post(
                        f"{self.base_url}/rest/api/content",
                        headers={**self._headers(), "Content-Type": "application/json"},
                        json=body,
                    )
                    action = "created"
                if resp.status_code in (200, 201):
                    data = resp.json()
                    webui = ((data.get("_links") or {}).get("webui") or "")
                    return {"status": "ok", "action": action, "id": str(data.get("id", "")),
                            "url": f"{self.base_url}{webui}" if webui else ""}
                detail = ""
                try:
                    detail = resp.json().get("message", "")
                except Exception:  # noqa: BLE001
                    detail = resp.text[:200]
                return {"status": "error", "detail": detail or f"HTTP {resp.status_code}"}
        except httpx.ConnectError:
            return {"status": "offline", "detail": "Confluence 연결 불가"}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Confluence upsert_page error: %s", exc)
            return {"status": "offline", "detail": str(exc)[:200]}

    async def update_page(
        self, page_id: str, title: str, body_html: str, *, version: int,
    ) -> dict:
        """page_id 로 지정한 페이지를 새 버전으로 직접 갱신한다.

        upsert_page 의 제목 기반 find 를 거치지 않으므로, 이미 연결된 문서의 재게시
        (제목이 바뀌어도 같은 페이지 유지)에 쓴다. version 은 **새** 버전 번호."""
        if not self.configured:
            return {"status": "offline", "detail": "Confluence 미설정"}
        if not (page_id and title):
            return {"status": "error", "detail": "페이지 ID 와 제목은 필수입니다."}
        body = {
            "type": "page",
            "title": title,
            "body": {"storage": {"value": body_html, "representation": "storage"}},
            "version": {"number": int(version)},
        }
        try:
            async with httpx.AsyncClient(timeout=self.timeout, verify=self.verify) as client:
                resp = await client.put(
                    f"{self.base_url}/rest/api/content/{page_id}",
                    headers={**self._headers(), "Content-Type": "application/json"},
                    json=body,
                )
                if resp.status_code == 401:
                    return {"status": "error", "detail": "인증 실패 (401)", "auth_failed": True}
                if resp.status_code == 404:
                    return {"status": "error", "detail": f"페이지 {page_id} 없음 (404)"}
                if resp.status_code == 409:
                    return {"status": "error",
                            "detail": "버전 충돌 (409) — 페이지가 다른 곳에서 수정됐습니다. 다시 가져온 뒤 게시하세요."}
                if resp.status_code != 200:
                    detail = ""
                    try:
                        detail = resp.json().get("message", "")
                    except Exception:  # noqa: BLE001
                        detail = resp.text[:200]
                    return {"status": "error", "detail": detail or f"HTTP {resp.status_code}"}
                data = resp.json()
                webui = ((data.get("_links") or {}).get("webui") or "")
                return {
                    "status": "ok", "action": "updated", "id": str(data.get("id", "")),
                    "version": ((data.get("version") or {}).get("number")),
                    "url": f"{self.base_url}{webui}" if webui else "",
                }
        except httpx.ConnectError:
            return {"status": "offline", "detail": "Confluence 연결 불가"}
        except httpx.TimeoutException:
            return {"status": "offline", "detail": "Confluence 응답 시간 초과"}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Confluence update_page error: %s", exc)
            return {"status": "offline", "detail": str(exc)[:200]}

    async def upload_attachment(
        self, page_id: str, filename: str, content: bytes, mime: str = "application/octet-stream",
    ) -> dict:
        """페이지 첨부 업로드/갱신 (`PUT /rest/api/content/{id}/child/attachment`).

        같은 파일명이 있으면 새 버전으로 갱신된다(멱등) — export 재게시에 안전."""
        if not self.configured:
            return {"status": "offline", "detail": "Confluence 미설정"}
        try:
            async with httpx.AsyncClient(timeout=self.timeout, verify=self.verify) as client:
                resp = await client.put(
                    f"{self.base_url}/rest/api/content/{page_id}/child/attachment",
                    headers=self._headers(),  # X-Atlassian-Token: no-check 포함 (sso/cookie)
                    files={"file": (filename, content, mime)},
                    data={"minorEdit": "true"},
                )
                if resp.status_code == 401:
                    return {"status": "error", "detail": "인증 실패 (401)", "auth_failed": True}
                if resp.status_code not in (200, 201):
                    return {"status": "error", "detail": f"HTTP {resp.status_code}"}
                return {"status": "ok", "filename": filename}
        except httpx.ConnectError:
            return {"status": "offline", "detail": "Confluence 연결 불가"}
        except httpx.TimeoutException:
            return {"status": "offline", "detail": "Confluence 응답 시간 초과"}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Confluence upload_attachment error: %s", exc)
            return {"status": "offline", "detail": str(exc)[:200]}

    async def get_attachment(self, page_id: str, filename: str) -> dict:
        """페이지 첨부 파일 다운로드 — import 시 이미지 인라인 변환용."""
        if not self.configured:
            return {"status": "offline", "detail": "Confluence 미설정"}
        try:
            async with httpx.AsyncClient(
                timeout=self.timeout, verify=self.verify, follow_redirects=True
            ) as client:
                resp = await client.get(
                    f"{self.base_url}/download/attachments/{page_id}/{filename}",
                    headers=self._headers(),
                )
                if resp.status_code == 401:
                    return {"status": "error", "detail": "인증 실패 (401)", "auth_failed": True}
                if resp.status_code != 200:
                    return {"status": "error", "detail": f"HTTP {resp.status_code}"}
                return {
                    "status": "ok",
                    "content": resp.content,
                    "mime": resp.headers.get("Content-Type", "application/octet-stream"),
                }
        except httpx.ConnectError:
            return {"status": "offline", "detail": "Confluence 연결 불가"}
        except httpx.TimeoutException:
            return {"status": "offline", "detail": "Confluence 응답 시간 초과"}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Confluence get_attachment error: %s", exc)
            return {"status": "offline", "detail": str(exc)[:200]}

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
