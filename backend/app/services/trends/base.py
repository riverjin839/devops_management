from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime


@dataclass
class CollectedItem:
    source_name: str
    source_type: str   # "github_release" | "rss"
    category: str
    item_type: str     # "release" | "blog" | "news"
    title: str
    url: str
    published_at: datetime
    raw_content: str
    version: str | None = None


class TrendCollectError(Exception):
    """수집 실패 — 메시지는 운영자가 화면에서 바로 읽는 사유(한국어)다.

    수집기는 실패를 빈 목록으로 숨기지 않고 이 예외를 올린다. ``TrendService._collect_source`` 가
    소스 상태를 ``error`` + 사유로 기록한다(빈 결과 ``empty`` 와 구분 — A-8).
    """


class BaseTrendCollector(ABC):
    @abstractmethod
    async def collect(self, url: str, since: datetime) -> list[CollectedItem]:
        """수집: since 이후 발행된 아이템 반환. 실패하면 ``TrendCollectError`` 를 올린다."""
        ...
