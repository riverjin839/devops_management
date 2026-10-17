"""K8S 자원 관리 드릴다운 캐시(`routers/k8s_allocation._cached`) — 만료 값이 워커 메모리에 남지 않는다.

예전엔 만료 항목을 상한(_CACHE_MAX)에 닿을 때만 지워, 큰 NS 의 Pod 목록 같은 만료 값이 최대 상한 개수까지
계속 남았다(백엔드 메모리 압박). 이제 저장할 때마다 만료 항목을 지운다.
"""
import pytest

from app.routers import k8s_allocation as ka


@pytest.fixture
def clock(monkeypatch):
    t = {"now": 1000.0}
    monkeypatch.setattr(ka.time, "monotonic", lambda: t["now"])
    monkeypatch.setattr(ka, "_CACHE", {})
    return t


def test_expired_entries_are_dropped_on_next_store(clock):
    ka._cached("c1:nspods:a", lambda: ["big"] * 1000)
    ka._cached("c1:nspods:b", lambda: ["big"] * 1000)
    clock["now"] += ka._CACHE_TTL + 1
    ka._cached("c1:nspods:c", lambda: [1])
    assert set(ka._CACHE) == {"c1:nspods:c"}


def test_hit_within_ttl_and_cap(clock, monkeypatch):
    calls = []
    assert ka._cached("k", lambda: calls.append(1) or "v") == "v"
    assert ka._cached("k", lambda: calls.append(1) or "x") == "v"  # TTL 내 재사용
    assert len(calls) == 1

    monkeypatch.setattr(ka, "_CACHE_MAX", 3)
    for i in range(5):
        clock["now"] += 0.1
        ka._cached(f"n{i}", lambda i=i: i)
    assert len(ka._CACHE) == 3 and "n4" in ka._CACHE and "k" not in ka._CACHE  # 가장 오래된 것부터 퇴출
