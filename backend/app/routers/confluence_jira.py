"""
Confluence / Jira API 테스트 라우터
GET /api/v1/confluence-jira/health           — 양쪽 연결 상태 확인
GET /api/v1/confluence-jira/confluence/spaces
GET /api/v1/confluence-jira/confluence/pages/search
GET /api/v1/confluence-jira/confluence/pages/{page_id}
GET /api/v1/confluence-jira/jira/projects
GET /api/v1/confluence-jira/jira/issues/search
GET /api/v1/confluence-jira/jira/issues/{issue_key}
"""

from __future__ import annotations

from fastapi import APIRouter, Query
from pydantic import BaseModel

from app.config import settings
from app.services.confluence_jira_service import ConfluenceService, JiraService

router = APIRouter(prefix="/confluence-jira", tags=["confluence-jira"])


# ─── 설정에서 서비스 인스턴스 생성 헬퍼 ─────────────────────

def _confluence() -> ConfluenceService:
    return ConfluenceService(
        base_url=settings.confluence_url,
        username=settings.confluence_username,
        password=settings.confluence_password,
        pat=settings.confluence_pat,
        verify_ssl=settings.confluence_verify_ssl,
    )


def _jira() -> JiraService:
    return JiraService(
        base_url=settings.jira_url,
        username=settings.jira_username,
        password=settings.jira_password,
        pat=settings.jira_pat,
        verify_ssl=settings.jira_verify_ssl,
    )


# ─── Health ──────────────────────────────────────────────────

@router.get("/health", summary="Confluence + Jira 연결 상태 확인")
def health_check():
    confluence_result = _confluence().ping() if settings.confluence_url else {"ok": False, "error": "CONFLUENCE_URL not set"}
    jira_result = _jira().ping() if settings.jira_url else {"ok": False, "error": "JIRA_URL not set"}
    return {
        "confluence": confluence_result,
        "jira": jira_result,
    }


# ─── Confluence 엔드포인트 ───────────────────────────────────

@router.get("/confluence/spaces", summary="Confluence 스페이스 목록")
def confluence_spaces(
    limit: int = Query(25, ge=1, le=100),
    start: int = Query(0, ge=0),
    space_type: str = Query("global", description="global | personal"),
):
    return _confluence().list_spaces(limit=limit, start=start, space_type=space_type)


@router.get("/confluence/pages/search", summary="Confluence 페이지 CQL 검색")
def confluence_search(
    cql: str = Query(..., description='예: space = "DEV" AND title ~ "배포"'),
    limit: int = Query(20, ge=1, le=50),
    start: int = Query(0, ge=0),
):
    return _confluence().search_pages(cql=cql, limit=limit, start=start)


@router.get("/confluence/spaces/{space_key}/pages", summary="특정 스페이스 페이지 목록")
def confluence_space_pages(
    space_key: str,
    limit: int = Query(20, ge=1, le=50),
    start: int = Query(0, ge=0),
):
    return _confluence().get_space_pages(space_key=space_key, limit=limit, start=start)


@router.get("/confluence/pages/{page_id}", summary="Confluence 페이지 상세 조회")
def confluence_page(page_id: str):
    return _confluence().get_page(page_id=page_id)


# ─── Jira 엔드포인트 ─────────────────────────────────────────

@router.get("/jira/projects", summary="Jira 프로젝트 목록")
def jira_projects(limit: int = Query(50, ge=1, le=200)):
    return _jira().list_projects(limit=limit)


@router.get("/jira/issues/search", summary="Jira JQL 이슈 검색")
def jira_search(
    jql: str = Query(..., description='예: project = DEV AND status != Done ORDER BY created DESC'),
    max_results: int = Query(20, ge=1, le=100),
    start_at: int = Query(0, ge=0),
):
    return _jira().search_issues(jql=jql, max_results=max_results, start_at=start_at)


@router.get("/jira/projects/{project_key}/issues", summary="특정 프로젝트 미완료 이슈")
def jira_project_issues(
    project_key: str,
    max_results: int = Query(20, ge=1, le=100),
):
    return _jira().get_project_issues(project_key=project_key, max_results=max_results)


@router.get("/jira/issues/{issue_key}", summary="Jira 이슈 상세 조회")
def jira_issue(issue_key: str):
    return _jira().get_issue(issue_key=issue_key)


# ─── 연결 설정 직접 지정 (테스트 전용) ──────────────────────

class ConnTestRequest(BaseModel):
    confluence_url: str = ""
    confluence_username: str = ""
    confluence_password: str = ""
    confluence_pat: str = ""
    confluence_verify_ssl: bool = True
    jira_url: str = ""
    jira_username: str = ""
    jira_password: str = ""
    jira_pat: str = ""
    jira_verify_ssl: bool = True


@router.post("/test-connection", summary="직접 입력한 URL/자격증명으로 연결 테스트")
def test_connection(body: ConnTestRequest):
    """설정 파일 없이 URL 과 자격증명을 직접 입력해 연결을 테스트합니다."""
    results: dict = {}

    if body.confluence_url:
        svc = ConfluenceService(
            base_url=body.confluence_url,
            username=body.confluence_username,
            password=body.confluence_password,
            pat=body.confluence_pat,
            verify_ssl=body.confluence_verify_ssl,
        )
        results["confluence"] = svc.ping()

    if body.jira_url:
        svc2 = JiraService(
            base_url=body.jira_url,
            username=body.jira_username,
            password=body.jira_password,
            pat=body.jira_pat,
            verify_ssl=body.jira_verify_ssl,
        )
        results["jira"] = svc2.ping()

    if not results:
        return {"ok": False, "error": "confluence_url 또는 jira_url 중 하나 이상 필요"}

    return results
