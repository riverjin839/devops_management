"""서비스 구성 — 화면 데이터 조립, V1 가져오기, 초안 평가, 버전 저장·비교·되돌리기, 노드 그룹(DB 사용).

범위(scope) = (클러스터, 서비스, 노드 그룹). 그룹 없음(None) = 기본 그룹 = 어느 그룹에도 들지 않은 나머지 노드.
기본 그룹 버전은 전체 값, 노드 그룹 버전은 **재정의 값만** 담고 실효 값 = 기본 최신 값 ∪ 그룹 재정의.
노드에는 아무것도 하지 않는다 — 적용은 다음 단계.
"""
from __future__ import annotations

from typing import Any, Optional
from uuid import UUID

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models import ClusterConfigSnapshot
from app.models.cluster import Cluster
from app.models.service_config import ServiceConfigGroup, ServiceConfigItem, ServiceConfigRule, ServiceConfigVersion
from app.services.node_param_watch.rules import node_matches
from app.services.service_config import current as C
from app.services.service_config import rules as RU
from app.services.service_config.catalog_seed import SERVICE_KEYS, SERVICES

SERVICE_BY_KEY = {s["key"]: s for s in SERVICES}
GROUPLESS_SERVICES = {"cilium"}  # 클러스터에 값이 하나뿐인 서비스는 노드 그룹이 없다
BASELINE_STATUSES = ("imported", "applied")


class ServiceConfigError(Exception):
    def __init__(self, status: int, detail: Any):
        super().__init__(str(detail))
        self.status = status
        self.detail = detail


# ── 조회 공용 ────────────────────────────────────────────────────────────────

def service_meta(service: str) -> dict[str, Any]:
    meta = SERVICE_BY_KEY.get(service)
    if meta is None:
        raise ServiceConfigError(404, f"알 수 없는 서비스: {service}")
    return {**meta, "group_supported": service not in GROUPLESS_SERVICES}


def load_items(db: Session, service: str) -> list[ServiceConfigItem]:
    return (
        db.query(ServiceConfigItem)
        .filter(ServiceConfigItem.service == service, ServiceConfigItem.enabled.is_(True))
        .order_by(ServiceConfigItem.sort_order.asc(), ServiceConfigItem.key.asc())
        .all()
    )


def load_rules(db: Session) -> list[ServiceConfigRule]:
    return db.query(ServiceConfigRule).filter(ServiceConfigRule.enabled.is_(True)).all()


def latest_snapshots(db: Session, cluster_id, service: str) -> list[ClusterConfigSnapshot]:
    """서비스에 필요한 컴포넌트별 최신 스냅샷 1개씩(Postgres DISTINCT ON)."""
    spec = C.SERVICE_COMPONENTS[service]
    conds = [ClusterConfigSnapshot.component == c for c in spec["exact"]]
    conds += [ClusterConfigSnapshot.component.like(f"{p}%") for p in spec["prefix"]]
    if not conds:
        return []
    return (
        db.query(ClusterConfigSnapshot)
        .filter(ClusterConfigSnapshot.cluster_id == cluster_id, or_(*conds))
        .order_by(ClusterConfigSnapshot.component.asc(), ClusterConfigSnapshot.collected_at.desc())
        .distinct(ClusterConfigSnapshot.component)
        .all()
    )


def list_versions(db: Session, cluster_id, service: str, group_id: Optional[UUID] = None) -> list[ServiceConfigVersion]:
    q = db.query(ServiceConfigVersion).filter(
        ServiceConfigVersion.cluster_id == cluster_id, ServiceConfigVersion.service == service)
    q = q.filter(ServiceConfigVersion.group_id.is_(None) if group_id is None else ServiceConfigVersion.group_id == group_id)
    return q.order_by(ServiceConfigVersion.version_no.desc()).all()


def list_groups(db: Session, cluster_id, service: str) -> list[ServiceConfigGroup]:
    return (
        db.query(ServiceConfigGroup)
        .filter(ServiceConfigGroup.cluster_id == cluster_id, ServiceConfigGroup.service == service)
        .order_by(ServiceConfigGroup.sort_order.asc(), ServiceConfigGroup.name.asc())
        .all()
    )


