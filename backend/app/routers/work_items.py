import csv
import io
from datetime import date, datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import case, or_
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Cluster
from app.models.work_item import WorkItem
from app.models.work_item_comment import WorkItemComment
from app.models.audit_log import AuditLog
from app.models.user import User
from app.models.app_setting import AppSetting
from app.auth.deps import require_operator, get_current_user
from app.config import settings
from app.services import audit_logger
from app.models.work_item_time_block import WorkItemTimeBlock
from app.schemas.work_item import (
    WorkItemCreate,
    WorkItemUpdate,
    WorkItemResponse,
    WorkItemListResponse,
    WorkItemStatusPatch,
    WorkItemStatusResponse,
    WorkItemCommentCreate,
    WorkItemCommentResponse,
    SimilarWorkItem,
    SimilarWorkItemListResponse,
)
from app.schemas.work_item_time_block import (
    TimeBlockCreate,
    TimeBlockUpdate,
    TimeBlockResponse,
)

router = APIRouter(prefix="/work-items", tags=["work-items"])

WIP_LIMIT = 2


def _queue_embedding_recompute(work_item_id) -> None:
    """임베딩 재계산 큐잉 — best-effort. Celery/Redis 미가용이어도 쓰기 응답에 영향 없음
    (이미 commit 이 끝난 뒤 호출되므로 여기서 실패해도 트랜잭션은 이미 완료된 상태)."""
    try:
        from app.celery_app import compute_work_item_embedding
        compute_work_item_embedding.delay(str(work_item_id))
    except Exception:
        import logging
        logging.getLogger(__name__).warning(
            "Failed to queue embedding recompute for work_item %s", work_item_id
        )


# G-C4: Ownership 검증.
#
# ⚠️ 신원 식별자 불일치 (근본 원인):
#   로그인 username 은 담당자 자동계정의 경우 **사번(employeeId)** 이다
#   (sync_assignee_accounts: username=사번, display_name=이름). 수동 생성 계정은 임의 username.
#   그런데 work item 의 담당자 필드(primary/secondary_assignee)에는 담당자 **이름**이 저장된다
#   (WorkItemForm 이 assignee.name 을 값으로 사용). 즉 신원 키가 필드마다 다르다.
#
# 정책(타협 없음): 소유권은 **유일키인 사번(employeeId) 기준으로 무조건 일치**시킨다.
#   담당자 관리(assignees: [{name, employeeId,...}]) 가 사번↔이름의 1:1 매핑을 보유하므로,
#   로그인 사용자를 이 레지스트리로 브리지해 사번·이름 양쪽 식별자로 확장한 뒤 매칭한다.
#   (담당자 이름/사번 고유성은 update_assignees 에서 강제 → 브리지가 모호하지 않음.)
def _resolve_owner_identities(user: User, db: Session) -> set[str]:
    """로그인 사용자를 대표하는 모든 식별자 집합 — 사번(employeeId)·이름을 담당자 레지스트리로 브리지."""
    ids: set[str] = set()
    if user.username and user.username.strip():
        ids.add(user.username.strip())
    if user.display_name and user.display_name.strip():
        ids.add(user.display_name.strip())
    try:
        setting = db.query(AppSetting).filter(AppSetting.key == "assignees").first()
        registry = setting.value if setting and isinstance(setting.value, list) else []
    except Exception:  # noqa: BLE001 - 레지스트리 조회 실패가 권한 판정 자체를 깨지 않도록
        registry = []
    # 사번 또는 이름 중 하나라도 현재 식별자에 걸리면 같은 담당자의 나머지 키도 본인으로 확장.
    for a in registry:
        if not isinstance(a, dict):
            continue
        emp = str(a.get("employeeId") or a.get("employee_id") or "").strip()
        name = str(a.get("name") or "").strip()
        if (emp and emp in ids) or (name and name in ids):
            if emp:
                ids.add(emp)
            if name:
                ids.add(name)
    return ids


