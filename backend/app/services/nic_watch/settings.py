"""NIC 상태 감시 설정 — AppSetting ``nic_watch.settings`` (UI-First, 모든 클러스터 공통).

인터페이스 이름·본딩 기대 값·임계치는 설치마다 다르므로 코드 상수가 아니라 화면(서비스 구성 ▸ NIC ▸ 설정)에서 고친다.
수집 대상(``enabled``·``include_*``·``exclude_names``)은 에이전트 보고 응답으로 전달돼 다음 주기부터 반영되고,
나머지 판정 기준은 조회할 때 적용되므로 저장 즉시 화면에 반영된다. 저장값이 손상돼 있어도 기본값으로 되돌린다(fail-safe).
"""
from __future__ import annotations

import re
from typing import Any

from sqlalchemy.orm import Session

SETTINGS_KEY = "nic_watch.settings"
# 클러스터별 재정의 — {cluster_id: {필드: 값}}. 적은 필드만 공통 기준을 덮고 나머지는 공통을 따른다.
OVERRIDES_KEY = "nic_watch.cluster_overrides"

KINDS = ("physical", "bond", "vlan", "tunnel", "bridge", "virtual")
BOND_MODES = ("", "balance-rr", "active-backup", "balance-xor", "broadcast", "802.3ad", "balance-tlb", "balance-alb")
HASH_POLICIES = ("", "layer2", "layer2+3", "layer3+4", "encap2+3", "encap3+4", "vlan+srcmac")
LACP_RATES = ("", "slow", "fast")

DEFAULTS: dict[str, Any] = {
    # ── 수집(에이전트에 전달) ──
    "enabled": True,
    "include_kinds": ["physical", "bond", "vlan", "tunnel"],
    "include_names": ["cilium_host", "cilium_vxlan", "cilium_geneve"],
    "exclude_names": ["lo", "lxc*", "veth*", "docker*", "cni*", "flannel*", "kube-ipvs*", "nodelocaldns", "tunl*"],
    # ── 서비스 구성 nic 서비스(설정 값 비교·버전) 대상 인터페이스 ──
    # bond_members: 본딩과 그 하위(본딩이 없으면 링크가 올라온 물리 인터페이스) | glob: target_glob 에 맞는 이름
    "target_mode": "bond_members",
    "target_glob": [],
    # ── 판정 기준(빈 값 = 검사 안 함) ──
    "expected_bond_mode": "802.3ad",
    "expected_hash_policy": "layer3+4",
    "expected_lacp_rate": "fast",
    "min_speed_mbps": 0,
    # 노드 간 값 비교(같은 인터페이스 이름) — MTU·속도·본딩 설정·offload
    "cross_node_check": True,
    # 증가율 계산 창(분)과 임계치
    "rate_window_minutes": 15,
    "drop_warn_per_min": 10,
    "crc_warn_count": 1,
    "flap_warn_count": 1,
    # offload 기대 값 — 커널 기능 이름: true/false. 포워딩하는 K8S 노드는 LRO 를 꺼야 한다.
    "offload_expect": {"rx-lro": False},
    # 마지막 보고 뒤 이 시간(분)이 지나면 '보고 끊김'
    "stale_minutes": 10,
}

_INT_LIMITS = {"min_speed_mbps": (0, 800000), "rate_window_minutes": (5, 60), "drop_warn_per_min": (0, 10_000_000),
               "crc_warn_count": (0, 1_000_000), "flap_warn_count": (0, 1000), "stale_minutes": (1, 1440)}
_GLOB_RE = re.compile(r"^[A-Za-z0-9_.:@*?\[\]-]{1,64}$")
_FEATURE_RE = re.compile(r"^[a-z0-9_-]{1,64}$")


def _globs(v: Any) -> list[str]:
    items = v if isinstance(v, list) else str(v or "").replace("\n", ",").split(",")
    out: list[str] = []
    for x in items:
        s = str(x).strip()
        if s and _GLOB_RE.match(s) and s not in out:
            out.append(s)
    return out[:50]


def normalize(stored: Any) -> dict[str, Any]:
    merged = {**DEFAULTS, **(stored if isinstance(stored, dict) else {})}
    out: dict[str, Any] = {}
    out["enabled"] = bool(merged.get("enabled"))
    out["cross_node_check"] = bool(merged.get("cross_node_check"))
    kinds = [k for k in (merged.get("include_kinds") or []) if k in KINDS] if isinstance(merged.get("include_kinds"), list) else []
    out["include_kinds"] = kinds
    out["include_names"] = _globs(merged.get("include_names"))
    out["exclude_names"] = _globs(merged.get("exclude_names"))
    out["target_mode"] = merged.get("target_mode") if merged.get("target_mode") in ("bond_members", "glob") else "bond_members"
    out["target_glob"] = _globs(merged.get("target_glob"))
    for key, allowed in (("expected_bond_mode", BOND_MODES), ("expected_hash_policy", HASH_POLICIES),
                         ("expected_lacp_rate", LACP_RATES)):
        v = str(merged.get(key) or "").strip()
        out[key] = v if v in allowed else DEFAULTS[key]
    for key, (lo, hi) in _INT_LIMITS.items():
        try:
            v = int(merged.get(key))
        except (TypeError, ValueError):
            v = DEFAULTS[key]
        out[key] = v if lo <= v <= hi else DEFAULTS[key]
    exp = merged.get("offload_expect")
    if isinstance(exp, list):  # 화면 형식 [{name, on}]
        exp = {str(x.get("name")): bool(x.get("on")) for x in exp if isinstance(x, dict) and x.get("name")}
    out["offload_expect"] = ({str(k): bool(v) for k, v in exp.items() if _FEATURE_RE.match(str(k))}
                             if isinstance(exp, dict) else dict(DEFAULTS["offload_expect"]))
    return out


