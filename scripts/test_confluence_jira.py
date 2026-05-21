#!/usr/bin/env python3
"""
폐쇄망 Confluence / Jira API 연결 테스트 스크립트
백엔드 서버 없이 직접 실행 가능.

사용법:
  # 환경 변수로 설정
  export CONFLUENCE_URL=http://confluence.company.local
  export CONFLUENCE_USERNAME=admin
  export CONFLUENCE_PASSWORD=yourpassword
  # 또는 PAT
  export CONFLUENCE_PAT=your-pat-token

  export JIRA_URL=http://jira.company.local
  export JIRA_USERNAME=admin
  export JIRA_PASSWORD=yourpassword

  python scripts/test_confluence_jira.py

  # SSL 검증 끄기 (자체 서명 인증서)
  CONFLUENCE_VERIFY_SSL=false JIRA_VERIFY_SSL=false python scripts/test_confluence_jira.py
"""

import json
import os
import sys

# backend 패키지 경로 추가
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

try:
    import httpx
except ImportError:
    print("[!] httpx 미설치 — pip install httpx 후 재시도")
    sys.exit(1)

# ─── 환경 변수 읽기 ─────────────────────────────────────────

CONFLUENCE_URL = os.getenv("CONFLUENCE_URL", "").rstrip("/")
CONFLUENCE_USERNAME = os.getenv("CONFLUENCE_USERNAME", "")
CONFLUENCE_PASSWORD = os.getenv("CONFLUENCE_PASSWORD", "")
CONFLUENCE_PAT = os.getenv("CONFLUENCE_PAT", "")
CONFLUENCE_VERIFY = os.getenv("CONFLUENCE_VERIFY_SSL", "true").lower() != "false"

JIRA_URL = os.getenv("JIRA_URL", "").rstrip("/")
JIRA_USERNAME = os.getenv("JIRA_USERNAME", "")
JIRA_PASSWORD = os.getenv("JIRA_PASSWORD", "")
JIRA_PAT = os.getenv("JIRA_PAT", "")
JIRA_VERIFY = os.getenv("JIRA_VERIFY_SSL", "true").lower() != "false"

# 테스트할 스페이스 키 / JQL (필요 시 수정)
CONFLUENCE_SPACE_KEY = os.getenv("CONFLUENCE_SPACE_KEY", "")
JIRA_PROJECT_KEY = os.getenv("JIRA_PROJECT_KEY", "")
JIRA_JQL = os.getenv("JIRA_JQL", "")


# ─── 출력 헬퍼 ──────────────────────────────────────────────

def _ok(label: str):
    print(f"  ✓  {label}")

def _fail(label: str, detail: str = ""):
    print(f"  ✗  {label}" + (f"  →  {detail}" if detail else ""))

def _section(title: str):
    print(f"\n{'─' * 55}")
    print(f"  {title}")
    print(f"{'─' * 55}")

def _dump(data: dict, indent: int = 4):
    print(json.dumps(data, ensure_ascii=False, indent=indent, default=str))


# ─── 공통 클라이언트 ─────────────────────────────────────────

def _make_client(base_url: str, username: str, password: str, pat: str, verify: bool) -> httpx.Client:
    if pat:
        headers = {"Authorization": f"Bearer {pat}", "Accept": "application/json"}
        auth = None
    elif username and password:
        auth = httpx.BasicAuth(username, password)
        headers = {"Accept": "application/json"}
    else:
        auth = None
        headers = {"Accept": "application/json"}
    return httpx.Client(
        base_url=base_url,
        auth=auth,
        headers=headers,
        verify=verify,
        timeout=30.0,
        follow_redirects=True,
    )


# ─── Confluence 테스트 ───────────────────────────────────────

