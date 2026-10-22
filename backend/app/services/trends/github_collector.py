from datetime import datetime, timezone

import httpx

from app.config import settings
from app.services.trends.base import BaseTrendCollector, CollectedItem, TrendCollectError
from app.services.trends.url_guard import make_client, validate_github_slug

# GitHub slug → display name + category
GITHUB_SOURCES: dict[str, tuple[str, str]] = {
    "kubernetes/kubernetes": ("Kubernetes", "k8s"),
    "cilium/cilium":         ("Cilium",     "cilium"),
    "torvalds/linux":        ("Linux Kernel", "linux"),
}


class GitHubReleaseCollector(BaseTrendCollector):
    """GitHub Releases API 를 통해 릴리즈 노트 수집.

    API 주소·토큰은 AppSetting ``trends.settings``(env 폴백) — ``TrendService`` 가 넘긴다.
    API 주소는 admin 이 정한 값이라(폐쇄망 GHE 는 내부 주소) SSRF 가드 대상이 아니고, 대신 slug 를
    엄격히 검증해 경로 조작을 막는다. 실패는 사유와 함께 ``TrendCollectError`` 로 올린다.
    """

    def __init__(self, api_url: str | None = None, token: str | None = None):
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        tok = token if token is not None else (settings.trends_github_token or None)
        if tok:
            headers["Authorization"] = f"Bearer {tok}"
        self._headers = headers
        self._api_url = (api_url or settings.trends_github_api_url).rstrip("/")

    async def collect(self, url: str, since: datetime) -> list[CollectedItem]:
        """url = 'owner/repo' 슬러그"""
        try:
            slug = validate_github_slug(url)
        except ValueError as e:
            raise TrendCollectError(str(e)) from None
        display_name, category = GITHUB_SOURCES.get(slug, (slug, "unknown"))
        api_url = f"{self._api_url}/repos/{slug}/releases?per_page=20"

        try:
            # 저장소 이름이 바뀌면 301 — 따라간다(httpx 는 다른 origin 으로 갈 때 Authorization 을 뗀다).
            async with make_client(timeout=30, follow_redirects=True) as client:
                r = await client.get(api_url, headers=self._headers)
        except httpx.TimeoutException:
            raise TrendCollectError("GitHub API 응답 시간 초과(30초)") from None
        except httpx.HTTPError as e:
            raise TrendCollectError(f"GitHub API 연결 실패 — {type(e).__name__}: {str(e)[:200]}") from None

        if r.status_code >= 400:
            raise TrendCollectError(_http_reason(r, slug))
        try:
            releases = r.json()
        except ValueError:
            raise TrendCollectError("GitHub API 응답이 JSON 이 아닙니다 — API 주소 설정을 확인하세요") from None
        if not isinstance(releases, list):
            raise TrendCollectError("GitHub API 응답 형식이 예상과 다릅니다(릴리즈 목록 아님)")

        items: list[CollectedItem] = []
        since_aware = since.replace(tzinfo=timezone.utc) if since.tzinfo is None else since
        for rel in releases:
            if not isinstance(rel, dict) or rel.get("draft"):
                continue
            published_str = rel.get("published_at") or rel.get("created_at") or ""
            try:
                published = datetime.fromisoformat(published_str.replace("Z", "+00:00"))
            except Exception:
                continue
            if published.tzinfo is None:
                published = published.replace(tzinfo=timezone.utc)
            if published < since_aware:
                continue
            tag = rel.get("tag_name") or ""
            body = rel.get("body") or ""
            items.append(CollectedItem(
                source_name=display_name,
                source_type="github_release",
                category=category,
                item_type="release",
                title=f"{display_name} {tag} 릴리즈",
                url=rel.get("html_url", ""),
                published_at=published.astimezone(timezone.utc).replace(tzinfo=None),
                raw_content=_trim(body, 2000),
                version=tag or None,
            ))
        return items


def _http_reason(r: httpx.Response, slug: str) -> str:
    code = r.status_code
    remaining = r.headers.get("x-ratelimit-remaining")
    if code in (403, 429) and (remaining == "0" or "rate limit" in r.text.lower()):
        return f"GitHub API 레이트 리밋 초과(HTTP {code}) — 설정에서 GitHub 토큰을 등록하세요"
    if code == 401:
        return "GitHub API 인증 실패(HTTP 401) — 토큰을 확인하세요"
    if code == 404:
        return f"저장소 '{slug}' 를 찾을 수 없습니다(HTTP 404)"
    return f"GitHub API HTTP {code} {r.reason_phrase or ''}".strip()


def _trim(text: str, max_len: int) -> str:
    return text[:max_len] + "…" if len(text) > max_len else text
