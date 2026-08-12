"""JiraService — 폐쇄망 Jira (Server/Data Center, REST API v2) 실패내성 클라이언트.

`agent_service` / `prometheus_service` 와 동일한 패턴:
 - async httpx 사용
 - **모든 예외를 잡아** 구조화된 `{"status": "ok|offline|error", ...}` dict 반환 — 절대 raise 안 함
 - 자체서명 TLS 대비 `verify` 옵션
 - 인증 2가지 (`auth_type`):
     · `pat`    → `Authorization: Bearer <token>` (DC 8.14+)
     · `cookie` → `Cookie: <세션 쿠키 문자열>` (PAT 발급 불가한 SSO 환경 — 사용자가 브라우저
                  세션 쿠키를 통째로 복사해 등록). POST(REST) 의 XSRF 회피 위해
                  `X-Atlassian-Token: no-check` 를 함께 보낸다.

매핑 헬퍼는 순수 함수로 분리해 테스트/override 가능.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

# Jira issue 에서 가져올 필드 (v2 search) — 최소화.
ISSUE_FIELDS = [
    "summary", "description", "issuetype", "status", "priority",
    "assignee", "created", "updated", "resolutiondate", "duedate", "parent",
    # 게시판 표를 Jira 와 같은 축으로 보여주기 위한 원본 항목.
    "components", "labels",
]


# ── 순수 매핑 헬퍼 (설정 override 가능) ───────────────────────────────────────────
def map_issue_type(jira_type: str | None) -> tuple[str, Optional[str]]:
    """Jira issuetype 명 → (work_item.type, type_label). Sub-task 는 호출부에서 parent 처리."""
    t = (jira_type or "").strip().lower()
    if t in ("bug", "결함", "버그"):
        return "issue", "bug"
    if t in ("epic",):
        return "task", "feature"
    # task / story / sub-task / 기타 → task
    return "task", None


def map_status_category(status_obj: dict | None) -> str:
    """Jira status.statusCategory.key → kanban_status (커스텀 워크플로 견고).

    statusCategory.key ∈ {new, indeterminate, done} 는 Jira 표준이라 프로젝트별
    상태명이 달라도 일관 매핑된다.
    """
    cat = ((status_obj or {}).get("statusCategory") or {}).get("key", "")
    if cat == "done":
        return "done"
    if cat == "indeterminate":
        return "in_progress"
    return "todo"  # new (또는 미상)


def map_priority(jira_priority: str | None) -> str:
    p = (jira_priority or "").strip().lower()
    if p in ("highest", "high", "critical", "blocker", "긴급", "높음"):
        return "high"
    if p in ("low", "lowest", "minor", "trivial", "낮음"):
        return "low"
    return "medium"


# PEP priority → Jira priority 이름 (push 시 역매핑). Jira Server/DC 기본 스킴(Highest/High/
# Medium/Low/Lowest) 기준. 프로젝트가 커스텀 우선순위를 쓰면 이름 불일치로 실패할 수 있어
# push 는 우선순위 갱신을 best-effort 로 처리한다(전체 반영을 막지 않음).
PEP_PRIORITY_TO_JIRA = {"high": "High", "medium": "Medium", "low": "Low"}


def strip_issue_key_prefix(title: str | None, key: str | None) -> str:
    """레거시 호환용 — 예전에는 PEP title 을 가져올 때 `"{KEY} {summary}"` 로 저장했으므로,
    Jira 로 summary 를 되돌릴 때 앞의 키 접두어를 제거한다(현재는 title 이 summary 만 담아
    보통 no-op). 접두어가 없으면(신규 가져오기 결과 또는 사용자가 제목을 통째로 바꿈) 원본 그대로."""
    t = (title or "").strip()
    if key and t.startswith(f"{key} "):
        return t[len(key) + 1:].strip()
    return t


def parse_jira_dt(value: str | None) -> Optional[datetime]:
    """Jira datetime (예: '2026-06-11T10:00:00.000+0900') → naive UTC datetime."""
    if not value:
        return None
    try:
        # +0900 형태를 +09:00 로 정규화해 fromisoformat 호환.
        v = value.strip()
        if len(v) >= 5 and (v[-5] in "+-") and v[-3] != ":":
            v = v[:-2] + ":" + v[-2:]
        dt = datetime.fromisoformat(v)
        if dt.tzinfo is not None:
            dt = dt.astimezone(tz=None).replace(tzinfo=None)
        return dt
    except Exception:  # noqa: BLE001
        return None


class JiraService:
    """사용자별 PAT 로 인스턴스화되는 Jira 프록시. 모듈 싱글톤은 미구성 placeholder."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        token: Optional[str] = None,
        *,
        auth_type: str = "pat",
        verify: bool = True,
        timeout: int = 30,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ):
        self.base_url = (base_url or "").rstrip("/")
        self.token = token or ""
        self.auth_type = (auth_type or "pat").strip().lower()
        self.verify = verify
        self.timeout = timeout
        # 테스트에서 httpx.MockTransport 를 주입하기 위한 훅 (jira_sso_http 와 동일 패턴).
        # 운영 경로에서는 None 이라 httpx 기본 전송을 그대로 쓴다.
        self.transport = transport

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.token)

    def _client(self, *, timeout: Optional[int] = None) -> httpx.AsyncClient:
        """모든 요청이 지나는 단일 클라이언트 팩토리 — 주입된 transport 를 여기서 반영한다."""
        kwargs: dict[str, Any] = {"timeout": timeout or self.timeout, "verify": self.verify}
        if self.transport is not None:
            kwargs["transport"] = self.transport
        return httpx.AsyncClient(**kwargs)

    def _headers(self) -> dict:
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        if self.auth_type in ("cookie", "sso"):
            # 세션 쿠키 재사용 — 'cookie'=사용자가 직접 붙여넣은 값, 'sso'=Playwright 로그인이
            # 자동 캡처한 값. 둘 다 Cookie 헤더로 동일하게 처리한다. 쿠키 인증은 Jira 의 XSRF
            # 방어를 타므로 REST POST 를 위해 no-check 토큰을 함께 보낸다.
            headers["Cookie"] = self.token
            headers["X-Atlassian-Token"] = "no-check"
        else:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    async def myself(self) -> dict:
        """연결 + 권한 확인. 성공 시 displayName 반환."""
        if not self.configured:
            return {"status": "offline", "detail": "Jira URL 또는 토큰이 설정되지 않았습니다."}
        try:
            async with self._client(timeout=10) as client:
                resp = await client.get(f"{self.base_url}/rest/api/2/myself", headers=self._headers())
                if resp.status_code == 401:
                    # auth_failed: 세션 만료 신호 — 라우터가 저장된 SSO 로그인으로 자동
                    # 재로그인을 시도하는 판별 키.
                    return {"status": "error", "detail": "인증 실패 — 토큰을 확인하세요 (401).",
                            "auth_failed": True}
                if resp.status_code == 403:
                    return {"status": "error", "detail": "권한 없음 (403)."}
                if resp.status_code != 200:
                    return {"status": "error", "detail": f"HTTP {resp.status_code}"}
                data = resp.json()
                return {
                    "status": "ok",
                    "display_name": data.get("displayName") or data.get("name", ""),
                    "account": data.get("name") or data.get("key", ""),
                }
        except httpx.ConnectError:
            logger.warning("Jira connect error — 폐쇄망 도달 불가 (%s)", self.base_url)
            return {"status": "offline", "detail": "Jira 서버에 연결할 수 없습니다 (네트워크/도메인 확인)."}
        except httpx.TimeoutException:
            return {"status": "offline", "detail": "Jira 응답 시간 초과."}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Jira myself error: %s", exc)
            return {"status": "offline", "detail": str(exc)[:200]}

    async def search(self, jql: str, *, max_results: int = 100, hard_cap: int = 500,
                     extra_fields: Optional[list[str]] = None) -> dict:
        """JQL 검색 — 페이지네이션 루프. 구조화 dict 반환 (절대 raise 안 함)."""
        if not self.configured:
            return {"status": "offline", "issues": [], "total": 0, "detail": "Jira 미설정"}
        issues: list[dict] = []
        start_at = 0
        try:
            async with self._client() as client:
                while True:
                    resp = await client.post(
                        f"{self.base_url}/rest/api/2/search",
                        headers=self._headers(),
                        json={
                            "jql": jql,
                            "startAt": start_at,
                            "maxResults": max_results,
                            "fields": ISSUE_FIELDS + list(extra_fields or []),
                        },
                    )
                    if resp.status_code == 400:
                        detail = ""
                        try:
                            detail = "; ".join(resp.json().get("errorMessages", []))
                        except Exception:  # noqa: BLE001
                            detail = resp.text[:200]
                        return {"status": "error", "issues": [], "total": 0,
                                "detail": f"JQL 오류: {detail or 'HTTP 400'}"}
                    if resp.status_code == 401:
                        return {"status": "error", "issues": [], "total": 0, "detail": "인증 실패 (401)"}
                    if resp.status_code != 200:
                        return {"status": "error", "issues": [], "total": 0, "detail": f"HTTP {resp.status_code}"}
                    data = resp.json()
                    batch = data.get("issues", [])
                    issues.extend(batch)
                    total = data.get("total", len(issues))
                    start_at += len(batch)
                    if not batch or start_at >= total or len(issues) >= hard_cap:
                        return {
                            "status": "ok",
                            "issues": issues[:hard_cap],
                            "total": total,
                            "truncated": len(issues) >= hard_cap < total,
                        }
        except httpx.ConnectError:
            return {"status": "offline", "issues": [], "total": 0, "detail": "Jira 연결 불가"}
        except httpx.TimeoutException:
            return {"status": "offline", "issues": [], "total": 0, "detail": "Jira 응답 시간 초과"}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Jira search error: %s", exc)
            return {"status": "offline", "issues": [], "total": 0, "detail": str(exc)[:200]}

    def issue_browse_url(self, key: str) -> str:
        return f"{self.base_url}/browse/{key}" if self.base_url and key else ""

    # ── 양방향 push (Phase 2) ────────────────────────────────────────────────
    async def update_issue(self, key: str, fields: dict) -> dict:
        """이슈 필드 편집 — `PUT /rest/api/2/issue/{key}` (`{"fields": {...}}`).

        summary/description/priority 등 값 필드 갱신용. 성공 시 204. 400 이면 Jira 가 준
        errorMessages/errors 를 사유로 돌려준다(예: 존재하지 않는 priority 이름, screen 에
        없는 필드). 절대 raise 하지 않고 구조화 dict 반환."""
        if not self.configured:
            return {"status": "offline", "detail": "Jira 미설정"}
        if not fields:
            return {"status": "ok", "detail": "변경 없음"}
        try:
            async with self._client() as client:
                resp = await client.put(
                    f"{self.base_url}/rest/api/2/issue/{key}",
                    headers=self._headers(), json={"fields": fields},
                )
                if resp.status_code in (200, 204):
                    return {"status": "ok"}
                detail = ""
                try:
                    body = resp.json()
                    msgs = list(body.get("errorMessages", []))
                    errs = body.get("errors", {}) or {}
                    msgs.extend(f"{k}: {v}" for k, v in errs.items())
                    detail = "; ".join(msgs)
                except Exception:  # noqa: BLE001
                    detail = resp.text[:200]
                return {"status": "error", "detail": detail or f"HTTP {resp.status_code}"}
        except httpx.ConnectError:
            return {"status": "offline", "detail": "Jira 연결 불가"}
        except httpx.TimeoutException:
            return {"status": "offline", "detail": "Jira 응답 시간 초과"}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Jira update_issue error: %s", exc)
            return {"status": "offline", "detail": str(exc)[:200]}

    async def get_issue(self, key: str, fields: Optional[list[str]] = None) -> dict:
        """단일 이슈 조회 (충돌 감지/현재 상태 확인용)."""
        if not self.configured:
            return {"status": "offline", "detail": "Jira 미설정"}
        params = {"fields": ",".join(fields)} if fields else {}
        try:
            async with self._client() as client:
                resp = await client.get(
                    f"{self.base_url}/rest/api/2/issue/{key}", headers=self._headers(), params=params
                )
                if resp.status_code == 404:
                    # missing: 이슈가 지워졌거나 **내 권한으로 안 보이는** 상태 — 둘을 서버가
                    # 구분할 수 없다. 호출부가 다른 오류와 구분해 사용자 확인을 받도록
                    # 플래그만 세워 준다(`myself()` 의 auth_failed 와 같은 패턴).
                    return {"status": "error", "detail": f"이슈 {key} 없음 (404)", "missing": True}
                if resp.status_code != 200:
                    return {"status": "error", "detail": f"HTTP {resp.status_code}"}
                return {"status": "ok", "issue": resp.json()}
        except httpx.ConnectError:
            return {"status": "offline", "detail": "Jira 연결 불가"}
        except httpx.TimeoutException:
            return {"status": "offline", "detail": "Jira 응답 시간 초과"}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Jira get_issue error: %s", exc)
            return {"status": "offline", "detail": str(exc)[:200]}

    async def remote_links(self, key: str) -> dict:
        """이슈의 원격 링크 목록 — `GET /rest/api/2/issue/{key}/remotelink`.

        Confluence 문서를 Jira 이슈에 붙여둔 경우 여기에 URL 이 들어온다. 이슈마다 1회
        호출(N+1) — `confluence_base_url` 설정 시에만(옵트인) 행 단위 재가져오기와 대량
        import 양쪽에서 호출한다."""
        if not self.configured:
            return {"status": "offline", "detail": "Jira 미설정", "links": []}
        try:
            async with self._client() as client:
                resp = await client.get(
                    f"{self.base_url}/rest/api/2/issue/{key}/remotelink", headers=self._headers()
                )
                if resp.status_code != 200:
                    return {"status": "error", "detail": f"HTTP {resp.status_code}", "links": []}
                links = []
                for raw in resp.json() or []:
                    obj = (raw or {}).get("object") or {}
                    url = (obj.get("url") or "").strip()
                    if url:
                        links.append({"url": url, "title": (obj.get("title") or "").strip()})
                return {"status": "ok", "links": links}
        except httpx.ConnectError:
            return {"status": "offline", "detail": "Jira 연결 불가", "links": []}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Jira remote_links error: %s", exc)
            return {"status": "offline", "detail": str(exc)[:200], "links": []}

    async def get_transitions(self, key: str) -> dict:
        """이슈의 가용 transition 목록. 각 항목에 to.statusCategory.key 포함."""
        if not self.configured:
            return {"status": "offline", "detail": "Jira 미설정", "transitions": []}
        try:
            async with self._client() as client:
                resp = await client.get(
                    f"{self.base_url}/rest/api/2/issue/{key}/transitions", headers=self._headers()
                )
                if resp.status_code != 200:
                    return {"status": "error", "detail": f"HTTP {resp.status_code}", "transitions": []}
                out = []
                for t in resp.json().get("transitions", []):
                    to = t.get("to", {}) or {}
                    out.append({
                        "id": t.get("id"),
                        "name": t.get("name", ""),
                        "to_name": to.get("name", ""),
                        "to_category": (to.get("statusCategory") or {}).get("key", ""),
                    })
                return {"status": "ok", "transitions": out}
        except httpx.ConnectError:
            return {"status": "offline", "detail": "Jira 연결 불가", "transitions": []}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Jira get_transitions error: %s", exc)
            return {"status": "offline", "detail": str(exc)[:200], "transitions": []}

    async def do_transition(self, key: str, transition_id: str) -> dict:
        if not self.configured:
            return {"status": "offline", "detail": "Jira 미설정"}
        try:
            async with self._client() as client:
                resp = await client.post(
                    f"{self.base_url}/rest/api/2/issue/{key}/transitions",
                    headers=self._headers(), json={"transition": {"id": str(transition_id)}},
                )
                if resp.status_code in (200, 204):
                    return {"status": "ok"}
                detail = ""
                try:
                    detail = "; ".join(resp.json().get("errorMessages", [])) or str(resp.json().get("errors", ""))
                except Exception:  # noqa: BLE001
                    detail = resp.text[:200]
                return {"status": "error", "detail": detail or f"HTTP {resp.status_code}"}
        except httpx.ConnectError:
            return {"status": "offline", "detail": "Jira 연결 불가"}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Jira do_transition error: %s", exc)
            return {"status": "offline", "detail": str(exc)[:200]}

    async def create_issue(
        self, project_key: str, summary: str, *, description: str = "",
        issue_type: str = "Task", priority: Optional[str] = None,
        labels: Optional[list[str]] = None, components: Optional[list[str]] = None,
        parent_key: str = "", epic_key: str = "", epic_field: str = "",
    ) -> dict:
        """새 이슈 생성 — `POST /rest/api/2/issue`. 성공 시 key/id 반환.

        priority/labels/components/epic 은 프로젝트 스킴에 없으면 400 이 나므로, 400 이면
        해당 선택 필드를 빼고 1회 재시도한다(핵심 필드만으로라도 생성되게).

        `parent_key` 는 Sub-task 생성용 상위 이슈 — Jira 가 필수로 요구하므로 재시도에서도
        빼지 않는다. `epic_key` 는 Epic Link(커스텀 필드 `epic_field`)로 보낸다."""
        if not self.configured:
            return {"status": "offline", "detail": "Jira 미설정"}
        if not (project_key and summary):
            return {"status": "error", "detail": "프로젝트 키와 제목은 필수입니다."}

        def _payload(with_optional: bool) -> dict:
            fields: dict[str, Any] = {
                "project": {"key": project_key},
                "summary": summary[:255],
                "issuetype": {"name": issue_type or "Task"},
            }
            if description:
                fields["description"] = description
            # Sub-task 는 parent 가 없으면 생성 자체가 불가 — 선택 필드로 취급하지 않는다.
            if parent_key:
                fields["parent"] = {"key": parent_key}
            if with_optional:
                if priority:
                    fields["priority"] = {"name": priority}
                if labels:
                    fields["labels"] = labels
                if components:
                    fields["components"] = [{"name": c} for c in components]
                if epic_key and epic_field:
                    fields[epic_field] = epic_key
            return {"fields": fields}

        try:
            async with self._client() as client:
                for with_optional in (True, False):
                    resp = await client.post(
                        f"{self.base_url}/rest/api/2/issue",
                        headers=self._headers(), json=_payload(with_optional),
                    )
                    if resp.status_code in (200, 201):
                        data = resp.json()
                        key = data.get("key", "")
                        return {"status": "ok", "key": key, "id": str(data.get("id", "")),
                                "url": self.issue_browse_url(key)}
                    if resp.status_code == 401:
                        return {"status": "error", "detail": "인증 실패 — 토큰을 확인하세요 (401).",
                                "auth_failed": True}
                    if resp.status_code != 400 or not with_optional:
                        detail = ""
                        try:
                            body = resp.json()
                            msgs = list(body.get("errorMessages", []))
                            msgs.extend(f"{k}: {v}" for k, v in (body.get("errors", {}) or {}).items())
                            detail = "; ".join(msgs)
                        except Exception:  # noqa: BLE001
                            detail = resp.text[:200]
                        return {"status": "error", "detail": detail or f"HTTP {resp.status_code}"}
                return {"status": "error", "detail": "이슈 생성 실패"}
        except httpx.ConnectError:
            return {"status": "offline", "detail": "Jira 연결 불가"}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Jira create_issue error: %s", exc)
            return {"status": "offline", "detail": str(exc)[:200]}

    async def delete_issue(self, key: str, *, delete_subtasks: bool = True) -> dict:
        """이슈 삭제 — `DELETE /rest/api/2/issue/{key}`. 권한이 없으면 403."""
        if not self.configured:
            return {"status": "offline", "detail": "Jira 미설정"}
        try:
            async with self._client() as client:
                resp = await client.delete(
                    f"{self.base_url}/rest/api/2/issue/{key}",
                    headers=self._headers(),
                    params={"deleteSubtasks": "true" if delete_subtasks else "false"},
                )
                if resp.status_code in (200, 204):
                    return {"status": "ok"}
                if resp.status_code == 403:
                    return {"status": "error", "detail": "이슈 삭제 권한이 없습니다 (403)."}
                if resp.status_code == 404:
                    return {"status": "error", "detail": f"이슈 {key} 없음 (404)"}
                return {"status": "error", "detail": f"HTTP {resp.status_code}"}
        except httpx.ConnectError:
            return {"status": "offline", "detail": "Jira 연결 불가"}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Jira delete_issue error: %s", exc)
            return {"status": "offline", "detail": str(exc)[:200]}

    async def add_comment(self, key: str, body: str) -> dict:
        if not self.configured:
            return {"status": "offline", "detail": "Jira 미설정"}
        try:
            async with self._client() as client:
                resp = await client.post(
                    f"{self.base_url}/rest/api/2/issue/{key}/comment",
                    headers=self._headers(), json={"body": body},
                )
                if resp.status_code in (200, 201):
                    return {"status": "ok"}
                return {"status": "error", "detail": f"HTTP {resp.status_code}"}
        except httpx.ConnectError:
            return {"status": "offline", "detail": "Jira 연결 불가"}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Jira add_comment error: %s", exc)
            return {"status": "offline", "detail": str(exc)[:200]}


