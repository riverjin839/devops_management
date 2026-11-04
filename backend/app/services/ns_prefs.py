"""네임스페이스 선택 기억 — 계정·클러스터별 마지막 선택과 최근 선택 NS.

`user_settings` 의 ``ns_prefs`` 키에 JSON 으로 저장한다(새 테이블·마이그레이션 없음).
NS 가 천 개 단위인 클러스터에서 탭을 옮기거나 재로그인할 때마다 NS 를 다시 고르는 시간을 줄이는 용도다.
순수 함수만 두어 DB 없이 테스트한다.
"""
from datetime import datetime, timezone
from typing import Any, Optional

from app.schemas.ns_prefs import (
    DEFAULT_RECENT_LIMIT,
    MAX_NS_CLUSTERS,
    MAX_NS_SELECTED,
    MAX_RECENT_LIMIT,
    NsClusterPrefs,
    NsPrefsOut,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _str_list(value: Any, cap: int) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, str) and item and item not in out:
            out.append(item)
        if len(out) >= cap:
            break
    return out


def load(raw: Any) -> dict:
    """저장 값을 방어적으로 정규화한다 — 깨진 행이어도 빈 기본값으로 동작."""
    if not isinstance(raw, dict):
        return {"recent_limit": DEFAULT_RECENT_LIMIT, "clusters": []}
    limit = raw.get("recent_limit")
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_RECENT_LIMIT:
        limit = DEFAULT_RECENT_LIMIT
    clusters: list[dict] = []
    for c in raw.get("clusters") or []:
        if not isinstance(c, dict) or not isinstance(c.get("cluster_id"), str) or not c["cluster_id"]:
            continue
        clusters.append({
            "cluster_id": c["cluster_id"],
            "selected": _str_list(c.get("selected"), MAX_NS_SELECTED),
            "recent": _str_list(c.get("recent"), MAX_RECENT_LIMIT),
            "updated_at": c.get("updated_at") if isinstance(c.get("updated_at"), str) else "",
        })
    return {"recent_limit": limit, "clusters": clusters}


def apply_update(
    current: dict,
    cluster_id: str,
    selected: list[str],
    recent_limit: Optional[int] = None,
) -> dict:
    """마지막 선택을 교체하고, **새로 추가된** NS 만 최근 목록 맨 앞으로 올린다.

    이미 선택돼 있던 NS 는 순서를 바꾸지 않는다(토글할 때마다 최근 목록이 출렁이지 않게).
    """
    limit = recent_limit if recent_limit is not None else current["recent_limit"]
    clusters = [dict(c) for c in current["clusters"]]
    entry = next((c for c in clusters if c["cluster_id"] == cluster_id), None)
    if entry is None:
        entry = {"cluster_id": cluster_id, "selected": [], "recent": [], "updated_at": ""}
        clusters.append(entry)
    previous = set(entry["selected"])
    added = [n for n in selected if n not in previous]
    recent: list[str] = []
    for name in list(reversed(added)) + entry["recent"]:
        if name not in recent:
            recent.append(name)
    entry["selected"] = list(selected)
    entry["recent"] = recent[:limit]
    entry["updated_at"] = _now()
    if len(clusters) > MAX_NS_CLUSTERS:
        clusters.sort(key=lambda c: c["updated_at"], reverse=True)
        clusters = clusters[:MAX_NS_CLUSTERS]
    return {"recent_limit": limit, "clusters": clusters}


def to_out(state: dict) -> NsPrefsOut:
    limit = state["recent_limit"]
    return NsPrefsOut(
        recent_limit=limit,
        clusters=[
            NsClusterPrefs(cluster_id=c["cluster_id"], selected=c["selected"], recent=c["recent"][:limit])
            for c in state["clusters"]
        ],
    )
