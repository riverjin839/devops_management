"""
TrendService: 수집 → 저장 → 요약 오케스트레이션

다이제스트 의미(정책 ④·A-10): **그날 새로 발견된 항목**. URL 은 전역 unique 라 이미 본 항목은 건너뛴다.
- 정기 수집(beat, ``lookback_days=None``): 소스마다 마지막 성공 수집 시각(``last_success_at``) 이후분만.
  처음 수집하는 소스만 ``FIRST_LOOKBACK_DAYS`` 를 되돌아본다.
- 수동 기간 선택(``lookback_days=N``): 백필 — 모든 소스를 N일 되돌아본다(이미 본 URL 은 여전히 skip).

실패 표시(A-8):
- 수집기 실패는 소스 ``last_status='error'`` + 사유. 빈 결과(``empty``)와 구분한다.
- 항목 요약 실패는 ``summary_ko=None`` + ``summary_status='failed'`` + ``summary_error``. 다음 수집 때
  재시도(항목당 최대 ``MAX_SUMMARY_ATTEMPTS`` 회).
- 다이제스트 상태: done / partial(일부 소스·요약 실패) / failed(전 소스 실패·예외).

동시 실행(A-9): 다이제스트 단위 Redis 락(``collect_lock``). 30분 넘게 진행 기록이 없는 collecting/summarizing
다이제스트는 다음 시작·조회 때 failed 로 정리한다.
"""
from __future__ import annotations

import logging
from datetime import datetime, date, timedelta
from typing import Any, Callable, Optional

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.trend import TrendSource, TrendItem, TrendDigest
from app.services.trends import summarizer, trend_settings
from app.services.trends.base import TrendCollectError
from app.services.trends.collect_lock import collect_lock
from app.services.trends.github_collector import GitHubReleaseCollector
from app.services.trends.rss_collector import RSSCollector, default_item_type, VALID_ITEM_TYPES

logger = logging.getLogger(__name__)

MAX_SUMMARY_ATTEMPTS = 3
MAX_SUMMARIES_PER_RUN = 300
FIRST_LOOKBACK_DAYS = 90
STALE_AFTER = timedelta(minutes=30)
RUNNING_STATUSES = ("collecting", "summarizing")
STALE_MESSAGE = "30분 넘게 진행 기록이 없어 중단된 것으로 처리했습니다(프로세스 재시작·요청 끊김 추정) — 다시 수집하세요"

LogFn = Callable[[str, str], None]          # (level, message)
StepFn = Callable[[str, str, str], None]    # (name, label, status)


class TrendCollectBusy(Exception):
    """같은 다이제스트를 이미 수집 중."""


def effective_item_type(source: TrendSource) -> str:
    if source.source_type == "github_release":
        return "release"
    if source.item_type in VALID_ITEM_TYPES:
        return source.item_type
    return default_item_type(source.url)


def _noop_log(_lvl: str, _msg: str) -> None:
    return None


def _noop_step(_n: str, _l: str, _s: str) -> None:
    return None


def _short(text: str, n: int = 60) -> str:
    t = (text or "").strip()
    return t if len(t) <= n else t[: n - 1] + "…"


