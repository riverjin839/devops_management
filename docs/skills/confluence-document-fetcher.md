# Confluence 문서 가져오기 — REST API 활용 가이드

> **시나리오:** 사내 Confluence(Server / Data Center / Cloud)에 저장된 런북·운영 문서를 이 프로젝트에서 프로그래매틱으로 가져오고 싶을 때의 인증 방법, 핵심 API, CQL 검색, 그리고 기존 코드에 통합하는 세 가지 패턴.

---

## 가능 여부 요약

**가능.** Confluence는 REST API v1(Server/Data Center) 및 v2(Cloud)를 공식 제공한다.  
Personal Access Token(PAT) 또는 API Token 인증으로 브라우저 로그인 없이 모든 접근이 가능하다.

---

## 인증 방법

| 방식 | Confluence 유형 | 발급 위치 | HTTP 헤더 |
|---|---|---|---|
| **PAT (개인 액세스 토큰)** | Server / Data Center 7.9+ | 프로필 → Personal Access Tokens | `Authorization: Bearer <token>` |
| **Basic Auth** | Server / Data Center (구형) | — | `Authorization: Basic base64(user:pass)` |
| **API Token + Email** | Cloud | id.atlassian.com → API tokens | `Authorization: Basic base64(email:token)` |
| **OAuth 2.0** | Cloud only | Atlassian developer console | `Authorization: Bearer <oauth_token>` |

> 신규 구축이라면 **PAT** (Server/DC) 또는 **API Token** (Cloud)를 권장한다.  
> Basic Auth(패스워드)는 Cloud에서 2024년부터 비활성화되었다.

### 환경변수 설계

`.env.example` 에 추가할 항목:

```env
CONFLUENCE_BASE_URL=https://wiki.corp.com        # 끝 슬래시 없이
CONFLUENCE_API_TOKEN=your-pat-or-api-token
CONFLUENCE_EMAIL=user@corp.com                   # Cloud 사용 시만
CONFLUENCE_DEFAULT_SPACES=OPS,K8S               # 기본 검색 스페이스 (콤마 구분)
```

---

## Confluence REST API 핵심 엔드포인트

### 특정 페이지 조회

```
GET /rest/api/content/{pageId}
    ?expand=body.storage,version,space,metadata.labels
```

응답의 `body.storage.value` 에 Confluence Storage Format(HTML 유사)으로 본문이 담긴다.

### CQL 검색으로 원하는 문서만 선택

```
GET /rest/api/content/search
    ?cql=<CQL_EXPRESSION>
    &limit=25
    &start=0
    &expand=version,space,metadata.labels
```

### 스페이스 목록

```
GET /rest/api/space?limit=50
```

### 특정 페이지의 하위 페이지

```
GET /rest/api/content/{pageId}/child/page?expand=version
```

### 첨부파일 목록

```
GET /rest/api/content/{pageId}/child/attachment
```

---

## CQL — 원하는 문서만 검색하는 방법

CQL(Confluence Query Language)은 Confluence 내장 검색 언어다. JIRA JQL과 유사한 문법을 사용한다.

### 주요 필터

```sql
-- 특정 스페이스
space = "OPS"

-- 페이지 타입만 (blogpost 제외)
type = page

-- 제목 포함 검색
title ~ "runbook"

-- 정확한 레이블
label = "k8s-ops"

-- 특정 페이지 하위 전체
ancestor = "123456"

-- 최근 수정
lastModified >= "2024-01-01"

-- 본문 전문 검색
text ~ "kubectl drain"

-- 작성자
creator = "user@corp.com"
```

### 실전 예시

```sql
-- OPS 스페이스의 k8s 레이블이 붙은 페이지
space="OPS" AND label="k8s" AND type=page

-- 제목에 "runbook"이 들어가는 운영 문서
title ~ "runbook" AND space="OPS" AND type=page

-- 온콜 관련 최근 3개월 수정 문서
label="on-call" AND lastModified >= "2024-03-01" AND type=page

-- 여러 스페이스에서 kubectl 언급 문서
space in ("OPS","K8S") AND text ~ "kubectl" AND type=page
```

---

## Python httpx 구현 예시

이 프로젝트의 fail-safe 서비스 패턴(`agent_service.py`, `prometheus_service.py`)과 동일한 스타일로 작성한다.

```python
# backend/app/services/confluence_service.py
import base64
import httpx
from app.config import settings


class ConfluenceService:
    def __init__(self):
        base_url = getattr(settings, "confluence_base_url", "")
        token = getattr(settings, "confluence_api_token", "")
        email = getattr(settings, "confluence_email", None)

        self.base_url = base_url.rstrip("/")
        self._available = bool(base_url and token)

        if email:
            cred = f"{email}:{token}"
            self._auth = f"Basic {base64.b64encode(cred.encode()).decode()}"
        else:
            self._auth = f"Bearer {token}"

        self._headers = {
            "Authorization": self._auth,
            "Accept": "application/json",
        }

    def search(self, cql: str, limit: int = 25) -> dict:
        """CQL로 문서 목록 검색. 실패 시 빈 목록 반환."""
        if not self._available:
            return {"results": [], "error": "Confluence not configured"}
        try:
            with httpx.Client(timeout=30) as client:
                resp = client.get(
                    f"{self.base_url}/rest/api/content/search",
                    headers=self._headers,
                    params={"cql": cql, "limit": limit,
                            "expand": "version,space,metadata.labels"},
                )
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            return {"results": [], "error": str(e)}

    def get_page(self, page_id: str) -> dict:
        """특정 pageId 문서 본문 반환. 실패 시 에러 dict."""
        if not self._available:
            return {"error": "Confluence not configured"}
        try:
            with httpx.Client(timeout=30) as client:
                resp = client.get(
                    f"{self.base_url}/rest/api/content/{page_id}",
                    headers=self._headers,
                    params={"expand": "body.storage,version,space"},
                )
                resp.raise_for_status()
                return resp.json()
        except Exception as e:
            return {"error": str(e)}

    def get_page_text(self, page_id: str, max_chars: int = 2000) -> str:
        """본문 Storage Format HTML을 평문으로 변환해 반환 (AI 주입용)."""
        page = self.get_page(page_id)
        if "error" in page:
            return ""
        html = page.get("body", {}).get("storage", {}).get("value", "")
        # 간단한 태그 제거 (beautifulsoup4 있으면 BeautifulSoup(html, "html.parser").get_text() 권장)
        import re
        text = re.sub(r"<[^>]+>", " ", html)
        text = re.sub(r"\s+", " ", text).strip()
        return text[:max_chars]


confluence_service = ConfluenceService()
```

