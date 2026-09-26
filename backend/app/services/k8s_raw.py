"""K8s LIST 응답을 **모델 역직렬화 없이** 읽기 — 목록 화면의 CPU 병목 제거.

kubernetes Python 클라이언트는 응답 JSON 을 `V1Pod` 같은 모델 객체로 재귀 변환한다(필드마다
setter·타입 검사·datetime 파싱). 파드 1000개면 이것만으로 초 단위 CPU 를 쓰는데, 목록 화면은
그중 몇 필드만 읽는다. 여기서는 `_preload_content=False` 로 원본 바이트를 받아 `json.loads`
하고, 결과 dict 를 **typed 모델과 같은 속성 이름**(snake_case)으로 읽을 수 있게 감싼다 —
그래서 기존 요약/컬럼 함수(`o.status.ready_replicas`, `o.spec.external_i_ps`, `.isoformat()` 등)를
고치지 않고 그대로 재사용한다.

규칙(typed 모델과 동일하게 보이도록):
  - 속성 이름 → JSON 키는 kubernetes 모델들의 `attribute_map` 에서 역산한다
    (`cluster_ip`→`clusterIP`, `external_i_ps`→`externalIPs`, `_continue`→`continue`).
  - 없는 필드는 None. 객체 노드는 항상 truthy(빈 status 도 `if o.status:` 통과 — typed 와 동일).
  - openapi 타입이 datetime 인 필드는 datetime 으로 파싱해 돌려준다.
  - dict 형 필드(labels/annotations/capacity/data…)는 진짜 dict(`_Map`)로 돌려준다.
"""
from __future__ import annotations

import inspect
import json
from datetime import datetime
from typing import Any, Callable, Optional

from kubernetes.client import models as _models


def _build_maps() -> tuple[dict[str, str], frozenset[str], frozenset[str], frozenset[str]]:
    """attribute_map 역산 + 필드 성격 분류.

    반환: (속성→JSON키, datetime 속성, dict 전용 속성, dict/모델 겸용 속성)
    """
    amap: dict[str, str] = {}
    dt: set[str] = set()
    cats: dict[str, set[str]] = {}
    for _name, cls in inspect.getmembers(_models, inspect.isclass):
        am = getattr(cls, "attribute_map", None)
        ot = getattr(cls, "openapi_types", None) or {}
        if not am:
            continue
        for attr, key in am.items():
            amap.setdefault(attr, key)
            t = ot.get(attr, "")
            if t == "datetime":
                dt.add(attr)
            if t.startswith("dict(") or t == "object":
                cats.setdefault(attr, set()).add("map")
            else:
                cats.setdefault(attr, set()).add("other")
    dict_only = frozenset(a for a, c in cats.items() if c == {"map"})
    dict_mixed = frozenset(a for a, c in cats.items() if "map" in c and len(c) > 1)
    return amap, frozenset(dt), dict_only, dict_mixed


_ATTR_MAP, _DATETIME_ATTRS, _DICT_ONLY, _DICT_MIXED = _build_maps()
_SCALARS = (str, int, float, bool, type(None))


def _parse_dt(v: Any) -> Any:
    if not isinstance(v, str):
        return v
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return v


def _lookup(d: dict, name: str) -> Any:
    """typed 모델의 속성 이름으로 JSON dict 값을 찾는다(없으면 None)."""
    if name.startswith("__"):
        raise AttributeError(name)
    # snake 이름이 그대로 키인 경우(data/type/kind…)를 먼저, 없으면 attribute_map 의 JSON 키.
    # (`port`↔`Port` 처럼 모델마다 다른 드문 충돌도 이 순서로 해소된다.)
    if name in d:
        v = d[name]
    else:
        key = _ATTR_MAP.get(name)
        if key is None or key not in d:
            return None
        v = d[key]
    if name in _DATETIME_ATTRS:
        return _parse_dt(v)
    if isinstance(v, dict):
        # dict 형 필드(labels/annotations/capacity/data…)는 진짜 dict 로 — `.items()/.get()` 이
        # dict 의미로 동작해야 한다. 모델 필드는 K8sObj 로(`items`/`values` 같은 필드명이 dict
        # 메서드와 겹쳐도 필드로 읽히게). 겸용 이름(selector/capacity/limits…)은 값 모양으로 판단.
        if name in _DICT_ONLY or (name in _DICT_MIXED and all(isinstance(x, _SCALARS) for x in v.values())):
            return _Map(v)
        return K8sObj(v)
    if isinstance(v, list):
        return [K8sObj(x) if isinstance(x, dict) else x for x in v]
    return v


class _Map(dict):
    """dict 형 필드 값. dict 그대로지만, 모델로 오분류된 경우를 대비해 속성 접근도 허용한다
    (예: 비어 있는 LabelSelector `{}` 의 `.match_labels` → None — typed 와 동일)."""

    def __getattr__(self, name: str) -> Any:
        return _lookup(self, name)


class K8sObj:
    """JSON dict 를 typed 모델처럼 속성으로 읽게 하는 얇은 래퍼(읽기 전용).

    dict 메서드를 두지 않는다 — K8s 모델에는 `items`(모든 List)·`values`(셀렉터 요구조건) 같은
    필드가 있어, dict 메서드가 있으면 필드 대신 메서드가 잡힌다.
    """

    __slots__ = ("_d",)

    def __init__(self, d: dict) -> None:
        self._d = d

    def __getattr__(self, name: str) -> Any:
        return _lookup(self._d, name)

    def __bool__(self) -> bool:  # typed 모델 객체는 필드가 비어도 truthy
        return True

    def to_dict(self) -> dict:
        return self._d

    def __repr__(self) -> str:  # pragma: no cover — 디버깅용
        return f"K8sObj({self._d!r:.120})"


def raw_call(fn: Callable[..., Any], *args: Any, timeout: Optional[Any] = None, **kw: Any) -> K8sObj:
    """`fn(*args, **kw)` 를 `_preload_content=False` 로 호출해 K8sObj 로 돌려준다.

    `_preload_content=False` 경로에는 풀 클라이언트의 기본 타임아웃이 주입되지 않으므로
    (스트리밍과 구분 불가) 반드시 timeout 을 받아 `_request_timeout` 으로 넘긴다.
    비 2xx 응답은 기존과 똑같이 ApiException 으로 올라온다.
    """
    if timeout is None:
        from app.services.k8s_client_pool import DEFAULT_TIMEOUT
        timeout = DEFAULT_TIMEOUT
    resp = fn(*args, _preload_content=False, _request_timeout=timeout, **kw)
    try:
        data = json.loads(resp.data)
    finally:
        try:
            resp.release_conn()
        except Exception:  # noqa: BLE001
            pass
    return K8sObj(data if isinstance(data, dict) else {"items": data})
