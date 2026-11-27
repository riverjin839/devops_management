"""알람 등록 요청 — `/alarm-requests`.

- 목록·상세·카탈로그 조회: 로그인 사용자 전체(요청 게시판은 공개, 볼 수 없는 클러스터는 이름을 가린다).
- 요청 등록: 로그인 사용자 전체(서비스 담당자). 요청자는 로그인 사용자로 고정.
- 수정·취소: 요청자 본인 또는 관리자, ``requested`` 상태에서만.
- 처리(검토 시작·승인·반려·반영 완료)와 카탈로그 편집: operator 이상.

클러스터에 명령을 보내지 않는다 — 「반영 완료」는 처리 기록 + 카탈로그 기본 임계치 갱신이다.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user, require_operator
from app.database import get_db
from app.models.alarm_request import AlarmCatalogItem, AlarmRequest
from app.models.user import User
from app.schemas.alarm_request import (
    AlarmCatalogItemIn,
    AlarmCatalogItemOut,
    AlarmRequestStatusIn,
    AlarmRequestIn,
    AlarmRequestListOut,
    AlarmRequestMeta,
    AlarmRequestOut,
)
from app.services import alarm_requests as svc
import asyncio
import uuid as _uuid

from app.schemas.alarm_request import AlarmApplySettings, RulePreviewItem
from app.services import alarm_rule_apply as rule_apply
from app.services import audit_logger, command_trace
from app.services.cluster_access import hidden_cluster_ids, require_cluster_access

router = APIRouter(prefix="/alarm-requests", tags=["alarm-requests"])


def _get_or_404(db: Session, req_id: int) -> AlarmRequest:
    req = db.query(AlarmRequest).filter(AlarmRequest.id == req_id).first()
    if not req:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="알람 등록 요청을 찾을 수 없습니다.")
    return req


def _out(db: Session, user: User, req: AlarmRequest) -> dict:
    return svc.serialize(req, hidden_cluster_ids(db, user), command_trace.is_admin_user(user))


def _catalog_or_404(db: Session, item_id: int) -> AlarmCatalogItem:
    item = db.query(AlarmCatalogItem).filter(AlarmCatalogItem.id == item_id).first()
    if not item:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="알람 카탈로그 항목을 찾을 수 없습니다.")
    return item


# ── 메타·카탈로그 ────────────────────────────────────────────────────────────
@router.get("/meta", response_model=AlarmRequestMeta)
def get_meta(db: Session = Depends(get_db)):
    return {"services": svc.service_list(db), "statuses": svc.STATUSES, "severities": svc.SEVERITIES}


@router.get("/catalog", response_model=list[AlarmCatalogItemOut])
def list_catalog(
    service: str | None = Query(default=None),
    include_disabled: bool = Query(default=False),
    db: Session = Depends(get_db),
):
    q = db.query(AlarmCatalogItem)
    if service:
        q = q.filter(AlarmCatalogItem.service == service)
    if not include_disabled:
        q = q.filter(AlarmCatalogItem.enabled.is_(True))
    return q.order_by(AlarmCatalogItem.service, AlarmCatalogItem.metric_name).all()


def _catalog_payload(payload: AlarmCatalogItemIn) -> dict:
    data = payload.model_dump(by_alias=True)
    data["service"] = data["service"].strip()
    data["metric_name"] = data["metric_name"].strip()
    return data


@router.post("/catalog", response_model=AlarmCatalogItemOut, status_code=status.HTTP_201_CREATED)
def create_catalog_item(
    payload: AlarmCatalogItemIn, request: Request,
    db: Session = Depends(get_db), actor: User = Depends(require_operator),
):
    data = _catalog_payload(payload)
    dup = db.query(AlarmCatalogItem.id).filter(
        AlarmCatalogItem.service == data["service"], AlarmCatalogItem.metric_name == data["metric_name"]).first()
    if dup:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="같은 서비스에 같은 알람 항목이 이미 있습니다.")
    item = AlarmCatalogItem(**data, updated_by=svc.display_name(actor))
    db.add(item)
    db.commit()
    db.refresh(item)
    audit_logger.record(db, action="alarm_catalog.create", actor=actor, target_type="alarm_catalog_item",
                        target_id=item.id, details={"service": item.service, "metric": item.metric_name}, request=request)
    return item


@router.put("/catalog/{item_id}", response_model=AlarmCatalogItemOut)
def update_catalog_item(
    item_id: int, payload: AlarmCatalogItemIn, request: Request,
    db: Session = Depends(get_db), actor: User = Depends(require_operator),
):
    item = _catalog_or_404(db, item_id)
    data = _catalog_payload(payload)
    dup = db.query(AlarmCatalogItem.id).filter(
        AlarmCatalogItem.service == data["service"], AlarmCatalogItem.metric_name == data["metric_name"],
        AlarmCatalogItem.id != item_id).first()
    if dup:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="같은 서비스에 같은 알람 항목이 이미 있습니다.")
    for k, v in data.items():
        setattr(item, k, v)
    item.updated_by = svc.display_name(actor)
    db.commit()
    db.refresh(item)
    audit_logger.record(db, action="alarm_catalog.update", actor=actor, target_type="alarm_catalog_item",
                        target_id=item.id, details={"service": item.service, "metric": item.metric_name}, request=request)
    return item


@router.delete("/catalog/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_catalog_item(
    item_id: int, request: Request,
    db: Session = Depends(get_db), actor: User = Depends(require_operator),
):
    item = _catalog_or_404(db, item_id)
    details = {"service": item.service, "metric": item.metric_name}
    db.delete(item)
    db.commit()
    audit_logger.record(db, action="alarm_catalog.delete", actor=actor, target_type="alarm_catalog_item",
                        target_id=item_id, details=details, request=request)
    return None


# ── PrometheusRule 적용 설정 ────────────────────────────────────────────────
@router.get("/apply-settings", response_model=AlarmApplySettings)
def get_apply_settings(db: Session = Depends(get_db)):
    """PrometheusRule 을 어디에·어떤 라벨로 만들지(AppSetting ``alarm_requests.apply``)."""
    return rule_apply.to_api(rule_apply.get_settings(db))


@router.put("/apply-settings", response_model=AlarmApplySettings)
def put_apply_settings(
    payload: AlarmApplySettings, request: Request,
    db: Session = Depends(get_db), actor: User = Depends(require_operator),
):
    try:
        saved = rule_apply.save_settings(db, rule_apply.from_api(payload.model_dump()))
    except rule_apply.ApplySettingsError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))
    audit_logger.record(db, action="alarm_request.apply_settings", actor=actor, target_type="app_setting",
                        target_id=rule_apply.SETTINGS_KEY, details={"namespace": saved["namespace"]}, request=request)
    return rule_apply.to_api(saved)


# ── 요청 ─────────────────────────────────────────────────────────────────────
@router.get("", response_model=AlarmRequestListOut)
def list_requests(
    status_filter: str | None = Query(default=None, alias="status"),
    service: str | None = Query(default=None),
    mine: bool = Query(default=False),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    q = db.query(AlarmRequest)
    if status_filter:
        q = q.filter(AlarmRequest.status == status_filter)
    if service:
        q = q.filter(AlarmRequest.service == service)
    if mine:
        q = q.filter(AlarmRequest.requested_by == user.username)
    rows = q.order_by(AlarmRequest.id.desc()).limit(1000).all()
    hidden = hidden_cluster_ids(db, user)
    is_admin = command_trace.is_admin_user(user)
    data = [svc.serialize(r, hidden, is_admin) for r in rows]
    return {"data": data, "total": len(data)}


@router.get("/{req_id}", response_model=AlarmRequestOut)
def get_request(req_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _out(db, user, _get_or_404(db, req_id))


@router.post("", response_model=AlarmRequestOut, status_code=status.HTTP_201_CREATED)
def create_request(
    payload: AlarmRequestIn, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    clusters = svc.resolve_clusters(db, user, payload.cluster_ids)
    thresholds = svc.normalize_thresholds(payload.thresholds)
    req = AlarmRequest(
        status="in_progress", service=payload.service.strip(), metric_name=payload.metric_name.strip(),
        meaning=payload.meaning.strip(),
        catalog_item_id=svc.catalog_id_for(db, payload.service, payload.metric_name),
        thresholds=thresholds, clusters=clusters, note=(payload.note or "").strip() or None,
        requested_by=user.username, requester_name=svc.display_name(user), history=[],
    )
    svc.add_history(req, user, "created")
    db.add(req)
    db.commit()
    db.refresh(req)
    audit_logger.record(db, action="alarm_request.create", actor=user, target_type="alarm_request",
                        target_id=req.id, details={"service": req.service, "metric": req.metric_name}, request=request)
    svc.notify_created(db, req)
    return _out(db, user, req)


def _require_editable(req: AlarmRequest, user: User) -> None:
    if req.requested_by != user.username and not svc.is_staff(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="본인 요청만 수정·취소할 수 있습니다.")
    if req.status != "in_progress":
        raise HTTPException(status.HTTP_409_CONFLICT, detail="「진행」 상태인 요청만 수정·취소할 수 있습니다.")


@router.put("/{req_id}", response_model=AlarmRequestOut)
def update_request(
    req_id: int, payload: AlarmRequestIn, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    req = _get_or_404(db, req_id)
    _require_editable(req, user)
    req.clusters = svc.resolve_clusters(db, user, payload.cluster_ids)
    req.thresholds = svc.normalize_thresholds(payload.thresholds)
    req.service = payload.service.strip()
    req.metric_name = payload.metric_name.strip()
    req.meaning = payload.meaning.strip()
    req.catalog_item_id = svc.catalog_id_for(db, req.service, req.metric_name)
    req.note = (payload.note or "").strip() or None
    svc.add_history(req, user, "updated")
    db.commit()
    db.refresh(req)
    audit_logger.record(db, action="alarm_request.update", actor=user, target_type="alarm_request",
                        target_id=req.id, request=request)
    return _out(db, user, req)


@router.delete("/{req_id}", status_code=status.HTTP_204_NO_CONTENT)
def cancel_request(
    req_id: int, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    req = _get_or_404(db, req_id)
    _require_editable(req, user)
    details = {"service": req.service, "metric": req.metric_name}
    db.delete(req)
    db.commit()
    audit_logger.record(db, action="alarm_request.cancel", actor=user, target_type="alarm_request",
                        target_id=req_id, details=details, request=request)
    return None


@router.post("/{req_id}/status", response_model=AlarmRequestOut)
def change_status(
    req_id: int, payload: AlarmRequestStatusIn, request: Request,
    db: Session = Depends(get_db), actor: User = Depends(require_operator),
):
    """상태 항목(진행·완료·반려) 변경 — 완료로 바꾸면 수정 임계치가 카탈로그 기본값이 된다. 반려는 사유 필수."""
    req = _get_or_404(db, req_id)
    svc.set_status(db, req, actor, payload.status, payload.comment)
    db.commit()
    db.refresh(req)
    audit_logger.record(db, action=f"alarm_request.status.{payload.status}", actor=actor, target_type="alarm_request",
                        target_id=req.id, details={"comment": payload.comment} if payload.comment else None,
                        request=request)
    svc.notify_status(db, req, actor)
    return _out(db, actor, req)


# ── PrometheusRule 미리보기·적용 ─────────────────────────────────────────────
@router.get("/{req_id}/rule-preview", response_model=list[RulePreviewItem])
def rule_preview(req_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """적용하면 클러스터마다 만들어질 PrometheusRule YAML(클러스터에 아무것도 보내지 않는다)."""
    req = _get_or_404(db, req_id)
    hidden = hidden_cluster_ids(db, user)
    items = rule_apply.preview(db, req)
    return [i for i in items if _uuid.UUID(str(i["cluster_id"])) not in hidden]


@router.post("/{req_id}/apply-rules/stream")
async def apply_rules_stream(
    req_id: int, request: Request,
    db: Session = Depends(get_db), actor: User = Depends(require_operator),
):
    """진행·완료 요청을 적용 클러스터마다 PrometheusRule 로 만든다 — SSE 실시간 로그(실제 K8S API 호출은 관리자에게 cmd 줄)."""
    from app.services.sse import stream_async_job

    req = _get_or_404(db, req_id)
    if req.status == "rejected":
        raise HTTPException(status.HTTP_409_CONFLICT, detail="반려된 요청은 클러스터에 적용할 수 없습니다.")
    if not rule_apply.effective_rules(req):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="적용할 expr 이 없습니다.")
    cluster_ids = [_uuid.UUID(str(c.get("id"))) for c in req.clusters or []]
    for cid in cluster_ids:
        require_cluster_access(db, actor, cid, "operate")
    audit_logger.record(db, action="alarm_request.apply_rules", actor=actor, target_type="alarm_request",
                        target_id=req.id, details={"clusters": [c.get("name") for c in req.clusters or []]},
                        request=request)
    actor_id = actor.id

    async def job(sdb: Session, emit):
        def work() -> dict:
            r = sdb.query(AlarmRequest).filter(AlarmRequest.id == req_id).one()
            a = sdb.query(User).filter(User.id == actor_id).one()
            if r.status == "rejected":
                raise HTTPException(status.HTTP_409_CONFLICT, detail="다른 사용자가 먼저 반려했습니다.")
            before = r.status
            out = rule_apply.run_apply(sdb, r, a, emit)
            if r.status != before:
                svc.notify_status(sdb, r, a)
            return out

        # to_thread 는 ContextVar(실행 명령 기록 sink)를 작업 스레드로 넘긴다.
        return await asyncio.to_thread(work)

    return stream_async_job(job, name=f"alarm-request-apply-{req_id}")
