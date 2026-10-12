"""점검 매트릭스 — 항목 CRUD/재정렬, 그리드 조회, cron 설정(항목/클러스터), 셀 이력,
수동 입력, 실행 계획(런북) 조회, 수동 실행(셀/클러스터/항목), 실행 로그, 이력 보관 설정."""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy.orm import Session

from app.auth.deps import get_cluster_scope, require_operator
from app.services import audit_logger
from app.services.cluster_access import ClusterScope, has_cluster_access, require_cluster_access, require_clusters_access
from app.database import get_db
from app.models import (
    CheckMatrixItem,
    CheckMatrixSchedule,
    CheckMatrixSourceType,
    Cluster,
    StatusEnum,
    User,
)
from app.services import check_matrix_service as svc

router = APIRouter(prefix="/check-matrix", tags=["Check Matrix"])

# DB 컬럼 길이(models/check_matrix.py)에 맞춘 입력 제약 — 넘치면 Postgres 오류가 잡히지 않은
# 채 빈 500 으로 터졌다. 앞뒤 공백은 잘라 "공백뿐인 이름" 도 거부한다.
Name150 = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=150)]
Short20 = Annotated[str, StringConstraints(strip_whitespace=True, max_length=20)]
Ref80 = Annotated[str, StringConstraints(strip_whitespace=True, max_length=80)]
Cat50 = Annotated[str, StringConstraints(strip_whitespace=True, max_length=50)]
Cron100 = Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)]


def _audit(db: Session, user: User, action: str, *, target_id: Any = None,
           target_type: str = "check_matrix", details: Optional[dict] = None,
           request: Optional[Request] = None, status: str = "success") -> None:
    """점검 매트릭스의 변경·실행은 전부 감사 로그에 남긴다(실패해도 본 동작은 막지 않음)."""
    audit_logger.record(
        db, action=f"check_matrix.{action}", actor=user, status=status,
        target_type=target_type, target_id=target_id, details=details, request=request,
    )


# ── Schemas ──────────────────────────────────────────────────────────────────
# 행 색은 테마 대응을 위해 차트 토큰 프리셋 키만 허용 (frontend --chart-1..8).
_ALLOWED_ROW_COLORS = {f"chart-{i}" for i in range(1, 9)}


class KeyValueIn(BaseModel):
    """이름을 **값 자리**에 두는 key/value 한 쌍.

    프론트 axios 인터셉터가 요청 본문의 *키* 를 camelCase→snake_case 로 바꾸기 때문에,
    사용자가 정한 이름(ansible extra var 등)을 dict 키로 받으면 조용히 변형된다
    (`myVar` → `my_var`). 런북 inputs 와 같은 회피 패턴이다.
    """
    name: str
    value: str = ""


def _kv_to_dict(entries: Optional[list[KeyValueIn]]) -> dict[str, Any]:
    return {e.name.strip(): e.value for e in (entries or []) if e.name.strip()}


class InventoryPickIn(BaseModel):
    cluster_id: UUID
    inventory_id: UUID


class NewPlaybookIn(BaseModel):
    """등록 마법사에서 그 자리에 만드는 Ansible 플레이북 — "내가 만든 파일을 점검으로".

    저장 시 공용 라이브러리(`AnsiblePlaybookFile`)에 YAML 본문을 넣고, 선택한 클러스터마다
    같은 이름의 `Playbook` 실행 단위를 만든다. 매트릭스 행의 source_ref 는 그 이름이다.
    """
    name: Name150
    content: str = ""
    description: Optional[str] = None
    tags: Optional[str] = None
    extra_vars: Optional[list[KeyValueIn]] = None
    cluster_ids: list[UUID] = Field(default_factory=list)
    # 라이브러리에 같은 이름의 플레이북 파일이 이미 있으면 기본은 409 로 막는다 — 그 파일을 쓰는
    # 다른 클러스터의 플레이북까지 본문이 조용히 바뀌기 때문. 덮어쓰려면 명시적으로 켠다.
    overwrite: bool = False
    # 클러스터별 인벤토리 지정(선택) — 비우면 클러스터 기본 인벤토리, 그것도 없으면
    # K8s 노드 목록으로 동적 생성. 키가 아니라 값 자리에 id 를 둔다(KeyValueIn 과 같은 이유).
    inventories: Optional[list[InventoryPickIn]] = None
    # 라이브러리에 이미 있는 플레이북 파일을 그대로 쓸 때(본문 재작성 없음).
    playbook_file_id: Optional[UUID] = None


