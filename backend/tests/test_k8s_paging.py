"""k8s_paging — resource_version 은 명시할 때만, 그것도 첫 페이지에만 전달된다.

RV="0" 은 apiserver 가 limit 을 무시하고 전량을 한 응답으로 돌려주므로 Pod 전수 순회(기본
경로)에는 절대 붙지 않아야 한다(OOM→502 재현 방지).
"""
from types import SimpleNamespace as NS

from app.services import k8s_paging as kp


class _Resp:
    def __init__(self, items, cont=None):
        self.items = items
        self.metadata = NS(_continue=cont)


def test_default_has_no_resource_version():
    calls = []

    def list_fn(**kw):
        calls.append(kw)
        return _Resp([1, 2])

    assert kp.list_all(list_fn) == [1, 2]
    assert "resource_version" not in calls[0]


def test_resource_version_only_on_first_page():
    calls = []

    def list_fn(**kw):
        calls.append(kw)
        return _Resp([1], cont=None if len(calls) == 2 else "tok")

    out = kp.list_all(list_fn, resource_version="0")
    assert out == [1, 1]
    assert calls[0].get("resource_version") == "0"
    assert "resource_version" not in calls[1] and calls[1].get("_continue") == "tok"
