"""ClusterItem 수집/관리 서비스.

현황 관리 대시보드의 '아이템' 카드 결과를 수집한다. 첫 기본 아이템은
K8s 노드 수(node_count) 이며, 클러스터마다 자동으로 1개 생성된다.

수집은 fail-safe — k8s 연결 실패/예외가 나도 raise 하지 않고 item 의
last_status='error' + last_error 에 사유를 기록한다.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.models import Cluster
from app.models.cluster_item import ClusterItem
from app.services.checkers.node_checker import NodeChecker

logger = logging.getLogger(__name__)


# 클러스터마다 보장되는 기본(builtin) 아이템 정의.
BUILTIN_ITEM_DEFS: list[dict] = [
    {
        "item_type": "node_count",
        "title": "K8s 노드 수",
        "icon": "🖥️",
        "description": "클러스터 전체 노드 수 (기본: 매일 새벽 1시 자동 점검, 수동 실행 가능)",
        "tier": "basic",
        "is_builtin": True,
        "source_mode": "auto",
        "auto_enabled": True,
        "schedule_hour": 1,
        "schedule_minute": 0,
        "card_size": "md",
        "unit": "대",
        "sort_order": 0,
    },
]


def ensure_builtin_items(db: Session, cluster: Cluster) -> list[ClusterItem]:
    """클러스터에 누락된 기본 아이템을 생성한다 (idempotent)."""
    existing = {
        i.item_type
        for i in db.query(ClusterItem)
        .filter(ClusterItem.cluster_id == cluster.id, ClusterItem.is_builtin.is_(True))
        .all()
    }
    created: list[ClusterItem] = []
    for d in BUILTIN_ITEM_DEFS:
        if d["item_type"] in existing:
            continue
        item = ClusterItem(cluster_id=cluster.id, **d)
        db.add(item)
        created.append(item)
    if created:
        db.commit()
        for item in created:
            db.refresh(item)
    return created


def _collect_node_count(cluster: Cluster) -> tuple[Optional[float], dict, Optional[str]]:
    """노드 수 1회 수집. (value, detail, error) 반환 — 예외는 error 문자열로."""
    try:
        # NodeChecker.check() 는 self.addon 을 사용하지 않으므로 addon=None 으로 직접 호출.
        result = NodeChecker(cluster, addon=None).check()
        details = result.details or {}
        total = details.get("total")
        value = float(total) if total is not None else None
        detail = {
            "total": total,
            "ready": details.get("ready"),
            "not_ready": (details.get("not_ready") or [])[:20],
            "status": result.status.value,
            "message": result.message,
        }
        return value, detail, None
    except Exception as e:  # noqa: BLE001
        return None, {}, str(e)[:300]


def run_item(db: Session, item: ClusterItem, source: str = "manual") -> ClusterItem:
    """아이템을 1회 수집하고 변경 추적을 반영한 뒤 커밋한다.

    source: manual | auto | ai — 결과를 어떤 방식으로 얻었는지 기록.
    """
    if item.item_type == "node_count":
        value, detail, err = _collect_node_count(item.cluster)
    else:
        value, detail, err = None, {}, f"지원하지 않는 아이템 타입: {item.item_type}"

    now = datetime.utcnow()
    item.last_checked_at = now
    item.last_source = source

    if err is not None:
        item.last_status = "error"
        item.last_error = err
    else:
        item.last_status = "ok"
        item.last_error = None
        item.result_detail = detail
        if value is not None:
            if item.current_value is None:
                # 최초 수집 — 변경 시점을 now 로 기록.
                item.previous_value = None
                item.last_changed_at = now
            elif value != item.current_value:
                item.previous_value = item.current_value
                item.last_changed_at = now
            item.current_value = value

    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def run_due_auto_items(db: Session, hour: int) -> list[dict]:
    """현재 시(KST)와 schedule_hour 가 일치하는 자동 아이템을 수집."""
    items = (
        db.query(ClusterItem)
        .filter(ClusterItem.enabled.is_(True))
        .filter(ClusterItem.auto_enabled.is_(True))
        .filter(ClusterItem.source_mode == "auto")
        .filter(ClusterItem.schedule_hour == hour)
        .all()
    )
    results: list[dict] = []
    for item in items:
        try:
            run_item(db, item, source="auto")
            results.append({"item_id": str(item.id), "value": item.current_value})
        except Exception as e:  # noqa: BLE001
            db.rollback()
            logger.exception("auto cluster item collection failed (%s): %s", item.id, e)
            results.append({"item_id": str(item.id), "error": str(e)[:200]})
    return results
