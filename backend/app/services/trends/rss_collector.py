import logging
import feedparser
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

from app.services.trends.base import BaseTrendCollector, CollectedItem, TrendCollectError
from app.services.trends.url_guard import guarded_get

logger = logging.getLogger(__name__)

# feed URL → (display_name, category, item_type) — 소스 행에 item_type 이 비었을 때의 기본값 표
RSS_SOURCE_META: dict[str, tuple[str, str, str]] = {
    "https://kubernetes.io/feed.xml":         ("Kubernetes 블로그",  "k8s",    "blog"),
    "https://cilium.io/blog/rss.xml":         ("Cilium 블로그",      "cilium", "blog"),
    "https://www.cncf.io/blog/feed/":         ("CNCF 블로그",        "cncf",   "blog"),
    "https://lwn.net/headlines/rss":          ("LWN.net",           "linux",  "news"),
    "https://www.kernel.org/feeds/all.atom.xml": ("kernel.org",     "linux",  "release"),
}
VALID_ITEM_TYPES = ("release", "blog", "news")
DEFAULT_ITEM_TYPE = "blog"


def default_item_type(url: str) -> str:
    meta = RSS_SOURCE_META.get((url or "").strip())
    return meta[2] if meta else DEFAULT_ITEM_TYPE


class RSSCollector(BaseTrendCollector):
    """RSS/Atom 피드 수집 — SSRF 가드(`url_guard.guarded_get`)를 거쳐 가져온다.

    가져오기·해석 실패는 ``TrendCollectError`` 로 올린다(빈 목록으로 숨기지 않는다 — A-8).
    """

    def __init__(self, allowed_hosts: list[str] | None = None):
        self._allowed_hosts = list(allowed_hosts or [])

    async def collect(self, url: str, since: datetime, item_type: str | None = None) -> list[CollectedItem]:
        display_name, category, meta_type = RSS_SOURCE_META.get(url, (url, "unknown", DEFAULT_ITEM_TYPE))
        item_type = item_type if item_type in VALID_ITEM_TYPES else meta_type
        raw_xml = await _fetch_feed(url, self._allowed_hosts)

        feed = feedparser.parse(raw_xml)
        if not getattr(feed, "entries", None) and getattr(feed, "bozo", False):
            exc = getattr(feed, "bozo_exception", None)
            raise TrendCollectError(f"피드 형식을 해석할 수 없습니다 — {str(exc)[:200] if exc else 'RSS/Atom 아님'}")
        since_aware = since.replace(tzinfo=timezone.utc) if since.tzinfo is None else since
        items: list[CollectedItem] = []

        for entry in feed.entries:
            published = _parse_date(entry)
            if published is None or published < since_aware:
                continue
            content = _entry_content(entry)
            items.append(CollectedItem(
                source_name=display_name,
                source_type="rss",
                category=category,
                item_type=item_type,
                title=entry.get("title", "(제목 없음)"),
                url=entry.get("link", ""),
                published_at=published.astimezone(timezone.utc).replace(tzinfo=None),
                raw_content=content,
            ))
        return items


async def _fetch_feed(url: str, allowed_hosts: list[str] | None = None) -> str:
    r = await guarded_get(url, allowed_hosts=allowed_hosts or [],
                          headers={"User-Agent": "k8s-daily-monitor/1.0"}, timeout=20)
    return r.text


def _parse_date(entry) -> datetime | None:
    for attr in ("published_parsed", "updated_parsed"):
        tup = getattr(entry, attr, None)
        if tup:
            from calendar import timegm
            return datetime.utcfromtimestamp(timegm(tup)).replace(tzinfo=timezone.utc)
    for attr in ("published", "updated"):
        val = getattr(entry, attr, None)
        if val:
            try:
                dt = parsedate_to_datetime(val)
                return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)
            except Exception:
                pass
    return None


def _entry_content(entry) -> str:
    if hasattr(entry, "content") and entry.content:
        return _strip_html(entry.content[0].get("value", ""))
    summary = entry.get("summary", "")
    return _strip_html(summary)[:2000]


def _strip_html(html: str) -> str:
    import re
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"\s+", " ", text)
    return text.strip()[:2000]