# kanban_status → 목표 Jira statusCategory.key (커스텀 워크플로 견고).
KANBAN_TO_CATEGORY = {"todo": "new", "in_progress": "indeterminate", "done": "done"}



def extract_epic_parts(fields: dict, epic_field: str = "") -> tuple[str, str]:
    """이슈에서 Epic(또는 상위 이슈)을 ``(key, summary)`` 로 분해해 돌려준다.

    Jira Server/DC 는 Epic Link 가 **커스텀 필드**(예: customfield_10008)라 필드 ID 를
    설정으로 받는다. 값이 문자열(에픽 키)이면 key 만, dict 면 key/summary 를 쓴다.
    설정이 없거나 값이 없으면 `parent`(서브태스크/차세대 프로젝트)로 폴백한다.

    key/summary 를 분리해 두면 화면에서 "DL-12 제목 상태" 박스로 렌더하면서 key 만
    링크로 걸 수 있다 — 합본 문자열만 있으면 링크 대상을 다시 파싱해야 한다."""
    if epic_field:
        raw = fields.get(epic_field)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()[:50], ""
        if isinstance(raw, dict):
            key = (raw.get("key") or "").strip()
            summary = (((raw.get("fields") or {}).get("summary")) or raw.get("name") or "").strip()
            if key or summary:
                return key[:50], summary[:200]
    key, summary = extract_parent_parts(fields)
    return key, summary


