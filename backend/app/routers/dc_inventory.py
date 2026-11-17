"""DC 인벤토리 API (`/api/v1/dc`) — 랙·장비·인터페이스·케이블·IPAM + 일괄 등록.

설계: ``docs/dc-inventory/DESIGN.md``. 이 라우터는 얇다 — 검증·변경 이력·미러는 전부
``services/dc_inventory`` 가 하고, 여기서는 권한·트랜잭션 경계(커밋)·응답 모양만 정한다.

권한: 조회 = 로그인 사용자 · 쓰기 = operator 이상 · 장비 삭제와 기존 데이터 연결 = admin.
도메인 예외(``DcError``·``FileError``)는 ``main.py`` 의 예외 핸들러가 ``{detail, code, conflict}`` 로 옮긴다.
스위치·K8s 로 나가는 호출은 없다(인벤토리 기록만 다룬다).
"""
import asyncio
import json
import uuid
from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Body, Depends, File, Form, Query, Request, Response, UploadFile
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user, require_admin, require_operator
from app.database import get_db
from app.models.dc_inventory import (
    DcCable,
    DcChangeLog,
    DcDevice,
    DcInterface,
    DcIpAddress,
    DcPrefix,
    DcRack,
)
from app.models.infra_node import InfraNode
from app.models.node_server_spec import NodeServerSpec
from app.models.user import User
from app.schemas.dc_inventory import (
    CREATE,
    UPDATE,
    BulkCablesRequest,
    BulkDevicesRequest,
    BulkInterfacesRequest,
    BulkIpRequest,
    CanvasPositionsRequest,
    LinkApplyRequest,
)
from app.services import audit_logger
from app.services.dc_inventory import bulk, crud, device_registry, exporter, importer, server_sheet, topology, validation
from app.services.dc_inventory.changelog import Ctx
from app.services.dc_inventory.errors import DcInvalid
from app.services.sse import Emit, log_evt, step_evt, stream_async_job

router = APIRouter(prefix="/dc", tags=["dc-inventory"])

_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _uuid_or_422(value: str, name: str) -> UUID:
    try:
        return UUID(value)
    except (ValueError, TypeError) as e:
        raise DcInvalid(f"{name} 값이 올바른 ID 가 아닙니다", code="bad_id", column=name) from e


# ── 요약 · 변경 이력 ─────────────────────────────────────────────────────────

@router.get("/overview")
def overview(db: Session = Depends(get_db)):
    """화면 상단 한 줄 요약용 건수."""
    interfaces = db.query(func.count(DcInterface.id)).scalar() or 0
    cables = db.query(func.count(DcCable.id)).scalar() or 0
    return {
        "racks": db.query(func.count(DcRack.id)).scalar(),
        "devices": db.query(func.count(DcDevice.id)).scalar(),
        "interfaces": interfaces,
        "cables": cables,
        "prefixes": db.query(func.count(DcPrefix.id)).scalar(),
        "ip_addresses": db.query(func.count(DcIpAddress.id)).scalar(),
        "unracked_devices": db.query(func.count(DcDevice.id)).filter(DcDevice.rack_id.is_(None)).scalar(),
        # 케이블 하나가 인터페이스 둘을 쓰고, 인터페이스당 케이블은 하나다.
        "unconnected_interfaces": max(interfaces - 2 * cables, 0),
        "unlinked_existing": (
            db.query(func.count(NodeServerSpec.id)).filter(NodeServerSpec.device_id.is_(None)).scalar()
            + db.query(func.count(InfraNode.id)).filter(InfraNode.device_id.is_(None)).scalar()
        ),
    }


