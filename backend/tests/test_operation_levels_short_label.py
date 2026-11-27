"""운영레벨 `short_label`(약칭) — 클러스터 패널 그룹 머리글에 쓰는 좁은 자리 이름.

핵심 계약:
1. 기본 레벨 순서는 운영 → 개발 → 스테이징이고 약칭은 PROD · DEV · STAGE.
2. 저장 데이터에 약칭이 없으면(구버전) 기본 레벨 value 는 기본 약칭, 그 외는 None(→ 화면이 label 을 쓴다).
3. PUT 은 약칭을 다듬어 저장하고, 빈 값은 None 으로 저장한다.
"""
from types import SimpleNamespace

import pytest

from app.routers import ui_settings as router_mod
from app.schemas.ui_settings import OperationLevelItem, OperationLevelsUpdate


class _FakeDb:
    def commit(self):
        pass

    def refresh(self, _obj):
        pass


@pytest.fixture
def stored(monkeypatch):
    setting = SimpleNamespace(value=None)

    def _fake(_db, _key, default_value):
        if setting.value is None:
            setting.value = default_value
        return setting

    monkeypatch.setattr(router_mod, "_get_or_create", _fake)
    return setting


def test_defaults_order_and_short_labels(stored):
    res = router_mod.get_operation_levels(db=_FakeDb())
    assert [(lv.value, lv.short_label) for lv in res.levels][:3] == [
        ("production", "PROD"), ("dev", "DEV"), ("staging", "STAGE"),
    ]


def test_legacy_items_get_default_short_label_by_value(stored):
    stored.value = {"levels": [
        {"value": "production", "label": "운영", "color": "red"},
        {"value": "qa", "label": "QA", "color": "slate"},
        {"value": "staging", "label": "스테이징", "color": "amber", "short_label": "  STG "},
    ]}
    res = router_mod.get_operation_levels(db=_FakeDb())
    assert [(lv.value, lv.short_label) for lv in res.levels] == [
        ("production", "PROD"), ("qa", None), ("staging", "STG"),
    ]


def test_put_trims_and_blanks_short_label(stored):
    payload = OperationLevelsUpdate(levels=[
        OperationLevelItem(value="production", label="운영", short_label=" PRD "),
        OperationLevelItem(value="qa", label="QA", short_label="   "),
    ])
    res = router_mod.update_operation_levels(payload=payload, db=_FakeDb(), _=None)
    assert [(lv.value, lv.short_label) for lv in res.levels] == [("production", "PRD"), ("qa", None)]
    assert [x["short_label"] for x in stored.value["levels"]] == ["PRD", None]
