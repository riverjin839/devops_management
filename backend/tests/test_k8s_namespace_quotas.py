"""Namespaces 목록의 Quota 사용/한도 열 — `GET /k8s/{id}/namespace-quotas` 집계."""
import json
import uuid
from types import SimpleNamespace

import pytest

from app.routers import k8s_resources as kr
from app.services.swr_cache import SWRCache


class _Resp:
    def __init__(self, body):
        self.data = json.dumps(body).encode()

    def release_conn(self):
        pass


def _rq(ns, name, hard, used=None, spec_only=False):
    body = {"metadata": {"name": name, "namespace": ns}, "spec": {"hard": hard}}
    if not spec_only:
        body["status"] = {"hard": hard, "used": used or {}}
    return body


@pytest.fixture
def env(monkeypatch):
    calls = []
    quotas = [
        _rq("team-a", "compute", {"requests.cpu": "4", "requests.memory": "8Gi", "pods": "20"},
            {"requests.cpu": "3500m", "requests.memory": "2Gi", "pods": "5"}),
        # 같은 NS 에 CPU 를 거는 두 번째 quota — 사용률이 더 높으므로 이것이 대표가 된다
        _rq("team-a", "burst", {"cpu": "1"}, {"cpu": "950m"}),
        _rq("team-b", "lim", {"limits.memory": "512Mi"}, {"limits.memory": "128Mi"}),
        _rq("team-c", "new", {"pods": "10"}, spec_only=True),
    ]

    class V1:
        def __init__(self, _c):
            pass

        def list_resource_quota_for_all_namespaces(self, **kw):
            calls.append(kw)
            start = int(kw.get("_continue") or 0)
            chunk = quotas[start:start + 2]
            nxt = start + 2
            meta = {"continue": str(nxt)} if nxt < len(quotas) else {}
            return _Resp({"metadata": meta, "items": chunk})

    monkeypatch.setattr(kr.k8s_client, "CoreV1Api", V1)
    monkeypatch.setattr(kr, "_list_cache", SWRCache(fresh=30, stale=60))
    monkeypatch.setattr(kr, "_require_cluster", lambda cid, db: SimpleNamespace(id=cid))
    monkeypatch.setattr(kr, "_api_client", lambda c: SimpleNamespace(configuration=SimpleNamespace(host="https://h")))
    monkeypatch.setattr(kr, "cache_group", lambda client, cid: "h")
    return calls


def test_parse_quantity():
    assert kr._parse_quantity("500m") == pytest.approx(0.5)
    assert kr._parse_quantity("2") == 2
    assert kr._parse_quantity("1Gi") == 2**30
    assert kr._parse_quantity("1G") == 1e9
    assert kr._parse_quantity("bad") is None


def test_aggregates_per_namespace(env):
    res = kr.list_namespace_quotas(uuid.uuid4(), db=None)
    assert [c.key for c in res.resources] == ["rcpu", "rmem", "lcpu", "lmem", "pods"]
    rows = {r.namespace: r for r in res.items}
    a = rows["team-a"]
    assert a.quota_count == 2
    # 4 코어 중 3.5(87.5%) 보다 1 코어 중 0.95(95%) 가 먼저 막힌다
    assert a.cells["rcpu"].quota == "burst"
    assert a.cells["rcpu"].ratio == pytest.approx(0.95)
    assert a.cells["rmem"].used == "2Gi" and a.cells["rmem"].hard == "8Gi"
    assert a.cells["pods"].used == "5" and a.cells["pods"].hard == "20"
    assert a.max_ratio == pytest.approx(0.95)
    assert rows["team-b"].cells["lmem"].used == "128Mi"
    assert rows["team-b"].cells["lmem"].ratio == pytest.approx(0.25)
    # status 가 아직 없으면 spec.hard 로 한도만, 사용은 0
    assert rows["team-c"].cells["pods"].used == "0" and rows["team-c"].cells["pods"].hard == "10"
    assert res.truncated is False
    assert len(env) == 2  # 페이지 2번


def test_cached_until_refresh(env):
    cid = uuid.uuid4()
    kr.list_namespace_quotas(cid, db=None)
    kr.list_namespace_quotas(cid, db=None)
    assert len(env) == 2
    kr.list_namespace_quotas(cid, refresh=True, db=None)
    assert len(env) == 4
