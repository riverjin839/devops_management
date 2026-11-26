"""본인 담당자 정보 self-update 로직 테스트.

사용자 메뉴 ▸ "내 담당자 정보" 패널이 쓰는 `PUT /ui-settings/assignees/me` 의 핵심 로직
(`_apply_self_editable_fields`) 을 검증한다. users 테이블이 담당자 명부를 겸하므로(모델
docstring 참고) 이 헬퍼는 순수 ORM 속성 대입이라 DB 없이 `User()` 인스턴스만으로 테스트한다
— 예전에는 JSON 리스트에서 사번으로 본인 행을 찾는 별도 매칭 단계가 있었지만, 지금은
`get_current_user` 가 이미 본인 행을 확정해 넘겨주므로 그 매칭 자체가 사라졌다.
"""
from app.models.user import User
import pytest
from fastapi import HTTPException

from app.routers.ui_settings import (
    _apply_self_editable_fields,
    _profile_complete,
    _validate_self_fields,
)
from app.services.assignee_accounts import _normalize_legacy_entry


def _user(**kwargs) -> User:
    defaults = dict(name="홍길동", employee_id="EMP001", ip="10.0.0.1")
    defaults.update(kwargs)
    return User(display_name=defaults.pop("name"), **defaults)


def test_updates_editable_fields_in_place():
    user = _user()
    _apply_self_editable_fields(user, {"ip": "10.0.0.99"})
    assert user.ip == "10.0.0.99"


def test_name_and_employee_id_are_not_self_editable():
    """이름(업무 담당자 식별 키)과 사번(로그인 username)은 payload 로 못 바꾼다."""
    user = _user()
    _apply_self_editable_fields(
        user,
        {"name": "가짜이름", "employeeId": "EMP999", "employee_id": "EMP998", "ip": "10.0.0.5"},
    )
    assert user.display_name == "홍길동"
    assert user.employee_id == "EMP001"
    assert user.ip == "10.0.0.5"


def test_absent_fields_are_left_untouched():
    user = _user(email="a@b.c", seat_location="3층 A-12", duty="Backend")
    _apply_self_editable_fields(user, {"ip": "10.0.0.7"})
    assert user.email == "a@b.c"
    assert user.seat_location == "3층 A-12"
    assert user.duty == "Backend"


def test_explicit_empty_string_clears_field():
    user = _user()
    _apply_self_editable_fields(user, {"ip": ""})
    assert user.ip == ""


def test_values_are_trimmed():
    user = _user()
    _apply_self_editable_fields(user, {"ip": "  10.0.0.3  ", "email": " a@b.c "})
    assert user.ip == "10.0.0.3"
    assert user.email == "a@b.c"


def test_accepts_snake_case_aliases():
    user = _user()
    _apply_self_editable_fields(
        user, {"seat_location": "2층 B-3", "duty": "SRE, DevOps"},
    )
    assert user.seat_location == "2층 B-3"
    assert user.duty == "SRE, DevOps"


def test_camel_case_alias_takes_priority_when_both_present():
    user = _user()
    _apply_self_editable_fields(user, {"seatLocation": "1층", "seat_location": "2층"})
    assert user.seat_location == "1층"


def test_profile_complete_requires_email_ip_seat():
    assert not _profile_complete(_user())  # 이메일·좌석 없음
    assert not _profile_complete(_user(email="a@b.co", seat_location="  "))
    assert _profile_complete(_user(email="a@b.co", seat_location="3층 A-12"))


def test_validate_rejects_bad_email_and_ip():
    user = _user()
    with pytest.raises(HTTPException):
        _validate_self_fields(user, {"email": "not-an-email"})
    with pytest.raises(HTTPException):
        _validate_self_fields(user, {"ip": "10.0.0"})
    _validate_self_fields(user, {"email": "a@b.co", "ip": "fe80::1", "seatLocation": "3층"})


def test_validate_skips_unchanged_legacy_value():
    """이미 저장된(레거시) 값을 그대로 보내면 형식 검사로 다른 필드 저장을 막지 않는다."""
    user = _user(ip="legacy-host")
    _validate_self_fields(user, {"ip": "legacy-host", "seatLocation": "2층"})


def test_legacy_roster_merges_primary_and_secondary_role_into_duty():
    e = _normalize_legacy_entry({"name": "홍", "primaryRole": "SRE", "secondaryRole": "DevOps"})
    assert e["duty"] == "SRE, DevOps"
    e = _normalize_legacy_entry({"name": "홍", "secondaryRole": "DevOps"})
    assert e["duty"] == "DevOps"
    e = _normalize_legacy_entry({"name": "홍", "duty": "플랫폼 운영", "primaryRole": "SRE"})
    assert e["duty"] == "플랫폼 운영"