def merge_effective(global_cfg: dict[str, Any], override: Any) -> dict[str, Any]:
    """공통 기준 위에 클러스터 재정의를 얹은 실효 기준(순수 함수). 모르는 키는 버리고 값은 항목별로 다시 검증한다."""
    ov = {k: v for k, v in (override if isinstance(override, dict) else {}).items() if k in DEFAULTS}
    return normalize({**global_cfg, **ov})


def validate_override(global_cfg: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """패치한 필드만 검증된 값으로 돌려준다 — 범위를 벗어난 숫자·모르는 선택지는 공통 값으로 정리된다."""
    patch = {k: v for k, v in patch.items() if k in DEFAULTS and v is not None}
    merged = normalize({**global_cfg, **patch})
    return {k: merged[k] for k in patch}


def agent_config(cfg: dict[str, Any]) -> dict[str, Any]:
    """에이전트 보고 응답의 ``nic`` — 수집 대상만."""
    return {k: cfg[k] for k in ("enabled", "include_kinds", "include_names", "exclude_names")}


def get_settings(db: Session) -> dict[str, Any]:
    from app.models.app_setting import AppSetting

    try:
        row = db.query(AppSetting).filter(AppSetting.key == SETTINGS_KEY).first()
    except Exception:  # noqa: BLE001
        db.rollback()
        return normalize(None)
    return normalize(row.value if row else None)


def set_settings(db: Session, patch: dict[str, Any]) -> dict[str, Any]:
    from app.models.app_setting import AppSetting

    row = db.query(AppSetting).filter(AppSetting.key == SETTINGS_KEY).first()
    prev = row.value if row and isinstance(row.value, dict) else {}
    merged = normalize({**prev, **{k: v for k, v in patch.items() if v is not None}})
    if row:
        row.value = merged
    else:
        db.add(AppSetting(key=SETTINGS_KEY, value=merged))
    db.commit()
    return get_settings(db)


# ── 클러스터별 재정의 ────────────────────────────────────────────────────────

def _load_overrides(db: Session) -> dict[str, dict[str, Any]]:
    from app.models.app_setting import AppSetting

    try:
        row = db.query(AppSetting).filter(AppSetting.key == OVERRIDES_KEY).first()
    except Exception:  # noqa: BLE001 — 저장값을 못 읽어도 공통 기준으로 동작한다(fail-safe)
        db.rollback()
        return {}
    value = row.value if row else None
    return {str(k): dict(v) for k, v in value.items() if isinstance(v, dict)} if isinstance(value, dict) else {}


def _save_overrides(db: Session, data: dict[str, dict[str, Any]]) -> None:
    from app.models.app_setting import AppSetting

    row = db.query(AppSetting).filter(AppSetting.key == OVERRIDES_KEY).first()
    clean = {k: v for k, v in data.items() if v}  # 빈 재정의는 지운다
    if row:
        row.value = clean
    else:
        db.add(AppSetting(key=OVERRIDES_KEY, value=clean))
    db.commit()


def get_effective(db: Session, cluster_id: Any) -> dict[str, Any]:
    """이 클러스터에 실제로 적용되는 기준 — 공통 기준 + 재정의."""
    return merge_effective(get_settings(db), _load_overrides(db).get(str(cluster_id)))


def get_cluster_settings(db: Session, cluster_id: Any) -> dict[str, Any]:
    """{effective, global, overridden} — 화면이 항목마다 '공통 값'과 '재정의' 여부를 보여주는 데 쓴다."""
    g = get_settings(db)
    ov = {k: v for k, v in (_load_overrides(db).get(str(cluster_id)) or {}).items() if k in DEFAULTS}
    return {"effective": merge_effective(g, ov), "global": g, "overridden": sorted(ov)}


def set_cluster_override(db: Session, cluster_id: Any, patch: dict[str, Any], reset: Any = ()) -> dict[str, Any]:
    """패치한 필드를 이 클러스터의 재정의로 저장하고, ``reset`` 의 필드는 재정의에서 빼서 공통을 따르게 한다."""
    data = _load_overrides(db)
    cur = dict(data.get(str(cluster_id)) or {})
    cur.update(validate_override(get_settings(db), patch))
    for k in reset or ():
        cur.pop(k, None)
    data[str(cluster_id)] = cur
    _save_overrides(db, data)
    return get_cluster_settings(db, cluster_id)


def clear_cluster_override(db: Session, cluster_id: Any) -> dict[str, Any]:
    data = _load_overrides(db)
    data.pop(str(cluster_id), None)
    _save_overrides(db, data)
    return get_cluster_settings(db, cluster_id)


def override_summary(db: Session) -> dict[str, list[str]]:
    """{cluster_id: [재정의한 필드]} — 공통 기준 화면의 '재정의한 클러스터'."""
    return {cid: sorted(k for k in ov if k in DEFAULTS) for cid, ov in _load_overrides(db).items() if ov}