class ItemIn(BaseModel):
    name: Name150
    description: Optional[str] = None
    unit: Optional[Short20] = None
    source_type: CheckMatrixSourceType
    source_ref: Optional[Ref80] = None
    category: Optional[Cat50] = None
    # 실제 점검 대상 식별자(예: "etcd") — D-062 "대상 중복 표시". category 와 동일한 자유
    # 문자열, 운영자가 화면에서 직접 입력/수정(하드코딩 enum 아님).
    target_key: Optional[Ref80] = None
    color: Optional[Short20] = None
    enabled: bool = True
    # 배치잡·플레이북·수동 입력 행의 결과를 클러스터 종합 상태에 반영(opt-in).
    affects_cluster_status: bool = False
    # 등록 마법사 전용 — deep_check 항목의 임계값/파라미터 초기값.
    # dedicated_definition=False 면 예전과 같이 "글로벌 정의가 없을 때만" 이 값으로 정의를
    # 만들고, 이미 있으면 조용히 무시한다(= 같은 종류의 다른 행과 설정 공유).
    thresholds: Optional[dict[str, Any]] = None
    params: Optional[dict[str, Any]] = None
    # True 면 이 행 전용 정의를 새로 만들어 물린다 — 같은 점검 종류로 설정이 다른 카드를
    # 여러 장 만들 수 있게 하는 스위치(기본 등록 카드의 커스터마이즈 포함).
    dedicated_definition: bool = False
    # 있으면 이 플레이북을 먼저 등록하고(source_ref = 그 이름) 매트릭스 행을 만든다.
    new_playbook: Optional[NewPlaybookIn] = None


class ItemOut(BaseModel):
    id: UUID
    name: str
    description: Optional[str] = None
    unit: Optional[str] = None
    source_type: CheckMatrixSourceType
    source_ref: Optional[str] = None
    category: Optional[str] = None
    target_key: Optional[str] = None
    color: Optional[str] = None
    # 이 행 전용 deep_check 정의 — 값이 있으면 같은 종류의 다른 행과 설정을 공유하지 않는다.
    definition_id: Optional[UUID] = None
    is_system: bool
    enabled: bool
    affects_cluster_status: bool = False
    sort_order: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ReorderRequest(BaseModel):
    item_ids: list[UUID] = Field(..., min_length=1)


class ScheduleIn(BaseModel):
    cron_expr: Optional[Cron100] = None
    enabled: bool = True


class ScheduleOut(BaseModel):
    item_id: UUID
    cluster_id: UUID
    cron_expr: Optional[str] = None
    enabled: bool
    last_run_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class ClusterCronIn(BaseModel):
    check_cron_expr: Optional[Cron100] = None
    # 저장된 cron 을 지우지 않고 켜고 끄는 스위치 — CheckMatrixSchedule.enabled 와 동일 패턴.
    check_cron_enabled: bool = True


class ManualEntryIn(BaseModel):
    status: StatusEnum
    # NaN/Infinity 는 핸들러에서 422 로 거부한다(_reject_non_finite) — 저장되면 이후 GET /grid 가
    # JSON 직렬화에 실패해 모든 사용자에게 500 이 된다. 스키마 제약(allow_inf_nan=False)으로 막으면
    # 검증 오류 응답 자체가 입력값 NaN 을 직렬화하다 다시 500 이 나서 핸들러에서 처리한다.
    value: Optional[float] = None
    message: Optional[str] = None


class SettingsIn(BaseModel):
    retention_days: int = Field(..., ge=1, le=3650)


def _validate_item_body(body: ItemIn, db: Session) -> None:
    if body.color and body.color not in _ALLOWED_ROW_COLORS:
        raise HTTPException(
            status_code=422,
            detail=f"color 는 chart-1..chart-8 프리셋 키만 허용됩니다: {body.color}",
        )
    if body.source_type == CheckMatrixSourceType.core_bundle:
        raise HTTPException(status_code=400, detail="core_bundle 항목은 시스템에서만 생성/관리됩니다.")
    if body.affects_cluster_status and body.source_type not in (
        CheckMatrixSourceType.batch_job, CheckMatrixSourceType.playbook, CheckMatrixSourceType.manual,
    ):
        raise HTTPException(
            status_code=400,
            detail=("'클러스터 상태에 반영' 은 배치잡·플레이북·수동 입력 항목에서만 켭니다 — 등록된 점검은 "
                    "운영 점검 정의의 '클러스터 상태에 반영', 애드온은 항상 반영됩니다."),
        )
    if body.source_type == CheckMatrixSourceType.deep_check:
        from app.services.registered_checks import REGISTRY
        if not body.source_ref or body.source_ref not in REGISTRY:
            raise HTTPException(status_code=400, detail=f"알 수 없는 check_type: {body.source_ref}")
    if body.source_type == CheckMatrixSourceType.addon:
        from app.services.checkers import CHECKER_REGISTRY
        if not body.source_ref or body.source_ref not in CHECKER_REGISTRY:
            raise HTTPException(status_code=400, detail=f"알 수 없는 addon type: {body.source_ref}")
    if body.source_type == CheckMatrixSourceType.batch_job:
        from app.models import BatchJob
        if not body.source_ref or not db.query(BatchJob).filter(BatchJob.name == body.source_ref).first():
            raise HTTPException(status_code=400, detail=f"등록된 배치잡이 없습니다: {body.source_ref}")
    if body.source_type == CheckMatrixSourceType.playbook:
        from app.models import Playbook
        if not body.source_ref or not db.query(Playbook).filter(Playbook.name == body.source_ref).first():
            raise HTTPException(status_code=400, detail=f"등록된 플레이북이 없습니다: {body.source_ref}")


