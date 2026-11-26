"""Cilium 데이터패스 설정 — AppSetting ``cilium_datapath.settings`` (UI-First).

임계치·보고 주기·맵 순회 시간 예산·고정 경로·에이전트 권한은 설치 환경마다 다르므로 코드 상수가 아니라
화면에서 고치는 값으로 둔다. 수집 관련 값은 에이전트 보고 응답(``agent_config``)으로 내려가 다음 주기부터
반영된다. 저장값이 손상돼 있어도 기본값으로 되돌려 조회·수신이 죽지 않게 한다(fail-safe).
"""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

SETTINGS_KEY = "cilium_datapath.settings"

DEFAULTS: dict[str, Any] = {
    # 에이전트 보고 주기(초).
    "interval_sec": 300,
    # 맵 하나를 세는 데 쓰는 최대 시간(ms) — 넘기면 그때까지 센 값을 하한으로 보고한다.
    "map_budget_ms": 2000,
    # 한 번의 수집 전체 시간 예산(ms) — 넘기면 남은 맵은 세지 않는다.
    "total_budget_ms": 20000,
    # 사용률 판정 임계치(%).
    "warn_pct": 70,
    "crit_pct": 90,
    # 사용률 알람(알람 인박스 CiliumBpfMapPressure) 켜기.
    "alerts_enabled": True,
    # Cilium 이 맵을 고정하는 경로(호스트 기준) — 에이전트는 /sys/fs/bpf 를 읽기 전용으로 마운트한다.
    "pin_dirs": ["/sys/fs/bpf/tc/globals"],
    # 수집할 맵 이름 접두어.
    "map_prefixes": ["cilium_"],
    # 프로그램 목록에 넣을 이름 접두어.
    "program_prefixes": ["cil_", "tail_"],
    # CAP_SYS_ADMIN 부여 — 프로그램 목록·고정되지 않은 맵 조회, 5.8 미만 커널(CAP_BPF 없음)에서 필요.
    # 매니페스트에 capability 가 추가되므로 기본은 끈다(최소 권한).
    "sys_admin": False,
    # 「지금 수집」 이 노드 보고를 기다리는 최대 시간(초).
    "run_timeout_sec": 90,
    # 마지막 보고 뒤 이 시간(분)이 지나면 화면에 '무응답' 으로 표시.
    "offline_minutes": 20,
    # 설치 매니페스트 기본값 — 폐쇄망이면 사내 레지스트리 경로로 바꾼다.
    "agent_image": "ghcr.io/riverjin839/devops_management/bpf-agent:latest",
    "agent_namespace": "k8s-monitor-agent",
    # 에이전트가 접속할 PEP API 주소(…/api/v1). 비우면 화면을 연 주소로 채운다.
    "ingest_base_url": "",
    "tls_verify": True,
}

_INT_LIMITS = {
    "interval_sec": (30, 3600),
    "map_budget_ms": (50, 30000),
    "total_budget_ms": (500, 120000),
    "warn_pct": (1, 100),
    "crit_pct": (1, 100),
    "run_timeout_sec": (15, 600),
    "offline_minutes": (1, 1440),
}
_LIST_KEYS = ("pin_dirs", "map_prefixes", "program_prefixes")
_BOOL_KEYS = ("alerts_enabled", "sys_admin", "tls_verify")


def _clean_list(raw: Any, default: list[str], *, abs_path: bool = False) -> list[str]:
    if isinstance(raw, str):
        raw = [x for x in raw.replace("\n", ",").split(",")]
    if not isinstance(raw, list):
        return list(default)
    out: list[str] = []
    for item in raw:
        s = str(item or "").strip()
        if not s or len(s) > 200 or s in out:
            continue
        if abs_path and (not s.startswith("/") or ".." in s.split("/")):
            continue
        out.append(s)
    return out[:20] or list(default)


def normalize(stored: Any) -> dict[str, Any]:
    merged = {**DEFAULTS, **(stored if isinstance(stored, dict) else {})}
    for key, (lo, hi) in _INT_LIMITS.items():
        try:
            val = int(merged.get(key))
        except (TypeError, ValueError):
            val = DEFAULTS[key]
        merged[key] = val if lo <= val <= hi else DEFAULTS[key]
    if merged["warn_pct"] >= merged["crit_pct"]:
        merged["warn_pct"], merged["crit_pct"] = DEFAULTS["warn_pct"], DEFAULTS["crit_pct"]
    if merged["map_budget_ms"] > merged["total_budget_ms"]:
        merged["map_budget_ms"] = merged["total_budget_ms"]
    for key in _LIST_KEYS:
        merged[key] = _clean_list(merged.get(key), DEFAULTS[key], abs_path=key == "pin_dirs")
    for key in _BOOL_KEYS:
        merged[key] = bool(merged.get(key))
    for key in ("agent_image", "agent_namespace", "ingest_base_url"):
        merged[key] = str(merged.get(key) or "").strip()
    merged["agent_image"] = merged["agent_image"] or DEFAULTS["agent_image"]
    merged["agent_namespace"] = merged["agent_namespace"] or DEFAULTS["agent_namespace"]
    merged["ingest_base_url"] = merged["ingest_base_url"].rstrip("/")
    return {k: merged[k] for k in DEFAULTS}


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


def agent_config(cfg: dict[str, Any]) -> dict[str, Any]:
    """보고 응답에 실어 에이전트로 내려보내는 수집 설정(에이전트 ``CollectCfg`` 와 같은 키)."""
    return {
        "interval_sec": cfg["interval_sec"],
        "map_budget_ms": cfg["map_budget_ms"],
        "total_budget_ms": cfg["total_budget_ms"],
        "pin_dirs": cfg["pin_dirs"],
        "map_prefixes": cfg["map_prefixes"],
        "scan_all_ids": cfg["sys_admin"],
        "program_inventory": cfg["sys_admin"],
        "program_prefixes": cfg["program_prefixes"],
    }
