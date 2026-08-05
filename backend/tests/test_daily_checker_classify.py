"""DB-free unit tests for DailyChecker._classify_healthz.

핵심 회귀 방지: anonymous-auth 를 끈 하드닝 클러스터가 익명 /healthz 프로브에
401/403 을 반환할 때, 예전처럼 critical→pending(미연결)으로 오진하지 않고
"도달 가능(인증 필요)" 으로 판정해야 한다.
"""
from app.models import StatusEnum
from app.services.daily_checker import DailyChecker


class TestClassifyHealthz:
    def test_200_fast_is_healthy(self):
        status, note = DailyChecker._classify_healthz(200, 120)
        assert status == StatusEnum.healthy
        assert note is None

    def test_200_slow_is_warning(self):
        status, note = DailyChecker._classify_healthz(200, 4500)
        assert status == StatusEnum.warning
        assert "느림" in (note or "")

    def test_401_is_reachable_healthy(self):
        """하드닝 클러스터(익명 healthz 차단) — 미연결 오진 금지."""
        status, note = DailyChecker._classify_healthz(401, 80)
        assert status == StatusEnum.healthy
        assert "인증 필요" in (note or "")
        assert "연결성은 정상" in (note or "")

    def test_403_is_reachable_healthy(self):
        status, note = DailyChecker._classify_healthz(403, 50)
        assert status == StatusEnum.healthy
        assert "인증 필요" in (note or "")

    def test_403_slow_is_warning_but_reachable(self):
        status, note = DailyChecker._classify_healthz(403, 3500)
        assert status == StatusEnum.warning
        assert "인증 필요" in (note or "")

    def test_404_is_warning_not_pending(self):
        """4xx(연결은 됨)는 warning — 연결 실패(critical→pending)와 구분."""
        status, note = DailyChecker._classify_healthz(404, 30)
        assert status == StatusEnum.warning
        assert "예상외 응답" in (note or "")

    def test_500_is_critical(self):
        status, _ = DailyChecker._classify_healthz(500, 30)
        assert status == StatusEnum.critical

    def test_no_response_is_critical(self):
        """status_code 없음(연결 실패) → critical (인증 폴백 후보)."""
        status, _ = DailyChecker._classify_healthz(None, None)
        assert status == StatusEnum.critical
