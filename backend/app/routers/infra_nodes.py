import json
import logging
import queue
import subprocess
import threading
import time
from datetime import datetime, timezone
from typing import Callable, Iterator
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status, Header
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.deps import require_operator
from app.database import SessionLocal, get_db
from app.models.cluster import Cluster
from app.models.infra_node import InfraNode
from app.models.topology_audit_log import TopologyAuditLog
from app.models.user import User
from app.schemas.infra_node import (
    InfraNodeCreate,
    InfraNodeUpdate,
    InfraNodeResponse,
    InfraNodeListResponse,
    NodeVerifyResult,
    SyncResult,
)
from app.services.check_definition_runner import DeepCheckService
from app.services.cluster_access import require_cluster_access
from app.services.kubeconfig import resolve_kubeconfig

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/infra-nodes", tags=["infra-nodes"])

# sync 직후 자동검증할 신규 노드 최대 수 (지연 상한).
_SYNC_VERIFY_MAX = 25

_KUBECTL_TIMEOUT = 30
_SYNC_RETRY_MAX = 2
SCOPE_READ = "infra_topology.read"
SCOPE_EDIT = "infra_topology.edit"
SCOPE_SYNC = "infra_topology.sync"
SCOPE_FORCE_FIX = "infra_topology.force_fix"


def _serialize_node(node: InfraNode | None) -> dict | None:
    if node is None:
        return None
    return {
        "id": str(node.id),
        "cluster_id": str(node.cluster_id),
        "hostname": node.hostname,
        "rack_name": node.rack_name,
        "ip_address": node.ip_address,
        "role": node.role,
        "cpu_cores": node.cpu_cores,
        "ram_gb": node.ram_gb,
        "disk_gb": node.disk_gb,
        "os_info": node.os_info,
        "switch_name": node.switch_name,
        "notes": node.notes,
        "auto_synced": node.auto_synced,
        "version": node.version,
        "updated_at": node.updated_at.isoformat() if node.updated_at else None,
    }


def _require_scope(required_scope: str):
    def _checker(x_api_scopes: str | None = Header(default=None)):
        raw_scopes = x_api_scopes or ""
        scopes = {s.strip() for s in raw_scopes.split(",") if s.strip()}
        if required_scope not in scopes:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Missing required scope: {required_scope}",
            )
    return _checker


def _audit(
    db: Session,
    cluster_id: UUID,
    *,
    entity_type: str,
    entity_id: str | None,
    action: str,
    scope: str,
    status_text: str,
    reason: str | None = None,
    before_data: dict | None = None,
    after_data: dict | None = None,
):
    db.add(
        TopologyAuditLog(
            cluster_id=cluster_id,
            entity_type=entity_type,
            entity_id=entity_id,
            action=action,
            scope=scope,
            status=status_text,
            reason=reason,
            before_data=before_data,
            after_data=after_data,
        )
    )


@router.get("", response_model=InfraNodeListResponse)
def list_infra_nodes(
    cluster_id: UUID | None = None,
    rack_name: str | None = None,
    _=Depends(_require_scope(SCOPE_READ)),
    db: Session = Depends(get_db),
):
    q = db.query(InfraNode)
    if cluster_id:
        q = q.filter(InfraNode.cluster_id == cluster_id)
    if rack_name:
        q = q.filter(InfraNode.rack_name == rack_name)
    nodes = q.order_by(InfraNode.rack_name, InfraNode.hostname).all()
    return InfraNodeListResponse(data=nodes, total=len(nodes))


@router.get("/{node_id}", response_model=InfraNodeResponse)
def get_infra_node(node_id: UUID, _=Depends(_require_scope(SCOPE_READ)), db: Session = Depends(get_db)):
    node = db.query(InfraNode).filter(InfraNode.id == node_id).first()
    if not node:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="InfraNode not found")
    return node


