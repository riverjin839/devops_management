"""Unit tests for batch-jobs-cron-fix.

Plan SC:
  SC-1  dispatcher 의 KST 시각 평가 (Asia/Seoul 로 cron 해석)
  SC-2  POST /batch-jobs 에 cron + 자격증명 미입력 → 422
  SC-3  PUT /batch-jobs/{id} 에 clear creds + cron 유지 → 422

These tests are DB-free — they exercise the pure helper / time logic
without spinning up Postgres. End-to-end 422 verification is covered by
manual L2/L3 in docs/02-design/features/batch-jobs-cron-fix.design.md §6.

Design Ref: §6.1 — L1 Backend Unit Tests
"""
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException

from app.routers.batch_jobs import _require_cron_credentials


# ── _require_cron_credentials (Plan SC-2 / SC-3) ─────────────────────────


class TestRequireCronCredentials:
    """Direct unit tests on the invariant helper.

    Same helper is invoked by both create_job (pre-state) and update_job
    (post-merge), so covering it here is the canonical regression net.
    """

    def test_no_cron_no_creds_allowed(self):
        """수동 전용 잡 — cron 없으면 자격증명 없어도 통과."""
        _require_cron_credentials(cron=None, has_password=False, has_private_key=False)
        _require_cron_credentials(cron="", has_password=False, has_private_key=False)
        _require_cron_credentials(cron="   ", has_password=False, has_private_key=False)

    def test_cron_with_password_allowed(self):
        """cron + 비밀번호 → 통과."""
        _require_cron_credentials(
            cron="0 23 * * *", has_password=True, has_private_key=False
        )

    def test_cron_with_private_key_allowed(self):
        """cron + 개인키 → 통과."""
        _require_cron_credentials(
            cron="0 23 * * *", has_password=False, has_private_key=True
        )

    def test_cron_with_both_creds_allowed(self):
        _require_cron_credentials(
            cron="0 23 * * *", has_password=True, has_private_key=True
        )

    def test_cron_without_any_creds_raises_422(self):
        """SC-2 / SC-3 의 핵심 경로."""
        with pytest.raises(HTTPException) as exc:
            _require_cron_credentials(
                cron="0 23 * * *", has_password=False, has_private_key=False
            )
        assert exc.value.status_code == 422
        assert "saved_password" in exc.value.detail
        assert "silent skip" in exc.value.detail


# ── dispatcher timezone logic (Plan SC-1) ────────────────────────────────


class TestDispatcherTimezoneLogic:
    """croniter + ZoneInfo 합성 결과를 직접 검증.

    dispatcher 함수 전체를 돌리는 대신 핵심 시간 산술만 분리해서
    검증한다 — DB / Celery 의존 없이 SC-1 의 본질만 확인.
    """

    def test_cron_with_kst_anchor_fires_at_kst_2300(self):
        """`0 23 * * *` + KST 평가 → KST 23:00 발화."""
        try:
            from croniter import croniter
        except ImportError:
            pytest.skip("croniter not installed")

        kst = ZoneInfo("Asia/Seoul")
        # KST 22:59 → 다음 발화는 같은 날 23:00
        anchor_kst = datetime(2026, 5, 27, 22, 59, 0, tzinfo=kst)
        next_fire = croniter("0 23 * * *", anchor_kst).get_next(datetime)
        assert next_fire.hour == 23
        assert next_fire.minute == 0
        # anchor 가 KST 22:59 면 같은 날 23:00 (다음날 아님)
        assert next_fire.day == 27

    def test_cron_with_utc_anchor_differs_from_kst(self):
        """동일 cron 이 UTC anchor 와 KST anchor 에서 9시간 차이 발생.

        이 차이가 바로 결함 A 의 본질. fix 후엔 항상 KST 로 해석되어야 한다.
        """
        try:
            from croniter import croniter
        except ImportError:
            pytest.skip("croniter not installed")

        kst = ZoneInfo("Asia/Seoul")
        utc = timezone.utc

        # Same wall-clock moment, two different zones
        anchor_kst = datetime(2026, 5, 27, 22, 59, 0, tzinfo=kst)
        anchor_utc = anchor_kst.astimezone(utc)  # = 13:59 UTC same day

        next_kst = croniter("0 23 * * *", anchor_kst).get_next(datetime)
        next_utc = croniter("0 23 * * *", anchor_utc).get_next(datetime)

        # KST 평가: 같은 날 KST 23:00
        # UTC 평가: 같은 날 UTC 23:00 = KST 익일 08:00
        diff = next_utc.astimezone(utc) - next_kst.astimezone(utc)
        assert diff == timedelta(hours=9), (
            f"UTC vs KST anchor should differ by 9h, got {diff}"
        )

    def test_naive_utc_anchor_converts_to_kst_correctly(self):
        """DB 의 naive UTC last_run_at → KST tz-aware 변환 라운드트립."""
        # last_run_at 시뮬레이션 — naive UTC datetime
        last_run_at_naive = datetime(2026, 5, 27, 13, 59, 0)  # = KST 22:59

        # dispatcher 가 하는 변환과 동일
        kst = ZoneInfo("Asia/Seoul")
        anchor_aware = last_run_at_naive.replace(tzinfo=timezone.utc).astimezone(kst)

        assert anchor_aware.hour == 22
        assert anchor_aware.minute == 59
        assert anchor_aware.tzinfo == kst


# ── timezone fallback (defensive behavior) ────────────────────────────────


class TestTimezoneFallback:
    """settings.batch_jobs_timezone 오타 보호.

    dispatcher 가 ZoneInfo 로딩 실패 시 Asia/Seoul 로 fallback 해야 한다.
    실제 dispatcher 호출은 DB+Celery 가 필요해 skip — 로직 정합성만 확인.
    """

    def test_invalid_timezone_raises_zoneinfo_error(self):
        """ZoneInfoNotFoundError 가 발생하는지 확인 (fallback 트리거)."""
        from zoneinfo import ZoneInfoNotFoundError

        with pytest.raises((ZoneInfoNotFoundError, ValueError, OSError)):
            ZoneInfo("Not/A/Real/Zone")

    def test_valid_timezone_loads(self):
        tz = ZoneInfo("Asia/Seoul")
        assert tz is not None
        # KST is UTC+9 (no DST)
        now = datetime.now(tz)
        offset = now.utcoffset()
        assert offset == timedelta(hours=9)
