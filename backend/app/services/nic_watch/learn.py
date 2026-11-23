"""관측 값에서 기준 제안 — "관측 값으로 채우기"의 근거(읽기 전용).

클러스터마다 인터페이스 이름(bond0·bond1·ens192·eth0 …)과 본딩 구성이 다르므로, 이름이 아니라 **종류**로 모아 가장 많이 보고된
값(최빈값)을 제안한다. 본딩이 하나도 없으면 본딩 기준을 비워(검사 안 함) 경고가 생기지 않게 한다. 저장은 하지 않는다 —
운영자가 화면에서 확인하고 저장한다.
"""
from __future__ import annotations

from collections import Counter
from typing import Any, Optional

_KINDS = ("physical", "bond", "vlan", "tunnel", "bridge", "virtual")


def _mode(values: list[Any]) -> Optional[Any]:
    vals = [v for v in values if v not in (None, "")]
    return Counter(vals).most_common(1)[0][0] if vals else None


def observe(states: list[dict[str, Any]]) -> dict[str, Any]:
    """``states`` = 노드별 ``{node, interfaces}`` (``cluster_view`` 와 같은 모양)."""
    names: dict[str, set[str]] = {k: set() for k in _KINDS}
    bonds: list[dict[str, Any]] = []
    speeds: list[int] = []
    for st in states:
        for it in st.get("interfaces") or []:
            kind = it.get("kind") or "virtual"
            names.setdefault(kind, set()).add(str(it.get("name")))
            if kind == "bond" and isinstance(it.get("bond"), dict):
                bonds.append(it["bond"])
            if kind == "physical" and (it.get("speed") or 0) > 0 and (it.get("operstate") in (None, "up")):
                speeds.append(int(it["speed"]))
    suggest: dict[str, Any] = {}
    if bonds:
        for key, field in (("expected_bond_mode", "mode"), ("expected_hash_policy", "xmit_hash_policy"),
                           ("expected_lacp_rate", "lacp_rate")):
            v = _mode([b.get(field) for b in bonds])
            if v is not None:
                suggest[key] = v
    else:  # 본딩이 없는 클러스터 — 본딩 기준을 검사하지 않는다
        suggest.update({"expected_bond_mode": "", "expected_hash_policy": "", "expected_lacp_rate": ""})
    if speeds:
        suggest["min_speed_mbps"] = min(speeds)  # 섞여 있으면 가장 느린 값 — 그보다 낮아진 링크만 경고
    return {
        "node_count": len(states),
        "interfaces": {k: sorted(v) for k, v in names.items() if v},
        "bond_count": len(bonds),
        "speeds": sorted(set(speeds)),
        "suggest": suggest,
    }
