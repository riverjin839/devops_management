"""서비스 구성 — 화면 데이터 조립과 V1 가져오기(DB 사용).

화면 1장 = (서비스의 설정 항목) × (선택한 버전의 값) × (노드별 현재 값). 1단계는 읽기 전용이며
버전은 '현재 값으로 V1 만들기' 로만 생긴다. 편집·저장·적용은 다음 단계.
"""
from __future__ import annotations

from typing import Any, Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models import ClusterConfigSnapshot
from app.models.cluster import Cluster
from app.models.service_config import ServiceConfigItem, ServiceConfigVersion
from app.services.service_config import current as C
from app.services.service_config.catalog_seed import SERVICES

SERVICE_BY_KEY = {s["key"]: s for s in SERVICES}


class ServiceConfigError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def service_meta(service: str) -> dict[str, Any]:
    meta = SERVICE_BY_KEY.get(service)
    if meta is None:
        raise ServiceConfigError(404, f"알 수 없는 서비스: {service}")
    return meta


def load_items(db: Session, service: str) -> list[ServiceConfigItem]:
    return (
        db.query(ServiceConfigItem)
        .filter(ServiceConfigItem.service == service, ServiceConfigItem.enabled.is_(True))
        .order_by(ServiceConfigItem.sort_order.asc(), ServiceConfigItem.key.asc())
        .all()
    )


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


def list_versions(db: Session, cluster_id, service: str) -> list[ServiceConfigVersion]:
    return (
        db.query(ServiceConfigVersion)
        .filter(ServiceConfigVersion.cluster_id == cluster_id, ServiceConfigVersion.service == service,
                ServiceConfigVersion.group_id.is_(None))
        .order_by(ServiceConfigVersion.version_no.desc())
        .all()
    )


def _version_out(v: ServiceConfigVersion) -> dict[str, Any]:
    return {
        "id": str(v.id), "version_no": v.version_no, "status": v.status, "note": v.note,
        "created_by": v.created_by, "created_at": v.created_at.isoformat() if v.created_at else None,
        "applied_at": v.applied_at.isoformat() if v.applied_at else None, "value_count": len(v.values or {}),
    }


def service_list(db: Session) -> list[dict[str, Any]]:
    counts: dict[str, int] = {}
    for svc, in db.query(ServiceConfigItem.service).filter(ServiceConfigItem.enabled.is_(True)).all():
        counts[svc] = counts.get(svc, 0) + 1
    return [{**s, "item_count": counts.get(s["key"], 0)} for s in SERVICES]


def build_view(db: Session, cluster: Cluster, service: str, version_no: Optional[int] = None) -> dict[str, Any]:
    meta = service_meta(service)
    items = load_items(db, service)
    cur = C.current_values(service, latest_snapshots(db, cluster.id, service), items)
    versions = list_versions(db, cluster.id, service)
    selected = next((v for v in versions if v.version_no == version_no), None) if version_no else (versions[0] if versions else None)
    if version_no and selected is None:
        raise ServiceConfigError(404, f"V{version_no} 를 찾을 수 없습니다.")
    vvals = (selected.values or {}) if selected else {}

    sections: dict[str, list[dict[str, Any]]] = {}
    counts = {"items": 0, "same": 0, "differs": 0, "mixed": 0, "unknown": 0}
    for it in items:
        summary = C.summarize(cur["values"].get(it.key) or {})
        vval = C.norm(vvals.get(it.key)) if it.key in vvals else None
        status = C.item_status(vval, summary) if selected else ("unknown" if not summary["groups"]
                                                                 else ("mixed" if not summary["uniform"] else "same"))
        counts["items"] += 1
        counts[status] += 1
        sections.setdefault(it.section, []).append({
            "id": str(it.id), "key": it.key, "label": it.label, "help": it.help, "value_type": it.value_type,
            "unit": it.unit, "options": it.options, "default_value": it.default_value,
            "restart_scope": it.restart_scope, "version_value": vval, "current": summary, "status": status,
        })
    nodes = sorted({s["node"] for s in cur["sources"]})
    return {
        "service": meta,
        "versions": [_version_out(v) for v in versions],
        "version": _version_out(selected) if selected else None,
        "sources": cur["sources"],
        "nodes": nodes,
        "counts": counts,
        "sections": [{"name": name, "items": rows} for name, rows in sections.items()],
    }


def import_v1(db: Session, cluster: Cluster, service: str, username: Optional[str]) -> dict[str, Any]:
    """현재 값으로 V1 을 만든다. 노드 간 값이 다르면 가장 많은 노드의 값을 쓴다(화면에 '노드 간 다름' 으로 계속 보인다)."""
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
            values[it.key] = summary["value"]
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