def extract_parent_parts(fields: dict) -> tuple[str, str]:
    """`parent` 필드 → ``(key, summary)``. Sub-task 의 상위 이슈(= PEP 의 task/Epic)."""
    parent = fields.get("parent") or {}
    if isinstance(parent, dict) and parent.get("key"):
        summary = ((parent.get("fields") or {}).get("summary")) or ""
        return str(parent["key"])[:50], str(summary)[:200]
    return "", ""


def extract_epic(fields: dict, epic_field: str = "") -> str:
    """`extract_epic_parts` 의 합본 표기 ("KEY summary") — 주간보고 집계 축으로 쓴다."""
    key, summary = extract_epic_parts(fields, epic_field)
    return f"{key} {summary}".strip()[:200]


# Greenhopper 레거시 스프린트 필드 문자열(Server/DC 구버전) — 예:
# "com.atlassian.greenhopper.service.sprint.Sprint@1a2b3c4d[id=5,rapidViewId=1,
#  state=ACTIVE,name=Sprint 12,...]" 에서 name= 값만 뽑는다.
_SPRINT_NAME_RE = re.compile(r"name=([^,\]]+)")


def extract_sprint_name(fields: dict, sprint_field: str = "") -> str:
    """Jira Sprint 커스텀필드 → 스프린트 이름(work_item.sprint_id 매칭용).

    Server/DC 구버전은 Greenhopper 문자열 리스트, 최신 REST 는 dict 리스트
    (`{"id":5,"name":"Sprint 12",...}`) — 둘 다 처리한다. 한 이슈가 여러 스프린트를
    거쳤으면(과거 이력 포함) 리스트의 마지막(가장 최근) 값을 쓴다."""
    if not sprint_field:
        return ""
    raw = fields.get(sprint_field)
    if not raw:
        return ""
    items = raw if isinstance(raw, list) else [raw]
    if not items:
        return ""
    last = items[-1]
    if isinstance(last, dict):
        return str(last.get("name") or "").strip()
    if isinstance(last, str):
        m = _SPRINT_NAME_RE.search(last)
        if m:
            return m.group(1).strip()
    return ""