@router.get("/changes")
def list_changes(
    object_type: Optional[str] = None,
    object_id: Optional[UUID] = None,
    actor: Optional[str] = None,
    batch_id: Optional[str] = None,
    source: Optional[str] = None,
    before: Optional[datetime] = Query(None, description="이 시각 이전 기록(다음 쪽)"),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """변경 이력 — 최신순. ``before`` 에 마지막 행의 ``created_at`` 을 넘기면 다음 쪽."""
    q = db.query(DcChangeLog)
    if object_type:
        q = q.filter(DcChangeLog.object_type == object_type)
    if object_id:
        q = q.filter(DcChangeLog.object_id == object_id)
    if actor:
        q = q.filter(DcChangeLog.actor_username == actor)
    if batch_id:
        q = q.filter(DcChangeLog.batch_id == batch_id)
    if source:
        q = q.filter(DcChangeLog.source == source)
    if before:
        q = q.filter(DcChangeLog.created_at < before)
    rows = q.order_by(DcChangeLog.created_at.desc(), DcChangeLog.id).limit(limit + 1).all()
    items = [{
        "id": str(r.id), "object_type": r.object_type, "object_id": str(r.object_id),
        "object_repr": r.object_repr, "action": r.action, "before": r.before, "after": r.after,
        "changed_fields": r.changed_fields, "actor_username": r.actor_username, "request_id": r.request_id,
        "batch_id": r.batch_id, "source": r.source, "created_at": r.created_at.isoformat(),
    } for r in rows[:limit]]
    return {"items": items, "has_more": len(rows) > limit}


# ── 토폴로지 (구간 · 클러스터 · 패브릭 계층 · 랙) ────────────────────────────

@router.get("/topology")
def get_topology(db: Session = Depends(get_db)):
    """토폴로지 캔버스 데이터 — 구간·연결 클러스터·패브릭 장비·랙(장착 장비 포함)·연결·온톨로지 관계."""
    return topology.build(db)


@router.put("/topology/positions")
def save_topology_positions(payload: CanvasPositionsRequest, db: Session = Depends(get_db),
                            _: User = Depends(require_operator)):
    """끌어 놓은 노드 위치 저장(모든 사용자가 같은 배치를 본다)."""
    saved = topology.save_positions(db, [p.model_dump() for p in payload.positions])
    db.commit()
    return {"saved": saved}


@router.delete("/topology/positions")
def reset_topology_positions(db: Session = Depends(get_db), _: User = Depends(require_operator)):
    """저장된 위치를 지우고 계층별 자동 배치로 되돌린다."""
    removed = topology.reset_positions(db)
    db.commit()
    return {"removed": removed}


# ── 장비: 다른 화면 재사용 · 상세 · 기존 데이터 연결 ─────────────────────────

@router.get("/devices/lookup")
def lookup_devices(
    hostname: Optional[str] = Query(None, description="쉼표로 여러 개"),
    cluster_id: Optional[UUID] = None,
    q: Optional[str] = None,
    limit: int = Query(500, ge=1, le=2000),
    db: Session = Depends(get_db),
):
    """다른 화면이 호스트명·클러스터로 장비 위치를 붙일 때 쓰는 가벼운 조회."""
    query = db.query(DcDevice)
    if hostname:
        query = query.filter(DcDevice.hostname.in_([h.strip() for h in hostname.split(",") if h.strip()]))
    if cluster_id:
        query = query.filter(DcDevice.cluster_id == cluster_id)
    if q:
        query = query.filter(DcDevice.hostname.ilike(f"%{q.strip()}%"))
    devices = query.order_by(DcDevice.hostname).limit(limit).all()
    racks = {r.id: r.name for r in db.query(DcRack.id, DcRack.name).all()}
    return {"items": [{
        "id": str(d.id), "hostname": d.hostname, "role": d.role, "status": d.status,
        "rack_id": str(d.rack_id) if d.rack_id else None, "rack_name": racks.get(d.rack_id),
        "position_u": d.position_u, "u_range": validation.u_range_label(d.position_u, d.u_height),
        "cluster_id": str(d.cluster_id) if d.cluster_id else None,
    } for d in devices]}


@router.get("/devices/link/preview")
def link_preview(db: Session = Depends(get_db)):
    """아직 연결되지 않은 노드 서버스펙·인프라 노드를 호스트명으로 분류한다(읽기 전용)."""
    return device_registry.link_preview(db)


def _link_apply(db: Session, payload: LinkApplyRequest, user: User, emit: Emit | None = None) -> dict[str, Any]:
    batch_id = str(uuid.uuid4())
    if emit is not None:
        step_evt(emit, "link", "연결", "running")
    result = device_registry.link_apply(
        db, [i.model_dump() for i in payload.items], actor=user, batch_id=batch_id,
        emit=(lambda level, msg: log_evt(emit, level, msg)) if emit is not None else None,
    )
    db.commit()
    result["batch_id"] = batch_id
    audit_logger.record(db, action="dc.link.apply", actor=user, target_type="dc_inventory",
                        details={"linked": result["linked"], "failed": result["failed"], "batch_id": batch_id})
    if emit is not None:
        step_evt(emit, "link", "연결", "failed" if result["failed"] else "done")
        log_evt(emit, "error" if result["failed"] else "info",
                f"연결 {result['linked']}건 · 실패 {result['failed']}건 · 건너뜀 {result['skipped']}건")
    return result


@router.post("/devices/link/apply")
def link_apply(payload: LinkApplyRequest, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    """선택한 호스트명만 연결한다(항목별 성공·실패를 돌려준다)."""
    return _link_apply(db, payload, user)


@router.post("/devices/link/apply/stream")
async def link_apply_stream(payload: LinkApplyRequest, user: User = Depends(require_admin)):
    """연결 실행 — 실시간 로그(SSE)."""
    async def job(sdb: Session, emit: Emit) -> dict[str, Any]:
        return await asyncio.to_thread(_link_apply, sdb, payload, user, emit)
    return stream_async_job(job, name="dc-link-apply")


@router.get("/devices/{device_id}/detail")
def device_detail(device_id: UUID, db: Session = Depends(get_db)):
    """장비 + 인터페이스(케이블 상대편·IP) + 연결된 기존 기록."""
    device = crud.get(db, "devices", device_id)
    ifaces = db.query(DcInterface).filter(DcInterface.device_id == device.id).order_by(DcInterface.name).all()
    iface_ids = [i.id for i in ifaces]
    cables = db.query(DcCable).filter(
        or_(DcCable.a_interface_id.in_(iface_ids), DcCable.b_interface_id.in_(iface_ids))).all() if iface_ids else []
    cable_rows = {c["id"]: c for c in crud.serialize_many(db, "cables", cables)}
    by_iface: dict[Any, dict[str, Any]] = {}
    for c in cables:
        row = cable_rows[str(c.id)]
        for mine, far in (("a", "b"), ("b", "a")):
            iid = getattr(c, f"{mine}_interface_id")
            if iid in iface_ids:
                by_iface[iid] = {
                    "id": row["id"], "label": row["label"], "status": row["status"],
                    "peer_device_id": row[f"{far}_device_id"], "peer_device_hostname": row[f"{far}_device_hostname"],
                    "peer_interface_name": row[f"{far}_interface_name"], "speed_mismatch": row["speed_mismatch"],
                }
    ips = db.query(DcIpAddress).filter(DcIpAddress.interface_id.in_(iface_ids)).all() if iface_ids else []
    ips_by_iface: dict[Any, list[dict[str, Any]]] = {}
    for ip in crud.serialize_many(db, "ip-addresses", ips):
        ips_by_iface.setdefault(ip["interface_id"], []).append(
            {"id": ip["id"], "address": ip["address"], "vrf_name": ip["vrf_name"], "role": ip["role"]})
    iface_rows = crud.serialize_many(db, "interfaces", ifaces)
    for row, iface in zip(iface_rows, ifaces):
        row["cable"] = by_iface.get(iface.id)
        row["ip_addresses"] = ips_by_iface.get(str(iface.id), [])
    return {
        "device": crud.serialize(db, "devices", device),
        "interfaces": iface_rows,
        "linked": {
            "node_spec_ids": [str(i) for (i,) in db.query(NodeServerSpec.id).filter(
                NodeServerSpec.device_id == device.id).all()],
            "infra_node_ids": [str(i) for (i,) in db.query(InfraNode.id).filter(
                InfraNode.device_id == device.id).all()],
        },
    }


# ── 화면 안 일괄 작업 ────────────────────────────────────────────────────────

def _bulk(db: Session, user: User, action: str, fn, payload) -> dict[str, Any]:
    ctx = Ctx(actor=user, source="bulk", batch_id=str(uuid.uuid4()))
    result = fn(db, payload.model_dump(), ctx)
    if result["ok"] and not result["dry_run"]:
        db.commit()
        result["applied"] = True
        result["batch_id"] = ctx.batch_id
        audit_logger.record(db, action=action, actor=user, target_type="dc_inventory",
                            details={"total": result["total"], "batch_id": ctx.batch_id})
    else:
        db.rollback()  # dry-run 이거나 하나라도 실패 — 전부 되돌린다
        result["applied"] = False
    return result


@router.post("/devices/bulk")
def bulk_devices(payload: BulkDevicesRequest, db: Session = Depends(get_db), user: User = Depends(require_operator)):
    """호스트명 패턴으로 장비 여러 대 생성. ``dry_run`` 이면 만들 목록과 충돌만 돌려준다."""
    return _bulk(db, user, "dc.devices.bulk", bulk.create_devices, payload)


@router.post("/interfaces/bulk-update")
def bulk_interfaces(payload: BulkInterfacesRequest, db: Session = Depends(get_db),
                    user: User = Depends(require_operator)):
    """선택한 포트(또는 장비 + 포트 범위)의 속도·용도·사용 여부를 한 번에 변경."""
    return _bulk(db, user, "dc.interfaces.bulk_update", bulk.update_interfaces, payload)


@router.post("/cables/bulk")
def bulk_cables(payload: BulkCablesRequest, db: Session = Depends(get_db), user: User = Depends(require_operator)):
    """포트 범위 대 장비 목록 케이블 연결."""
    return _bulk(db, user, "dc.cables.bulk", bulk.create_cables, payload)


@router.post("/ip-addresses/bulk")
def bulk_ips(payload: BulkIpRequest, db: Session = Depends(get_db), user: User = Depends(require_operator)):
    """Prefix 의 빈 주소를 선택한 인터페이스들에 순서대로 배정."""
    return _bulk(db, user, "dc.ip_addresses.bulk", bulk.assign_ips, payload)


# ── Excel/CSV 일괄 등록 · 내보내기 ───────────────────────────────────────────

async def _read_upload(file: UploadFile) -> bytes:
    content = await file.read(importer.MAX_FILE_BYTES + 1)
    if len(content) > importer.MAX_FILE_BYTES:
        raise importer.FileError(f"파일이 너무 큽니다 (최대 {importer.MAX_FILE_BYTES // 1024 // 1024}MB)", 413)
    if not content:
        raise importer.FileError("빈 파일입니다")
    return content


# ── 서버 일괄 등록 (현업 엑셀 열 그대로 — 파일 또는 붙여넣기) ──────────────────

async def _server_rows(file: UploadFile | None, rows_json: str | None) -> tuple[list[list], str]:
    """multipart 의 파일 또는 붙여넣은 표(JSON 2차원 배열) → (행 목록, 입력 이름)."""
    if file is not None and file.filename:
        content = await _read_upload(file)
        return server_sheet.rows_from_file(content, file.filename), file.filename
    if rows_json:
        try:
            rows = json.loads(rows_json)
        except ValueError as e:
            raise DcInvalid("붙여넣은 표를 읽지 못했습니다", code="bad_rows") from e
        if not isinstance(rows, list) or not all(isinstance(r, list) for r in rows):
            raise DcInvalid("붙여넣은 표 형식이 올바르지 않습니다", code="bad_rows")
        return rows, "붙여넣기"
    raise DcInvalid("파일을 올리거나 엑셀에서 복사한 표를 붙여넣으세요", code="empty")


def _server_run(db: Session, rows: list[list], source: str, user: User, *, apply: bool,
                emit: Emit | None = None) -> dict[str, Any]:
    info = server_sheet.interpret(rows)
    if info["missing"]:
        raise DcInvalid(f"필수 열이 없습니다: {', '.join(info['missing'])}", code="missing_column")
    parsed, created, warnings = server_sheet.to_parsed(db, info)
    notes = [f"헤더 {info['header_row']}행 · 서버 {len(info['servers']):,}대 · 읽은 열: "
             + ", ".join(server_sheet.LABEL[k] for k in info["present"])]
    if created:
        notes.append(f"새로 만들 위치 {len(created)}개 — " + ", ".join(created[:10]) + (" …" if len(created) > 10 else ""))
    log = (lambda level, msg: log_evt(emit, level, msg)) if emit is not None else None
    result = importer.run_parsed(db, parsed, sha256=server_sheet.fingerprint(rows), filename=source, actor=user,
                                 apply=apply, emit=log, notes=notes)
    result["columns"] = info["columns"]
    result["header_row"] = info["header_row"]
    result["created_locations"] = created
    result["warnings"] = warnings + result.get("warnings", [])
    return result


@router.get("/import/servers/template.xlsx")
def server_import_template():
    """서버 일괄 등록 양식 — 서버구성 · 서버환경 · 호스트명 · 서버용도 · OS버전 · NW설정 · 이중화 · DC 위치 · RACK 열 · 랙 No. · 하단 위치."""
    return Response(content=server_sheet.template_xlsx(), media_type=_XLSX,
                    headers={"Content-Disposition": 'attachment; filename="dc-server-import.xlsx"'})


@router.post("/import/servers/preview")
async def server_import_preview(
    file: Optional[UploadFile] = File(None),
    rows_json: Optional[str] = Form(None, description="엑셀에서 복사한 표 — JSON 2차원 배열(첫 줄 헤더)"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """서버 행을 검증하고 행별 판정(추가·변경·오류)을 돌려준다. DB 를 바꾸지 않는다."""
    rows, source = await _server_rows(file, rows_json)
    return await asyncio.to_thread(_server_run, db, rows, source, user, apply=False)


@router.post("/import/servers/apply/stream")
async def server_import_apply_stream(
    file: Optional[UploadFile] = File(None),
    rows_json: Optional[str] = Form(None),
    sha256: str = Form(..., description="미리보기 응답의 sha256"),
    user: User = Depends(require_operator),
):
    """확정 — 전체 한 트랜잭션, 오류가 하나라도 있으면 아무것도 반영하지 않는다. 진행은 실시간 로그(SSE)."""
    rows, source = await _server_rows(file, rows_json)
    if server_sheet.fingerprint(rows) != (sha256 or "").strip().lower():
        raise DcInvalid("미리보기에서 검증한 내용과 다릅니다. 다시 미리보기부터 진행하세요.", code="sha_mismatch")

    def work(sdb: Session, emit: Emit) -> dict[str, Any]:
        step_evt(emit, "validate", "검증", "running")
        result = _server_run(sdb, rows, source, user, apply=True, emit=emit)
        step_evt(emit, "validate", "검증", "done" if result["ok"] else "failed")
        step_evt(emit, "apply", "반영", "done" if result["applied"] else "failed")
        audit_logger.record(
            sdb, action="dc.import.servers", actor=user, target_type="dc_inventory",
            status="success" if result["applied"] else "failure",
            details={"source": source, "summary": result["summary"], "batch_id": result["batch_id"]},
        )
        return result

    async def job(sdb: Session, emit: Emit) -> dict[str, Any]:
        return await asyncio.to_thread(work, sdb, emit)
    return stream_async_job(job, name="dc-server-import")


@router.get("/import/template.xlsx")
def import_template():
    """빈 양식(시트별 헤더 + 설명 시트)."""
    return Response(content=exporter.template_xlsx(), media_type=_XLSX,
                    headers={"Content-Disposition": 'attachment; filename="dc-inventory-template.xlsx"'})


@router.get("/export.xlsx")
def export_xlsx(db: Session = Depends(get_db)):
    """현재 데이터를 일괄 등록 양식 그대로 내보낸다(다시 올리면 전부 "변경 없음")."""
    name = f"dc-inventory-{datetime.utcnow():%Y%m%d}.xlsx"
    return Response(content=exporter.export_xlsx(db), media_type=_XLSX,
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.post("/import/preview")
async def import_preview(
    file: UploadFile = File(...),
    sheet: Optional[str] = Form(None, description="CSV 일 때 시트 이름"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """파일을 검증하고 행별 판정(추가·변경·오류)을 돌려준다. DB 를 바꾸지 않는다."""
    content = await _read_upload(file)
    return await asyncio.to_thread(
        importer.run, db, content, file.filename or "upload.xlsx", actor=user, apply=False, sheet_hint=sheet)


def _import_apply(db: Session, content: bytes, filename: str, sheet: str | None, user: User,
                  emit: Emit | None = None) -> dict[str, Any]:
    if emit is not None:
        step_evt(emit, "validate", "검증", "running")
    result = importer.run(
        db, content, filename, actor=user, apply=True, sheet_hint=sheet,
        emit=(lambda level, msg: log_evt(emit, level, msg)) if emit is not None else None,
    )
    if emit is not None:
        step_evt(emit, "validate", "검증", "done" if result["ok"] else "failed")
        step_evt(emit, "apply", "반영", "done" if result["applied"] else "failed")
    audit_logger.record(
        db, action="dc.import.apply", actor=user, target_type="dc_inventory",
        status="success" if result["applied"] else "failure",
        details={"filename": filename, "sha256": result["sha256"], "summary": result["summary"],
                 "batch_id": result["batch_id"]},
    )
    return result


async def _checked_upload(file: UploadFile, sha256: str) -> bytes:
    content = await _read_upload(file)
    if importer.sha256_of(content) != (sha256 or "").strip().lower():
        raise DcInvalid("미리보기에서 검증한 파일과 다릅니다. 다시 미리보기부터 진행하세요.", code="sha_mismatch")
    return content


@router.post("/import/apply")
async def import_apply(
    file: UploadFile = File(...),
    sha256: str = Form(..., description="미리보기 응답의 sha256"),
    sheet: Optional[str] = Form(None),
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
):
    """확정 — 전체가 한 트랜잭션. 오류가 하나라도 있으면 아무것도 반영하지 않는다."""
    content = await _checked_upload(file, sha256)
    return await asyncio.to_thread(_import_apply, db, content, file.filename or "upload.xlsx", sheet, user)


@router.post("/import/apply/stream")
async def import_apply_stream(
    file: UploadFile = File(...),
    sha256: str = Form(...),
    sheet: Optional[str] = Form(None),
    user: User = Depends(require_operator),
):
    """확정 — 시트별 진행을 실시간 로그(SSE)로 보낸다. 마지막 ``result`` 이벤트가 동기 응답과 같다."""
    content = await _checked_upload(file, sha256)
    filename = file.filename or "upload.xlsx"

    async def job(sdb: Session, emit: Emit) -> dict[str, Any]:
        return await asyncio.to_thread(_import_apply, sdb, content, filename, sheet, user, emit)
    return stream_async_job(job, name="dc-import-apply")


# ── 리소스 CRUD ──────────────────────────────────────────────────────────────

def _register_crud(key: str, *, delete_dep=require_operator) -> None:
    res = crud.resource(key)
    create_schema = CREATE[key]
    update_schema = UPDATE[key]
    tag_label = res.label

    def list_items(
        request: Request,
        q: Optional[str] = Query(None, description="이름 검색"),
        limit: int = Query(200, ge=1, le=5000),
        offset: int = Query(0, ge=0),
        db: Session = Depends(get_db),
    ):
        filters: dict[str, Any] = {}
        for name in res.filters:
            raw = request.query_params.get(name)
            if raw in (None, ""):
                continue
            filters[name] = _uuid_or_422(raw, name) if name.endswith("_id") else raw
        extra = []
        if key == "devices" and request.query_params.get("unracked") == "true":
            extra.append(DcDevice.rack_id.is_(None))
        if key == "cables" and request.query_params.get("device_id"):
            dev_id = _uuid_or_422(request.query_params["device_id"], "device_id")
            mine = db.query(DcInterface.id).filter(DcInterface.device_id == dev_id)
            extra.append(or_(DcCable.a_interface_id.in_(mine), DcCable.b_interface_id.in_(mine)))
        items, total = crud.list_(db, key, filters=filters, q=q, limit=limit, offset=offset, extra=extra)
        return {"items": crud.serialize_many(db, key, items), "total": total}

    def create_item(payload: create_schema, db: Session = Depends(get_db),  # type: ignore[valid-type]
                    user: User = Depends(require_operator)):
        ctx = Ctx(actor=user)
        obj = crud.create(db, key, payload.model_dump(), ctx)
        db.commit()
        db.refresh(obj)
        return {**crud.serialize(db, key, obj), "warnings": ctx.warnings}

    def get_item(item_id: UUID, db: Session = Depends(get_db)):
        return crud.serialize(db, key, crud.get(db, key, item_id))

    def update_item(item_id: UUID, payload: update_schema = Body(...),  # type: ignore[valid-type]
                    db: Session = Depends(get_db), user: User = Depends(require_operator)):
        data = payload.model_dump(exclude_unset=True)
        version = data.pop("version", None)
        ctx = Ctx(actor=user)
        obj = crud.update(db, key, item_id, data, ctx, version=version)
        db.commit()
        db.refresh(obj)
        return {**crud.serialize(db, key, obj), "warnings": ctx.warnings}

    def delete_item(item_id: UUID, db: Session = Depends(get_db), user: User = Depends(delete_dep)):
        crud.delete(db, key, item_id, Ctx(actor=user))
        db.commit()
        return Response(status_code=204)

    filter_note = f" 필터: {', '.join(res.filters)}." if res.filters else ""
    router.add_api_route(f"/{key}", list_items, methods=["GET"], summary=f"{tag_label} 목록",
                         description=f"{tag_label} 목록.{filter_note}", name=f"dc_list_{key}")
    router.add_api_route(f"/{key}", create_item, methods=["POST"], status_code=201,
                         summary=f"{tag_label} 추가", name=f"dc_create_{key}")
    router.add_api_route(f"/{key}/{{item_id}}", get_item, methods=["GET"], summary=f"{tag_label} 조회",
                         name=f"dc_get_{key}")
    router.add_api_route(f"/{key}/{{item_id}}", update_item, methods=["PUT"],
                         summary=f"{tag_label} 수정 (보낸 필드만, version 불일치 시 409)", name=f"dc_update_{key}")
    router.add_api_route(f"/{key}/{{item_id}}", delete_item, methods=["DELETE"], status_code=204,
                         summary=f"{tag_label} 삭제", name=f"dc_delete_{key}")


for _key in crud.RESOURCES:
    # 장비는 다른 화면(서버스펙·토폴로지)이 가리키는 원본이라 삭제는 admin 만 — operator 는 상태를 decommission 으로.
    _register_crud(_key, delete_dep=require_admin if _key == "devices" else require_operator)
