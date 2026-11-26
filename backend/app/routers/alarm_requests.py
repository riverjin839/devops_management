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
    AlarmRequestAction,
    AlarmRequestIn,
    AlarmRequestListOut,
    AlarmRequestMeta,
    AlarmRequestOut,
)
from app.services import alarm_requests as svc
from app.services import audit_logger
from app.services.cluster_access import hidden_cluster_ids

router = APIRouter(prefix="/alarm-requests", tags=["alarm-requests"])


def _get_or_404(db: Session, req_id: int) -> AlarmRequest:
    req = db.query(AlarmRequest).filter(AlarmRequest.id == req_id).first()
    if not req:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="알람 등록 요청을 찾을 수 없습니다.")
    return req


def _out(db: Session, user: User, req: AlarmRequest) -> dict:
    return svc.serialize(req, hidden_cluster_ids(db, user))


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
    data = [svc.serialize(r, hidden) for r in rows]
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
        status="requested", service=payload.service.strip(), metric_name=payload.metric_name.strip(),
        meaning=payload.meaning.strip(), catalog_item_id=payload.catalog_item_id,
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
    if req.status != "requested":
        raise HTTPException(status.HTTP_409_CONFLICT, detail="검토가 시작된 요청은 수정·취소할 수 없습니다.")


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
    req.catalog_item_id = payload.catalog_item_id
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


@router.post("/{req_id}/action", response_model=AlarmRequestOut)
def act_on_request(
    req_id: int, payload: AlarmRequestAction, request: Request,
    db: Session = Depends(get_db), actor: User = Depends(require_operator),
):
    req = _get_or_404(db, req_id)
    svc.apply_action(db, req, actor, payload.action, payload.comment)
    db.commit()
    db.refresh(req)
    audit_logger.record(db, action=f"alarm_request.{payload.action}", actor=actor, target_type="alarm_request",
                        target_id=req.id, details={"comment": payload.comment} if payload.comment else None,
                        request=request)
    svc.notify_status(db, req, actor)
    return _out(db, actor, req)
