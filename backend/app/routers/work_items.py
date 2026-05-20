import csv
import io
from datetime import date, datetime
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import case
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Cluster
from app.models.work_item import WorkItem
from app.models.user import User
from app.auth.deps import require_operator
from app.schemas.work_item import (
    WorkItemCreate,
    WorkItemUpdate,
    WorkItemResponse,
    WorkItemListResponse,
    WorkItemStatusPatch,
    WorkItemStatusResponse,
)

router = APIRouter(prefix="/work-items", tags=["work-items"])

WIP_LIMIT = 2


def _apply_filters(query, *, type_: Optional[str], cluster_id: Optional[UUID],
                   assignee: Optional[str], category: Optional[str],
                   priority: Optional[str], kanban_status: Optional[str],
                   module: Optional[str], started_from: Optional[date],
                   started_to: Optional[date], closed: Optional[bool]):
    if type_:
        query = query.filter(WorkItem.type == type_)
    if cluster_id:
        query = query.filter(WorkItem.cluster_id == cluster_id)
    if assignee:
        query = query.filter(
            WorkItem.primary_assignee.ilike(f"%{assignee}%")
            | WorkItem.secondary_assignee.ilike(f"%{assignee}%")
            | WorkItem.assignee.ilike(f"%{assignee}%")
        )
    if category:
        query = query.filter(WorkItem.category.ilike(f"%{category}%"))
    if priority:
        query = query.filter(WorkItem.priority == priority)
    if kanban_status:
        query = query.filter(WorkItem.kanban_status == kanban_status)
    if module:
        query = query.filter(WorkItem.module == module)
    if started_from:
        query = query.filter(WorkItem.started_at >= started_from)
    if started_to:
        query = query.filter(WorkItem.started_at <= started_to)
    if closed is True:
        query = query.filter(WorkItem.closed_at.isnot(None))
    elif closed is False:
        query = query.filter(WorkItem.closed_at.is_(None))
    return query


@router.get("", response_model=WorkItemListResponse)
def list_work_items(
    type: Optional[str] = Query(default=None, pattern="^(task|issue|meeting|training|etc)$"),
    cluster_id: UUID | None = Query(default=None),
    assignee: str | None = Query(default=None),
    category: str | None = Query(default=None),
    priority: str | None = Query(default=None),
    kanban_status: str | None = Query(default=None),
    module: str | None = Query(default=None),
    started_from: date | None = Query(default=None),
    started_to: date | None = Query(default=None),
    closed: bool | None = Query(default=None),
    db: Session = Depends(get_db),
):
    """Work item 목록 — type='issue'/'task' 필터 가능, 그 외 통합 필터.

    parent_id 가 있는 sub-task 는 결과에서 제외하지 않는다 (한 리스트에서 보고 싶을 수 있어 그대로 노출).
    """
    query = db.query(WorkItem)
    query = _apply_filters(
        query, type_=type, cluster_id=cluster_id, assignee=assignee, category=category,
        priority=priority, kanban_status=kanban_status, module=module,
        started_from=started_from, started_to=started_to, closed=closed,
    )
    items = query.order_by(WorkItem.started_at.desc(), WorkItem.created_at.desc()).all()
    return WorkItemListResponse(data=items, total=len(items))