def _assert_ownership(item: WorkItem, user: User, *, op: str, db: Session) -> None:
    """admin 이 아니고 (등록자도 담당자 본인도 아니면) 403. 신원은 사번↔이름 브리지로 판정."""
    if user.role == "admin":
        return
    ids = _resolve_owner_identities(user, db)
    # 본인이 등록한 work item 은 담당자가 아니어도 수정/삭제 허용 (created_by = actor.username).
    if item.created_by and item.created_by in ids:
        return
    # 담당자(이름 저장) 본인 — 사번으로 로그인했어도 브리지된 이름으로 매칭됨.
    # primary/secondary 모두 쉼표 복수 담당자를 허용하므로 분리해서 매칭한다.
    assignee_names = {
        n.strip()
        for raw in (item.primary_assignee, item.secondary_assignee)
        for n in (raw or "").split(",")
        if n.strip()
    }
    if assignee_names & ids:
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={
            "error": "WORK_ITEM_FORBIDDEN",
            "message": f"본인이 등록했거나 담당인 work item 만 {op} 할 수 있습니다.",
            "id": str(item.id),
            "required": "admin role, creator, or self-assignee",
        },
    )


def _local_tz():
    """설정된 서비스 타임존(기본 Asia/Seoul). 한국은 DST 가 없어 고정 +09:00."""
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
    try:
        return ZoneInfo(settings.batch_jobs_timezone)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return ZoneInfo("Asia/Seoul")


def _local_day_bounds_utc(date_str: Optional[str]):
    """KST(서비스 타임존) 기준 '그 날' [00:00, 다음날 00:00) 을 UTC-naive 로 반환.

    started_at/closed_at 은 UTC-naive 로 저장되므로(앱 canonical), '오늘' 경계도
    KST 자정을 UTC 로 변환한 naive 값이어야 KST 사용자의 하루와 일치한다.
    date_str 형식 오류 시 오늘(KST)로 대체. 반환: (start_utc_naive, end_utc_naive, kst_date).
    """
    tz = _local_tz()
    if date_str:
        try:
            d = datetime.strptime(date_str, "%Y-%m-%d").date()
        except ValueError:
            d = datetime.now(tz).date()
    else:
        d = datetime.now(tz).date()
    start_local = datetime(d.year, d.month, d.day, tzinfo=tz)
    end_local = start_local + timedelta(days=1)
    start_utc = start_local.astimezone(timezone.utc).replace(tzinfo=None)
    end_utc = end_local.astimezone(timezone.utc).replace(tzinfo=None)
    return start_utc, end_utc, d


def _not_found(item_id: UUID) -> HTTPException:
    """G-I5: 일관된 404 에러 — code 포함 dict detail."""
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"error": "WORK_ITEM_NOT_FOUND", "message": "Work item not found", "id": str(item_id)},
    )


def _resolve_clusters(db: Session, cluster_ids, cluster_id, cluster_name):
    """다중 대상 클러스터를 정규화한다.

    반환: (ids_str | None, names | None, primary_id(UUID) | None, primary_name(str) | None)
      - cluster_ids 우선, 없으면 단일 cluster_id 를 1개짜리 목록으로.
      - 중복 제거(순서 유지), 이름은 DB 에서 resolve(미존재 id 는 빈 이름).
      - cluster_id/cluster_name 컬럼엔 대표(첫 번째)를 넣어 기존 단일 표시/필터와 호환.
    """
    candidates = list(cluster_ids) if cluster_ids else ([cluster_id] if cluster_id else [])
    seen: set[str] = set()
    ids = []
    for c in candidates:
        if c is None:
            continue
        s = str(c)
        if s in seen:
            continue
        seen.add(s)
        ids.append(c)
    if not ids:
        return None, None, None, cluster_name
    rows = db.query(Cluster).filter(Cluster.id.in_(ids)).all()
    name_by = {str(r.id): r.name for r in rows}
    ids_str = [str(c) for c in ids]
    names = [name_by.get(s, "") for s in ids_str]
    primary_id = ids[0]
    primary_name = names[0] or cluster_name
    return ids_str, names, primary_id, primary_name


