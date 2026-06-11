"""JiraService — 폐쇄망 Jira (Server/Data Center, REST API v2) 실패내성 클라이언트.

`agent_service` / `prometheus_service` 와 동일한 패턴:
 - async httpx 사용
 - **모든 예외를 잡아** 구조화된 `{"status": "ok|offline|error", ...}` dict 반환 — 절대 raise 안 함
 - 자체서명 TLS 대비 `verify` 옵션
 - 인증: 사용자별 PAT → `Authorization: Bearer <token>` (DC 8.14+)

매핑 헬퍼는 순수 함수로 분리해 테스트/override 가능.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

# Jira issue 에서 가져올 필드 (v2 search) — 최소화.
ISSUE_FIELDS = [
    "summary", "description", "issuetype", "status", "priority",
    "assignee", "created", "updated", "resolutiondate", "duedate", "parent",
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
        verify: bool = True,
        timeout: int = 30,
    ):
        self.base_url = (base_url or "").rstrip("/")
        self.token = token or ""
        self.verify = verify
        self.timeout = timeout

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.token)

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    async def myself(self) -> dict:
        """연결 + 권한 확인. 성공 시 displayName 반환."""
        if not self.configured:
            return {"status": "offline", "detail": "Jira URL 또는 토큰이 설정되지 않았습니다."}
        try:
            async with httpx.AsyncClient(timeout=10, verify=self.verify) as client:
                resp = await client.get(f"{self.base_url}/rest/api/2/myself", headers=self._headers())
                if resp.status_code == 401:
                    return {"status": "error", "detail": "인증 실패 — 토큰을 확인하세요 (401)."}
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

    async def search(self, jql: str, *, max_results: int = 100, hard_cap: int = 500) -> dict:
        """JQL 검색 — 페이지네이션 루프. 구조화 dict 반환 (절대 raise 안 함)."""
        if not self.configured:
            return {"status": "offline", "issues": [], "total": 0, "detail": "Jira 미설정"}
        issues: list[dict] = []
        start_at = 0
        try:
            async with httpx.AsyncClient(timeout=self.timeout, verify=self.verify) as client:
                while True:
                    resp = await client.post(
                        f"{self.base_url}/rest/api/2/search",
                        headers=self._headers(),
                        json={
                            "jql": jql,
                            "startAt": start_at,
                            "maxResults": max_results,
                            "fields": ISSUE_FIELDS,
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


def map_jira_issue(issue: dict, base_url: str, *, assignee_resolver=None) -> dict:
    """단일 Jira 이슈 → work_item 필드 dict (생성/upsert 공용). 순수 함수."""
    fields = issue.get("fields", {}) or {}
    key = issue.get("key", "")
    summary = (fields.get("summary") or "").strip()
    wtype, type_label = map_issue_type((fields.get("issuetype") or {}).get("name"))
    kanban = map_status_category(fields.get("status"))
    priority = map_priority((fields.get("priority") or {}).get("name"))
    status_name = (fields.get("status") or {}).get("name", "")
    assignee_obj = fields.get("assignee") or {}
    jira_assignee = assignee_obj.get("displayName") or assignee_obj.get("name") or ""
    pep_assignee = assignee_resolver(jira_assignee) if (assignee_resolver and jira_assignee) else jira_assignee

    started = parse_jira_dt(fields.get("created")) or datetime.utcnow()
    closed = parse_jira_dt(fields.get("resolutiondate")) if kanban == "done" else None
    desc = fields.get("description")
    content = desc if isinstance(desc, str) and desc.strip() else summary or key

    return {
        "type": wtype,
        "type_label": type_label,
        "title": f"{key} {summary}".strip()[:200],
        "category": "Jira",
        "content": content,
        "kanban_status": kanban,
        "priority": priority,
        "primary_assignee": pep_assignee or "(미할당)",
        "started_at": started,
        "closed_at": closed,
        "jira_issue_id": str(issue.get("id", "")),
        "jira_issue_key": key,
        "jira_url": f"{base_url.rstrip('/')}/browse/{key}" if base_url and key else None,
        "jira_status": status_name,
        "jira_updated_at": parse_jira_dt(fields.get("updated")),
    }


# 미설정 placeholder 싱글톤 (라우터에서 사용자별 자격증명으로 재생성).
jira_service = JiraService()