@router.post("", response_model=InfraNodeResponse, status_code=status.HTTP_201_CREATED)
def create_infra_node(
    payload: InfraNodeCreate,
    _=Depends(_require_scope(SCOPE_EDIT)),
    user: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    cluster = db.query(Cluster).filter(Cluster.id == payload.cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")
    # 본문 cluster_id 는 경로 의존성(enforce_cluster_access)이 못 보므로 여기서 테넌트 바인딩을 직접 판정.
    require_cluster_access(db, user, cluster.id, "operate")
    payload_data = payload.model_dump()
    # 클러스터 관리정보(first_host·description) 자동입력은 첫 노드에만 적용한다(D-100). 매번 채우면
    # 모든 노드가 같은 IP·메모를 갖게 되고, 운영자가 일부러 비운 값도 다시 채워진다.
    is_first_node = not db.query(InfraNode.id).filter(InfraNode.cluster_id == cluster.id).first()
    if is_first_node:
        if not payload_data.get("ip_address") and cluster.first_host:
            payload_data["ip_address"] = cluster.first_host
        if not payload_data.get("notes") and cluster.description:
            payload_data["notes"] = f"[cluster:{cluster.name}] {cluster.description}"
    node = InfraNode(**payload_data)
    db.add(node)
    _audit(
        db,
        payload.cluster_id,
        entity_type="node",
        entity_id=None,
        action="create",
        scope=SCOPE_EDIT,
        status_text="success",
        after_data=payload.model_dump(mode="json"),
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"이 클러스터에 이미 hostname '{payload.hostname}' 노드가 있습니다.",
        )
    db.refresh(node)
    return node


@router.put("/{node_id}", response_model=InfraNodeResponse)
def update_infra_node(
    node_id: UUID,
    payload: InfraNodeUpdate,
    _=Depends(_require_scope(SCOPE_EDIT)),
    user: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    node = db.query(InfraNode).filter(InfraNode.id == node_id).first()
    if not node:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="InfraNode not found")
    require_cluster_access(db, user, node.cluster_id, "operate")
    if node.version != payload.version:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "Optimistic lock conflict",
                "expected_version": node.version,
                "current_updated_at": node.updated_at.isoformat() if node.updated_at else None,
            },
        )
    before_data = _serialize_node(node)
    patch_data = payload.model_dump(exclude_unset=True, exclude={"version"})
    # NOT NULL 컬럼에 null 이 오면 무시한다(그 외 필드의 null 은 "값 지우기" — D-100).
    for required in ("hostname", "role"):
        if patch_data.get(required, "") is None:
            patch_data.pop(required)
    for k, v in patch_data.items():
        setattr(node, k, v)
    node.version += 1
    _audit(
        db,
        node.cluster_id,
        entity_type="node",
        entity_id=str(node.id),
        action="update",
        scope=SCOPE_EDIT,
        status_text="success",
        before_data=before_data,
        after_data=_serialize_node(node),
    )
    db.commit()
    db.refresh(node)
    return node


@router.delete("/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_infra_node(
    node_id: UUID,
    _=Depends(_require_scope(SCOPE_FORCE_FIX)),
    user: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    node = db.query(InfraNode).filter(InfraNode.id == node_id).first()
    if not node:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="InfraNode not found")
    require_cluster_access(db, user, node.cluster_id, "operate")
    before_data = _serialize_node(node)
    _audit(
        db,
        node.cluster_id,
        entity_type="node",
        entity_id=str(node.id),
        action="delete",
        scope=SCOPE_FORCE_FIX,
        status_text="success",
        before_data=before_data,
    )
    db.delete(node)
    db.commit()
    return None


# ─── 실행 로그 (D-089) ──────────────────────────────────────────────────────
# "K8s 동기화"·"검증" 은 실행 버튼이라 상세·실시간 로그가 필수다(CLAUDE.md). 동기 엔드포인트와
# SSE(`/stream`) 엔드포인트가 같은 실행 함수(_run_sync / _run_verify)를 쓰고, 이벤트는 emit
# 콜백으로 흘린다 — 동기 경로는 버리고, 스트림 경로는 큐를 거쳐 SSE 로 내보낸다.

Emit = Callable[[dict], None]

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}
# 이벤트 없이 이 시간이 지나면 SSE 주석(ping)을 보내 프록시 유휴 타임아웃을 피한다.
_SSE_PING_SEC = 15.0

# 체커 ExecutionStep.status → RunLogPanel 단계 칩 상태
_CHECK_STEP_STATUS = {"running": "running", "success": "done", "skipped": "done", "failed": "failed"}