@router.get("/export/csv")
def export_csv(
    type: Optional[str] = Query(default=None, pattern="^(task|issue|meeting|training|etc)$"),
    cluster_id: UUID | None = Query(default=None),
    assignee: str | None = Query(default=None),
    category: str | None = Query(default=None),
    priority: str | None = Query(default=None),
    kanban_status: str | None = Query(default=None),
    module: str | None = Query(default=None),
    started_from: date | None = Query(default=None),
    started_to: date | None = Query(default=None),
    db: Session = Depends(get_db),
):
    """Work item CSV 다운로드 — type 무관 통합 컬럼."""
    query = db.query(WorkItem)
    query = _apply_filters(
        query, type_=type, cluster_id=cluster_id, assignee=assignee, category=category,
        priority=priority, kanban_status=kanban_status, module=module,
        started_from=started_from, started_to=started_to, closed=None,
    )
    items = query.order_by(WorkItem.started_at.desc(), WorkItem.created_at.desc()).all()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "유형",
        "담당자(정)",
        "담당자(부)",
        "대상 클러스터",
        "모듈",
        "분류",
        "라벨",
        "내용",
        "완료 조건",
        "조치/결과",
        "우선순위",
        "칸반 상태",
        "예상 시간(h)",
        "시작/발생일",
        "종료/완료일",
        "비고",
        "등록일시",
    ])
    type_label_map = {"task": "작업", "issue": "이슈", "meeting": "회의", "training": "교육", "etc": "기타"}
    for w in items:
        writer.writerow([
            type_label_map.get(w.type, w.type),
            w.primary_assignee,
            w.secondary_assignee or "",
            w.cluster_name or "",
            w.module or "",
            w.category,
            w.type_label or "",
            w.content,
            w.done_condition or "",
            w.resolution or "",
            w.priority,
            w.kanban_status,
            w.effort_hours or "",
            w.started_at.isoformat() if w.started_at else "",
            w.closed_at.isoformat() if w.closed_at else "",
            w.remarks or "",
            w.created_at.strftime("%Y-%m-%d %H:%M") if w.created_at else "",
        ])

    output.seek(0)
    bom = "﻿"
    filename = f"work-items-{date.today().isoformat()}.csv"
    return StreamingResponse(
        iter([bom + output.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/today/summary")
def get_today_summary(date: Optional[str] = None, db: Session = Depends(get_db)):
    """오늘의 작업/이슈 요약 — task + issue 모두 대상.

    그룹 키: primary_assignee + secondary_assignee 모두 (한 항목이 두 사람의 그룹에
    동시에 보임). priority 정렬은 의미순(high → medium → low → 그 외).
    """
    if date:
        try:
            target = datetime.strptime(date, "%Y-%m-%d")
        except ValueError:
            target = datetime.utcnow()
    else:
        target = datetime.utcnow()
    today_start = target.replace(hour=0, minute=0, second=0, microsecond=0)
    today_end = today_start.replace(hour=23, minute=59, second=59)

    # ORDER BY 알파벳순 정렬은 'high' < 'low' < 'medium' 이 되어 의미와 어긋남.
    # CASE 로 의미상 우선순위를 강제.
    priority_order = case(
        (WorkItem.priority == "high", 0),
        (WorkItem.priority == "medium", 1),
        (WorkItem.priority == "low", 2),
        else_=3,
    )

    today_items = (
        db.query(WorkItem)
        .filter(
            WorkItem.started_at >= today_start,
            WorkItem.started_at <= today_end,
        )
        .order_by(WorkItem.primary_assignee, priority_order)
        .all()
    )

    in_progress_items = (
        db.query(WorkItem)
        .filter(
            WorkItem.kanban_status == "in_progress",
            ~((WorkItem.started_at >= today_start) & (WorkItem.started_at <= today_end)),
        )
        .order_by(WorkItem.primary_assignee, priority_order)
        .all()
    )

    assignee_map: dict[str, dict] = {}

    def add_to_groups(item: WorkItem, bucket_key: str) -> None:
        # primary + secondary 모두를 후보로 — 한 항목이 협업자의 그룹에도 표시되도록.
        # 같은 사람이 primary/secondary 둘 다인 비정상 케이스는 중복 제거.
        names: list[str] = []
        primary = item.primary_assignee or item.assignee
        if primary:
            names.append(primary)
        if item.secondary_assignee and item.secondary_assignee not in names:
            names.append(item.secondary_assignee)
        if not names:
            names.append("미지정")
        for name in names:
            assignee_map.setdefault(
                name, {"assignee": name, "today_tasks": [], "in_progress_tasks": []}
            )
            assignee_map[name][bucket_key].append(item)

    for it in today_items:
        add_to_groups(it, "today_tasks")
    for it in in_progress_items:
        add_to_groups(it, "in_progress_tasks")

    def serialize(w: WorkItem) -> dict:
        return {
            "id": str(w.id),
            "type": w.type,
            "assignee": w.assignee,
            "primary_assignee": w.primary_assignee,
            "secondary_assignee": w.secondary_assignee,
            "cluster_id": str(w.cluster_id) if w.cluster_id else None,
            "cluster_name": w.cluster_name,
            "category": w.category,
            "content": w.content,
            "resolution": w.resolution,
            "started_at": w.started_at.isoformat() if w.started_at else None,
            "closed_at": w.closed_at.isoformat() if w.closed_at else None,
            "priority": w.priority,
            "kanban_status": w.kanban_status,
            "module": w.module,
            "type_label": w.type_label,
            "effort_hours": w.effort_hours,
            "done_condition": w.done_condition,
            "remarks": w.remarks,
            "service": w.service,
            "confluence_url": w.confluence_url,
            "created_at": w.created_at.isoformat() if w.created_at else None,
            "updated_at": w.updated_at.isoformat() if w.updated_at else None,
        }

    result = []
    for key in sorted(assignee_map.keys()):
        g = assignee_map[key]
        result.append({
            "assignee": g["assignee"],
            "today_tasks": [serialize(t) for t in g["today_tasks"]],
            "in_progress_tasks": [serialize(t) for t in g["in_progress_tasks"]],
        })
    return {
        "date": today_start.strftime("%Y-%m-%d"),
        "total_today": len(today_items),
        "total_in_progress": len(in_progress_items),
        "groups": result,
    }


@router.get("/{item_id}", response_model=WorkItemResponse)
def get_work_item(item_id: UUID, db: Session = Depends(get_db)):
    item = db.query(WorkItem).filter(WorkItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Work item not found")
    return item


@router.post("", response_model=WorkItemResponse, status_code=status.HTTP_201_CREATED)
def create_work_item(
    payload: WorkItemCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    cluster_name = payload.cluster_name
    if payload.cluster_id and not cluster_name:
        cluster = db.query(Cluster).filter(Cluster.id == payload.cluster_id).first()
        if not cluster:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")
        cluster_name = cluster.name

    primary_assignee = (payload.primary_assignee or payload.assignee).strip()
    secondary_assignee = payload.secondary_assignee.strip() if payload.secondary_assignee else None
    overridden = {"cluster_name", "assignee", "primary_assignee", "secondary_assignee"}
    item = WorkItem(
        **{k: v for k, v in payload.model_dump().items() if k not in overridden},
        assignee=primary_assignee,
        primary_assignee=primary_assignee,
        secondary_assignee=secondary_assignee,
        cluster_name=cluster_name,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.put("/{item_id}", response_model=WorkItemResponse)
def update_work_item(
    item_id: UUID,
    payload: WorkItemUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    item = db.query(WorkItem).filter(WorkItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Work item not found")

    update_data = payload.model_dump(exclude_unset=True)
    if "primary_assignee" in update_data:
        update_data["assignee"] = update_data["primary_assignee"]
    elif "assignee" in update_data:
        update_data["primary_assignee"] = update_data["assignee"]

    if "cluster_id" in update_data and update_data["cluster_id"] and "cluster_name" not in update_data:
        cluster = db.query(Cluster).filter(Cluster.id == update_data["cluster_id"]).first()
        if not cluster:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")
        update_data["cluster_name"] = cluster.name

    for key, value in update_data.items():
        setattr(item, key, value)

    db.commit()
    db.refresh(item)
    return item


@router.patch("/{item_id}/status", response_model=WorkItemStatusResponse)
def patch_status(
    item_id: UUID,
    payload: WorkItemStatusPatch,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """칸반 상태 이동 — type 무관 in_progress 총합으로 WIP 체크. done 이동 시 closed_at 자동 set."""
    item = db.query(WorkItem).filter(WorkItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Work item not found")

    wip_warning = False
    if payload.kanban_status == "in_progress":
        wip_count = (
            db.query(WorkItem)
            .filter(WorkItem.kanban_status == "in_progress", WorkItem.id != item_id)
            .count()
        )
        if wip_count >= WIP_LIMIT:
            wip_warning = True

    item.kanban_status = payload.kanban_status
    if payload.kanban_status == "done" and not item.closed_at:
        item.closed_at = datetime.utcnow()

    db.commit()
    db.refresh(item)
    return WorkItemStatusResponse(data=item, wip_warning=wip_warning)


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_work_item(
    item_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    item = db.query(WorkItem).filter(WorkItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Work item not found")
    db.delete(item)
    db.commit()
    return None