class TrendService:
    def __init__(self, db: Session):
        self.db = db
        cfg = trend_settings.effective(db)
        self._github = GitHubReleaseCollector(api_url=cfg["github_api_url"], token=cfg["github_token"],
                                              allowed_hosts=cfg["allowed_hosts"])
        self._rss = RSSCollector(allowed_hosts=cfg["allowed_hosts"])
        # 마지막 run_daily_collect 의 실행 요약(응답 `run` 필드)
        self.last_run: dict[str, Any] | None = None

    # ── 오래 멈춘 다이제스트 정리 ───────────────────────────────────────

    def recover_stale(self) -> int:
        """collecting/summarizing 으로 30분 넘게 갱신이 없고 락도 없는 다이제스트 → failed."""
        cutoff = datetime.utcnow() - STALE_AFTER
        try:
            rows = (
                self.db.query(TrendDigest)
                .filter(TrendDigest.status.in_(RUNNING_STATUSES))
                .filter(func.coalesce(TrendDigest.updated_at, TrendDigest.created_at) < cutoff)
                .all()
            )
            n = 0
            for d in rows:
                if collect_lock.is_held(d.digest_date):
                    continue
                d.status = "failed"
                d.error_message = STALE_MESSAGE
                n += 1
            if n:
                self.db.commit()
            return n
        except Exception as e:  # noqa: BLE001 — 조회를 막지 않는다
            logger.warning("trends: 멈춘 다이제스트 정리 실패: %s", e)
            self.db.rollback()
            return 0

    # ── 수집 진입점 ─────────────────────────────────────────────

    async def run_daily_collect(
        self,
        target_date: date | None = None,
        lookback_days: int | None = None,
        *,
        log: Optional[LogFn] = None,
        step: Optional[StepFn] = None,
        lock_token: str | None = None,
    ) -> TrendDigest:
        """수집 + LLM 요약. ``lock_token`` 이 없으면 직접 락을 잡는다(이미 수집 중이면 TrendCollectBusy).

        넘겨받은 락도, 직접 잡은 락도 끝나면 해제한다.
        """
        if target_date is None:
            target_date = date.today()
        if lock_token is None:
            lock_token = collect_lock.acquire(target_date)
            if lock_token is None:
                raise TrendCollectBusy("이미 수집 중입니다")
        try:
            return await self._run(target_date, lookback_days, log or _noop_log, step or _noop_step, lock_token)
        finally:
            collect_lock.release(target_date, lock_token)

    async def _run(
        self, target_date: date, lookback_days: int | None, log: LogFn, step: StepFn, lock_token: str,
    ) -> TrendDigest:
        self.recover_stale()
        db = self.db

        digest = db.query(TrendDigest).filter(TrendDigest.digest_date == target_date).first()
        if digest is None:
            digest = TrendDigest(digest_date=target_date, status="collecting")
            db.add(digest)
        else:
            digest.status = "collecting"
            digest.error_message = None
        digest.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(digest)

        def touch() -> None:
            digest.updated_at = datetime.utcnow()
            collect_lock.refresh(target_date, lock_token)

        mode = f"백필 {lookback_days}일" if lookback_days else "증분(마지막 성공 수집 이후)"
        run: dict[str, Any] = {
            "mode": "backfill" if lookback_days else "incremental",
            "lookback_days": lookback_days,
            "sources": [], "source_total": 0, "source_ok": 0, "source_failed": 0,
            "new_items": 0, "summary_total": 0, "summary_ok": 0, "summary_failed": 0,
            "overall_summary": "skipped",
        }
        self.last_run = run

        try:
            sources = db.query(TrendSource).filter(TrendSource.enabled == True).order_by(  # noqa: E712
                TrendSource.category, TrendSource.name).all()
            n_src = len(sources)
            run["source_total"] = n_src
            log("info", f"{target_date} 기술 동향 수집 시작 — 활성 소스 {n_src}개 · {mode}")

            # 1) 소스 수집
            step("collect", "소스 수집", "running")
            for source in sources:
                res = await self._collect_source(source, lookback_days, target_date)
                run["sources"].append(res)
                run["new_items"] += res["new_count"]
                if res["status"] == "error":
                    run["source_failed"] += 1
                    log("error", f"{source.name} · 신규 0 · {res['error']}")
                else:
                    run["source_ok"] += 1
                    log("info", f"{source.name} · 신규 {res['new_count']}")
                touch()
                db.commit()
            step("collect", "소스 수집", "failed" if run["source_failed"] else "done")

            # 2) 항목 요약 — 이번 다이제스트 미요약분 + 이전 실패분(시도 3회 미만) 재시도
            digest.status = "summarizing"
            touch()
            db.commit()
            step("summarize", "항목 요약", "running")
            pending = (
                db.query(TrendItem)
                .filter(TrendItem.summary_status.in_(("pending", "failed")))
                .filter(TrendItem.summary_attempts < MAX_SUMMARY_ATTEMPTS)
                .order_by((TrendItem.digest_date == target_date).desc(), TrendItem.published_at.desc())
                .limit(MAX_SUMMARIES_PER_RUN)
                .all()
            )
            n_sum = len(pending)
            run["summary_total"] = n_sum
            if n_sum == 0:
                log("info", "요약할 항목이 없습니다")
            for i, item in enumerate(pending, 1):
                res = await summarizer.summarize_item(item.title, item.raw_content or "")
                item.summary_attempts = (item.summary_attempts or 0) + 1
                if res.ok:
                    item.summary_ko = res.text
                    item.summary_status = "ok"
                    item.summary_error = None
                    run["summary_ok"] += 1
                    log("info", f"요약 {i}/{n_sum} · {_short(item.title)}")
                else:
                    item.summary_ko = None
                    item.summary_status = "failed"
                    item.summary_error = res.error
                    run["summary_failed"] += 1
                    left = MAX_SUMMARY_ATTEMPTS - item.summary_attempts
                    retry = f" — 다음 수집 때 재시도({left}회 남음)" if left > 0 else " — 재시도 한도 도달"
                    log("warn", f"요약 {i}/{n_sum} · {_short(item.title)} · 실패: {res.error}{retry}")
                touch()
                db.commit()
            step("summarize", "항목 요약", "failed" if run["summary_failed"] else "done")

            # 3) 종합 요약 — 이 다이제스트의 항목 기준
            all_items = (
                db.query(TrendItem)
                .filter(TrendItem.digest_date == target_date)
                .order_by(TrendItem.published_at.desc())
                .all()
            )
            overall_error: str | None = None
            if all_items:
                step("digest", "종합 요약", "running")
                items_dict = [
                    {"category": i.source.category if i.source else "", "title": i.title, "version": i.version}
                    for i in all_items
                ]
                res = await summarizer.summarize_digest(str(target_date), items_dict)
                if res.ok:
                    digest.overall_summary_ko = res.text
                    run["overall_summary"] = "ok"
                    log("info", "종합 요약 완료")
                    step("digest", "종합 요약", "done")
                else:
                    digest.overall_summary_ko = None
                    overall_error = res.error
                    run["overall_summary"] = "failed"
                    log("warn", f"종합 요약 실패: {res.error}")
                    step("digest", "종합 요약", "failed")
            else:
                log("info", "이 날짜에 새로 발견된 항목이 없어 종합 요약을 건너뜁니다")

            digest.item_count = len(all_items)
            digest_failed_items = sum(1 for i in all_items if i.summary_status == "failed")

            # 4) 상태 판정
            problems: list[str] = []
            if run["source_failed"]:
                failed_names = ", ".join(s["name"] for s in run["sources"] if s["status"] == "error")
                problems.append(f"소스 실패 {run['source_failed']}/{n_src} ({_short(failed_names, 120)})")
            # 이 다이제스트 항목 기준(이전 날짜 항목의 재시도 실패는 그 날짜 다이제스트 몫)
            if digest_failed_items:
                problems.append(f"항목 요약 실패 {digest_failed_items}건")
            if overall_error:
                problems.append(f"종합 요약 실패 — {overall_error}")

            if n_src and run["source_failed"] == n_src:
                digest.status = "failed"
            elif problems:
                digest.status = "partial"
            else:
                digest.status = "done"
            digest.error_message = " · ".join(problems) if problems else (
                None if n_src else "활성화된 수집 소스가 없습니다")
            touch()
            db.commit()
            db.refresh(digest)

            log("error" if digest.status == "failed" else ("warn" if digest.status == "partial" else "info"),
                f"합계 · 소스 성공 {run['source_ok']}/{n_src} · 신규 {run['new_items']}건 · "
                f"요약 성공 {run['summary_ok']} · 요약 실패 {run['summary_failed']} · 상태 {digest.status}")

        except Exception as e:  # noqa: BLE001
            logger.exception("트렌드 수집 실패: %s", e)
            db.rollback()
            digest = db.query(TrendDigest).filter(TrendDigest.digest_date == target_date).first() or digest
            digest.status = "failed"
            digest.error_message = f"{type(e).__name__}: {str(e)[:500]}"
            digest.updated_at = datetime.utcnow()
            db.commit()
            log("error", f"수집 중단 — {digest.error_message}")

        return digest

    def _since_for(self, source: TrendSource, lookback_days: int | None, target_date: date) -> datetime:
        if lookback_days:
            return datetime.combine(target_date - timedelta(days=lookback_days), datetime.min.time())
        if source.last_success_at:
            # 발행 시각이 수집 시각보다 늦게 피드에 반영되는 경우를 위해 하루 겹친다(중복은 URL 로 걸러짐).
            return source.last_success_at - timedelta(days=1)
        return datetime.combine(target_date - timedelta(days=FIRST_LOOKBACK_DAYS), datetime.min.time())

    async def _collect_source(
        self, source: TrendSource, lookback_days: int | None, target_date: date,
    ) -> dict[str, Any]:
        """한 소스 수집 → 신규 항목 저장. 결과 dict: {id, name, status, new_count, fetched, error}."""
        since = self._since_for(source, lookback_days, target_date)
        out: dict[str, Any] = {"id": str(source.id), "name": source.name, "status": "error",
                               "new_count": 0, "fetched": 0, "error": None}
        try:
            if source.source_type == "github_release":
                raw = await self._github.collect(source.url, since)
            else:
                raw = await self._rss.collect(source.url, since, item_type=effective_item_type(source))
        except TrendCollectError as e:
            reason = str(e)[:500] or type(e).__name__
            return self._mark_source_error(source, reason, out)
        except Exception as e:  # noqa: BLE001
            logger.warning("소스 수집 실패 %s: %s", source.name, e)
            return self._mark_source_error(source, f"{type(e).__name__}: {str(e)[:500]}", out)

        out["fetched"] = len(raw)
        # URL 전역 중복 제거 — 이미 본 항목은 skip(다른 날짜 다이제스트 포함)
        seen: set[str] = set()
        candidates = []
        for c in raw:
            u = (c.url or "").strip()
            if not u or u in seen or len(u) > 500:
                continue
            seen.add(u)
            candidates.append((u, c))
        existing: set[str] = set()
        urls = [u for u, _ in candidates]
        for chunk_start in range(0, len(urls), 500):
            chunk = urls[chunk_start:chunk_start + 500]
            existing |= {row[0] for row in self.db.query(TrendItem.url).filter(TrendItem.url.in_(chunk)).all()}

        new_count = 0
        for u, c in candidates:
            if u in existing:
                continue
            item = TrendItem(
                source_id=source.id,
                title=(c.title or "(제목 없음)")[:500],
                url=u,
                published_at=c.published_at,
                raw_content=c.raw_content,
                version=(c.version or None) and c.version[:50],
                item_type=c.item_type,
                digest_date=target_date,
                summary_status="pending",
                summary_attempts=0,
            )
            # 동시 수집(다른 날짜 다이제스트)과 겹치면 unique 위반 — 그 항목만 건너뛴다.
            sp = self.db.begin_nested()
            try:
                self.db.add(item)
                self.db.flush()
                sp.commit()
                new_count += 1
            except IntegrityError:
                sp.rollback()

        now = datetime.utcnow()
        source.last_status = "ok" if new_count else "empty"
        dup = len(raw) - new_count
        source.last_message = (
            f"{new_count}개 신규 수집 (원본 {len(raw)}개, 이미 수집 {dup}개 제외)"
            if new_count else f"새 항목 없음 (since={since.date()}, 원본 {len(raw)}개 확인)"
        )
        source.last_item_count = new_count
        source.last_collected_at = now
        source.last_success_at = now
        self.db.commit()
        out.update(status=source.last_status, new_count=new_count)
        return out

    def _mark_source_error(self, source: TrendSource, reason: str, out: dict[str, Any]) -> dict[str, Any]:
        self.db.rollback()
        source.last_status = "error"
        source.last_message = reason
        source.last_item_count = 0
        source.last_collected_at = datetime.utcnow()
        self.db.commit()
        out.update(status="error", error=reason)
        return out

    # ── 조회 ────────────────────────────────────────────────────

    def get_digest(self, target_date: date) -> TrendDigest | None:
        self.recover_stale()
        return self.db.query(TrendDigest).filter(TrendDigest.digest_date == target_date).first()

    def list_digests(self, limit: int = 30) -> list[TrendDigest]:
        self.recover_stale()
        return (
            self.db.query(TrendDigest)
            .order_by(TrendDigest.digest_date.desc())
            .limit(limit)
            .all()
        )

    def summary_counts(self, dates: list[date]) -> dict[date, dict[str, int]]:
        """다이제스트 날짜별 항목 요약 상태 집계 {date: {ok, failed, pending}}."""
        if not dates:
            return {}
        rows = (
            self.db.query(TrendItem.digest_date, TrendItem.summary_status, func.count())
            .filter(TrendItem.digest_date.in_(dates))
            .group_by(TrendItem.digest_date, TrendItem.summary_status)
            .all()
        )
        out: dict[date, dict[str, int]] = {d: {"ok": 0, "failed": 0, "pending": 0} for d in dates}
        for d, st, n in rows:
            key = st if st in ("ok", "failed", "pending") else "pending"
            out.setdefault(d, {"ok": 0, "failed": 0, "pending": 0})[key] += int(n)
        return out

    def list_items(
        self,
        target_date: date,
        category: str | None = None,
        item_type: str | None = None,
    ) -> list[TrendItem]:
        q = (
            self.db.query(TrendItem)
            .join(TrendSource)
            .filter(TrendItem.digest_date == target_date)
        )
        if category:
            q = q.filter(TrendSource.category == category)
        if item_type:
            q = q.filter(TrendItem.item_type == item_type)
        return q.order_by(TrendItem.published_at.desc()).all()

    # ── 소스 관리 ────────────────────────────────────────────────

    def get_source(self, source_id: str) -> TrendSource | None:
        return self.db.query(TrendSource).filter(TrendSource.id == source_id).first()

    def list_sources(self) -> list[TrendSource]:
        return self.db.query(TrendSource).order_by(TrendSource.category, TrendSource.name).all()

    def toggle_source(self, source_id: str, enabled: bool) -> TrendSource | None:
        src = self.get_source(source_id)
        if src:
            src.enabled = enabled
            self.db.commit()
            self.db.refresh(src)
        return src

    def create_source(
        self, name: str, source_type: str, url: str, category: str, enabled: bool = True,
        item_type: str | None = None,
    ) -> TrendSource:
        src = TrendSource(
            name=name.strip(), source_type=source_type.strip(),
            url=url.strip(), category=category.strip(), enabled=enabled,
            item_type=item_type or "blog",
        )
        self.db.add(src)
        self.db.commit()
        self.db.refresh(src)
        return src

    def update_source(
        self, source_id: str, *,
        name: str | None = None, source_type: str | None = None,
        url: str | None = None, category: str | None = None,
        enabled: bool | None = None, item_type: str | None = None,
    ) -> TrendSource | None:
        src = self.get_source(source_id)
        if not src:
            return None
        if name is not None:        src.name = name.strip()
        if source_type is not None: src.source_type = source_type.strip()
        if url is not None:         src.url = url.strip()
        if category is not None:    src.category = category.strip()
        if enabled is not None:     src.enabled = enabled
        if item_type is not None:   src.item_type = item_type
        self.db.commit()
        self.db.refresh(src)
        return src

    def deactivate_source(self, source_id: str) -> TrendSource | None:
        """DELETE 기본 동작 — 비활성화(과거 다이제스트 항목 보존)."""
        return self.toggle_source(source_id, False)

    def delete_source(self, source_id: str) -> bool:
        """하드 삭제 — 항목까지 cascade 삭제(admin 전용)."""
        src = self.get_source(source_id)
        if not src:
            return False
        self.db.delete(src)
        self.db.commit()
        return True