def test_confluence():
    _section("Confluence API 테스트")

    if not CONFLUENCE_URL:
        print("  [SKIP] CONFLUENCE_URL 미설정")
        return

    print(f"  URL     : {CONFLUENCE_URL}")
    print(f"  Auth    : {'PAT' if CONFLUENCE_PAT else ('Basic' if CONFLUENCE_USERNAME else '없음')}")
    print(f"  SSL     : {'검증함' if CONFLUENCE_VERIFY else '⚠ 검증 안 함 (자체 서명 인증서)'}")

    with _make_client(CONFLUENCE_URL, CONFLUENCE_USERNAME, CONFLUENCE_PASSWORD, CONFLUENCE_PAT, CONFLUENCE_VERIFY) as c:

        # 1. 연결 확인
        try:
            r = c.get("/rest/api/space", params={"limit": 1})
            r.raise_for_status()
            data = r.json()
            _ok(f"연결 성공 (HTTP {r.status_code})  총 스페이스: {data.get('size', 0)}")
        except Exception as e:
            _fail("연결 실패", str(e))
            return

        # 2. 스페이스 목록
        try:
            r = c.get("/rest/api/space", params={"limit": 5, "type": "global"})
            r.raise_for_status()
            spaces = r.json().get("results", [])
            _ok(f"스페이스 목록 ({len(spaces)}건)")
            for s in spaces:
                print(f"       [{s.get('key')}] {s.get('name')}")
        except Exception as e:
            _fail("스페이스 목록 조회 실패", str(e))

        # 3. 특정 스페이스 페이지
        key = CONFLUENCE_SPACE_KEY or (spaces[0].get("key") if spaces else "")
        if key:
            try:
                cql = f'space = "{key}" AND type = "page" ORDER BY created DESC'
                r = c.get("/rest/api/content/search", params={"cql": cql, "limit": 3})
                r.raise_for_status()
                pages = r.json().get("results", [])
                _ok(f"[{key}] 페이지 최근 3건")
                for p in pages:
                    print(f"       [{p.get('id')}] {p.get('title')}")
            except Exception as e:
                _fail(f"[{key}] 페이지 조회 실패", str(e))

        # 4. 내 정보 (Server API)
        try:
            r = c.get("/rest/api/user/current")
            r.raise_for_status()
            me = r.json()
            _ok(f"현재 사용자: {me.get('displayName')} ({me.get('username')})")
        except Exception:
            pass  # 일부 버전에서 미지원


# ─── Jira 테스트 ────────────────────────────────────────────

def test_jira():
    _section("Jira API 테스트")

    if not JIRA_URL:
        print("  [SKIP] JIRA_URL 미설정")
        return

    print(f"  URL     : {JIRA_URL}")
    print(f"  Auth    : {'PAT' if JIRA_PAT else ('Basic' if JIRA_USERNAME else '없음')}")
    print(f"  SSL     : {'검증함' if JIRA_VERIFY else '⚠ 검증 안 함 (자체 서명 인증서)'}")

    with _make_client(JIRA_URL, JIRA_USERNAME, JIRA_PASSWORD, JIRA_PAT, JIRA_VERIFY) as c:

        # 1. 서버 정보
        try:
            r = c.get("/rest/api/2/serverInfo")
            r.raise_for_status()
            info = r.json()
            _ok(f"연결 성공  버전: {info.get('version')}  이름: {info.get('serverTitle')}")
        except Exception as e:
            _fail("연결 실패", str(e))
            return

        # 2. 프로젝트 목록
        projects = []
        try:
            r = c.get("/rest/api/2/project", params={"maxResults": 10})
            r.raise_for_status()
            data = r.json()
            projects = data if isinstance(data, list) else data.get("values", [])
            _ok(f"프로젝트 목록 ({len(projects)}건)")
            for p in projects[:5]:
                print(f"       [{p.get('key')}] {p.get('name')}")
        except Exception as e:
            _fail("프로젝트 목록 조회 실패", str(e))

        # 3. 이슈 검색 (JQL)
        proj_key = JIRA_PROJECT_KEY or (projects[0].get("key") if projects else "")
        jql = JIRA_JQL or (f"project = {proj_key} ORDER BY created DESC" if proj_key else "ORDER BY created DESC")
        try:
            r = c.post(
                "/rest/api/2/search",
                json={
                    "jql": jql,
                    "fields": ["summary", "status", "assignee", "priority", "issuetype"],
                    "maxResults": 3,
                },
            )
            r.raise_for_status()
            issues = r.json().get("issues", [])
            total = r.json().get("total", 0)
            _ok(f"이슈 검색  JQL: {jql!r}  (총 {total}건, 3건 표시)")
            for i in issues:
                f = i.get("fields", {})
                status = f.get("status", {}).get("name", "")
                summary = f.get("summary", "")
                print(f"       [{i.get('key')}] [{status}] {summary}")
        except Exception as e:
            _fail("이슈 검색 실패", str(e))

        # 4. 내 정보
        try:
            r = c.get("/rest/api/2/myself")
            r.raise_for_status()
            me = r.json()
            _ok(f"현재 사용자: {me.get('displayName')} ({me.get('name')})")
        except Exception:
            pass


# ─── 진입점 ─────────────────────────────────────────────────

if __name__ == "__main__":
    print("\n폐쇄망 Confluence / Jira API 연결 테스트")
    print("설정 방법: 환경 변수 CONFLUENCE_URL, JIRA_URL 등 참고")

    test_confluence()
    test_jira()

    _section("완료")
    print("  API 엔드포인트 (백엔드 기동 후)")
    print("  GET  /api/v1/confluence-jira/health")
    print("  POST /api/v1/confluence-jira/test-connection  ← URL 직접 입력")
    print("  GET  /api/v1/confluence-jira/confluence/spaces")
    print("  GET  /api/v1/confluence-jira/jira/projects")
    print()
