"""맵 그룹 카탈로그 — 화면 라벨·순서와 사용률이 높을 때 검토할 cilium-config 키.

에이전트는 맵 이름을 그대로 보내고(숫자 꼬리는 그룹으로 묶음), 여기서 사람이 읽는 라벨과 설정 추천을 붙인다.
카탈로그에 없는 맵도 화면에 그대로 나온다(라벨 = ``cilium_`` 을 뗀 이름). 이름은 Cilium 버전에 따라
``_v2``·``_v3`` 꼬리가 붙어 바뀌므로 같은 맵의 옛 이름도 함께 적는다.
"""
from __future__ import annotations

from typing import Any, Optional

# (그룹 이름들, 라벨, cilium-config 키 또는 None, 메모)
_ENTRIES: list[tuple[tuple[str, ...], str, Optional[str], str]] = [
    (("cilium_ct4_global",), "CT TCP4", "bpf-ct-global-tcp-max",
     "가득 차면 새 TCP 연결을 기록하지 못해 드롭된다(CT map insertion failed)."),
    (("cilium_ct6_global",), "CT TCP6", "bpf-ct-global-tcp-max", ""),
    (("cilium_ct_any4_global",), "CT ANY4", "bpf-ct-global-any-max", "UDP·ICMP 등 비 TCP 연결 추적."),
    (("cilium_ct_any6_global",), "CT ANY6", "bpf-ct-global-any-max", ""),
    (("cilium_snat_v4_external",), "NAT4", "bpf-nat-global-max",
     "가득 차면 마스커레이드가 실패한다(No mapping for NAT masquerade)."),
    (("cilium_snat_v6_external",), "NAT6", "bpf-nat-global-max", ""),
    (("cilium_lb4_services_v2", "cilium_lb4_services"), "LB4 서비스", "bpf-lb-map-max", ""),
    (("cilium_lb4_backends_v3", "cilium_lb4_backends_v2", "cilium_lb4_backends"), "LB4 백엔드", "bpf-lb-map-max", ""),
    (("cilium_lb4_reverse_nat",), "LB4 역NAT", "bpf-lb-map-max", ""),
    (("cilium_lb6_services_v2", "cilium_lb6_services"), "LB6 서비스", "bpf-lb-map-max", ""),
    (("cilium_lb6_backends_v3", "cilium_lb6_backends_v2", "cilium_lb6_backends"), "LB6 백엔드", "bpf-lb-map-max", ""),
    (("cilium_ipcache_v2", "cilium_ipcache"), "ipcache", None,
     "크기가 고정이다 — 가득 차면 클러스터의 엔드포인트·외부 CIDR 수를 줄여야 한다."),
    (("cilium_policy_v2", "cilium_policy"), "정책(최대)", "bpf-policy-map-max",
     "엔드포인트마다 하나 — 가장 찬 엔드포인트의 맵을 보여준다."),
    (("cilium_nodeport_neigh4",), "이웃4", "bpf-neigh-global-max", ""),
    (("cilium_nodeport_neigh6",), "이웃6", "bpf-neigh-global-max", ""),
    (("cilium_lxc",), "엔드포인트", None, ""),
    (("cilium_tunnel_map",), "터널", None, ""),
    (("cilium_ratelimit",), "레이트리밋", None, ""),
]

_BY_GROUP: dict[str, tuple[int, str, Optional[str], str]] = {}
for _i, (_names, _label, _key, _note) in enumerate(_ENTRIES):
    for _n in _names:
        _BY_GROUP[_n] = (_i, _label, _key, _note)

# ct·nat·neigh·policy 크기는 bpf-map-dynamic-size-ratio 를 쓰면 그 비율로 정해진다.
DYNAMIC_RATIO_KEYS = {"bpf-ct-global-tcp-max", "bpf-ct-global-any-max", "bpf-nat-global-max",
                      "bpf-neigh-global-max", "bpf-policy-map-max"}


def describe(group: str) -> dict[str, Any]:
    """그룹 → {label, order, config_key, note, known}."""
    hit = _BY_GROUP.get(group)
    if hit:
        order, label, key, note = hit
        return {"label": label, "order": order, "config_key": key, "note": note, "known": True}
    label = group[len("cilium_"):] if group.startswith("cilium_") else group
    return {"label": label, "order": 1000, "config_key": None, "note": "", "known": False}


def recommendation(config_key: Optional[str], max_entries: int) -> Optional[str]:
    """사용률이 임계치를 넘은 맵의 설정 검토 문구."""
    if not config_key or max_entries <= 0:
        return None
    text = f"{config_key} {max_entries:,} → {max_entries * 2:,} 검토 (cilium-config)"
    if config_key in DYNAMIC_RATIO_KEYS:
        text += " · bpf-map-dynamic-size-ratio 를 쓰면 그 비율이 우선"
    return text