# ── Items CRUD / reorder ─────────────────────────────────────────────────────
@router.get("/items", response_model=list[ItemOut])
def list_items(db: Session = Depends(get_db)):
    return (
        db.query(CheckMatrixItem)
        .order_by(CheckMatrixItem.sort_order.asc(), CheckMatrixItem.created_at.asc())
        .all()
    )


def _coerce_wizard_values(body: ItemIn) -> None:
    """마법사가 보낸 임계값/파라미터를 spec 타입으로 강제(모르는 키·잘못된 타입은 400)."""
    if body.source_type != CheckMatrixSourceType.deep_check or not body.source_ref:
        return
    from app.services.registered_checks import REGISTRY
    entry = REGISTRY.get(body.source_ref)
    if entry is None:
        return
    spec = entry[1]
    try:
        if body.thresholds:
            body.thresholds = svc.coerce_spec_values(
                spec.threshold_fields, body.thresholds, group="thresholds", ref=body.source_ref)
        if body.params:
            body.params = svc.coerce_spec_values(
                spec.param_fields, body.params, group="params", ref=body.source_ref)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/items", response_model=ItemOut)
def create_item(
    body: ItemIn,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    # 새 플레이북을 함께 등록하는 경우 — 실행 대상(Playbook 행)이 먼저 있어야 검증을 통과한다.
    created_playbook: Optional[dict[str, Any]] = None
    if body.new_playbook is not None:
        if body.source_type != CheckMatrixSourceType.playbook:
            raise HTTPException(status_code=400, detail="new_playbook 은 playbook 실행 방식에서만 사용합니다.")
        # 대상 클러스터는 본문으로 오므로 경로 가드가 보지 못한다 — 직접 operate 권한을 확인한다.
        require_clusters_access(db, user, body.new_playbook.cluster_ids, "operate")
        if body.new_playbook.playbook_file_id is None and not body.new_playbook.overwrite:
            from app.models.ansible_assets import AnsiblePlaybookFile
            if db.query(AnsiblePlaybookFile).filter(AnsiblePlaybookFile.name == body.new_playbook.name).first():
                raise HTTPException(
                    status_code=409,
                    detail=(f"플레이북 라이브러리에 «{body.new_playbook.name}» 이(가) 이미 있습니다 — "
                            "다른 이름을 쓰거나, 라이브러리에서 불러오거나, 덮어쓰기를 선택하세요."),
                )
        try:
            created_playbook = svc.create_playbook_card_targets(
                db,
                name=body.new_playbook.name,
                content=body.new_playbook.content,
                description=body.new_playbook.description,
                tags=body.new_playbook.tags,
                extra_vars=_kv_to_dict(body.new_playbook.extra_vars),
                cluster_ids=body.new_playbook.cluster_ids,
                inventory_ids={
                    str(p.cluster_id): p.inventory_id
                    for p in (body.new_playbook.inventories or [])
                },
                playbook_file_id=body.new_playbook.playbook_file_id,
            )
        except ValueError as e:
            db.rollback()
            raise HTTPException(status_code=400, detail=str(e))
        body.source_ref = created_playbook["name"]

    _validate_item_body(body, db)
    _coerce_wizard_values(body)
    max_sort = (
        db.query(CheckMatrixItem.sort_order)
        .order_by(CheckMatrixItem.sort_order.desc())
        .limit(1)
        .scalar()
    ) or 0
    row = CheckMatrixItem(
        **body.model_dump(exclude={"thresholds", "params", "dedicated_definition", "new_playbook"}),
        is_system=False, sort_order=max_sort + 10,
    )
    db.add(row)
    if body.source_type == CheckMatrixSourceType.deep_check and body.source_ref:
        if body.dedicated_definition:
            # 이 행 전용 정의 — 같은 점검 종류를 쓰는 다른 행의 설정을 건드리지 않는다.
            try:
                definition = svc.create_dedicated_definition(
                    db, body.source_ref,
                    name=body.name, description=body.description,
                    thresholds=body.thresholds, params=body.params,
                )
            except ValueError as e:
                db.rollback()
                raise HTTPException(status_code=400, detail=str(e))
            row.definition_id = definition.id
        else:
            # 공유 정의 — 글로벌 정의가 없으면 이 값으로 함께 생성(기존 동작).
            definition, created = svc.ensure_deep_check_definition(
                db, body.source_ref, body.thresholds, body.params,
            )
            # 공유 정의가 이미 있는데 입력값이 그것과 다르면, 예전엔 입력값을 조용히 버렸다(테스트는
            # 입력값으로 돌고 운영은 기존 값으로 도는 불일치). 입력값을 살리려 이 행 전용으로 분리한다.
            if not created and (
                any((definition.thresholds or {}).get(k) != v for k, v in (body.thresholds or {}).items())
                or any((definition.params or {}).get(k) != v for k, v in (body.params or {}).items())
            ):
                dedicated = svc.create_dedicated_definition(
                    db, body.source_ref, name=body.name, description=body.description,
                    thresholds={**(definition.thresholds or {}), **(body.thresholds or {})},
                    params={**(definition.params or {}), **(body.params or {})},
                )
                row.definition_id = dedicated.id
    db.commit()
    db.refresh(row)
    _audit(db, user, "item.create", target_id=row.id, request=request, details={
        "name": row.name, "source_type": row.source_type.value, "source_ref": row.source_ref,
        "new_playbook": bool(created_playbook),
    })
    return row


@router.put("/items/{item_id}", response_model=ItemOut)
def update_item(
    item_id: UUID,
    body: ItemIn,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    row = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    if row.is_system:
        # 시스템 항목(core_bundle)도 표시 속성(이름/설명/단위/표시 여부)은 고칠 수 있어야 한다.
        # 막는 것은 실행 소스 변경뿐 — Cluster.status 산정 경로가 바뀌면 안 되기 때문.
        if body.source_type != row.source_type or (body.source_ref or None) != (row.source_ref or None):
            raise HTTPException(
                status_code=400,
                detail="시스템 항목은 실행 소스(source_type/source_ref)를 바꿀 수 없습니다 — 이름/설명/단위/표시 여부만 수정 가능합니다.",
            )
        if body.color and body.color not in _ALLOWED_ROW_COLORS:
            raise HTTPException(status_code=422, detail=f"color 는 chart-1..chart-8 만 허용: {body.color}")
        row.name = body.name
        row.description = body.description
        row.unit = body.unit
        row.category = body.category
        row.target_key = body.target_key
        row.color = body.color
        row.enabled = body.enabled
        db.commit()
        db.refresh(row)
        _audit(db, user, "item.update", target_id=row.id, request=request, details={"name": row.name})
        return row
    _validate_item_body(body, db)
    # 실행 소스를 바꾸면 이전 행 전용 정의는 더 이상 이 행의 것이 아니다 — 연결만 끊는다
    # (정의 자체는 남기고 운영 점검 화면에서 정리하게 둔다). 판정은 덮어쓰기 전에 한다.
    source_changed = (
        body.source_type != row.source_type
        or (body.source_ref or None) != (row.source_ref or None)
    )
    old_definition_id = row.definition_id
    old_affects = bool(row.affects_cluster_status)
    for k, v in body.model_dump(
        exclude={"thresholds", "params", "dedicated_definition", "new_playbook"},
    ).items():
        setattr(row, k, v)
    if source_changed:
        # 이전 소스의 값·이력이 새 점검의 셀에 섞여 보이지 않게 비우고, 이전 행 전용 정의는
        # 정리한다(남겨 두면 공유 정의로 오인돼 같은 종류의 다른 행을 오염시킨다).
        row.definition_id = None
        db.flush()
        if old_definition_id:
            svc.delete_dedicated_definition(db, old_definition_id)
        svc.reset_item_cells(db, row)
        if row.source_type == CheckMatrixSourceType.deep_check and row.source_ref:
            # 생성 경로와 같이 실행할 정의를 보장한다 — 없으면 모든 셀이 "정의 없음" 으로 건너뛴다.
            svc.ensure_deep_check_definition(db, row.source_ref)
    db.commit()
    db.refresh(row)
    if old_affects != bool(row.affects_cluster_status) or (old_affects and (source_changed or not row.enabled)):
        # 반영 여부가 바뀌면 이 행이 걸린 모든 클러스터의 종합 상태를 다시 계산한다.
        from app.services import cluster_status_service
        for (cid,) in db.query(Cluster.id).all():
            try:
                cluster_status_service.recompute(db, cid)
            except Exception:  # noqa: BLE001
                db.rollback()
    _audit(db, user, "item.update", target_id=row.id, request=request, details={
        "name": row.name, "source_changed": source_changed,
        "source_type": row.source_type.value, "source_ref": row.source_ref,
    })
    return row


@router.delete("/items/{item_id}")
def delete_item(
    item_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    row = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    if row.is_system:
        raise HTTPException(
            status_code=400,
            detail="시스템 항목은 삭제할 수 없습니다 — 클러스터 상태 계산에 사용됩니다. 대신 비활성화로 그리드에서 숨길 수 있습니다.",
        )
    definition_id = row.definition_id
    name = row.name
    db.delete(row)
    db.flush()
    if definition_id:
        svc.delete_dedicated_definition(db, definition_id)
    db.commit()
    _audit(db, user, "item.delete", target_id=item_id, request=request, details={"name": name})
    return {"status": "ok"}


@router.post("/items/reorder")
def reorder_items(body: ReorderRequest, db: Session = Depends(get_db), _: User = Depends(require_operator)):
    """순서 일괄 갱신 — 받은 순서대로, 목록에 없는 항목은 기존 순서를 유지한 채 뒤에 붙여
    **전체**를 10 간격으로 재할당한다.

    예전엔 받은 id 만 1000 부터 다시 매겨, 화면을 연 뒤 다른 사람이 추가한 항목(목록에 없음)이
    낮은 sort_order 로 남아 맨 위로 튀었다. 한 번에 전부 읽어 id 당 쿼리도 없앤다.
    """
    if len(set(body.item_ids)) != len(body.item_ids):
        raise HTTPException(status_code=422, detail="item_ids 에 중복 id 가 포함되어 있습니다.")
    rows = (
        db.query(CheckMatrixItem)
        .order_by(CheckMatrixItem.sort_order.asc(), CheckMatrixItem.created_at.asc())
        .all()
    )
    by_id = {r.id: r for r in rows}
    missing = [iid for iid in body.item_ids if iid not in by_id]
    if missing:
        raise HTTPException(status_code=404, detail=f"CheckMatrixItem {missing[0]} not found")
    requested = set(body.item_ids)
    ordered = [by_id[iid] for iid in body.item_ids] + [r for r in rows if r.id not in requested]
    for i, row in enumerate(ordered):
        row.sort_order = (i + 1) * 10
    db.commit()
    return {"updated": len(ordered)}


@router.get("/items/{item_id}/detail")
def get_item_detail(
    item_id: UUID,
    db: Session = Depends(get_db),
    scope: ClusterScope = Depends(get_cluster_scope),
):
    """항목 상세(``/checks/:itemId``, R-4 6차 라운드 4단계) — 이 항목의 클러스터별 cron/최근 결과.

    테넌트 바인딩으로 가려진 클러스터는 셀 목록에서 뺀다(그리드와 같은 범위).
    """
    out = svc.item_detail(db, item_id, hidden_cluster_ids=scope.hidden)
    if out is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    return out


class ItemSourceConfigIn(BaseModel):
    """항목(행) 단위 임계값/파라미터 저장 — 값은 spec 필드 타입 그대로(문자열 아님)."""
    thresholds: Optional[dict[str, Any]] = None
    params: Optional[dict[str, Any]] = None
    # True 면 이 행 전용 정의로 분리해서 저장(공유 정의는 그대로 둔다).
    dedicated: bool = False


@router.get("/items/{item_id}/source-config")
def get_item_source_config(item_id: UUID, db: Session = Depends(get_db)):
    """행의 실행 설정(임계값/파라미터) + 편집 폼 스펙 — 기본 등록 카드도 확인·수정 가능하게."""
    item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item_id).first()
    if item is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    return svc.item_source_config(db, item)


@router.put("/items/{item_id}/source-config")
def put_item_source_config(
    item_id: UUID,
    body: ItemSourceConfigIn,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    """행의 실행 설정 저장. ``dedicated`` 면 이 행 전용 정의로 분리(copy-on-write).

    공유 정의(같은 점검 종류의 다른 행·전 클러스터가 함께 쓰는 정의)를 그대로 고치는 것은
    admin 만 할 수 있다 — operator 가 자기 테넌트 밖 클러스터의 동작까지 바꾸는 것을 막는다.
    operator 는 "이 항목 전용으로 분리" 해서 저장한다.
    """
    item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item_id).first()
    if item is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    if not body.dedicated and not item.definition_id and user.role != "admin":
        raise HTTPException(
            status_code=403,
            detail=("공유 설정(같은 점검 종류를 쓰는 모든 항목·클러스터에 적용)은 admin 만 바꿀 수 있습니다 — "
                    "'이 항목 전용 설정으로 분리' 를 켜고 저장하세요."),
        )
    try:
        out = svc.update_item_source_config(
            db, item,
            thresholds=body.thresholds, params=body.params, dedicated=body.dedicated,
        )
    except ValueError as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    _audit(db, user, "item.source_config", target_id=item.id, request=request, details={
        "dedicated": out.get("dedicated"), "created": out.get("created"),
    })
    return out


class ItemPreviewIn(BaseModel):
    source_type: CheckMatrixSourceType
    source_ref: Optional[str] = None
    cluster_id: UUID
    thresholds: Optional[dict[str, Any]] = None
    params: Optional[dict[str, Any]] = None
    config: Optional[dict[str, Any]] = None
    # 아직 저장 전인 플레이북 본문을 그대로 시험 실행할 때 (source_type=playbook, source_ref 없음).
    playbook_content: Optional[str] = None
    inventory_id: Optional[UUID] = None
    extra_vars: Optional[list[KeyValueIn]] = None
    tags: Optional[str] = None
    # 기본 dry-run(ansible --check) — 실제 변경을 내려면 호출부가 명시적으로 꺼야 한다.
    check_mode: bool = True
    # 저장된 항목을 "지금 설정으로" 시험 실행할 때(항목 상세) — 그 행의 실효 정의 값을 기본으로 깐다.
    item_id: Optional[UUID] = None


@router.post("/items/preview")
def preview_item(
    body: ItemPreviewIn,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    """등록 전 저장 없이 1회 실행 — 등록 마법사의 "테스트" 단계.

    응답의 ``log`` 는 실행 상세 로그(단계/명령 출력)다 — 화면은 "로그 보기"로 펼쳐 보여준다.
    대상 클러스터가 본문으로 오므로 경로 가드 대신 여기서 operate 권한을 직접 확인한다.
    플레이북을 dry-run 없이 실제 적용하는 미리 실행은 admin 만 가능하다.
    """
    require_cluster_access(db, user, body.cluster_id, "operate")
    if not body.check_mode and user.role != "admin":
        raise HTTPException(
            status_code=403,
            detail="dry-run(--check) 없이 실제로 적용하는 미리 실행은 admin 만 할 수 있습니다.",
        )
    item = None
    if body.item_id is not None:
        item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == body.item_id).first()
        if item is None:
            raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    try:
        out = svc.preview_item(
            db, body.source_type, body.source_ref, body.cluster_id,
            thresholds=body.thresholds, params=body.params, config=body.config,
            playbook_content=body.playbook_content, inventory_id=body.inventory_id,
            extra_vars=_kv_to_dict(body.extra_vars), tags=body.tags, check_mode=body.check_mode,
            item=item,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    _audit(db, user, "item.preview", target_type="cluster", target_id=body.cluster_id, request=request,
           details={"source_type": body.source_type.value, "source_ref": body.source_ref,
                    "check_mode": body.check_mode, "status": out.get("status")})
    return out


@router.get("/exec-techs")
def get_catalog(db: Session = Depends(get_db)):
    """등록 마법사 카탈로그 — 실행 기술별 점검 종류 목록(프론트 하드코딩 없이 API 로 제공)."""
    return svc.list_catalog(db)


# ── Grid / history / manual entry ────────────────────────────────────────────
@router.get("/grid")
def get_grid(db: Session = Depends(get_db), scope: ClusterScope = Depends(get_cluster_scope)):
    return svc.build_grid(db, hidden_cluster_ids=scope.hidden)


@router.get("/cell/{item_id}/{cluster_id}/history")
def get_cell_history(
    item_id: UUID, cluster_id: UUID, days: int = Query(30, ge=1, le=3650), db: Session = Depends(get_db),
):
    return svc.get_cell_history(db, item_id, cluster_id, days=days)


@router.post("/cell/{item_id}/{cluster_id}/manual-entry")
def post_manual_entry(
    item_id: UUID,
    cluster_id: UUID,
    body: ManualEntryIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item_id).first()
    if item is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    if item.source_type != CheckMatrixSourceType.manual:
        raise HTTPException(status_code=400, detail="수동 입력은 manual 타입 항목에서만 가능합니다.")
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    import math
    if body.value is not None and not math.isfinite(body.value):
        raise HTTPException(status_code=422, detail="값은 유한한 숫자여야 합니다 (NaN/Infinity 불가).")
    svc.record_manual_entry(
        db, item_id, cluster_id, body.status, body.value, body.message,
        triggered_by=_actor(user),
    )
    _audit(db, user, "cell.manual_entry", target_id=item_id, details={
        "cluster_id": str(cluster_id), "status": body.status.value, "value": body.value,
    })
    return {"status": "ok"}


# ── Schedule / cron ──────────────────────────────────────────────────────────
@router.put("/schedule/{item_id}/{cluster_id}", response_model=ScheduleOut)
def put_schedule(
    item_id: UUID,
    cluster_id: UUID,
    body: ScheduleIn,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item_id).first()
    if item is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    if item.source_type == CheckMatrixSourceType.core_bundle:
        raise HTTPException(
            status_code=400,
            detail="핵심 항목의 cron 은 클러스터 열에서 설정합니다 (PUT /check-matrix/clusters/{cluster_id}/cron).",
        )
    if item.source_type == CheckMatrixSourceType.manual and body.cron_expr:
        raise HTTPException(
            status_code=400,
            detail="수동 입력 항목은 자동 실행이 없어 주기를 설정할 수 없습니다.",
        )
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    try:
        svc.validate_cron_min_interval(body.cron_expr)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    row = (
        db.query(CheckMatrixSchedule)
        .filter(CheckMatrixSchedule.item_id == item_id, CheckMatrixSchedule.cluster_id == cluster_id)
        .first()
    )
    cron_expr = body.cron_expr or None
    if row is None:
        row = CheckMatrixSchedule(item_id=item_id, cluster_id=cluster_id)
        db.add(row)
    if row.cron_expr != cron_expr or row.last_run_at is None:
        # 기준점을 "지금" 으로 — 새로 넣거나 바꾼 cron 이 등록 1분 안에 엉뚱한 시각에 발화하지
        # 않고 다음 예정 시각에 처음 돈다(예: 14:00 에 0 3 * * * 저장 → 다음 날 03:00).
        row.last_run_at = datetime.utcnow()
    row.cron_expr = cron_expr
    row.enabled = body.enabled
    db.commit()
    db.refresh(row)
    _audit(db, user, "schedule.update", target_id=item_id, request=request, details={
        "cluster_id": str(cluster_id), "cron_expr": row.cron_expr, "enabled": row.enabled,
    })
    return row


@router.put("/clusters/{cluster_id}/cron")
def put_cluster_cron(
    cluster_id: UUID,
    body: ClusterCronIn,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    try:
        svc.validate_cron_min_interval(body.check_cron_expr)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    cron_expr = body.check_cron_expr or None
    if cluster.check_cron_expr != cron_expr or cluster.check_last_run_at is None:
        cluster.check_last_run_at = datetime.utcnow()  # put_schedule 과 같은 이유(즉시 발화 방지)
    cluster.check_cron_expr = cron_expr
    cluster.check_cron_enabled = body.check_cron_enabled
    db.commit()
    _audit(db, user, "cluster_cron.update", target_type="cluster", target_id=cluster_id, request=request,
           details={"cron_expr": cron_expr, "enabled": body.check_cron_enabled})
    return {
        "cluster_id": str(cluster.id),
        "check_cron_expr": cluster.check_cron_expr,
        "check_cron_enabled": cluster.check_cron_enabled,
    }


# ── 런북 (실행 계획 — 실제로 클러스터에 나가는 명령) ─────────────────────────────
@router.get("/cell/{item_id}/{cluster_id}/runbook")
def get_cell_runbook(item_id: UUID, cluster_id: UUID, db: Session = Depends(get_db)):
    """이 셀이 실제 운영 클러스터에서 무슨 명령을 어떤 순서로 도는지. 실행하지 않는다."""
    from app.services.check_matrix_runbook import build_runbook

    item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item_id).first()
    if item is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    return build_runbook(db, item, cluster)


class SourceConfigEntry(BaseModel):
    group: str  # deep_check: "thresholds"|"params" / addon: "config"
    name: str
    value: str  # 문자열로 받아 서버가 spec 필드 타입으로 강제 (빈 문자열 = 기본값 복귀)


class SourceConfigIn(BaseModel):
    entries: list[SourceConfigEntry] = Field(..., min_length=1)


@router.put("/cell/{item_id}/{cluster_id}/source-config")
def put_source_config(
    item_id: UUID,
    cluster_id: UUID,
    body: SourceConfigIn,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    """셀 실행 소스의 설정(deep_check thresholds/params, addon config)을 매트릭스에서 직접 수정.

    글로벌 정의를 수정하면 전 클러스터에 적용된다 — runbook 의 definition_scope 로 UI 가 경고한다.
    """
    item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item_id).first()
    if item is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    try:
        out = svc.update_source_config(
            db, item, cluster, [e.model_dump() for e in body.entries],
        )
    except ValueError as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    _audit(db, user, "cell.source_config", target_id=item_id, request=request, details={
        "cluster_id": str(cluster_id), "fields": [f"{e.group}.{e.name}" for e in body.entries],
    })
    return out


# ── 수동 실행 (셀 / 클러스터 열 / 항목 행) ────────────────────────────────────────
def _actor(user: User) -> str:
    # User 모델의 표시명 컬럼은 display_name 이다 (full_name 아님 — models/user.py).
    return user.display_name or user.username


@router.post("/cell/{item_id}/{cluster_id}/run")
def run_cell(
    item_id: UUID,
    cluster_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    """셀 1건 실행 — **큐잉 후 즉시** queued 수행을 돌려준다.

    예전엔 요청 안에서 끝까지 동기 실행해, 오래 걸리는 점검(플레이북·SSH)이 프록시 타임아웃(60s)
    에 잘려 504 가 나고 실행 중에는 아무 로그도 볼 수 없었다. 이제 화면은 받은 ``id`` 로
    ``GET /runs/{id}`` 를 폴링해 단계·명령 출력을 실시간으로 보여 준다. 같은 셀이 이미 대기/실행
    중이면 새로 만들지 않고 그 수행을 돌려준다(``deduplicated``).
    """
    item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item_id).first()
    if item is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    if item.source_type == CheckMatrixSourceType.manual:
        raise HTTPException(
            status_code=400,
            detail="수동 입력 항목은 실행할 수 없습니다 — 셀 상세의 '값 입력'을 사용하세요.",
        )
    try:
        out = svc.queue_cell_now(db, item, cluster, triggered_by=_actor(user))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    _audit(db, user, "run.cell", target_id=item_id, request=request, details={
        "cluster_id": str(cluster_id), "run_id": out["id"], "deduplicated": out.get("deduplicated"),
    })
    return out


@router.post("/clusters/{cluster_id}/run")
def run_cluster(
    cluster_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    """클러스터(열) 단위 일괄 실행 — 큐잉만 하고 batch_id 를 돌려준다."""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    out = svc.run_cluster_now(db, cluster, triggered_by=_actor(user))
    _audit(db, user, "run.cluster", target_type="cluster", target_id=cluster_id, request=request,
           details={"batch_id": out["batch_id"], "total": out["total"], "skipped": out.get("skipped")})
    return out


@router.post("/items/{item_id}/run")
def run_item(
    item_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    """공통 점검 항목(행) 단위 일괄 실행 — 이 사용자가 **실행 권한(operate)을 가진** 클러스터 대상.

    클러스터가 경로에 없어 경로 가드가 보지 못한다 — 예전엔 다른 테넌트에 바인딩된 클러스터까지
    실행됐다. 테넌트 바인딩으로 실행할 수 없는 클러스터는 대상에서 뺀다.
    """
    item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == item_id).first()
    if item is None:
        raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다.")
    if item.source_type == CheckMatrixSourceType.manual:
        raise HTTPException(
            status_code=400,
            detail="수동 입력 항목은 실행할 수 없습니다 — 클러스터별로 값을 직접 입력하세요.",
        )
    if not item.enabled:
        raise HTTPException(status_code=400, detail="비활성화된 항목입니다 — 항목 수정에서 다시 켜야 실행할 수 있습니다.")
    allowed = [c.id for c in db.query(Cluster.id).all() if has_cluster_access(db, user, c.id, "operate")]
    out = svc.run_item_now(db, item, triggered_by=_actor(user), allowed_cluster_ids=allowed)
    _audit(db, user, "run.item", target_id=item_id, request=request,
           details={"batch_id": out["batch_id"], "total": out["total"], "skipped": out.get("skipped")})
    return out


# ── 실행 로그 ─────────────────────────────────────────────────────────────────
@router.get("/runs")
def list_runs(
    item_id: Optional[UUID] = None,
    cluster_id: Optional[UUID] = None,
    batch_id: Optional[UUID] = None,
    trigger: Optional[str] = None,
    run_state: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    scope: ClusterScope = Depends(get_cluster_scope),
):
    """수행 로그 목록 — cron 자동 실행과 수동 실행(셀/클러스터/항목/수동입력)을 모두 포함.

    ``run_state`` 는 콤마 구분 다중값(예: ``queued,running``) — 매트릭스 화면이 "지금 실행
    중인 것"만 가볍게 폴링해 cron 배지/타임라인을 실시간에 가깝게 갱신하는 데 쓴다.
    테넌트 바인딩으로 가려진 클러스터의 수행은 목록에서 빠진다.
    """
    if cluster_id is not None and not scope.visible(cluster_id):
        return {"total": 0, "limit": limit, "offset": offset, "runs": []}
    try:
        return svc.list_runs(
            db, item_id=item_id, cluster_id=cluster_id, batch_id=batch_id,
            trigger=trigger, run_state=run_state, limit=limit, offset=offset,
            hidden_cluster_ids=scope.hidden,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.get("/runs/{run_id}")
def get_run(
    run_id: UUID,
    db: Session = Depends(get_db),
    scope: ClusterScope = Depends(get_cluster_scope),
):
    """수행 1건 상세 — 실행 단계, 실제 나간 명령과 출력, 해석된 런북까지."""
    out = svc.get_run(db, run_id)
    if out is None or not scope.visible(out.get("cluster_id")):
        raise HTTPException(status_code=404, detail="실행 로그를 찾을 수 없습니다.")
    return out


# ── Settings (이력 보관 주기) ──────────────────────────────────────────────────
@router.get("/settings")
def get_settings_route(db: Session = Depends(get_db)):
    return svc.get_settings(db)


@router.put("/settings")
def put_settings_route(
    body: SettingsIn,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    out = svc.set_settings(db, body.retention_days)
    _audit(db, user, "settings.update", request=request, details={"retention_days": body.retention_days})
    return out
