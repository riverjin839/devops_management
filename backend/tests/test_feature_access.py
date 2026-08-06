"""feature_access 정규화 테스트 — Settings "접근 제어"(화면별 노출 + 세부 역할 제한)가
저장하는 값의 방어적 정규화와 레거시 키 마이그레이션을 검증한다.
"""
from app.routers.ui_settings import _normalize_feature_access


def test_normalize_rejects_non_dict():
    assert _normalize_feature_access(None) == {}
    assert _normalize_feature_access("nope") == {}
    assert _normalize_feature_access([1, 2, 3]) == {}


def test_normalize_drops_non_dict_rules():
    out = _normalize_feature_access({"/wbs": "not-a-dict", "/ops-checks": {"roles": ["operator"]}})
    assert "/wbs" not in out
    assert out["/ops-checks"]["roles"] == ["operator"]


def test_normalize_coerces_roles_and_users_to_string_lists():
    out = _normalize_feature_access({"/ops-checks": {"roles": ["operator", 1], "users": None}})
    assert out["/ops-checks"] == {"roles": ["operator", "1"], "users": []}


def test_normalize_keeps_enabled_false_only():
    out = _normalize_feature_access({
        "/ops-checks": {"roles": [], "users": [], "enabled": False},
        "/bulk-exec": {"roles": [], "users": [], "enabled": True},
        "/etcdctl": {"roles": [], "users": []},
    })
    assert out["/ops-checks"] == {"roles": [], "users": [], "enabled": False}
    # enabled=True 나 미설정은 "기본 열림" 이므로 필드 자체를 저장하지 않는다(payload 최소화).
    assert "enabled" not in out["/bulk-exec"]
    assert "enabled" not in out["/etcdctl"]


def test_normalize_migrates_legacy_wbs_key_to_path():
    out = _normalize_feature_access({"wbs": {"roles": ["operator"], "users": []}})
    assert "wbs" not in out
    assert out["/wbs"] == {"roles": ["operator"], "users": []}


def test_normalize_does_not_overwrite_existing_path_key_with_legacy():
    """새 '/wbs' 설정이 이미 있으면 구 'wbs' 키로 덮어쓰지 않고, 레거시 키는 결과에서 사라진다."""
    out = _normalize_feature_access({
        "wbs": {"roles": ["viewer"], "users": []},
        "/wbs": {"roles": ["operator"], "users": []},
    })
    assert out["/wbs"] == {"roles": ["operator"], "users": []}
    assert "wbs" not in out