def _get_group(db: Session, cluster: Cluster, service: str, group_id: Optional[UUID]) -> Optional[ServiceConfigGroup]:
    if group_id is None:
        return None
    if service in GROUPLESS_SERVICES:
        raise ServiceConfigError(422, f"{SERVICE_BY_KEY[service]['label']} 은(는) 클러스터에 값이 하나라 노드 그룹이 없습니다.")
    g = db.query(ServiceConfigGroup).filter(
        ServiceConfigGroup.id == group_id, ServiceConfigGroup.cluster_id == cluster.id,
        ServiceConfigGroup.service == service).first()
    if g is None:
        raise ServiceConfigError(404, "노드 그룹을 찾을 수 없습니다.")
    return g


def node_group_map(nodes: list[str], groups: list[ServiceConfigGroup]) -> dict[str, Optional[str]]:
    """노드 → 처음 일치한 그룹 id(없으면 None = 기본 그룹)."""
    out: dict[str, Optional[str]] = {}
    for n in nodes:
        out[n] = next((str(g.id) for g in groups if node_matches(g.node_pattern, n)), None)
    return out


def _version_out(v: ServiceConfigVersion) -> dict[str, Any]:
    return {
        "id": str(v.id), "version_no": v.version_no, "status": v.status, "note": v.note,
        "group_id": str(v.group_id) if v.group_id else None,
        "created_by": v.created_by, "created_at": v.created_at.isoformat() if v.created_at else None,
        "applied_at": v.applied_at.isoformat() if v.applied_at else None, "value_count": len(v.values or {}),
    }


def service_list(db: Session) -> list[dict[str, Any]]:
    counts: dict[str, int] = {}
    for svc, in db.query(ServiceConfigItem.service).filter(ServiceConfigItem.enabled.is_(True)).all():
        counts[svc] = counts.get(svc, 0) + 1
    return [{**s, "group_supported": s["key"] not in GROUPLESS_SERVICES, "item_count": counts.get(s["key"], 0)}
            for s in SERVICES]


def _default_latest_values(db: Session, cluster_id, service: str) -> dict[str, Any]:
    vs = list_versions(db, cluster_id, service)
    return dict(vs[0].values or {}) if vs else {}


