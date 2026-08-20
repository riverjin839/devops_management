"""work_item_board_settings 정규화 테스트 — 업무 관리 게시판 공통(Settings) 값의
방어적 정규화(뷰 노출/기본 뷰/배지 노출)를 검증한다. `test_feature_access.py` 와 동일하게
순수 함수(`_normalize_board_settings`)만 직접 호출한다 — admin 권한 검사(`require_admin`)는
공용 의존성이라 여기서 재검증하지 않는다.
"""
from app.routers.ui_settings import _normalize_board_settings


def test_normalize_rejects_non_dict_and_returns_defaults():
    out = _normalize_board_settings(None)
    assert out["view_visibility"] == {"epic": True, "table": True, "calendar": False, "kanban": False}
    assert out["default_view"] == "epic"
    assert out["badge_visibility"] == {"total": False, "wip": False, "done": False, "overdue": False}


def test_normalize_keeps_valid_overrides():
    out = _normalize_board_settings({
        "view_visibility": {"epic": False, "table": True, "calendar": True, "kanban": False},
        "default_view": "calendar",
        "badge_visibility": {"total": True, "wip": True, "done": False, "overdue": True},
    })
    assert out["view_visibility"] == {"epic": False, "table": True, "calendar": True, "kanban": False}
    assert out["default_view"] == "calendar"
    assert out["badge_visibility"] == {"total": True, "wip": True, "done": False, "overdue": True}


def test_normalize_falls_back_to_defaults_when_all_views_hidden():
    out = _normalize_board_settings({
        "view_visibility": {"epic": False, "table": False, "calendar": False, "kanban": False},
    })
    assert out["view_visibility"] == {"epic": True, "table": True, "calendar": False, "kanban": False}
    assert out["default_view"] == "epic"


def test_normalize_falls_back_default_view_when_hidden_or_invalid():
    # default_view 가 숨겨진 뷰를 가리키면 우선순위(epic -> table -> kanban -> calendar)로 폴백.
    out = _normalize_board_settings({
        "view_visibility": {"epic": False, "table": False, "calendar": True, "kanban": True},
        "default_view": "table",
    })
    assert out["default_view"] == "kanban"

    # 존재하지 않는 값도 동일하게 폴백.
    out2 = _normalize_board_settings({"default_view": "not-a-view"})
    assert out2["default_view"] == "epic"


def test_normalize_coerces_badge_visibility_to_booleans_per_key():
    out = _normalize_board_settings({"badge_visibility": {"total": 1, "wip": 0, "unknown_key": True}})
    assert out["badge_visibility"] == {"total": True, "wip": False, "done": False, "overdue": False}


def test_normalize_ignores_unknown_view_keys():
    out = _normalize_board_settings({"view_visibility": {"epic": True, "bogus": True}})
    assert "bogus" not in out["view_visibility"]
    assert out["view_visibility"] == {"epic": True, "table": True, "calendar": False, "kanban": False}
