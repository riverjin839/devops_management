"""본인 담당자 정보 self-update 로직 테스트.

사용자 메뉴 ▸ "내 담당자 정보" 패널이 쓰는 `PUT /ui-settings/assignees/me` 의 핵심 로직
(`_apply_self_assignee_patch`) 을 검증한다. 이 패널은 예전에 전체 목록을 덮어쓰는 admin
전용 `PUT /ui-settings/assignees` 를 호출해서 operator 가 본인 IP 를 바꾸면 403 이 났다.
"""
from app.routers.ui_settings import _apply_self_assignee_patch, _normalize_assignee


def _list(*entries) -> list[dict]:
    return [n for e in entries if (n := _normalize_assignee(e)) is not None]


def test_updates_only_own_row_by_employee_id():
    cleaned = _list(
        {"name": "홍길동", "employeeId": "EMP001", "ip": "10.0.0.1"},
        {"name": "이순신", "employeeId": "EMP002", "ip": "10.0.0.2"},
    )
    idx = _apply_self_assignee_patch(cleaned, "EMP002", {"ip": "10.0.0.99"})

    assert idx == 1
    assert cleaned[1]["ip"] == "10.0.0.99"
    # 다른 담당자 행은 그대로.
    assert cleaned[0]["ip"] == "10.0.0.1"


def test_returns_minus_one_when_no_matching_row():
    cleaned = _list({"name": "홍길동", "employeeId": "EMP001"})
    assert _apply_self_assignee_patch(cleaned, "EMP999", {"ip": "10.0.0.9"}) == -1
    assert cleaned[0].get("ip") is None


def test_returns_minus_one_for_blank_username():
    """사번 없이 만들어진 계정(admin 등)이 사번 빈 담당자 행을 잘못 잡지 않아야 한다."""
    cleaned = _list({"name": "사번없음"})
    assert _apply_self_assignee_patch(cleaned, "", {"ip": "10.0.0.9"}) == -1
    assert _apply_self_assignee_patch(cleaned, "   ", {"ip": "10.0.0.9"}) == -1


def test_name_and_employee_id_are_not_self_editable():
    """이름(업무 담당자 식별 키)과 사번(로그인 username)은 payload 로 못 바꾼다."""
    cleaned = _list({"name": "홍길동", "employeeId": "EMP001", "ip": "10.0.0.1"})
    _apply_self_assignee_patch(
        cleaned, "EMP001",
        {"name": "가짜이름", "employeeId": "EMP999", "employee_id": "EMP998", "ip": "10.0.0.5"},
    )
    assert cleaned[0]["name"] == "홍길동"
    assert cleaned[0]["employeeId"] == "EMP001"
    assert cleaned[0]["ip"] == "10.0.0.5"


def test_absent_fields_are_left_untouched():
    cleaned = _list({
        "name": "홍길동", "employeeId": "EMP001", "email": "a@b.c",
        "ip": "10.0.0.1", "seatLocation": "3층 A-12", "primaryRole": "Backend",
    })
    _apply_self_assignee_patch(cleaned, "EMP001", {"ip": "10.0.0.7"})
    assert cleaned[0]["email"] == "a@b.c"
    assert cleaned[0]["seatLocation"] == "3층 A-12"
    assert cleaned[0]["primaryRole"] == "Backend"


def test_explicit_empty_string_clears_field():
    cleaned = _list({"name": "홍길동", "employeeId": "EMP001", "ip": "10.0.0.1"})
    _apply_self_assignee_patch(cleaned, "EMP001", {"ip": ""})
    assert cleaned[0]["ip"] == ""


def test_values_are_trimmed():
    cleaned = _list({"name": "홍길동", "employeeId": "EMP001"})
    _apply_self_assignee_patch(cleaned, "EMP001", {"ip": "  10.0.0.3  ", "email": " a@b.c "})
    assert cleaned[0]["ip"] == "10.0.0.3"
    assert cleaned[0]["email"] == "a@b.c"


def test_accepts_snake_case_aliases():
    cleaned = _list({"name": "홍길동", "employeeId": "EMP001"})
    _apply_self_assignee_patch(
        cleaned, "EMP001",
        {"seat_location": "2층 B-3", "primary_role": "SRE", "secondary_role": "DevOps"},
    )
    assert cleaned[0]["seatLocation"] == "2층 B-3"
    assert cleaned[0]["primaryRole"] == "SRE"
    assert cleaned[0]["secondaryRole"] == "DevOps"


def test_username_matching_ignores_surrounding_whitespace():
    cleaned = _list({"name": "홍길동", "employeeId": " EMP001 "})
    assert _apply_self_assignee_patch(cleaned, "EMP001", {"ip": "10.0.0.4"}) == 0
    assert cleaned[0]["ip"] == "10.0.0.4"
