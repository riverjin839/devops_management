"""NIC 상태 → 서비스 구성 ``nic`` 서비스의 노드 현재 값 스냅샷(``nic:{node}``).

에이전트 보고·SSH 수집이 ``NodeNicState`` 를 쓸 때마다 대상 인터페이스의 **설정 값만** 평탄화해
``cluster_config_snapshots`` 에 저장한다(해시가 같으면 저장 안 함). 저장되면 서비스 구성 변경 감지
(``service_config_changes``·변경 알람)와 드리프트 알람이 기존 경로(``watch.store_and_watch``·``sync_drift``)로 돈다.
카운터·링크 상태 같은 상태값은 넣지 않는다(판정은 ``analyze``).

평탄화 키(``catalog_seed`` 의 nic 항목과 같은 이름):
- ``ring.rx``·``ring.tx``·``channels.combined`` = ``현재/최대``(예 ``1024/8192``)
- ``offload.<커널 기능 이름>`` = ``on``/``off``
- ``bond.xmit_hash_policy``·``bond.lacp_rate``(802.3ad 만)·``bond.miimon``
인터페이스(또는 본딩)마다 값이 다르면 ``ens1f0=1024/8192 ens1f1=4096/8192`` 처럼 이름=값을 공백으로 잇는다.

대상 인터페이스(설정 ``target_mode``): ``bond_members``(기본 — 본딩과 그 하위 인터페이스, 본딩이 없으면 링크가 올라온
물리 인터페이스) | ``glob``(``target_glob`` 에 맞는 이름).

측정하지 않은 값은 대상 인터페이스가 같을 때만 이전 스냅샷 값을 유지한다 — 예: 채널 수를 보고하지 않는 구버전
에이전트(1.2.x)가 SSH 수집 값을 지우지 않게. 측정했는데 값이 없거나(드라이버 미지원) 대상이 바뀌었으면 지운다.
"""
from __future__ import annotations

import fnmatch
import logging
from datetime import datetime
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models import ClusterConfigSnapshot
from app.models.cluster import Cluster

logger = logging.getLogger(__name__)

COMPONENT_PREFIX = "nic:"
OFFLOAD_FEATURES = ("rx-lro", "rx-gro", "tx-tcp-segmentation", "rx-checksum", "tx-checksum-ip-generic",
                    "tx-udp_tnl-segmentation")
RING_KEYS = ("ring.rx", "ring.tx")
CHANNEL_KEYS = ("channels.combined",)
OFFLOAD_KEYS = tuple(f"offload.{f}" for f in OFFLOAD_FEATURES)
BOND_KEYS = ("bond.xmit_hash_policy", "bond.lacp_rate", "bond.miimon")


