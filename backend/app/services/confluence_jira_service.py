"""
Confluence / Jira REST API 서비스 (폐쇄망 대응)

- Confluence Server/DC : REST API v1  (/rest/api/)
- Jira Server/DC       : REST API v2  (/rest/api/2/)
- 인증                 : Basic Auth(username:password) 또는 PAT(Bearer)
- SSL                  : verify 옵션으로 자체 서명 인증서 대응
- 모든 외부 호출은 fail-safe — 예외를 잡아 구조화된 에러 dict 반환
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)


# ─── 공통 헬퍼 ───────────────────────────────────────────────


def _build_auth(username: str, password: str, pat: str) -> tuple[httpx.Auth | None, dict]:
    """인증 방식 결정: PAT 우선, 없으면 Basic Auth."""
    if pat:
        return None, {"Authorization": f"Bearer {pat}"}
    if username and password:
        return httpx.BasicAuth(username, password), {}
    return None, {}


def _client(base_url: str, username: str, password: str, pat: str, verify_ssl: bool) -> httpx.Client:
    auth, extra_headers = _build_auth(username, password, pat)
    headers = {"Content-Type": "application/json", "Accept": "application/json", **extra_headers}
    return httpx.Client(
        base_url=base_url,
        auth=auth,
        headers=headers,
        verify=verify_ssl,
        timeout=30.0,
        follow_redirects=True,
    )


def _err(msg: str, exc: Exception | None = None) -> dict:
    detail = str(exc) if exc else ""
    logger.warning("confluence_jira_service: %s  %s", msg, detail)
    return {"ok": False, "error": msg, "detail": detail}


# ─── Confluence ──────────────────────────────────────────────


class ConfluenceService:
    """Confluence Server / Data Center REST API v1 클라이언트."""

    def __init__(
        self,
        base_url: str,          # e.g. http://confluence.company.local
        username: str = "",
        password: str = "",
        pat: str = "",          # Personal Access Token (PAT) — Basic Auth 대신 사용 가능
        verify_ssl: bool = True,
    ):
        self.base_url = base_url.rstrip("/")
        self.username = username
        self.password = password
        self.pat = pat
        self.verify_ssl = verify_ssl

    # ── 연결 확인 ────────────────────────────────────────────

    def ping(self) -> dict:
        """Confluence 서버 연결 확인 (공간 목록 1건 조회)."""
        try:
            with _client(self.base_url, self.username, self.password, self.pat, self.verify_ssl) as c:
                r = c.get("/rest/api/space", params={"limit": 1})
                r.raise_for_status()
                data = r.json()
                return {
                    "ok": True,
                    "status_code": r.status_code,
                    "total_spaces": data.get("size", 0),
                    "server_url": self.base_url,
                }
        except Exception as e:
            return _err("Confluence ping failed", e)

    # ── 스페이스 ─────────────────────────────────────────────

    def list_spaces(self, limit: int = 25, start: int = 0, space_type: str = "global") -> dict:
        """스페이스 목록 조회."""
        try:
            with _client(self.base_url, self.username, self.password, self.pat, self.verify_ssl) as c:
                r = c.get(
                    "/rest/api/space",
                    params={"limit": limit, "start": start, "type": space_type, "expand": "description.plain"},
                )
                r.raise_for_status()
                data = r.json()
                spaces = [
                    {
                        "key": s.get("key"),
                        "name": s.get("name"),
                        "type": s.get("type"),
                        "description": (
                            s.get("description", {}).get("plain", {}).get("value", "")
                        ),
                        "url": f"{self.base_url}/display/{s.get('key')}",
                    }
                    for s in data.get("results", [])
                ]
                return {"ok": True, "spaces": spaces, "total": data.get("size", 0), "limit": limit, "start": start}
        except Exception as e:
            return _err("Confluence list_spaces failed", e)

    # ── 페이지 ───────────────────────────────────────────────

    def search_pages(self, cql: str, limit: int = 20, start: int = 0) -> dict:
        """CQL(Confluence Query Language)로 페이지 검색.

        예시 CQL:
          space = "DEV" AND title ~ "배포"
          type = "page" AND space = "OPS" ORDER BY created DESC
        """
        try:
            with _client(self.base_url, self.username, self.password, self.pat, self.verify_ssl) as c:
                r = c.get(
                    "/rest/api/content/search",
                    params={"cql": cql, "limit": limit, "start": start, "expand": "space,version"},
                )
                r.raise_for_status()
                data = r.json()
                pages = [
                    {
                        "id": p.get("id"),
                        "title": p.get("title"),
                        "space_key": p.get("space", {}).get("key"),
                        "space_name": p.get("space", {}).get("name"),
                        "version": p.get("version", {}).get("number"),
                        "url": f"{self.base_url}/pages/viewpage.action?pageId={p.get('id')}",
                    }
                    for p in data.get("results", [])
                ]
                return {"ok": True, "pages": pages, "total": data.get("totalSize", 0), "limit": limit, "start": start}
        except Exception as e:
            return _err("Confluence search_pages failed", e)

    def get_page(self, page_id: str) -> dict:
        """페이지 본문(storage format) 조회."""
        try:
            with _client(self.base_url, self.username, self.password, self.pat, self.verify_ssl) as c:
                r = c.get(
                    f"/rest/api/content/{page_id}",
                    params={"expand": "body.storage,version,space,ancestors"},
                )
                r.raise_for_status()
                data = r.json()
                return {
                    "ok": True,
                    "id": data.get("id"),
                    "title": data.get("title"),
                    "space_key": data.get("space", {}).get("key"),
                    "version": data.get("version", {}).get("number"),
                    "body": data.get("body", {}).get("storage", {}).get("value", ""),
                    "url": f"{self.base_url}/pages/viewpage.action?pageId={page_id}",
                }
        except Exception as e:
            return _err(f"Confluence get_page({page_id}) failed", e)

    def get_space_pages(self, space_key: str, limit: int = 20, start: int = 0) -> dict:
        """특정 스페이스의 페이지 목록 조회."""
        cql = f'space = "{space_key}" AND type = "page" ORDER BY created DESC'
        return self.search_pages(cql=cql, limit=limit, start=start)


# ─── Jira ────────────────────────────────────────────────────


class JiraService:
    """Jira Server / Data Center REST API v2 클라이언트."""

    def __init__(
        self,
        base_url: str,          # e.g. http://jira.company.local
        username: str = "",
        password: str = "",
        pat: str = "",
        verify_ssl: bool = True,
    ):
        self.base_url = base_url.rstrip("/")
        self.username = username
        self.password = password
        self.pat = pat
        self.verify_ssl = verify_ssl

    # ── 연결 확인 ────────────────────────────────────────────

    def ping(self) -> dict:
        """Jira 서버 연결 확인 (서버 info 조회)."""
        try:
            with _client(self.base_url, self.username, self.password, self.pat, self.verify_ssl) as c:
                r = c.get("/rest/api/2/serverInfo")
                r.raise_for_status()
                data = r.json()
                return {
                    "ok": True,
                    "status_code": r.status_code,
                    "server_title": data.get("serverTitle"),
                    "version": data.get("version"),
                    "base_url": data.get("baseUrl"),
                }
        except Exception as e:
            return _err("Jira ping failed", e)

    # ── 프로젝트 ─────────────────────────────────────────────

    def list_projects(self, limit: int = 50) -> dict:
        """프로젝트 목록 조회."""
        try:
            with _client(self.base_url, self.username, self.password, self.pat, self.verify_ssl) as c:
                r = c.get("/rest/api/2/project", params={"maxResults": limit, "expand": "description"})
                r.raise_for_status()
                data = r.json()
                projects = [
                    {
                        "id": p.get("id"),
                        "key": p.get("key"),
                        "name": p.get("name"),
                        "type": p.get("projectTypeKey"),
                        "description": p.get("description", ""),
                        "url": f"{self.base_url}/browse/{p.get('key')}",
                    }
                    for p in (data if isinstance(data, list) else data.get("values", []))
                ]
                return {"ok": True, "projects": projects, "total": len(projects)}
        except Exception as e:
            return _err("Jira list_projects failed", e)

    # ── 이슈 ─────────────────────────────────────────────────

    def search_issues(self, jql: str, fields: list[str] | None = None, max_results: int = 20, start_at: int = 0) -> dict:
        """JQL(Jira Query Language)로 이슈 검색.

        예시 JQL:
          project = DEV AND status != Done ORDER BY created DESC
          assignee = currentUser() AND sprint in openSprints()
          labels = "k8s" AND created >= -7d
        """
        _fields = fields or ["summary", "status", "assignee", "priority", "created", "updated", "labels", "issuetype"]
        try:
            with _client(self.base_url, self.username, self.password, self.pat, self.verify_ssl) as c:
                r = c.post(
                    "/rest/api/2/search",
                    json={"jql": jql, "fields": _fields, "maxResults": max_results, "startAt": start_at},
                )
                r.raise_for_status()
                data = r.json()
                issues = [
                    {
                        "key": i.get("key"),
                        "summary": i.get("fields", {}).get("summary"),
                        "status": i.get("fields", {}).get("status", {}).get("name"),
                        "priority": i.get("fields", {}).get("priority", {}).get("name"),
                        "assignee": (
                            i.get("fields", {}).get("assignee") or {}
                        ).get("displayName"),
                        "issue_type": i.get("fields", {}).get("issuetype", {}).get("name"),
                        "labels": i.get("fields", {}).get("labels", []),
                        "created": i.get("fields", {}).get("created"),
                        "updated": i.get("fields", {}).get("updated"),
                        "url": f"{self.base_url}/browse/{i.get('key')}",
                    }
                    for i in data.get("issues", [])
                ]
                return {
                    "ok": True,
                    "issues": issues,
                    "total": data.get("total", 0),
                    "max_results": max_results,
                    "start_at": start_at,
                }
        except Exception as e:
            return _err("Jira search_issues failed", e)

    def get_issue(self, issue_key: str) -> dict:
        """특정 이슈 상세 조회 (댓글 포함)."""
        try:
            with _client(self.base_url, self.username, self.password, self.pat, self.verify_ssl) as c:
                r = c.get(
                    f"/rest/api/2/issue/{issue_key}",
                    params={"expand": "renderedFields,names,changelog"},
                )
                r.raise_for_status()
                data = r.json()
                f = data.get("fields", {})
                comments = [
                    {
                        "author": (c.get("author") or {}).get("displayName"),
                        "body": c.get("body", ""),
                        "created": c.get("created"),
                    }
                    for c in f.get("comment", {}).get("comments", [])
                ]
                return {
                    "ok": True,
                    "key": data.get("key"),
                    "summary": f.get("summary"),
                    "description": f.get("description") or "",
                    "status": f.get("status", {}).get("name"),
                    "priority": (f.get("priority") or {}).get("name"),
                    "assignee": (f.get("assignee") or {}).get("displayName"),
                    "reporter": (f.get("reporter") or {}).get("displayName"),
                    "issue_type": f.get("issuetype", {}).get("name"),
                    "labels": f.get("labels", []),
                    "components": [c.get("name") for c in f.get("components", [])],
                    "created": f.get("created"),
                    "updated": f.get("updated"),
                    "comments": comments,
                    "url": f"{self.base_url}/browse/{data.get('key')}",
                }
        except Exception as e:
            return _err(f"Jira get_issue({issue_key}) failed", e)

    def get_project_issues(self, project_key: str, max_results: int = 20) -> dict:
        """특정 프로젝트의 미완료 이슈 조회."""
        jql = f"project = {project_key} AND status != Done ORDER BY updated DESC"
        return self.search_issues(jql=jql, max_results=max_results)