def _apply_filters(query, *, type_: Optional[str], cluster_id: Optional[UUID],
                   assignee: Optional[str], category: Optional[str],
                   priority: Optional[str], kanban_status: Optional[str],
                   module: Optional[str], started_from: Optional[date],
                   started_to: Optional[date], closed: Optional[bool],
                   all_attendees: Optional[bool] = None,
                   sprint_id: Optional[UUID] = None):
    if type_:
        query = query.filter(WorkItem.type == type_)
    if all_attendees is True:
        query = query.filter(WorkItem.all_attendees.is_(True))
    if sprint_id is not None:
        query = query.filter(WorkItem.sprint_id == sprint_id)
    if cluster_id:
        # 단일 대표(cluster_id) 또는 다중 목록(cluster_ids) 어느 쪽에 속해도 매칭.
        query = query.filter(or_(
            WorkItem.cluster_id == cluster_id,
            WorkItem.cluster_ids.contains([str(cluster_id)]),
        ))
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
    type: Optional[str] = Query(
        default=None, pattern="^(task|issue|meeting|training|etc)$",
        description="Work item 유형 필터 (task/issue/meeting/training/etc)",
    ),
    cluster_id: UUID | None = Query(default=None, description="대상 클러스터 UUID 필터"),
    assignee: str | None = Query(default=None, description="담당자(primary/secondary/legacy) ILIKE 부분 일치"),
    category: str | None = Query(default=None, description="카테고리 ILIKE 부분 일치"),
    priority: str | None = Query(default=None, description="우선순위 (high/medium/low)"),
    kanban_status: str | None = Query(default=None, description="칸반 상태 (backlog/todo/in_progress/review_test/done)"),
    module: str | None = Query(default=None, description="모듈 (k8s/keycloak/... 또는 frontend MODULE_CONFIG)"),
    started_from: date | None = Query(default=None, description="started_at 시작 (포함)"),
    started_to: date | None = Query(default=None, description="started_at 종료 (포함)"),
    closed: bool | None = Query(default=None, description="true=closed 만, false=open 만, 미지정=전체"),
    all_attendees: bool | None = Query(default=None, description="true=공통업무 항목만"),
    sprint_id: UUID | None = Query(default=None, description="스프린트 ID 필터"),
    # G-C2: 페이지네이션 — 클라이언트가 명시적으로 limit 지정. 기본 100, 최대 500.
    offset: int = Query(default=0, ge=0, description="페이지네이션 offset (0 부터)"),
    limit: int = Query(default=100, ge=1, le=500, description="페이지네이션 limit (1~500, 기본 100)"),
    db: Session = Depends(get_db),
    # G-C1: GET 도 인증 필수 — viewer 까지 허용. operator/admin 이 아닌 익명 접근 차단.
    _: User = Depends(get_current_user),
):
    """Work item 목록 (페이지네이션 + 필터).

    parent_id 가 있는 sub-task 는 결과에서 제외하지 않는다 (한 리스트에서 보고 싶을 수 있어
    그대로 노출). 응답 `total` 은 필터 적용 후 전체 카운트, `data` 는 offset~limit 범위만.
    """
    query = db.query(WorkItem)
    query = _apply_filters(
        query, type_=type, cluster_id=cluster_id, assignee=assignee, category=category,
        priority=priority, kanban_status=kanban_status, module=module,
        started_from=started_from, started_to=started_to, closed=closed,
        all_attendees=all_attendees, sprint_id=sprint_id,
    )
    # G-C2: 진짜 COUNT 쿼리 (limit 이전) + offset/limit 적용.
    total = query.count()
    items = (
        query.order_by(WorkItem.started_at.desc(), WorkItem.created_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return WorkItemListResponse(
        data=items, total=total, offset=offset, limit=limit,
        has_more=(offset + len(items)) < total,
    )


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
    # G-C3: 무인증 bulk export 차단 — operator 만 가능. limit 으로 메모리 cap.
    limit: int = Query(default=5000, ge=1, le=10000, description="최대 export 행 수 (메모리 보호용)"),
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
    request: Request = None,  # noqa: B008 — fastapi DI
):
    """Work item CSV 다운로드 (인증 + limit). 5000행 기본, 최대 10000행.

    G-C3: 이전엔 무인증 + 무제한 bulk export 가 가능했음. 이제 operator role 필수 +
    행 수 cap. 5천행 초과 시 클라이언트는 명시적으로 limit 늘려야 함 (감사 추적).
    """
    query = db.query(WorkItem)
    query = _apply_filters(
        query, type_=type, cluster_id=cluster_id, assignee=assignee, category=category,
        priority=priority, kanban_status=kanban_status, module=module,
        started_from=started_from, started_to=started_to, closed=None,
    )
    items = (
        query.order_by(WorkItem.started_at.desc(), WorkItem.created_at.desc())
        .limit(limit)
        .all()
    )
    audit_logger.record(
        db,
        action="work_item.export_csv",
        actor=actor,
        target_type="work_item",
        target_id=None,
        details={"row_count": len(items), "filters": {
            "type": type, "cluster_id": str(cluster_id) if cluster_id else None,
            "assignee": assignee, "category": category, "priority": priority,
            "kanban_status": kanban_status, "module": module,
        }},
        request=request,
    )

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "유형",
        "담당자(정)",
        "담당자(부)",
        "대상 클러스터",
        "서비스",
        "컴포넌트",
        "모듈(legacy)",
        "분류",
        "라벨",
        "제목",
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
            w.service or "",
            w.component or "",
            w.module or "",
            w.category,
            w.type_label or "",
            w.title or "",
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
def get_today_summary(
    date: Optional[str] = Query(default=None, description="YYYY-MM-DD; 미지정 시 오늘(UTC)"),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),  # G-C1
):
    """오늘의 작업/이슈 요약 — task + issue 모두 대상.

    그룹 키: primary_assignee + secondary_assignee 모두 (한 항목이 두 사람의 그룹에
    동시에 보임). priority 정렬은 의미순(high → medium → low → 그 외).
    """
    # KST(서비스 타임존) 기준 하루 경계를 UTC-naive 로 계산 — 이른 아침(00:00~08:59 KST)
    # 업무가 UTC 로 전날에 걸쳐 전날 그룹으로 빠지던 문제를 없앤다. end 는 배타적(다음날 00:00).
    today_start, today_end, kst_date = _local_day_bounds_utc(date)

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
            WorkItem.started_at < today_end,
        )
        .order_by(WorkItem.primary_assignee, priority_order)
        .all()
    )

    in_progress_items = (
        db.query(WorkItem)
        .filter(
            WorkItem.kanban_status == "in_progress",
            ~((WorkItem.started_at >= today_start) & (WorkItem.started_at < today_end)),
        )
        .order_by(WorkItem.primary_assignee, priority_order)
        .all()
    )

    # 지연(overdue) — 기준일 이전 예정 + 미완료 + (진행중은 위 버킷에 포함되므로 제외).
    overdue_items = (
        db.query(WorkItem)
        .filter(
            WorkItem.started_at < today_start,
            WorkItem.kanban_status.notin_(["done", "in_progress"]),
        )
        .order_by(WorkItem.primary_assignee, priority_order)
        .all()
    )

    assignee_map: dict[str, dict] = {}

    def split_names(raw: str | None) -> list[str]:
        # 담당자 필드에 쉼표로 여러 명이 들어올 수 있다 (예: primary "A,B", secondary "C, D").
        # 한 명씩 분리해 각자의 그룹으로 집계한다.
        if not raw:
            return []
        return [n.strip() for n in raw.split(",") if n.strip()]

    def add_to_groups(item: WorkItem, bucket_key: str) -> None:
        # primary + secondary 모두를 후보로 — 한 항목이 협업자의 그룹에도 표시되도록.
        # 같은 사람이 primary/secondary 둘 다인(혹은 쉼표 중복) 케이스는 중복 제거.
        names: list[str] = []
        for n in split_names(item.primary_assignee or item.assignee):
            if n not in names:
                names.append(n)
        for n in split_names(item.secondary_assignee):
            if n not in names:
                names.append(n)
        if not names:
            names.append("미지정")
        for name in names:
            assignee_map.setdefault(
                name, {"assignee": name, "today_tasks": [], "in_progress_tasks": [], "overdue_tasks": []}
            )
            assignee_map[name][bucket_key].append(item)

    for it in today_items:
        add_to_groups(it, "today_tasks")
    for it in in_progress_items:
        add_to_groups(it, "in_progress_tasks")
    for it in overdue_items:
        add_to_groups(it, "overdue_tasks")

    def serialize(w: WorkItem) -> dict:
        return {
            "id": str(w.id),
            "type": w.type,
            "title": w.title,
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
            "component": w.component,
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
            "overdue_tasks": [serialize(t) for t in g["overdue_tasks"]],
        })
    return {
        "date": kst_date.strftime("%Y-%m-%d"),
        "total_today": len(today_items),
        "total_in_progress": len(in_progress_items),
        "total_overdue": len(overdue_items),
        "groups": result,
    }