def scope_effective(db: Session, cluster_id, service: str, group_id: Optional[UUID],
                    overrides: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """범위의 실효 값. ``overrides`` 를 주면 그룹 최신 재정의 대신 그 값(초안)을 쓴다."""
    base = _default_latest_values(db, cluster_id, service)
    if group_id is None:
        return dict(overrides) if overrides is not None else base
    if overrides is None:
        gv = list_versions(db, cluster_id, service, group_id)
        overrides = dict(gv[0].values or {}) if gv else {}
    return {**base, **overrides}


def _pending(versions: list[ServiceConfigVersion]) -> Optional[dict[str, Any]]:
    """최신이 미적용 저장본이면 기준(최신 가져옴/적용 버전, 없으면 빈 값) 대비 바뀐 키 수."""
    if not versions or versions[0].status != "saved":
        return None
    latest = versions[0]
    baseline = next((v for v in versions if v.status in BASELINE_STATUSES), None)
    changes = diff_values((baseline.values if baseline else {}) or {}, latest.values or {})
    return {
        "version_no": latest.version_no, "baseline_version_no": baseline.version_no if baseline else None,
        "count": len(changes), "note": latest.note, "created_by": latest.created_by,
        "created_at": latest.created_at.isoformat() if latest.created_at else None,
    }


def diff_values(a: dict[str, Any], b: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for key in sorted(set(a) | set(b)):
        av, bv = C.norm(a.get(key)), C.norm(b.get(key))
        if av == bv:
            continue
        change = "added" if key not in a else ("removed" if key not in b else "changed")
        out.append({"key": key, "a": av, "b": bv, "change": change})
    return out


# ── 화면 데이터 ──────────────────────────────────────────────────────────────

def build_view(db: Session, cluster: Cluster, service: str, version_no: Optional[int] = None,
               group_id: Optional[UUID] = None) -> dict[str, Any]:
    meta = service_meta(service)
    group = _get_group(db, cluster, service, group_id)
    items = load_items(db, service)
    cur = C.current_values(service, latest_snapshots(db, cluster.id, service), items)
    all_nodes = sorted({s["node"] for s in cur["sources"]})
    groups = list_groups(db, cluster.id, service) if meta["group_supported"] else []
    membership = node_group_map(all_nodes, groups)
    gid = str(group.id) if group else None
    scope_nodes = [n for n in all_nodes if membership.get(n) == gid]

    versions = list_versions(db, cluster.id, service, group.id if group else None)
    selected = next((v for v in versions if v.version_no == version_no), None) if version_no else (versions[0] if versions else None)
    if version_no and selected is None:
        raise ServiceConfigError(404, f"V{version_no} 를 찾을 수 없습니다.")
    default_vals = _default_latest_values(db, cluster.id, service)
    if group:
        overrides = dict(selected.values or {}) if selected else {}
        effective = {**default_vals, **overrides}
        has_values = bool(default_vals) or bool(overrides)
    else:
        overrides = {}
        effective = dict(selected.values or {}) if selected else {}
        has_values = selected is not None

    sections: dict[str, list[dict[str, Any]]] = {}
    counts = {"items": 0, "same": 0, "differs": 0, "mixed": 0, "unknown": 0}
    for it in items:
        node_vals = {n: v for n, v in (cur["values"].get(it.key) or {}).items() if n in scope_nodes}
        summary = C.summarize(node_vals)
        vval = C.norm(effective.get(it.key)) if it.key in effective else None
        status = C.item_status(vval if has_values else None, summary)
        counts["items"] += 1
        counts[status] += 1
        sections.setdefault(it.section, []).append({
            "id": str(it.id), "key": it.key, "label": it.label, "help": it.help, "value_type": it.value_type,
            "unit": it.unit, "options": it.options, "default_value": it.default_value,
            "min_value": getattr(it, "min_value", None), "max_value": getattr(it, "max_value", None),
            "restart_scope": it.restart_scope, "version_value": vval,
            "base_value": C.norm(default_vals.get(it.key)) if it.key in default_vals else None,
            "override_value": C.norm(overrides.get(it.key)) if group and it.key in overrides else None,
            "inherited": bool(group) and it.key not in overrides,
            "current": summary, "status": status,
        })
    groups_out = []
    for g in groups:
        members = [n for n in all_nodes if membership.get(n) == str(g.id)]
        groups_out.append({"id": str(g.id), "name": g.name, "node_pattern": g.node_pattern, "description": g.description,
                           "sort_order": g.sort_order, "nodes": members})
    return {
        "service": meta,
        "group": {"id": gid, "name": group.name if group else "기본", "node_pattern": group.node_pattern if group else None},
        "groups": groups_out,
        "default_nodes": [n for n in all_nodes if membership.get(n) is None],
        "versions": [_version_out(v) for v in versions],
        "version": _version_out(selected) if selected else None,
        "default_version_no": list_versions(db, cluster.id, service)[0].version_no if default_vals else None,
        "pending": _pending(versions),
        "sources": [s for s in cur["sources"] if s["node"] in scope_nodes],
        "nodes": scope_nodes,
        "all_nodes": all_nodes,
        "counts": counts,
        "sections": [{"name": name, "items": rows} for name, rows in sections.items()],
    }


# ── V1 가져오기 ──────────────────────────────────────────────────────────────

def import_v1(db: Session, cluster: Cluster, service: str, username: Optional[str]) -> dict[str, Any]:
    """현재 값으로 V1 을 만든다(기본 그룹). 노드 간 값이 다르면 가장 많은 노드의 값을 쓴다."""
    service_meta(service)
    if list_versions(db, cluster.id, service):
        raise ServiceConfigError(409, "이미 설정 버전이 있습니다. V1 은 처음 한 번만 만들 수 있습니다.")
    items = load_items(db, service)
    cur = C.current_values(service, latest_snapshots(db, cluster.id, service), items)
    values: dict[str, str] = {}
    mixed: list[str] = []
    for it in items:
        summary = C.summarize(cur["values"].get(it.key) or {})
        if summary["value"] is not None:
            values[it.key] = C.to_version_value(summary["value"]) or summary["value"]
            if not summary["uniform"]:
                mixed.append(it.key)
    if not values:
        raise ServiceConfigError(422, "수집된 현재 값이 없습니다. 먼저 '현재 값 수집' 으로 노드 설정을 읽어 오세요.")
    nodes = sorted({s["node"] for s in cur["sources"]})
    row = ServiceConfigVersion(
        cluster_id=cluster.id, service=service, group_id=None, version_no=1, values=values, status="imported",
        note=f"현재 값에서 가져옴 — 노드 {len(nodes)}개, 항목 {len(values)}/{len(items)}"
             + (f", 노드 간 다른 값 {len(mixed)}개는 다수 값" if mixed else ""),
        created_by=username,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"version": _version_out(row), "imported": len(values), "total": len(items), "mixed": mixed, "nodes": nodes}


# ── 초안 평가·저장 ───────────────────────────────────────────────────────────

def _others(db: Session, cluster_id, service: str) -> dict[str, dict[str, Any]]:
    """다른 서비스 값 — 최신 기본 버전, 없으면 현재 노드 다수값(규칙의 원인·대상으로 쓰인다)."""
    out: dict[str, dict[str, Any]] = {}
    for svc in SERVICE_KEYS:
        if svc == service:
            continue
        vals = _default_latest_values(db, cluster_id, svc)
        if not vals:
            items = load_items(db, svc)
            cur = C.current_values(svc, latest_snapshots(db, cluster_id, svc), items)
            vals = {k: C.summarize(v)["value"] for k, v in cur["values"].items() if v}
        out[svc] = vals
    return out


def _clean(values: dict[str, Any], keys: set[str]) -> dict[str, str]:
    unknown = sorted(k for k in values if k not in keys)
    if unknown:
        raise ServiceConfigError(422, f"알 수 없는 설정 키: {', '.join(unknown[:10])}")
    return {k: C.norm(v) for k, v in values.items() if C.norm(v) not in (None, "")}


def evaluate_draft(db: Session, cluster: Cluster, service: str, group_id: Optional[UUID],
                   draft: dict[str, Any]) -> dict[str, Any]:
    service_meta(service)
    group = _get_group(db, cluster, service, group_id)
    keys = {it.key for it in load_items(db, service)}
    draft = _clean(draft, keys)
    gid = group.id if group else None
    before = scope_effective(db, cluster.id, service, gid)
    after = scope_effective(db, cluster.id, service, gid, overrides=draft)
    changed = {d["key"] for d in diff_values(before, after)}
    values = {**_others(db, cluster.id, service), service: after}
    results = RU.evaluate(load_rules(db), service, values, changed)
    return {"changed": sorted(changed), "results": results, "blocking": sum(1 for r in results if r["blocking"])}


def save_version(db: Session, cluster: Cluster, service: str, group_id: Optional[UUID], base_version_no: int,
                 values: dict[str, Any], note: Optional[str], username: Optional[str]) -> dict[str, Any]:
    service_meta(service)
    group = _get_group(db, cluster, service, group_id)
    gid = group.id if group else None
    keys = {it.key for it in load_items(db, service)}
    clean = _clean(values, keys)
    versions = list_versions(db, cluster.id, service, gid)
    latest_no = versions[0].version_no if versions else 0
    if base_version_no != latest_no:
        raise ServiceConfigError(409, f"그사이 V{latest_no} 이 저장됐습니다. 화면을 새로 읽고 다시 편집하세요.")
    if gid is None and latest_no == 0:
        raise ServiceConfigError(422, "먼저 '현재 값으로 V1 만들기' 로 기준 버전을 만드세요.")
    previous = dict(versions[0].values or {}) if versions else {}
    if not diff_values(previous, clean):
        raise ServiceConfigError(422, "바뀐 값이 없습니다.")
    ev = evaluate_draft(db, cluster, service, gid, clean)
    blocking = [r for r in ev["results"] if r["blocking"]]
    if blocking:
        raise ServiceConfigError(422, {
            "message": "지켜야 하는 조건을 어겨 저장할 수 없습니다.",
            "violations": [{"target_key": r["target_key"], "reason": r["reason"], "suggested": r["suggested"]} for r in blocking],
        })
    for v in versions:
        if v.status == "saved":
            v.status = "superseded"
    row = ServiceConfigVersion(cluster_id=cluster.id, service=service, group_id=gid, version_no=latest_no + 1,
                               values=clean, status="saved", note=(note or "").strip()[:2000] or None,
                               created_by=username)
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"version": _version_out(row), "changes": diff_values(previous, clean)}


def compare_versions(db: Session, cluster: Cluster, service: str, group_id: Optional[UUID], a: int, b: int) -> dict[str, Any]:
    service_meta(service)
    group = _get_group(db, cluster, service, group_id)
    versions = {v.version_no: v for v in list_versions(db, cluster.id, service, group.id if group else None)}
    if a not in versions or b not in versions:
        raise ServiceConfigError(404, "비교할 버전을 찾을 수 없습니다.")
    labels = {it.key: (it.section, it.label) for it in load_items(db, service)}
    rows = diff_values(versions[a].values or {}, versions[b].values or {})
    for r in rows:
        r["section"], r["label"] = labels.get(r["key"], (None, None))
    return {"a": _version_out(versions[a]), "b": _version_out(versions[b]), "rows": rows}


def revert_to(db: Session, cluster: Cluster, service: str, group_id: Optional[UUID], version_no: int,
              username: Optional[str]) -> dict[str, Any]:
    group = _get_group(db, cluster, service, group_id)
    gid = group.id if group else None
    versions = list_versions(db, cluster.id, service, gid)
    target = next((v for v in versions if v.version_no == version_no), None)
    if target is None:
        raise ServiceConfigError(404, f"V{version_no} 를 찾을 수 없습니다.")
    return save_version(db, cluster, service, gid, versions[0].version_no, dict(target.values or {}),
                        f"V{version_no} 값으로 되돌림", username)


# ── 노드 그룹 ────────────────────────────────────────────────────────────────

def _check_pattern(pattern: str) -> str:
    pats = [p.strip() for p in (pattern or "").split(",") if p.strip()]
    if not pats:
        raise ServiceConfigError(422, "노드 패턴을 입력하세요 (예: gpu-*, es-?).")
    return ", ".join(pats)


def save_group(db: Session, cluster: Cluster, service: str, group_id: Optional[UUID], name: str, node_pattern: str,
               description: Optional[str], username: Optional[str]) -> ServiceConfigGroup:
    meta = service_meta(service)
    if not meta["group_supported"]:
        raise ServiceConfigError(422, f"{meta['label']} 은(는) 노드 그룹을 쓰지 않습니다.")
    name = (name or "").strip()
    if not name or name == "기본":
        raise ServiceConfigError(422, "그룹 이름을 입력하세요('기본' 은 쓸 수 없습니다).")
    pattern = _check_pattern(node_pattern)
    dup = db.query(ServiceConfigGroup.id).filter(
        ServiceConfigGroup.cluster_id == cluster.id, ServiceConfigGroup.service == service,
        ServiceConfigGroup.name == name)
    if group_id is not None:
        dup = dup.filter(ServiceConfigGroup.id != group_id)
    if dup.first():
        raise ServiceConfigError(409, f"같은 이름의 그룹이 있습니다: {name}")
    if group_id is None:
        order = len(list_groups(db, cluster.id, service)) * 10 + 10
        g = ServiceConfigGroup(cluster_id=cluster.id, service=service, name=name, node_pattern=pattern,
                               description=(description or "").strip() or None, sort_order=order, created_by=username)
        db.add(g)
    else:
        g = _get_group(db, cluster, service, group_id)
        g.name, g.node_pattern, g.description = name, pattern, (description or "").strip() or None
    db.commit()
    db.refresh(g)
    return g


def delete_group(db: Session, cluster: Cluster, service: str, group_id: UUID) -> str:
    g = _get_group(db, cluster, service, group_id)
    name = g.name
    db.query(ServiceConfigVersion).filter(ServiceConfigVersion.group_id == g.id).delete(synchronize_session=False)
    db.delete(g)
    db.commit()
    return name
