"""NS 선택 기억(ns_prefs) 서비스 테스트 — DB 없이 순수 함수만 검증한다.

핵심 계약:
1. 새로 추가된 NS 만 최근 목록 맨 앞으로 올라가고, 이미 선택돼 있던 NS 는 순서가 바뀌지 않는다.
2. 최근 목록은 recent_limit(기본 3) 로 잘린다.
3. 클러스터별로 격리된다.
4. 깨진 저장 값은 빈 기본값으로 복구된다.
"""
from app.schemas.ns_prefs import NsPrefsUpdate
from app.services import ns_prefs as svc


def _empty():
    return svc.load(None)


def _entry(state, cid):
    return next(c for c in state["clusters"] if c["cluster_id"] == cid)


def test_empty_default():
    assert _empty() == {"recent_limit": 3, "clusters": []}
    assert svc.to_out(_empty()).clusters == []


def test_selection_is_saved_and_recent_gets_newest_first():
    s = svc.apply_update(_empty(), "c1", ["a"])
    s = svc.apply_update(s, "c1", ["b"])
    e = _entry(s, "c1")
    assert e["selected"] == ["b"]
    assert e["recent"] == ["b", "a"]


def test_recent_is_capped_at_limit():
    s = _empty()
    for ns in ["a", "b", "c", "d"]:
        s = svc.apply_update(s, "c1", [ns])
    assert _entry(s, "c1")["recent"] == ["d", "c", "b"]


def test_already_selected_namespace_does_not_reorder_recent():
    s = svc.apply_update(_empty(), "c1", ["a"])
    s = svc.apply_update(s, "c1", ["b"])
    # a 를 다시 추가 선택 → 새로 추가된 a 만 맨 앞으로
    s = svc.apply_update(s, "c1", ["b", "a"])
    assert _entry(s, "c1")["recent"] == ["a", "b"]
    # b 만 해제해도 최근 순서는 그대로
    s = svc.apply_update(s, "c1", ["a"])
    assert _entry(s, "c1")["recent"] == ["a", "b"]


def test_clearing_selection_keeps_recent():
    s = svc.apply_update(_empty(), "c1", ["a"])
    s = svc.apply_update(s, "c1", [])
    e = _entry(s, "c1")
    assert e["selected"] == []
    assert e["recent"] == ["a"]


def test_clusters_are_isolated():
    s = svc.apply_update(_empty(), "c1", ["a"])
    s = svc.apply_update(s, "c2", ["x"])
    assert _entry(s, "c1")["selected"] == ["a"]
    assert _entry(s, "c2")["recent"] == ["x"]


def test_recent_limit_can_change_and_trims_output():
    s = _empty()
    for ns in ["a", "b", "c"]:
        s = svc.apply_update(s, "c1", [ns])
    s = svc.apply_update(s, "c1", ["c"], recent_limit=2)
    assert svc.to_out(s).clusters[0].recent == ["c", "b"]


def test_corrupt_value_recovers_to_defaults():
    assert svc.load("garbage") == {"recent_limit": 3, "clusters": []}
    state = svc.load({"recent_limit": 99, "clusters": [{"cluster_id": 1}, {"cluster_id": "c1", "selected": "x"}]})
    assert state["recent_limit"] == 3
    assert state["clusters"] == [{"cluster_id": "c1", "selected": [], "recent": [], "updated_at": ""}]


def test_cluster_count_is_bounded_dropping_least_recently_used():
    s = _empty()
    for i in range(205):
        s = svc.apply_update(s, f"c{i}", ["a"])
    assert len(s["clusters"]) == 200
    ids = {c["cluster_id"] for c in s["clusters"]}
    assert "c204" in ids


def test_update_payload_dedupes_and_strips_names():
    p = NsPrefsUpdate(cluster_id="c1", selected=[" a ", "a", "", "b"])
    assert p.selected == ["a", "b"]