@router.get("/{item_id}", response_model=WorkItemResponse)
def get_work_item(
    item_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),  # G-C1
):
    item = db.query(WorkItem).filter(WorkItem.id == item_id).first()
    if not item:
        raise _not_found(item_id)
    return item


@router.get("/{item_id}/similar", response_model=SimilarWorkItemListResponse)
def get_similar_work_items(
    item_id: UUID,
    limit: int = Query(default=5, ge=1, le=20),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """pgvector 코사인 거리 기반 유사 WorkItem 검색 (제목+본문 임베딩).

    대상 WorkItem 또는 후보 쪽 임베딩이 아직 계산되지 않았으면(Celery 대기 중)
    ``embedding_available=False`` 와 함께 빈 목록을 반환한다 — 실패가 아니라 "아직 준비 안 됨".
    """
    item = db.query(WorkItem).filter(WorkItem.id == item_id).first()
    if not item:
        raise _not_found(item_id)

    try:
        # item.embedding 은 deferred 컬럼 — 여기서 처음 접근할 때 DB 에서 로드된다.
        # pgvector 확장/embedding 컬럼이 없는 환경(마이그레이션 fail-open)이면 이 시점에
        # UndefinedColumn 이 나므로, "실패"가 아니라 "아직 준비 안 됨"으로 취급한다.
        if item.embedding is None:
            return SimilarWorkItemListResponse(data=[], embedding_available=False)

        distance = WorkItem.embedding.cosine_distance(item.embedding).label("distance")
        rows = (
            db.query(WorkItem, distance)
            .filter(WorkItem.id != item.id)
            .filter(WorkItem.embedding.isnot(None))
            .order_by(distance.asc())
            .limit(limit)
            .all()
        )
    except DBAPIError:
        db.rollback()
        return SimilarWorkItemListResponse(data=[], embedding_available=False)

    return SimilarWorkItemListResponse(
        data=[
            SimilarWorkItem(
                id=row.id,
                type=row.type,
                title=row.title,
                category=row.category,
                assignee=row.assignee,
                cluster_name=row.cluster_name,
                similarity=max(0.0, 1.0 - dist),
            )
            for row, dist in rows
        ],
        embedding_available=True,
    )


@router.post("", response_model=WorkItemResponse, status_code=status.HTTP_201_CREATED)
def create_work_item(
    payload: WorkItemCreate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
    request: Request = None,  # noqa: B008
):
    # 다중 대상 클러스터 정규화 (cluster_id/cluster_name 은 대표값 유지).
    cluster_ids_norm, cluster_names_norm, primary_cluster_id, primary_cluster_name = _resolve_clusters(
        db, payload.cluster_ids, payload.cluster_id, payload.cluster_name,
    )

    primary_assignee = (payload.primary_assignee or payload.assignee).strip()
    secondary_assignee = payload.secondary_assignee.strip() if payload.secondary_assignee else None
    overridden = {"cluster_name", "cluster_id", "cluster_ids",
                  "assignee", "primary_assignee", "secondary_assignee"}
    item = WorkItem(
        **{k: v for k, v in payload.model_dump().items() if k not in overridden},
        assignee=primary_assignee,
        primary_assignee=primary_assignee,
        secondary_assignee=secondary_assignee,
        cluster_id=primary_cluster_id,
        cluster_name=primary_cluster_name,
        cluster_ids=cluster_ids_norm,
        cluster_names=cluster_names_norm,
        created_by=actor.username,  # 등록자 기록 — 본인 삭제/수정 권한 판정에 사용
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    # G-C5: audit log
    audit_logger.record(
        db, action="work_item.create", actor=actor,
        target_type="work_item", target_id=item.id,
        details={"type": item.type, "category": item.category,
                 "primary_assignee": item.primary_assignee,
                 "cluster_id": str(item.cluster_id) if item.cluster_id else None},
        request=request,
    )
    _queue_embedding_recompute(item.id)  # 비동기 — 쓰기 응답 속도에 영향 없음
    return item


@router.put("/{item_id}", response_model=WorkItemResponse)
def update_work_item(
    item_id: UUID,
    payload: WorkItemUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
    request: Request = None,  # noqa: B008
):
    item = db.query(WorkItem).filter(WorkItem.id == item_id).first()
    if not item:
        raise _not_found(item_id)

    _assert_ownership(item, actor, op="수정", db=db)  # G-C4

    update_data = payload.model_dump(exclude_unset=True)
    if "primary_assignee" in update_data:
        update_data["assignee"] = update_data["primary_assignee"]
    elif "assignee" in update_data:
        update_data["primary_assignee"] = update_data["assignee"]

    # 클러스터(단일/다중) 변경 시 대표값 + 목록을 함께 재계산.
    if "cluster_ids" in update_data or "cluster_id" in update_data:
        ids_str, names, primary_id, primary_name = _resolve_clusters(
            db,
            update_data.get("cluster_ids"),
            update_data.get("cluster_id"),
            update_data.get("cluster_name"),
        )
        update_data["cluster_id"] = primary_id
        update_data["cluster_name"] = primary_name
        update_data["cluster_ids"] = ids_str
        update_data["cluster_names"] = names

    for key, value in update_data.items():
        setattr(item, key, value)

    # done 전이 시 closed_at 자동 관리 — PATCH /status 규약과 통일.
    # 정식 폼 수정으로 done 저장 시 완료일이 비면 자동 채우고(미해결 KPI/성장 막대 오탐 방지),
    # done 에서 벗어나면(재오픈) 명시 입력이 없을 때 완료일을 해제한다.
    if "kanban_status" in update_data:
        if update_data["kanban_status"] == "done":
            if not item.closed_at:
                item.closed_at = datetime.utcnow()
        elif "closed_at" not in update_data:
            item.closed_at = None

    db.commit()
    db.refresh(item)
    # G-C5: audit log — 변경된 필드만 기록 (전체 dump 는 PII 누출 위험)
    audit_logger.record(
        db, action="work_item.update", actor=actor,
        target_type="work_item", target_id=item.id,
        details={"changed_fields": sorted(update_data.keys())},
        request=request,
    )
    # 제목/본문이 바뀐 경우에만 임베딩 재계산 큐잉 — 무관한 필드 변경(상태/담당자 등)마다
    # 매번 Ollama 를 호출하지 않도록.
    if "title" in update_data or "content" in update_data:
        _queue_embedding_recompute(item.id)
    return item


@router.patch("/{item_id}/status", response_model=WorkItemStatusResponse)
def patch_status(
    item_id: UUID,
    payload: WorkItemStatusPatch,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
    request: Request = None,  # noqa: B008
):
    """칸반 상태 이동 — type 무관 in_progress 총합으로 WIP 체크. done 이동 시 closed_at 자동 set."""
    item = db.query(WorkItem).filter(WorkItem.id == item_id).first()
    if not item:
        raise _not_found(item_id)

    _assert_ownership(item, actor, op="상태 변경", db=db)  # G-C4

    prev_status = item.kanban_status
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
    # G-C5: audit log
    audit_logger.record(
        db, action="work_item.status_change", actor=actor,
        target_type="work_item", target_id=item.id,
        details={"from": prev_status, "to": payload.kanban_status, "wip_warning": wip_warning},
        request=request,
    )
    return WorkItemStatusResponse(data=item, wip_warning=wip_warning)


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_work_item(
    item_id: UUID,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
    request: Request = None,  # noqa: B008
):
    item = db.query(WorkItem).filter(WorkItem.id == item_id).first()
    if not item:
        raise _not_found(item_id)

    _assert_ownership(item, actor, op="삭제", db=db)  # G-C4

    # G-C5: audit log — 삭제 직전 메타 캡처 (delete 후엔 못 읽음)
    audit_details = {
        "type": item.type, "category": item.category,
        "primary_assignee": item.primary_assignee,
        "cluster_id": str(item.cluster_id) if item.cluster_id else None,
        "had_subtasks": bool(item.subtasks),
    }
    target_id_snapshot = item.id

    db.delete(item)
    db.commit()

    audit_logger.record(
        db, action="work_item.delete", actor=actor,
        target_type="work_item", target_id=target_id_snapshot,
        details=audit_details, request=request,
    )
    return None


# ── 댓글 (협업 코멘트) ────────────────────────────────────────────────────────
@router.get("/{item_id}/comments", response_model=list[WorkItemCommentResponse])
def list_comments(
    item_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return (
        db.query(WorkItemComment)
        .filter(WorkItemComment.work_item_id == item_id)
        .order_by(WorkItemComment.created_at.asc())
        .all()
    )


@router.post("/{item_id}/comments", response_model=WorkItemCommentResponse,
             status_code=status.HTTP_201_CREATED)
def add_comment(
    item_id: UUID,
    payload: WorkItemCommentCreate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    item = db.query(WorkItem).filter(WorkItem.id == item_id).first()
    if not item:
        raise _not_found(item_id)
    comment = WorkItemComment(
        work_item_id=item_id,
        author=actor.username,
        author_name=actor.display_name,
        body=payload.body.strip(),
    )
    db.add(comment)
    db.commit()
    db.refresh(comment)
    # 담당자/등록자에게 개인 알림(알림 종) — 실패해도 댓글 자체엔 영향 없음.
    try:
        from app.services.user_notify import notify_work_item_comment
        notify_work_item_comment(db, item, actor, comment)
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
    return comment


@router.delete("/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_comment(
    comment_id: UUID,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    comment = db.query(WorkItemComment).filter(WorkItemComment.id == comment_id).first()
    if not comment:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "COMMENT_NOT_FOUND", "message": "Comment not found", "id": str(comment_id)},
        )
    # 작성자 본인 또는 admin 만 삭제.
    if actor.role != "admin" and comment.author and comment.author != actor.username:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "COMMENT_FORBIDDEN", "message": "본인이 작성한 댓글만 삭제할 수 있습니다."},
        )
    db.delete(comment)
    db.commit()
    return None


# ── 변경 이력 (활동 로그) — audit_logs 재활용 ─────────────────────────────────
@router.get("/{item_id}/activities")
def list_activities(
    item_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """이 업무의 생성/수정/상태변경 이력(audit_logs)을 시간순으로 반환."""
    rows = (
        db.query(AuditLog)
        .filter(AuditLog.target_type == "work_item", AuditLog.target_id == str(item_id))
        .order_by(AuditLog.created_at.asc())
        .all()
    )
    return [
        {
            "id": r.id,
            "action": r.action,
            "actor": r.actor_username,
            "details": r.details,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


# ── 날짜별 시간 블록 (time blocks) ──────────────────────────────────────────────
# 업무의 전체 기간(started_at~closed_at) 안에서 날짜별 실제 작업 시간대를 관리한다.
# 시각은 자정 기준 분(0..1440)으로 저장 — timezone 모호성 제거.

@router.get("/time-blocks/range", response_model=list[TimeBlockResponse])
def list_time_blocks_range(
    start: date = Query(..., description="조회 시작일 (YYYY-MM-DD)"),
    end: date = Query(..., description="조회 종료일 (YYYY-MM-DD, 포함)"),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    """기간 내 모든 업무의 시간 블록 — 당일 스케줄 보드용. 프런트가 work item 과 join."""
    if end < start:
        raise HTTPException(status_code=422, detail="end 가 start 보다 빠릅니다.")
    return (
        db.query(WorkItemTimeBlock)
        .filter(WorkItemTimeBlock.block_date >= start, WorkItemTimeBlock.block_date <= end)
        .order_by(WorkItemTimeBlock.block_date.asc(), WorkItemTimeBlock.start_minute.asc())
        .all()
    )


@router.get("/{item_id}/time-blocks", response_model=list[TimeBlockResponse])
def list_item_time_blocks(
    item_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    if not db.query(WorkItem).filter(WorkItem.id == item_id).first():
        raise HTTPException(status_code=404, detail="Work item not found")
    return (
        db.query(WorkItemTimeBlock)
        .filter(WorkItemTimeBlock.work_item_id == item_id)
        .order_by(WorkItemTimeBlock.block_date.asc(), WorkItemTimeBlock.start_minute.asc())
        .all()
    )


@router.post("/{item_id}/time-blocks", response_model=TimeBlockResponse, status_code=status.HTTP_201_CREATED)
def create_time_block(
    item_id: UUID,
    payload: TimeBlockCreate,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    if not db.query(WorkItem).filter(WorkItem.id == item_id).first():
        raise HTTPException(status_code=404, detail="Work item not found")
    block = WorkItemTimeBlock(
        work_item_id=item_id,
        block_date=payload.block_date,
        start_minute=payload.start_minute,
        end_minute=payload.end_minute,
        note=payload.note,
    )
    db.add(block)
    try:
        db.commit(); db.refresh(block)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=500, detail=f"시간 블록 저장 실패: {str(e)[:200]}") from e
    return block


@router.patch("/time-blocks/{block_id}", response_model=TimeBlockResponse)
def update_time_block(
    block_id: UUID,
    payload: TimeBlockUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    block = db.query(WorkItemTimeBlock).filter(WorkItemTimeBlock.id == block_id).first()
    if not block:
        raise HTTPException(status_code=404, detail="Time block not found")
    data = payload.model_dump(exclude_unset=True)
    for field, val in data.items():
        setattr(block, field, val)
    # 순서 검증 (수정 후)
    if block.end_minute <= block.start_minute:
        raise HTTPException(status_code=422, detail="end_minute 은 start_minute 보다 커야 합니다.")
    try:
        db.commit(); db.refresh(block)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=500, detail=f"시간 블록 수정 실패: {str(e)[:200]}") from e
    return block


@router.delete("/time-blocks/{block_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_time_block(
    block_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    block = db.query(WorkItemTimeBlock).filter(WorkItemTimeBlock.id == block_id).first()
    if not block:
        raise HTTPException(status_code=404, detail="Time block not found")
    db.delete(block)
    db.commit()
    return None
