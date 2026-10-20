"""운영레벨 `guarded`(보호 레벨) 필드 — 13차 정책 3·4.

핵심 계약:
1. 저장 데이터에 guarded 가 없으면(구버전) value 가 production·dr 일 때만 true.
2. 저장 데이터에 bool 이 있으면 그대로 쓴다(운영자가 Settings 에서 바꾼 값).
3. PUT 에서 guarded 를 생략하면 같은 기본 규칙으로 채워 저장하고, 명시하면 그대로 저장한다.
4. 응답의 guarded 는 항상 bool 이다.

DB 없이 `_get_or_create` 를 가짜로 바꿔 라우터 함수만 검증한다.
"""
from types import SimpleNamespace

import pytest

from app.routers import ui_settings as router_mod
from app.schemas.ui_settings import (
    OperationLevelItem,
    OperationLevelsUpdate,
    default_guarded,
)


class _FakeDb:
    def commit(self):
        pass

    def refresh(self, _obj):
        pass


@pytest.fixture
def stored(monkeypatch):
    """`_get_or_create` 가 돌려줄 AppSetting 대역 — value 를 테스트가 직접 채운다."""
    setting = SimpleNamespace(value=None)

    def _fake(_db, _key, default_value):
        if setting.value is None:
            setting.value = default_value
        return setting

    monkeypatch.setattr(router_mod, "_get_or_create", _fake)
    return setting


def test_default_guarded_rule():
    assert default_guarded("production") is True
    assert default_guarded("dr") is True
    assert default_guarded(" DR ") is True
    assert default_guarded("staging") is False
    assert default_guarded("prod") is False  # 정확한 value 만 — 나머지는 운영자가 UI 에서 켠다
    assert default_guarded("") is False


def test_defaults_mark_production_and_dr(stored):
    res = router_mod.get_operation_levels(db=_FakeDb())
    by_value = {lv.value: lv.guarded for lv in res.levels}
    assert by_value["production"] is True
    assert by_value["dr"] is True
    assert by_value["staging"] is False
    assert by_value["dev"] is False
    assert by_value["test"] is False


def test_legacy_items_without_guarded_are_derived_from_value(stored):
    stored.value = {"levels": [
        {"value": "production", "label": "운영", "color": "red"},
        {"value": "dr", "label": "DR", "color": "purple"},
        {"value": "qa", "label": "QA", "color": "slate"},
    ]}
    res = router_mod.get_operation_levels(db=_FakeDb())
    assert [(lv.value, lv.guarded) for lv in res.levels] == [
        ("production", True), ("dr", True), ("qa", False),
    ]


def test_stored_bool_wins_over_default(stored):
    stored.value = {"levels": [
        {"value": "production", "label": "운영", "color": "red", "guarded": False},
        {"value": "staging", "label": "스테이징", "color": "amber", "guarded": True},
        {"value": "dev", "label": "개발", "color": "blue", "guarded": "yes"},  # bool 아님 → 기본 규칙
    ]}
    res = router_mod.get_operation_levels(db=_FakeDb())
    assert [(lv.value, lv.guarded) for lv in res.levels] == [
        ("production", False), ("staging", True), ("dev", False),
    ]


def test_put_fills_missing_guarded_and_keeps_explicit(stored):
    payload = OperationLevelsUpdate(levels=[
        OperationLevelItem(value="production", label="운영"),            # 생략 → True
        OperationLevelItem(value="dr", label="DR", guarded=False),       # 명시 False 유지
        OperationLevelItem(value="staging", label="스테이징", guarded=True),
        OperationLevelItem(value="dev", label="개발"),                    # 생략 → False
    ])
    res = router_mod.update_operation_levels(payload=payload, db=_FakeDb(), _=None)
    expected = [("production", True), ("dr", False), ("staging", True), ("dev", False)]
    assert [(lv.value, lv.guarded) for lv in res.levels] == expected
    # 저장값에도 bool 로 남는다 — 다음 GET 이 같은 값을 돌려준다.
    assert [(x["value"], x["guarded"]) for x in stored.value["levels"]] == expected
    again = router_mod.get_operation_levels(db=_FakeDb())
    assert [(lv.value, lv.guarded) for lv in again.levels] == expected