# 이슈 본문에 섞여 들어온 Confluence 문서 링크를 찾기 위한 URL 패턴 (공백/따옴표/괄호 전까지).
_URL_RE = re.compile(r"https?://[^\s\"'<>\]\)]+")


def extract_confluence_url(fields: dict, confluence_base_url: str = "") -> str:
    """이슈 본문(description)에서 **설정된 Confluence Base URL 로 시작하는 링크**를 찾는다.

    Jira 이슈에 문서 링크를 본문으로 붙여두는 관행이 흔해, 가져오기 시 이 링크를 그대로
    업무의 Confluence 대표 링크로 우선 채워준다 — 원격 링크(remote_links, N+1) 스캔보다
    먼저 시도해 API 콜을 아낀다. Base URL 이 설정돼 있지 않으면 오탐을 피하려 아무것도
    반환하지 않는다."""
    base = (confluence_base_url or "").strip().rstrip("/")
    if not base:
        return ""
    desc = fields.get("description")
    if not isinstance(desc, str) or not desc:
        return ""
    for url in _URL_RE.findall(desc):
        if url.rstrip("/").startswith(base):
            return url[:500]
    return ""


def map_jira_issue(
    issue: dict, base_url: str, *, assignee_resolver=None, epic_field: str = "",
    confluence_base_url: str = "", sprint_field: str = "",
    epic_override: Optional[tuple[str, str]] = None,
    remote_confluence_links: Optional[list[dict]] = None,
) -> dict:
    """단일 Jira 이슈 → work_item 필드 dict (생성/upsert 공용). 순수 함수 — API 콜은 호출부
    (jira.py 라우터) 가 미리 해서 `epic_override`(상위 Task 의 Epic 값 — Sub-task 체인
    해석용)/`remote_confluence_links`(원격 링크 전체 목록) 로 넘긴다."""
    fields = issue.get("fields", {}) or {}
    key = issue.get("key", "")
    summary = (fields.get("summary") or "").strip()
    issue_type_name = ((fields.get("issuetype") or {}).get("name") or "").strip()
    wtype, type_label = map_issue_type(issue_type_name)
    kanban = map_status_category(fields.get("status"))
    priority = map_priority((fields.get("priority") or {}).get("name"))
    status_name = (fields.get("status") or {}).get("name", "")
    assignee_obj = fields.get("assignee") or {}
    jira_assignee = assignee_obj.get("displayName") or assignee_obj.get("name") or ""
    pep_assignee = assignee_resolver(assignee_obj) if (assignee_resolver and jira_assignee) else jira_assignee

    started = parse_jira_dt(fields.get("created")) or datetime.utcnow()
    closed = parse_jira_dt(fields.get("resolutiondate")) if kanban == "done" else None
    due = parse_jira_dt(fields.get("duedate"))
    due_date = due.date() if due else None
    desc = fields.get("description")
    content = desc if isinstance(desc, str) and desc.strip() else summary or key

    if epic_override is not None:
        epic_key, epic_summary = epic_override
    else:
        epic_key, epic_summary = extract_epic_parts(fields, epic_field)
    parent_key, parent_summary = extract_parent_parts(fields)
    sprint_name = extract_sprint_name(fields, sprint_field)
    # 원격 링크(remote link) 로 찾은 Confluence 페이지 전체 — {"url","title"} 리스트.
    confluence_links = [
        {"url": str(link["url"])[:500], "title": str(link.get("title") or "")[:200]}
        for link in (remote_confluence_links or [])
        if isinstance(link, dict) and link.get("url")
    ]
    components = [
        str(c.get("name") or "").strip()
        for c in (fields.get("components") or [])
        if isinstance(c, dict) and (c.get("name") or "").strip()
    ]
    labels = [str(x).strip() for x in (fields.get("labels") or []) if str(x).strip()]
    # 업무 분류(category) 는 Jira component 를 1순위로 쓴다 — 주간보고 진척률이 category ×
    # Epic 으로 묶이는데, 전부 "Jira" 로 들어가면 구분 축이 사라진다. component 가 없을
    # 때만 종전처럼 "Jira" 로 폴백한다.
    category = components[0] if components else "Jira"

    out = {
        "type": wtype,
        "type_label": type_label,
        "title": (summary or key)[:200],
        "category": category,
        "content": content,
        "kanban_status": kanban,
        "priority": priority,
        "primary_assignee": pep_assignee or "(미할당)",
        "started_at": started,
        "closed_at": closed,
        "due_date": due_date,
        "sprint_name": sprint_name or None,
        "jira_issue_id": str(issue.get("id", "")),
        "jira_issue_key": key,
        "jira_url": f"{base_url.rstrip('/')}/browse/{key}" if base_url and key else None,
        "jira_status": status_name,
        "jira_status_category": ((fields.get("status") or {}).get("statusCategory") or {}).get("key") or None,
        "jira_updated_at": parse_jira_dt(fields.get("updated")),
        "jira_epic": f"{epic_key} {epic_summary}".strip()[:200],
        "jira_epic_key": epic_key or None,
        "jira_epic_summary": epic_summary or None,
        "jira_issue_type": issue_type_name or None,
        "jira_parent_key": parent_key or None,
        "jira_parent_summary": parent_summary or None,
        "jira_components": components or None,
        "jira_labels": labels or None,
        # 대표(단일) 링크 — 본문 스캔 우선, 없으면 원격 링크 중 첫 값(기존 단건 재가져오기와
        # 동일 우선순위). 전체 목록은 별도 confluence_links.
        "confluence_url": (
            extract_confluence_url(fields, confluence_base_url)
            or (confluence_links[0]["url"] if confluence_links else None)
        ),
    }
    # confluence_links 는 이번 호출에서 원격 링크 조회를 **시도했을 때만** 채운다
    # (remote_confluence_links=None ↔ "이번엔 안 봤음" 을 "찾아봤는데 0건" 과 구분해야
    # 호출부가 기존 값을 잘못 지우지 않는다 — 아래 confluence_links 딕셔너리 키
    # 존재 여부로 판별).
    if remote_confluence_links is not None:
        out["confluence_links"] = confluence_links
    return out


# 미설정 placeholder 싱글톤 (라우터에서 사용자별 자격증명으로 재생성).
jira_service = JiraService()
