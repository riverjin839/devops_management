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


def test_raw_pages_follow_json_continue_and_release_connection():
    """raw=True: `_preload_content=False` 로 받은 원본 바이트를 JSON 으로 읽고, `metadata.continue`
    로 다음 페이지를 따라가며, 매 페이지 연결을 반납한다. on_page 는 요청 직전에 1부터 번호를 넘긴다."""
    import json as _json

    from app.services import k8s_paging as kp

    released: list[int] = []
    seen_kw: list[dict] = []

    class _Resp:
        def __init__(self, body, idx):
            self.data = body
            self._idx = idx

        def release_conn(self):
            released.append(self._idx)

    pages = [
        {"metadata": {"continue": "t1"}, "items": [{"metadata": {"name": "a", "namespace": "x"}}]},
        {"metadata": {}, "items": [{"metadata": {"name": "b", "namespace": "y"},
                                    "spec": {"nodeName": "n1"}}]},
    ]

    def list_fn(**kw):
        seen_kw.append(kw)
        i = 1 if kw.get("_continue") == "t1" else 0
        return _Resp(_json.dumps(pages[i]).encode(), i)

    order: list[int] = []
    items = list(kp.iter_all(list_fn, raw=True, on_page=order.append))
    assert [it.metadata.name for it in items] == ["a", "b"]
    assert items[1].spec.node_name == "n1" and items[0].spec is None   # typed 와 같은 속성 이름
    assert all(kw["_preload_content"] is False for kw in seen_kw)
    assert seen_kw[1]["_continue"] == "t1"
    assert released == [0, 1]
    assert order == [1, 2]
