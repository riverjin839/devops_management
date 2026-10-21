"""네임스페이스 담당자 — 공개 화면(일일 리포트·외부 서비스)에 NS 별 담당 팀/사람·연락처를 붙인다.

결정 순서(UI-First, 코드에 매핑을 박지 않는다):
1. 규칙(AppSetting `ns_owners.settings.rules`) — `pattern`(glob, 예: `pay-*`) · `cluster_id`(선택) ·
   `owner` · `contact`. 위에서부터 첫 일치.
2. 클러스터 NS 라벨/어노테이션 — `label_keys`(기본 `owner`, `team`) 중 값이 있는 첫 키. NS 목록은
   일일 롤업·외부 서비스 수집·"라벨 다시 읽기" 때 K8s 에서 읽어 `ns_owners.label_cache` 에 둔다
   (공개 화면은 캐시만 읽는다 — 비인증 요청이 K8s 를 조회하지 않게).
K8s 조회 실패는 fail-safe — 이전 캐시를 그대로 두고 사유만 남긴다.
"""
from __future__ import annotations

import fnmatch
import logging
from datetime import datetime
from typing import Any, Callable, Optional

from sqlalchemy.orm import Session

log = logging.getLogger(__name__)

SETTINGS_KEY = "ns_owners.settings"
CACHE_KEY = "ns_owners.label_cache"

DEFAULTS: dict[str, Any] = {
    "rules": [],                     # [{pattern, cluster_id?, owner, contact?}]
    "label_keys": ["owner", "team"],
    "show_contact": True,            # 공개 화면에 연락처를 보일지
}


def _get(db: Session, key: str) -> dict:
    from app.models.app_setting import AppSetting
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    return row.value if row and isinstance(row.value, dict) else {}


def _put(db: Session, key: str, value: dict) -> None:
    from app.models.app_setting import AppSetting
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=key, value=value))
    db.commit()


def normalize(values: dict[str, Any]) -> dict[str, Any]:
    out = dict(DEFAULTS)
    out.update({k: v for k, v in (values or {}).items() if k in DEFAULTS and v is not None})
    rules = []
    for r in out["rules"] if isinstance(out["rules"], list) else []:
        if not isinstance(r, dict):
            continue
        pattern = str(r.get("pattern") or "").strip()
        owner = str(r.get("owner") or "").strip()
        if not pattern or not owner:
            continue
        rules.append({"pattern": pattern[:253], "owner": owner[:120],
                      "contact": str(r.get("contact") or "").strip()[:200] or None,
                      "cluster_id": str(r.get("cluster_id") or "").strip() or None})
    out["rules"] = rules[:500]
    keys = out["label_keys"] if isinstance(out["label_keys"], list) else []
    out["label_keys"] = [str(k).strip() for k in keys if str(k).strip()][:10]
    out["show_contact"] = bool(out["show_contact"])
    return out


def get_settings(db: Session) -> dict[str, Any]:
    return normalize(_get(db, SETTINGS_KEY))


def set_settings(db: Session, values: dict[str, Any]) -> dict[str, Any]:
    merged = normalize({**get_settings(db), **{k: v for k, v in (values or {}).items() if k in DEFAULTS}})
    _put(db, SETTINGS_KEY, merged)
    return merged


def label_cache(db: Session) -> dict[str, Any]:
    return _get(db, CACHE_KEY)


def refresh_labels(db: Session, cluster, emit: Optional[Callable[[str, str], None]] = None) -> dict[str, Any]:
    """클러스터 NS 라벨·어노테이션에서 담당자 값을 읽어 캐시에 넣는다(fail-safe)."""
    emit = emit or (lambda lvl, msg: log.info("[ns-owners %s] %s", lvl, msg))
    keys = get_settings(db)["label_keys"]
    if not keys:
        emit("info", f"{cluster.name}: 담당자 라벨 키가 비어 있어 건너뜀")
        return {"ok": True, "found": 0, "skipped": True}
    try:
        from kubernetes import client as k8s_client
        from app.services.k8s_client_pool import get_api_client
        items = k8s_client.CoreV1Api(get_api_client(cluster)).list_namespace(_request_timeout=20).items
    except Exception as e:  # noqa: BLE001
        msg = f"{cluster.name}: 네임스페이스 조회 실패 — {str(e)[:200]}"
        emit("warn", msg)
        return {"ok": False, "error": msg}
    found: dict[str, dict[str, str]] = {}
    for ns in items:
        md = ns.metadata
        labels, ann = md.labels or {}, md.annotations or {}
        for k in keys:
            v = labels.get(k) or ann.get(k)
            if v:
                found[md.name] = {"owner": str(v)[:120], "key": k}
                break
    cache = label_cache(db)
    cache[str(cluster.id)] = {"updated_at": datetime.utcnow().isoformat(), "ns": found}
    _put(db, CACHE_KEY, cache)
    emit("info", f"{cluster.name}: NS {len(items)}개 중 담당자 라벨 {len(found)}개 ({', '.join(keys)})")
    return {"ok": True, "found": len(found), "namespaces": len(items)}


def resolver(db: Session, cluster_id) -> Callable[[str], Optional[dict[str, Any]]]:
    """ns → {owner, contact, source} | None. 화면 응답을 만들 때 한 번 만들어 재사용한다."""
    cfg = get_settings(db)
    cid = str(cluster_id)
    rules = [r for r in cfg["rules"] if not r["cluster_id"] or r["cluster_id"] == cid]
    labels = (label_cache(db).get(cid) or {}).get("ns") or {}
    show_contact = cfg["show_contact"]

    def resolve(ns: str) -> Optional[dict[str, Any]]:
        for r in rules:
            if fnmatch.fnmatchcase(ns, r["pattern"]):
                return {"owner": r["owner"], "contact": r["contact"] if show_contact else None, "source": "rule"}
        hit = labels.get(ns)
        if hit:
            return {"owner": hit["owner"], "contact": None, "source": f"label:{hit['key']}"}
        return None
    return resolve