def select_targets(ifaces: list[dict[str, Any]], mode: str = "bond_members",
                   globs: Optional[list[str]] = None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(본딩들, 물리 대상 인터페이스들)."""
    by = {i.get("name"): i for i in ifaces if isinstance(i, dict) and i.get("name")}
    if mode == "glob":
        hit = [i for n, i in by.items() if any(fnmatch.fnmatchcase(str(n), g) for g in (globs or []))]
        return [i for i in hit if i.get("kind") == "bond"], [i for i in hit if i.get("kind") != "bond"]
    bonds = [i for i in by.values() if i.get("kind") == "bond"]
    members = [by[s] for b in bonds for s in ((b.get("bond") or {}).get("slaves") or []) if s in by]
    if bonds:
        return bonds, members
    return [], [i for i in by.values() if i.get("kind") == "physical" and i.get("operstate") == "up"]


def _cm(cur: Any, mx: Any) -> Optional[str]:
    try:
        c, m = int(cur), int(mx)
    except (TypeError, ValueError):
        return None
    return f"{c}/{m}" if m > 0 else None


def _join(per: dict[str, Optional[str]]) -> Optional[str]:
    vals = {n: v for n, v in per.items() if v is not None}
    if not vals:
        return None
    distinct = set(vals.values())
    if len(distinct) == 1:
        return next(iter(distinct))
    return " ".join(f"{n}={v}" for n, v in sorted(vals.items()))


def flatten(ifaces: list[dict[str, Any]], mode: str = "bond_members",
            globs: Optional[list[str]] = None) -> dict[str, Any]:
    """{targets, flat, measured} — ``measured`` 는 이번 입력이 실제로 측정한 키(값이 없어도)."""
    bonds, phys = select_targets(ifaces, mode, globs)
    per: dict[str, dict[str, Optional[str]]] = {}
    measured: set[str] = set()

    def put(key: str, name: str, value: Optional[str]) -> None:
        per.setdefault(key, {})[name] = value

    for it in phys:
        n = str(it["name"])
        if "ring" in it:
            measured.update(RING_KEYS)
            ring = it.get("ring") or {}
            put("ring.rx", n, _cm(ring.get("rx"), ring.get("rx_max")))
            put("ring.tx", n, _cm(ring.get("tx"), ring.get("tx_max")))
        if "channels" in it:
            measured.update(CHANNEL_KEYS)
            ch = it.get("channels") or {}
            put("channels.combined", n, _cm(ch.get("combined"), ch.get("combined_max")))
        if "features" in it:
            measured.update(OFFLOAD_KEYS)
            feats = it.get("features") or {}
            for f in OFFLOAD_FEATURES:
                st = feats.get(f)
                put(f"offload.{f}", n, (("on" if st.get("on") else "off") if isinstance(st, dict) else None))
    for b in bonds:
        n = str(b["name"])
        bd = b.get("bond") or {}
        if not bd:
            continue
        measured.update(BOND_KEYS)
        put("bond.xmit_hash_policy", n, bd.get("xmit_hash_policy") or None)
        put("bond.lacp_rate", n, (bd.get("lacp_rate") or None) if bd.get("mode") == "802.3ad" else None)
        put("bond.miimon", n, str(bd["miimon"]) if bd.get("miimon") is not None else None)
    flat = {k: v for k, v in ((k, _join(p)) for k, p in per.items()) if v is not None}
    return {"targets": sorted([str(b["name"]) for b in bonds] + [str(i["name"]) for i in phys]),
            "flat": flat, "measured": sorted(measured)}


def carry_over(prev_flat: dict[str, Any], new_flat: dict[str, Any], measured: list[str],
               prev_targets: Optional[list[str]] = None, new_targets: Optional[list[str]] = None) -> dict[str, Any]:
    """이번에 측정하지 않은 키는 이전 값을 유지한다 — **대상 인터페이스가 같을 때만**.
    대상이 바뀌면(설정 변경·본딩 구성 변경) 이전 대상의 값은 지금 값이 아니므로 버린다."""
    out = dict(new_flat)
    if prev_targets is not None and new_targets is not None and sorted(prev_targets) != sorted(new_targets):
        return out
    m = set(measured)
    for k, v in (prev_flat or {}).items():
        if k not in m and k not in out:
            out[k] = v
    return out


def store(db: Session, cluster: Cluster, node: str, ifaces: list[dict[str, Any]], source: str,
          now: Optional[datetime] = None) -> bool:
    """``nic:{node}`` 스냅샷 저장 + 변경 감지 + (저장됐으면) nic 드리프트 알람 동기화. 실패는 삼키고 False."""
    from app.services.nic_watch.settings import get_effective
    from app.services.service_config import watch as W

    now = now or datetime.utcnow()
    comp = f"{COMPONENT_PREFIX}{node}"
    try:
        cfg = get_effective(db, cluster.id)  # 공통 기준 + 이 클러스터 재정의
        snap = flatten(ifaces, cfg.get("target_mode") or "bond_members", cfg.get("target_glob") or [])
        last = (db.query(ClusterConfigSnapshot)
                .filter(ClusterConfigSnapshot.cluster_id == cluster.id, ClusterConfigSnapshot.component == comp)
                .order_by(ClusterConfigSnapshot.collected_at.desc()).first())
        prev_flat = ((last.data or {}).get("flat") or {}) if last else {}
        prev_targets = (last.data or {}).get("targets") if last else None
        flat = carry_over(prev_flat, snap["flat"], snap["measured"], prev_targets, snap["targets"])
        if not flat and not last:
            return False
        data = {"node": node, "source": source, "targets": snap["targets"], "flat": flat}
        stored = W.store_and_watch(db, cluster, comp, "nic", None, data, now, source)
        if stored:
            db.commit()
            W.sync_drift(db, cluster, ["nic"])
        return stored
    except Exception as exc:  # noqa: BLE001 — 스냅샷 실패가 NIC 보고·수집을 막지 않는다
        db.rollback()
        logger.warning("nic snapshot 저장 실패 %s/%s: %s", cluster.id, node, exc)
        return False
