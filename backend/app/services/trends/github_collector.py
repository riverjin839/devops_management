from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx

from app.config import settings
from app.services.trends.base import BaseTrendCollector, CollectedItem, TrendCollectError
from app.services.trends.url_guard import guarded_get, validate_github_slug

# GitHub slug → display name + category
GITHUB_SOURCES: dict[str, tuple[str, str]] = {
    "kubernetes/kubernetes": ("Kubernetes", "k8s"),
    "cilium/cilium":         ("Cilium",     "cilium"),
    "torvalds/linux":        ("Linux Kernel", "linux"),
}


class GitHubReleaseCollector(BaseTrendCollector):
    """GitHub Releases API 를 통해 릴리즈 노트 수집.

    API 주소·토큰·허용 호스트는 AppSetting ``trends.settings``(env 폴백) — ``TrendService`` 가 넘긴다.
    요청은 RSS 와 같은 SSRF 가드(``url_guard.guarded_get``)를 거친다 — 매 hop 검사한 IP 로 고정 연결,
    redirect 재검사, 본문 상한, 다른 origin 으로 redirect 되면 토큰 헤더 제거. admin 이 정한 API 주소의
    호스트는 허용 호스트로 취급해(폐쇄망 GHE 는 내부 주소) 차단하지 않되 주소 고정은 똑같이 하고,
    redirect 로 넘어가는 **다른** 내부 호스트는 허용 호스트 설정에 없으면 막는다. slug 는 엄격히 검증해
    경로 조작을 막는다. 실패는 사유와 함께 ``TrendCollectError`` 로 올린다.
    """

    def __init__(self, api_url: str | None = None, token: str | None = None,
                 allowed_hosts: list[str] | None = None):
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        tok = token if token is not None else (settings.trends_github_token or None)
        if tok:
            headers["Authorization"] = f"Bearer {tok}"
        self._headers = headers
        self._api_url = (api_url or settings.trends_github_api_url).rstrip("/")
        api_host = (urlparse(self._api_url).hostname or "").lower()
        self._allowed_hosts = [*(allowed_hosts or []), *([api_host] if api_host else [])]

    async def collect(self, url: str, since: datetime) -> list[CollectedItem]:
        """url = 'owner/repo' 슬러그"""
        try:
            slug = validate_github_slug(url)
        except ValueError as e:
            raise TrendCollectError(str(e)) from None
        display_name, category = GITHUB_SOURCES.get(slug, (slug, "unknown"))
        api_url = f"{self._api_url}/repos/{slug}/releases?per_page=20"

        try:
            # 저장소 이름이 바뀌면 301 — guarded_get 이 hop 마다 다시 검사하며 따라간다(다른 origin 으로
            # 가면 Authorization 을 뗀다). 4xx/5xx 는 응답으로 받아 GitHub 전용 사유로 바꾼다.
            r = await guarded_get(api_url, allowed_hosts=self._allowed_hosts, headers=self._headers,
                                  timeout=30, raise_for_status=False)
        except TrendCollectError as e:
            # 차단(UrlBlocked)은 그 유형을 유지한다 — 사유 앞에 출처만 붙인다.
            raise type(e)(f"GitHub API {e}") from None

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
