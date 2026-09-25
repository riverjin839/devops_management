"""점검 매트릭스 cron 최소 간격 검증(`validate_cron_min_interval`) — 클러스터 열/셀/정의
cron 저장(`PUT .../clusters/{id}/cron`, `PUT .../schedule/{item}/{cluster}`,
`DeepCheckDefinition.schedule_cron`) 이 공유하는 유일한 가드다.

핵심 계약:
1. 단일 주기 cron(`*/N`)은 N 분 간격 그대로 판정한다.
2. 필드 안에 값이 여러 개 섞여 간격이 고르지 않은 cron(예: "0,4 * * * *")도 그중 **가장
   촘촘한** 구간 기준으로 판정한다 — base 이후 첫 구간만 보면 놓치는 패턴.
3. 빈 값/None 은 검증을 건너뛴다(스케줄 없음과 동일).
4. 문법 자체가 잘못된 cron 은 별도 메시지로 거부한다.
"""
import pytest

from app.services.check_matrix_service import validate_cron_min_interval


def test_below_min_interval_rejected():
    with pytest.raises(ValueError, match="최소 간격"):
        validate_cron_min_interval("*/1 * * * *")


def test_exactly_min_interval_accepted():
    validate_cron_min_interval("*/5 * * * *")  # raises nothing


def test_above_min_interval_accepted():
    validate_cron_min_interval("*/15 * * * *")


def test_uneven_multi_value_field_with_tight_sub_interval_is_rejected():
    """회귀 테스트 — "0,4 * * * *" 는 매시 정각→04분(4분) / 04분→다음 시 정각(56분) 두
    구간이 번갈아 반복된다. base(2024-01-01 00:00:00) 이후 첫 구간만 보면 우연히 56분
    구간이 걸려 통과해버렸다(실제로는 4분 간격으로 도는데도) — 이제는 연속 표본 중
    최솟값(4분)으로 판정해 정확히 거부한다."""
    with pytest.raises(ValueError, match="최소 간격"):
        validate_cron_min_interval("0,4 * * * *")


def test_daily_multi_value_field_with_wide_gaps_accepted():
    """"0 9,13,18 * * *" 는 4시간/5시간 간격뿐이라 통과해야 한다 — 회귀 수정이 정상
    케이스까지 과도하게 거부하지 않는지 확인."""
    validate_cron_min_interval("0 9,13,18 * * *")


def test_empty_and_none_are_noop():
    validate_cron_min_interval("")
    validate_cron_min_interval(None)


def test_invalid_syntax_rejected_with_distinct_message():
    with pytest.raises(ValueError, match="올바르지 않은"):
        validate_cron_min_interval("this is not a cron")