class _RunFailure(Exception):
    """실행 중단 사유 — 동기 경로는 HTTPException 으로, 스트림 경로는 error 이벤트로 바뀐다."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _noop_emit(_evt: dict) -> None:
    return None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _log(emit: Emit, level: str, message: str) -> None:
    emit({"type": "log", "level": level, "ts": _now(), "message": message})


def _step(emit: Emit, name: str, label: str, status_: str) -> None:
    emit({"type": "step", "name": name, "label": label, "status": status_})


def _status_level(status_: str) -> str:
    return {"critical": "error", "error": "error", "warning": "warn", "pending": "warn"}.get(status_, "info")


def _check_step_line(rec: dict, prefix: str = "") -> tuple[str, str] | None:
    """종료된 체커 단계 → (level, 로그 문장). 진행 중(running) 단계는 None."""
    st = rec.get("status") or "running"
    if st == "running":
        return None
    level = {"failed": "error", "skipped": "warn"}.get(st, "info")
    label = rec.get("label") or rec.get("id") or "?"
    detail = (rec.get("detail") or "").strip()
    msg = f"{prefix}{label} — {st} · {int(rec.get('duration_ms') or 0)}ms"
    if detail:
        msg += f" — {detail[:300]}"
    return level, msg


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"


def _stream_job(job: Callable[[Session, Emit], BaseModel]) -> StreamingResponse:
    """job(sdb, emit) 을 작업 스레드에서 돌리고 emit 된 이벤트를 SSE 로 흘린다.

    - FastAPI 0.106+ 는 yield 의존성(get_db)을 스트리밍 전에 닫으므로 작업 스레드가 자기 세션을 연다.
    - 마지막에 ``result``{result: <응답 모델>} 또는 ``error``{message} 를 보낸다(빈 500 금지).
    - 클라이언트가 끊어도 작업은 끝까지 돌고(동기화·감사 로그 정합성) 세션을 스스로 닫는다.
    """
    q: "queue.Queue[object]" = queue.Queue()
    done = object()

    def worker() -> None:
        sdb = SessionLocal()
        try:
            result = job(sdb, q.put)
            q.put({"type": "result", "result": result.model_dump(mode="json")})
        except _RunFailure as e:
            sdb.rollback()
            q.put({"type": "error", "message": e.detail})
        except Exception as e:  # noqa: BLE001
            sdb.rollback()
            logger.exception("infra-nodes stream job failed")
            q.put({"type": "error", "message": f"실행 중 오류: {str(e)[:300]}"})
        finally:
            sdb.close()
            q.put(done)

    threading.Thread(target=worker, name="infra-nodes-stream", daemon=True).start()

    def gen() -> Iterator[str]:
        while True:
            try:
                evt = q.get(timeout=_SSE_PING_SEC)
            except queue.Empty:
                yield ": ping\n\n"
                continue
            if evt is done:
                return
            yield _sse(evt)  # type: ignore[arg-type]

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


def _verify_node_health(
    db: Session,
    cluster: Cluster,
    hostname: str,
    node_id: UUID | None = None,
    on_step: Callable[[dict], None] | None = None,
) -> NodeVerifyResult:
    """node_health deep check 를 단일 노드에 대해 실행하고 NodeVerifyResult 로 매핑.

    fail-safe: 어떤 오류도 500 으로 새지 않고 status='error' 결과로 반환한다.
    ``on_step`` 은 체커 단계 진입·종료를 실행 중에 받는다(실시간 로그).
    """
    try:
        res = DeepCheckService(db).run_node_health_once(cluster, node_name=hostname, on_step=on_step)
        nodes = (res.get("details") or {}).get("nodes") or []
        ok = bool(nodes[0]["ok"]) if nodes else False
        return NodeVerifyResult(
            hostname=hostname,
            status=res.get("status", "pending"),
            message=res.get("message", ""),
            ok=ok,
            node_id=node_id,
            details=res.get("details") or {},
            steps=res.get("steps") or [],
            step_plan=res.get("step_plan") or [],
            duration_ms=int(res.get("duration_ms") or 0),
        )
    except Exception as e:  # noqa: BLE001
        return NodeVerifyResult(
            hostname=hostname, status="error", ok=False, node_id=node_id,
            message=f"검증 실패: {str(e)[:200]}",
        )


def _load_verify_target(db: Session, user: User, node_id: UUID) -> tuple[InfraNode, Cluster]:
    node = db.query(InfraNode).filter(InfraNode.id == node_id).first()
    if not node:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="InfraNode not found")
    require_cluster_access(db, user, node.cluster_id, "operate")
    cluster = db.query(Cluster).filter(Cluster.id == node.cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")
    return node, cluster


def _run_verify(db: Session, node: InfraNode, cluster: Cluster, emit: Emit) -> NodeVerifyResult:
    """노드 1대 node_health 검증 + 감사 기록. 체커 단계마다 step/log 이벤트를 낸다."""
    _log(emit, "info", f"노드 검증 시작 — {cluster.name} · {node.hostname} (node_health)")

    def on_step(rec: dict) -> None:
        name = f"check:{rec.get('id')}"
        label = rec.get("label") or str(rec.get("id"))
        _step(emit, name, label, _CHECK_STEP_STATUS.get(rec.get("status") or "running", "running"))
        line = _check_step_line(rec)
        if line:
            _log(emit, *line)

    result = _verify_node_health(db, cluster, node.hostname, node_id=node.id, on_step=on_step)
    _audit(
        db,
        node.cluster_id,
        entity_type="node",
        entity_id=str(node.id),
        action="verify",
        scope=SCOPE_SYNC,
        status_text=result.status,
        after_data={"status": result.status, "ok": result.ok, "message": result.message},
    )
    db.commit()
    _log(emit, _status_level(result.status),
         f"검증 완료 — {result.status} · {result.duration_ms}ms — {result.message}")
    return result


@router.post("/{node_id}/verify", response_model=NodeVerifyResult)
def verify_infra_node(
    node_id: UUID,
    _=Depends(_require_scope(SCOPE_SYNC)),
    user: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    """노드 추가 검증 — 해당 노드의 Ready/Pressure/Taint/Allocatable/CNI·kube-proxy 를 점검."""
    node, cluster = _load_verify_target(db, user, node_id)
    return _run_verify(db, node, cluster, _noop_emit)


@router.post("/{node_id}/verify/stream")
def verify_infra_node_stream(
    node_id: UUID,
    _=Depends(_require_scope(SCOPE_SYNC)),
    user: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    """노드 검증 — SSE 실시간 로그 버전(D-089). 체커 단계가 진행되는 대로 step/log 를 흘린다.

    이벤트: ``log``{level,ts,message} · ``step``{name,label,status} · ``result``{result: NodeVerifyResult}
    · ``error``{message}. 권한·존재 검증 실패는 스트림 시작 전에 일반 HTTP 오류로 응답한다.
    본문은 axios 를 타지 않으므로 snake_case 원문 JSON 이다.
    """
    node, cluster = _load_verify_target(db, user, node_id)
    nid, cid = node.id, cluster.id

    def job(sdb: Session, emit: Emit) -> NodeVerifyResult:
        s_node = sdb.query(InfraNode).filter(InfraNode.id == nid).first()
        s_cluster = sdb.query(Cluster).filter(Cluster.id == cid).first()
        if s_node is None or s_cluster is None:
            raise _RunFailure(status.HTTP_404_NOT_FOUND, "노드 또는 클러스터 정보를 다시 읽지 못했습니다.")
        return _run_verify(sdb, s_node, s_cluster, emit)

    return _stream_job(job)


def _parse_ram_gb(mem_str: str) -> int | None:
    if not mem_str:
        return None
    try:
        if mem_str.endswith("Ki"):
            return round(int(mem_str[:-2]) / (1024 * 1024))
        if mem_str.endswith("Mi"):
            return round(int(mem_str[:-2]) / 1024)
        if mem_str.endswith("Gi"):
            return int(mem_str[:-2])
        return round(int(mem_str) / (1024 * 1024 * 1024))
    except ValueError:
        return None


def _sync_kubectl_cmd(cluster: Cluster, emit: Emit) -> list[str]:
    """kubeconfig 해석 단계. DB 에만 저장된 kubeconfig 도 파일로 재구체화해 쓴다.

    아무 kubeconfig 도 등록되지 않은 클러스터는 예전처럼 kubectl 기본 설정(서비스 어카운트·기본
    컨텍스트)으로 시도한다. 경로가 등록됐는데 해석이 안 되면 다른 클러스터를 읽지 않도록 중단한다.
    """
    _step(emit, "kubeconfig", "kubeconfig 확인", "running")
    kc_path, kc_reason = resolve_kubeconfig(cluster)
    cmd = ["kubectl", "get", "nodes", "-o", "json"]
    if kc_path:
        _log(emit, "info", f"kubeconfig: {kc_path}")
        _step(emit, "kubeconfig", "kubeconfig 확인", "done")
        return ["kubectl", "--kubeconfig", kc_path] + cmd[1:]
    if cluster.kubeconfig_path or getattr(cluster, "kubeconfig_content", None):
        _log(emit, "error", kc_reason)
        _step(emit, "kubeconfig", "kubeconfig 확인", "failed")
        raise _RunFailure(status.HTTP_502_BAD_GATEWAY, kc_reason)
    _log(emit, "warn", "등록된 kubeconfig 가 없어 kubectl 기본 설정(서비스 어카운트·기본 컨텍스트)으로 시도합니다.")
    _step(emit, "kubeconfig", "kubeconfig 확인", "done")
    return cmd


def _run_sync(db: Session, cluster: Cluster, emit: Emit) -> SyncResult:
    """kubectl get nodes → InfraNode upsert → 신규 노드 자동 검증. 단계마다 step/log 이벤트를 낸다."""
    cluster_id = cluster.id
    _log(emit, "info", f"K8s 노드 동기화 시작 — {cluster.name}")

    def fail(reason: str, status_code: int) -> None:
        _audit(
            db,
            cluster_id,
            entity_type="node",
            entity_id=None,
            action="sync",
            scope=SCOPE_SYNC,
            status_text="failed",
            reason=reason,
        )
        db.commit()
        raise _RunFailure(status_code, reason)

    cmd = _sync_kubectl_cmd(cluster, emit)

    # ── 1) kubectl get nodes (재시도) ─────────────────────────────
    _step(emit, "kubectl", "kubectl get nodes", "running")
    result = None
    retries = 0
    for attempt in range(_SYNC_RETRY_MAX + 1):
        _log(emit, "info", f"kubectl get nodes 실행 (시도 {attempt + 1}/{_SYNC_RETRY_MAX + 1}, "
                           f"timeout {_KUBECTL_TIMEOUT}s)")
        t0 = time.time()
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=_KUBECTL_TIMEOUT,
            )
            ms = int((time.time() - t0) * 1000)
            if result.returncode == 0:
                _log(emit, "info", f"응답 수신 — {ms}ms")
                break
            _log(emit, "warn", f"kubectl 오류(rc={result.returncode}, {ms}ms): {(result.stderr or '').strip()[:300]}")
        except subprocess.TimeoutExpired:
            result = None
            _log(emit, "warn", f"kubectl 시간 초과({_KUBECTL_TIMEOUT}s)")
        except FileNotFoundError:
            _log(emit, "error", "kubectl 바이너리를 찾을 수 없습니다.")
            _step(emit, "kubectl", "kubectl get nodes", "failed")
            fail("kubectl not found", status.HTTP_503_SERVICE_UNAVAILABLE)
        retries = attempt + 1
        if attempt < _SYNC_RETRY_MAX:
            delay = 1.0 * (attempt + 1)
            _log(emit, "info", f"{delay:.0f}초 후 재시도")
            time.sleep(delay)

    if result is None or result.returncode != 0:
        reason = "kubectl timed out" if result is None else f"kubectl error: {result.stderr[:200]}"
        _log(emit, "error", f"kubectl get nodes 실패 — 재시도 {retries}회 모두 실패")
        _step(emit, "kubectl", "kubectl get nodes", "failed")
        fail(reason, status.HTTP_502_BAD_GATEWAY if result else status.HTTP_504_GATEWAY_TIMEOUT)

    try:
        k8s_data = json.loads(result.stdout)
    except json.JSONDecodeError:
        _log(emit, "error", "kubectl 출력이 JSON 이 아닙니다.")
        _step(emit, "kubectl", "kubectl get nodes", "failed")
        raise _RunFailure(status.HTTP_502_BAD_GATEWAY, "Invalid kubectl output")
    items = k8s_data.get("items", [])
    _log(emit, "info", f"노드 {len(items)}개 수신")
    _step(emit, "kubectl", "kubectl get nodes", "done")

    # ── 2) 노드별 upsert ──────────────────────────────────────────
    _step(emit, "upsert", "노드 반영", "running")
    created_count = 0
    updated_count = 0
    errors: list[str] = []
    created_hostnames: list[str] = []

    for item in items:
        try:
            hostname = item.get("metadata", {}).get("name", "")
            if not hostname:
                errors.append("missing hostname in kubectl item")
                _log(emit, "error", "hostname 이 없는 항목을 건너뜁니다.")
                continue

            labels = item.get("metadata", {}).get("labels", {})
            if "node-role.kubernetes.io/master" in labels or "node-role.kubernetes.io/control-plane" in labels:
                role = "master"
            else:
                role = "worker"

            capacity = item.get("status", {}).get("capacity", {})
            cpu_str = capacity.get("cpu", "")
            cpu_cores = None
            if cpu_str:
                try:
                    cpu_cores = int(cpu_str)
                except ValueError:
                    pass
            ram_gb = _parse_ram_gb(capacity.get("memory", ""))  # e.g. "16Gi" or "16384Ki"

            ip_address = None
            for addr in item.get("status", {}).get("addresses", []):
                if addr.get("type") == "InternalIP":
                    ip_address = addr.get("address")
                    break

            node_info = item.get("status", {}).get("nodeInfo", {})
            os_info = node_info.get("osImage", None)
            spec = f"{role} · CPU {cpu_cores if cpu_cores is not None else '-'} · RAM {ram_gb if ram_gb is not None else '-'}GB" \
                   f" · {ip_address or 'IP 없음'}"

            existing = db.query(InfraNode).filter(
                InfraNode.cluster_id == cluster_id,
                InfraNode.hostname == hostname,
            ).first()

            if existing:
                existing.role = role
                if cpu_cores is not None:
                    existing.cpu_cores = cpu_cores
                if ram_gb is not None:
                    existing.ram_gb = ram_gb
                if ip_address:
                    existing.ip_address = ip_address
                if os_info:
                    existing.os_info = os_info
                existing.auto_synced = True
                existing.version += 1
                updated_count += 1
                _log(emit, "info", f"[{hostname}] 갱신 — {spec}")
            else:
                new_node = InfraNode(
                    cluster_id=cluster_id,
                    hostname=hostname,
                    role=role,
                    cpu_cores=cpu_cores,
                    ram_gb=ram_gb,
                    ip_address=ip_address,
                    os_info=os_info,
                    auto_synced=True,
                )
                db.add(new_node)
                created_count += 1
                created_hostnames.append(hostname)
                _log(emit, "info", f"[{hostname}] 신규 추가 — {spec}")
        except Exception as e:
            name = item.get("metadata", {}).get("name", "unknown")
            errors.append(f"{name}: {str(e)[:120]}")
            _log(emit, "error", f"[{name}] 반영 실패 — {str(e)[:200]}")

    failed_count = len(errors)
    partial_failure = failed_count > 0
    _audit(
        db,
        cluster_id,
        entity_type="node",
        entity_id=None,
        action="sync",
        scope=SCOPE_SYNC,
        status_text="partial" if partial_failure else "success",
        reason="; ".join(errors[:5]) if errors else None,
        after_data={
            "created": created_count,
            "updated": updated_count,
            "failed": failed_count,
            "retry_count": retries,
        },
    )
    db.commit()
    _log(emit, "warn" if partial_failure else "info",
         f"반영 완료 — 신규 {created_count} · 갱신 {updated_count} · 실패 {failed_count}")
    _step(emit, "upsert", "노드 반영", "failed" if partial_failure else "done")

    # ── 3) 신규 노드 자동 검증 (best-effort — 실패해도 sync 결과/semantics 불변) ──
    verifications: list[NodeVerifyResult] = []
    verified_truncated = False
    if created_hostnames:
        _step(emit, "verify", "신규 노드 검증", "running")
        try:
            targets = created_hostnames[:_SYNC_VERIFY_MAX]
            verified_truncated = len(created_hostnames) > _SYNC_VERIFY_MAX
            if verified_truncated:
                _log(emit, "warn", f"신규 노드 {len(created_hostnames)}대 중 {_SYNC_VERIFY_MAX}대만 자동 검증합니다.")
            for i, h in enumerate(targets, 1):
                _log(emit, "info", f"[{h}] 검증 시작 ({i}/{len(targets)})")

                def on_step(rec: dict, _h: str = h) -> None:
                    line = _check_step_line(rec, prefix=f"[{_h}] ")
                    if line:
                        _log(emit, *line)

                v = _verify_node_health(db, cluster, h, on_step=on_step)
                verifications.append(v)
                _log(emit, _status_level(v.status), f"[{h}] 검증 {v.status} · {v.duration_ms}ms — {v.message}")
            bad = sum(1 for v in verifications if not v.ok)
            _step(emit, "verify", "신규 노드 검증", "failed" if bad else "done")
        except Exception as e:  # noqa: BLE001
            verifications = []
            verified_truncated = False
            _log(emit, "warn", f"자동 검증을 건너뜁니다 — {str(e)[:200]}")
            _step(emit, "verify", "신규 노드 검증", "failed")
    else:
        _log(emit, "info", "신규 노드가 없어 자동 검증을 생략합니다.")

    _log(emit, "warn" if partial_failure else "info",
         f"동기화 완료 — 신규 {created_count} · 갱신 {updated_count} · 실패 {failed_count} · 재시도 {retries}회")
    return SyncResult(
        success=not partial_failure,
        created=created_count,
        updated=updated_count,
        failed=failed_count,
        retry_count=retries,
        partial_failure=partial_failure,
        errors=errors[:20],
        total=created_count + updated_count + failed_count,
        verifications=verifications,
        verified_truncated=verified_truncated,
    )


def _load_sync_target(db: Session, cluster_id: UUID) -> Cluster:
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")
    return cluster


@router.post("/sync/{cluster_id}", response_model=SyncResult)
def sync_infra_nodes_from_k8s(
    cluster_id: UUID,
    _=Depends(_require_scope(SCOPE_SYNC)),
    _operator: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    """kubectl get nodes 를 통해 클러스터 노드 정보를 자동 수집하고 upsert"""
    cluster = _load_sync_target(db, cluster_id)
    try:
        return _run_sync(db, cluster, _noop_emit)
    except _RunFailure as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


@router.post("/sync/{cluster_id}/stream")
def sync_infra_nodes_from_k8s_stream(
    cluster_id: UUID,
    _=Depends(_require_scope(SCOPE_SYNC)),
    _operator: User = Depends(require_operator),
    db: Session = Depends(get_db),
):
    """K8s 노드 동기화 — SSE 실시간 로그 버전(D-089).

    kubeconfig 확인 → kubectl get nodes(재시도) → 노드별 upsert → 신규 노드 자동 검증(체커 단계까지)을
    진행되는 대로 흘린다. 이벤트: ``log``{level,ts,message} · ``step``{name,label,status}
    · ``result``{result: SyncResult} · ``error``{message}. 권한·존재 검증 실패는 스트림 시작 전에
    일반 HTTP 오류로 응답한다(테넌트 operate 판정은 라우터 마운트의 cluster-scoped 의존성).
    """
    cid = _load_sync_target(db, cluster_id).id

    def job(sdb: Session, emit: Emit) -> SyncResult:
        s_cluster = sdb.query(Cluster).filter(Cluster.id == cid).first()
        if s_cluster is None:
            raise _RunFailure(status.HTTP_404_NOT_FOUND, "클러스터 정보를 다시 읽지 못했습니다.")
        return _run_sync(sdb, s_cluster, emit)

    return _stream_job(job)
