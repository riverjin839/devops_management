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


# ── 서버 측 강제 (app.auth.feature_access) ────────────────────────────────────
# 프론트 canAccessFeature 와 같은 판정을 백엔드가 화면 전용 API 에 적용하는지 검증한다.
from types import SimpleNamespace

from app.auth.feature_access import (
    FEATURE_API_PATTERNS,
    can_access_feature,
    feature_for_path,
)


def _user(role="viewer", username="kim", display_name="김철수"):
    return SimpleNamespace(role=role, username=username, display_name=display_name)


def test_can_access_no_rule_is_open():
    assert can_access_feature({}, "/mindmap", _user())


def test_can_access_admin_bypasses_everything():
    access = {"/mindmap": {"roles": [], "users": [], "enabled": False}}
    assert can_access_feature(access, "/mindmap", _user(role="admin"))


def test_can_access_disabled_blocks_non_admin():
    access = {"/mindmap": {"roles": ["viewer"], "users": ["kim"], "enabled": False}}
    assert not can_access_feature(access, "/mindmap", _user())


def test_can_access_empty_lists_is_open():
    assert can_access_feature({"/mindmap": {"roles": [], "users": []}}, "/mindmap", _user())


def test_can_access_by_role_or_user():
    access = {"/mindmap": {"roles": ["operator"], "users": ["김철수"]}}
    assert can_access_feature(access, "/mindmap", _user(role="operator", display_name=None))
    assert can_access_feature(access, "/mindmap", _user())  # display_name 매칭
    assert not can_access_feature(access, "/mindmap", _user(username="lee", display_name="이영희"))


def test_legacy_user_role_is_viewer():
    access = {"/mindmap": {"roles": ["viewer"], "users": []}}
    assert can_access_feature(access, "/mindmap", _user(role="user"))


def test_feature_for_path_matches_dedicated_apis():
    assert feature_for_path("/api/v1/mindmaps") == "/mindmap"
    assert feature_for_path("/api/v1/mindmaps/abc/nodes") == "/mindmap"
    assert feature_for_path("/api/v1/clusters/abc/rbac/roles") == "/k8s-rbac"
    assert feature_for_path("/api/v1/clusters/abc/etcdctl/run") == "/etcdctl"
    assert feature_for_path("/api/v1/k8s/abc/allocation/overview") == "/k8s-allocation"
    assert feature_for_path("/api/v1/agent/chat/stream") == "/agent-chat"


def test_feature_for_path_skips_shared_apis():
    # 여러 화면이 공유하는 API 는 막지 않는다 — 한 화면 제한이 다른 화면을 깨뜨리면 안 된다.
    assert feature_for_path("/api/v1/clusters") is None
    assert feature_for_path("/api/v1/clusters/abc/etcdctl/master-candidates") is None
    assert feature_for_path("/api/v1/agent/health") is None
    assert feature_for_path("/api/v1/lake-service-types") is None
    assert feature_for_path("/api/v1/mindmapsx") is None
    assert feature_for_path("/api/v1/ui-settings/feature-access") is None


def test_feature_keys_are_route_paths():
    assert all(k.startswith("/") for k in FEATURE_API_PATTERNS)