> **HTML 파싱:** `beautifulsoup4` 가 설치된 환경에서는 `BeautifulSoup(html, "html.parser").get_text(separator="\n")` 로 대체하면 더 깔끔하다.

---

## 이 프로젝트 통합 포인트 3가지

### 1. KnowledgeHub URL → 내용 미리보기

현재 `KnowledgeHubPage.tsx` 는 `confluence_url` 을 외부 링크로만 열어준다.  
아래 엔드포인트를 추가하면 앱 안에서 바로 내용을 표시할 수 있다.

```
GET /api/v1/knowledge/confluence-preview?url=https://wiki.corp.com/pages/viewpage.action?pageId=123456
```

구현 위치: `backend/app/routers/knowledge.py` → `confluence_service.get_page_text(page_id)`

URL에서 `pageId` 추출 패턴:
```python
import re
match = re.search(r"pageId=(\d+)", url)
page_id = match.group(1) if match else None
```

---

### 2. AI Agent context 주입

`agent_service.py` 의 `chat()` 메서드는 `context` dict 를 받아 프롬프트에 삽입한다.  
인시던트 분석 시 관련 런북 내용을 자동으로 주입할 수 있다.

```python
# 예시: cluster가 critical일 때 k8s-ops 레이블 런북 첨부
runbook_cql = f'space="OPS" AND label="k8s-ops" AND title ~ "{cluster_name}"'
results = confluence_service.search(runbook_cql, limit=1)
if results.get("results"):
    page_id = results["results"][0]["id"]
    runbook_text = confluence_service.get_page_text(page_id, max_chars=1500)
    context["extra"] = f"관련 런북:\n{runbook_text}"
```

---

### 3. Trend 수집 패턴 재사용

`backend/app/services/trends/` 에는 `BaseTrendCollector` 를 상속하는 GitHub/RSS 수집기가 있다.  
동일한 패턴으로 Confluence 수집기를 추가할 수 있다.

```python
# backend/app/services/trends/confluence_collector.py
from .base import BaseTrendCollector, TrendItem
from app.services.confluence_service import confluence_service

class ConfluenceCollector(BaseTrendCollector):
    source = "confluence"

    def collect(self, spaces: list[str] | None = None) -> list[TrendItem]:
        """지정 스페이스의 최근 수정 문서를 TrendItem으로 변환."""
        spaces = spaces or (settings.confluence_default_spaces or "").split(",")
        space_filter = " OR ".join(f'space="{s.strip()}"' for s in spaces if s.strip())
        cql = f"({space_filter}) AND type=page AND lastModified >= now('-7d')"
        results = confluence_service.search(cql, limit=20)
        items = []
        for r in results.get("results", []):
            items.append(TrendItem(
                source=self.source,
                title=r.get("title", ""),
                url=f"{confluence_service.base_url}{r.get('_links', {}).get('webui', '')}",
                summary=r.get("space", {}).get("name", ""),
            ))
        return items
```

---

## 페이지네이션

Confluence API는 기본적으로 최대 25건을 반환한다. 전체 결과가 필요하면 `start` 를 증가시켜 순회한다.

```python
def search_all(self, cql: str) -> list[dict]:
    results, start, limit = [], 0, 50
    while True:
        page = self.search_page(cql, start=start, limit=limit)
        batch = page.get("results", [])
        results.extend(batch)
        if len(batch) < limit:
            break
        start += limit
    return results
```

---

## 주의사항

| 항목 | 내용 |
|---|---|
| **접근 권한** | PAT 발급 계정이 접근 가능한 스페이스만 조회된다. 서비스 계정 PAT 사용 권장 |
| **대용량 본문** | Storage Format HTML은 수십 KB 이상일 수 있다. AI 주입 시 앞 1500~2000자만 잘라 사용 |
| **HTML 파싱** | `beautifulsoup4` 패키지 추가 필요: `pip install beautifulsoup4` |
| **Cloud v2 API** | Cloud는 `/rest/api/v2/pages/{id}` 도 사용 가능. `body-format=storage` 파라미터 필요 |
| **레이트 리밋** | Server/DC는 기본 없음. Cloud는 1,000 req/min (계정당) |
| **민감 정보** | 백업 export 시 Confluence 토큰은 `SENSITIVE_COLUMNS` 에 등록해 마스킹 필요 |

---

## 참고 링크

- [Confluence REST API 공식 문서 (Server/DC)](https://docs.atlassian.com/software/confluence/docs/api/rest/)
- [Confluence Cloud REST API v2](https://developer.atlassian.com/cloud/confluence/rest/v2/intro/)
- [CQL 레퍼런스](https://developer.atlassian.com/server/confluence/advanced-searching-using-cql/)
- [Personal Access Tokens (Server/DC 7.9+)](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html)
