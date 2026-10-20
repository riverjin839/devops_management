"""클러스터 아이템 Pod 집계 — 전체 Pod 를 한 번에 받지 않고 페이지(continue)로 세며, 절단은 partial 로 남긴다."""
from types import SimpleNamespace as NS

from app.services import cluster_item_service as svc


def _pod(phase):
    return NS(status=NS(phase=phase))


class _Core:
    def __init__(self, pages, fail_on_second=False):
        self.pages = pages
        self.fail = fail_on_second
        self.pod_calls = []

    def list_namespace(self, **kw):
        return NS(items=[NS(), NS()], metadata=NS(_continue=None))

    def list_pod_for_all_namespaces(self, **kw):
        self.pod_calls.append(kw)
        assert "limit" in kw  # 페이지 단위 조회
        i = len(self.pod_calls) - 1
        if self.fail and i == 1:
            raise TimeoutError("read timed out")
        items, cont = self.pages[i]
        return NS(items=items, metadata=NS(_continue=cont))


def _run(monkeypatch, core):
    monkeypatch.setattr(svc, "_k8s", lambda cluster: (core, None))
    return svc._collect_workload_count(NS(cluster=None), db=None)


def test_counts_across_pages(monkeypatch):
    core = _Core([([_pod("Running"), _pod("Pending")], "c1"), ([_pod("Running"), _pod("Failed")], None)])
    r = _run(monkeypatch, core)
    assert r.value == 4.0 and r.status == "warning"
    assert r.detail == {"pods": 4, "namespaces": 2, "running": 2, "pending": 1, "failed": 1}
    assert len(core.pod_calls) == 2


def test_truncated_listing_is_marked_partial(monkeypatch):
    core = _Core([([_pod("Running")], "c1")], fail_on_second=True)
    r = _run(monkeypatch, core)
    assert r.detail["pods"] == 1 and r.detail["partial"] is True and r.status == "warning"
