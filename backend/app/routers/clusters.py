import os
import subprocess
import tempfile
from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from kubernetes import client as k8s_client, config as k8s_config
from kubernetes.client import ApiException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from uuid import UUID

from app.config import settings
from app.database import get_db
from app.models import Cluster, Addon
from app.models.cluster import StatusEnum
from app.models.daily_check import DailyCheckLog, CheckSchedule
from app.models.work_item import WorkItem
from app.models.user import User
from app.auth.deps import require_operator
from app.services.health_checker import HealthChecker
from app.services.config_snapshot import record_cluster_meta_snapshots
from app.services import audit_logger
from app.schemas import (
    ClusterCreate,
    ClusterUpdate,
    ClusterResponse,
    ClusterListResponse,
)

_CONNECT_TIMEOUT = 5  # seconds
_K8S_AUTH_TIMEOUT = 15  # seconds — 300노드 규모 API server 부하 고려. heavy call 은 *4 배수.


# ── helpers ──────────────────────────────────────────────────────────────────

def _kubeconfig_store_path(cluster_id: UUID) -> str:
    """클러스터 ID 기반 kubeconfig 저장 경로"""
    return os.path.join(settings.kubeconfig_store_dir, f"{cluster_id}.yaml")


# kubeconfig 저장/재생성은 app/services/kubeconfig.py 의 공용 헬퍼 사용
from app.services.kubeconfig import (
    save_kubeconfig_content as _save_kubeconfig_content,  # noqa: F401  (호환)
    ensure_kubeconfig_file as _ensure_kubeconfig_file,    # noqa: F401  (호환)
)


def _verify_cluster_connectivity(api_endpoint: str, kubeconfig_path: str | None) -> None:
    """
    클러스터 등록 전 연결 가능 여부 검증.
    - kubeconfig_path 가 제공된 경우: 파일 존재 여부 확인
    - api_endpoint: /healthz 로 HTTP 요청, 응답이 있으면 OK (401/403 포함)
    연결 실패 시 HTTPException(422) 발생.
    """
    # 1) kubeconfig 파일 존재 확인 (경로가 직접 지정된 경우)
    if kubeconfig_path:
        if not os.path.exists(kubeconfig_path):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"kubeconfig 파일을 찾을 수 없습니다: '{kubeconfig_path}'. 경로를 확인하세요.",
            )

    # 2) API 엔드포인트 연결 확인
    healthz_url = api_endpoint.rstrip("/") + "/healthz"
    try:
        with httpx.Client(verify=False, timeout=_CONNECT_TIMEOUT) as client:
            resp = client.get(healthz_url)
        # 401/403 은 인증 문제일 뿐 엔드포인트 자체는 정상
        if resp.status_code >= 500:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"클러스터 API 서버가 오류를 반환했습니다 (HTTP {resp.status_code}). "
                       "API Endpoint를 확인하세요.",
            )
    except HTTPException:
        raise
    except httpx.ConnectError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"클러스터 API 서버에 연결할 수 없습니다: '{api_endpoint}'. "
                   "API Endpoint 주소가 올바른지 확인하세요.",
        )
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"클러스터 API 서버 연결 시간 초과 ({_CONNECT_TIMEOUT}s): '{api_endpoint}'. "
                   "네트워크 연결 및 방화벽 설정을 확인하세요.",
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"클러스터 연결 검증 실패: {str(exc)[:200]}",
        )

    # 3) kubeconfig 로 인증 가능한지 확인 (제공된 경우)
    if kubeconfig_path:
        _verify_kubeconfig_auth(api_endpoint, kubeconfig_path)


def _diagnose_max_retries(kubeconfig_host: str, exc: Exception) -> str:
    """urllib3 MaxRetryError / ConnectionError 를 사람이 읽을 수 있는 원인 설명으로.

    흔한 시나리오:
    - kubeconfig server URL 이 private IP (예: 10.x / 192.168.x / cluster.local)
      인데 백엔드 컨테이너 네트워크에서 라우팅 안 됨 → "대상 호스트 도달 불가"
    - DNS 실패 (FQDN 이 backend resolver 에서 안 풀림)
    - TLS/인증서 문제 (self-signed CA 가 kubeconfig 에 없거나 잘못)
    - 방화벽/보안 그룹 차단 (6443 포트 막힘)
    """
    msg = str(exc).lower()
    hints: list[str] = []
    if "name or service not known" in msg or "nodename nor servname" in msg or "temporary failure in name resolution" in msg:
        hints.append("DNS 해석 실패 — kubeconfig server URL 의 도메인을 backend 컨테이너가 resolve 할 수 있는지 확인")
    if "connection refused" in msg:
        hints.append("접속 거부 — 대상 호스트의 API 서버 포트(보통 6443)가 살아있는지, 방화벽이 열려있는지 확인")
    if "no route to host" in msg or "network is unreachable" in msg:
        hints.append("라우팅 불가 — kubeconfig server 가 internal IP(10.x/192.168.x/cluster.local)인 경우, backend 컨테이너는 기본적으로 그 네트워크에 접근 못 함. 공용 endpoint 또는 jump host 경유 필요")
    if "timed out" in msg or "timeout" in msg:
        hints.append("타임아웃 — 네트워크 경로가 느리거나 중간에 패킷이 버려짐")
    if "certificate verify failed" in msg or "ssl:" in msg:
        hints.append("TLS/CA 검증 실패 — kubeconfig 의 certificate-authority-data 가 실제 서버 인증서와 매칭되는지 확인")
    if "max retries exceeded" in msg and not hints:
        hints.append("urllib3 재시도 소진 — 네트워크 또는 TLS 설정 점검 필요")

    base = f"kubeconfig 서버({kubeconfig_host}) 에 연결할 수 없습니다."
    if hints:
        return base + " 가능한 원인: " + " / ".join(hints)
    return base + f" 원문: {str(exc)[:200]}"


def _verify_kubeconfig_auth(api_endpoint: str, kubeconfig_path: str) -> None:
    """kubeconfig 인증/권한 유효성 검증."""
    api_client = None
    kubeconfig_host = ""
    try:
        api_client = k8s_config.new_client_from_config(config_file=kubeconfig_path)
        kubeconfig_host = (api_client.configuration.host or "").rstrip("/")
        normalized_api_endpoint = api_endpoint.rstrip("/")
        if kubeconfig_host and kubeconfig_host != normalized_api_endpoint:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    "kubeconfig 서버 주소와 API Endpoint가 일치하지 않습니다. "
                    f"kubeconfig: '{kubeconfig_host}', API Endpoint: '{normalized_api_endpoint}'"
                ),
            )

        v1 = k8s_client.CoreV1Api(api_client)
        v1.list_namespace(limit=1, _request_timeout=_K8S_AUTH_TIMEOUT)
    except HTTPException:
        raise
    except ApiException as exc:
        if exc.status in (401, 403):
            detail = f"kubeconfig 인증에 실패했습니다 (HTTP {exc.status}). 토큰/인증서/권한을 확인하세요. 서버: {kubeconfig_host or '(알 수 없음)'}"
        else:
            detail = f"kubeconfig 검증 실패 (HTTP {exc.status}): {exc.reason}. 서버: {kubeconfig_host or '(알 수 없음)'}"
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=detail)
    except Exception as exc:
        # urllib3 MaxRetryError / ConnectionError / SSLError 등 네트워크 계열은
        # 원인을 추정해서 안내
        exc_text = str(exc).lower()
        if (
            "max retries" in exc_text
            or "newconnectionerror" in exc_text
            or "sslerror" in exc_text
            or "name or service not known" in exc_text
            or "timed out" in exc_text
        ):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=_diagnose_max_retries(kubeconfig_host or api_endpoint, exc),
            )
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"kubeconfig 검증 실패: {str(exc)[:200]}",
        )


# ── 클러스터 생성 시 자동 등록할 기본 애드온 ─────────────────────────────────
DEFAULT_ADDONS = [
    {"name": "etcd Leader",    "type": "etcd-leader",    "icon": "💾", "description": "etcd leader election & health status"},
    {"name": "Node Status",    "type": "node-check",     "icon": "🖥️", "description": "Node readiness & pressure conditions"},
    {"name": "Control Plane",  "type": "control-plane",  "icon": "🎛️", "description": "API Server, Scheduler, Controller Manager"},
    {"name": "CoreDNS",        "type": "system-pod",     "icon": "🔍", "description": "Cluster DNS service"},
]

router = APIRouter(prefix="/clusters", tags=["clusters"])


# ── Kubeconfig request/response schemas ───────────────────────────────────────
class KubeconfigUpdateRequest(BaseModel):
    content: str


class KubeconfigResponse(BaseModel):
    content: str
    path: str


# ── routes ────────────────────────────────────────────────────────────────────

@router.get("", response_model=ClusterListResponse)
def get_clusters(db: Session = Depends(get_db)):
    """전체 클러스터 목록 조회 — 사용자 지정 seq 오름차순, 동률은 이름 순."""
    clusters = db.query(Cluster).order_by(Cluster.seq.asc(), Cluster.name.asc()).all()
    return ClusterListResponse(data=clusters)


class ReorderRequest(BaseModel):
    """드래그앤드랍 정렬 결과: 클러스터 id 를 원하는 순서대로 보냄."""
    cluster_ids: list[UUID] = Field(..., min_length=1)


@router.post("/reorder")
def reorder_clusters(
    payload: ReorderRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """순서 일괄 갱신 — 받은 순서대로 seq 를 10 간격으로 재할당."""
    seen: set[UUID] = set()
    for i, cid in enumerate(payload.cluster_ids):
        if cid in seen:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="cluster_ids 에 중복 id 가 포함되어 있습니다.",
            )
        seen.add(cid)
        cluster = db.query(Cluster).filter(Cluster.id == cid).first()
        if not cluster:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Cluster {cid} not found",
            )
        cluster.seq = 1000 + i * 10
    db.commit()
    return {"updated": len(payload.cluster_ids)}


@router.get("/{cluster_id}", response_model=ClusterResponse)
def get_cluster(cluster_id: UUID, db: Session = Depends(get_db)):
    """클러스터 상세 조회"""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")
    return cluster


@router.post("", response_model=ClusterResponse, status_code=status.HTTP_201_CREATED)
def create_cluster(
    cluster_data: ClusterCreate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """클러스터 생성 (등록 전 연결 검증 포함, skip_connectivity_check=True 시 임시 등록)"""
    # 중복 이름 체크
    existing = db.query(Cluster).filter(Cluster.name == cluster_data.name).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cluster with this name already exists",
        )

    # kubeconfig_content 는 임시 파일에 저장 후 검증에 활용
    payload = cluster_data.model_dump(exclude={"kubeconfig_content", "skip_connectivity_check"})
    content = cluster_data.kubeconfig_content
    effective_path = payload.get("kubeconfig_path")
    skip_check = cluster_data.skip_connectivity_check

    connectivity_failed = False
    connectivity_error: str | None = None

    temp_kubeconfig_path = None
    if content and content.strip():
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False, encoding="utf-8") as temp_file:
            temp_file.write(content.strip())
            temp_kubeconfig_path = temp_file.name
        effective_path = temp_kubeconfig_path

    try:
        api_ep = (cluster_data.api_endpoint or '').strip()
        if skip_check or not api_ep:
            # 연결 검증 생략 — 실패해도 임시(pending) 상태로 등록
            if api_ep:
                try:
                    _verify_cluster_connectivity(api_ep, effective_path)
                except HTTPException as exc:
                    connectivity_failed = True
                    connectivity_error = exc.detail
            else:
                connectivity_failed = True
                connectivity_error = "API Endpoint 미입력 — 임시(가등록) 상태"
        else:
            _verify_cluster_connectivity(api_ep, effective_path)
    finally:
        if temp_kubeconfig_path and os.path.exists(temp_kubeconfig_path):
            os.remove(temp_kubeconfig_path)

    # 연결 실패 시 pending 상태로 설정
    if connectivity_failed:
        payload["status"] = StatusEnum.pending

    cluster = Cluster(**payload)
    db.add(cluster)
    db.flush()  # cluster.id 확정

    # kubeconfig content 가 있으면 DB 에 보관하고 파일로도 저장
    if content and content.strip():
        cleaned = content.strip()
        cluster.kubeconfig_content = cleaned
        cluster.kubeconfig_path = _save_kubeconfig_content(cluster.id, cleaned)

    # 기본 애드온 자동 등록
    for addon_config in DEFAULT_ADDONS:
        db.add(Addon(cluster_id=cluster.id, **addon_config))

    # 새 클러스터에도 샘플 점검 playbook 을 자동으로 채워 넣는다.
    # 본문은 ansible_playbook_files (DB 라이브러리) 를 통해 공유 — 이미 lifespan 시드에서
    # upsert 됐다면 그 row 를 재사용하고, 없으면 디스크에서 읽어 새로 등록한다.
    try:
        from app.main import _SAMPLE_PLAYBOOKS
        from app.models.ansible_assets import AnsiblePlaybookFile
        from app.models.playbook import Playbook as PlaybookModel

        base_dir = settings.ansible_playbook_dir.rstrip("/")
        for sp in _SAMPLE_PLAYBOOKS:
            file_row = db.query(AnsiblePlaybookFile).filter(
                AnsiblePlaybookFile.name == sp["name"],
            ).first()
            if file_row is None:
                disk_path = f"{base_dir}/{sp['playbook_path']}"
                if os.path.exists(disk_path):
                    try:
                        with open(disk_path, "r", encoding="utf-8") as f:
                            body = f.read()
                        file_row = AnsiblePlaybookFile(
                            name=sp["name"],
                            description=sp["description"],
                            content=body,
                        )
                        db.add(file_row)
                        db.flush()
                    except OSError:
                        file_row = None
            db.add(PlaybookModel(
                cluster_id=cluster.id,
                name=sp["name"],
                description=sp["description"],
                playbook_file_id=file_row.id if file_row else None,
                inventory_path=None,
                extra_vars=sp.get("extra_vars"),
                show_on_dashboard=sp.get("show_on_dashboard", False),
            ))
    except Exception:
        # 샘플 seed 실패해도 클러스터 등록 자체는 성공시킴 — 추후 lifespan 의 seed 가 보완.
        pass

    db.commit()

    # pending 상태가 아닌 경우에만 초기 점검 + 노드 IP 자동 수집 수행
    if not connectivity_failed:
        HealthChecker(db).run_check(cluster.id)
        # kubeconfig 가 등록돼 있으면 노드 IP/노드 수/마스터 hostname 을 best-effort 로 채움.
        # 실패해도 클러스터 등록 자체는 성공시킴 — 사용자가 이후 "IP 수집" 버튼으로 재시도 가능.
        try:
            _collect_node_basics(cluster, db)
        except Exception:
            pass

    db.refresh(cluster)
    audit_logger.record(
        db,
        action="cluster.create",
        actor=actor,
        status="success",
        target_type="cluster",
        target_id=cluster.id,
        details={"name": cluster.name},
        request=request,
    )
    return cluster


@router.put("/{cluster_id}", response_model=ClusterResponse)
def update_cluster(
    cluster_id: UUID,
    cluster_data: ClusterUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """클러스터 수정"""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    update_data = cluster_data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(cluster, key, value)

    db.commit()
    db.refresh(cluster)
    return cluster


@router.delete("/{cluster_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_cluster(
    cluster_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """클러스터 삭제"""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")
    snapshot = {"name": cluster.name}

    # 저장된 kubeconfig 파일 삭제
    stored_path = _kubeconfig_store_path(cluster_id)
    if os.path.exists(stored_path):
        try:
            os.remove(stored_path)
        except OSError:
            pass

    # FK 제약 때문에 Cluster 삭제 전 연관 데이터 처리
    # - DailyCheckLog, CheckSchedule: cluster_id NOT NULL → 먼저 삭제
    db.query(DailyCheckLog).filter(DailyCheckLog.cluster_id == cluster_id).delete(synchronize_session=False)
    db.query(CheckSchedule).filter(CheckSchedule.cluster_id == cluster_id).delete(synchronize_session=False)
    # - WorkItem (issue / task 통합): cluster_id nullable → NULL 처리 (레코드 보관)
    db.query(WorkItem).filter(WorkItem.cluster_id == cluster_id).update(
        {"cluster_id": None}, synchronize_session=False
    )

    db.delete(cluster)
    db.commit()
    audit_logger.record(
        db,
        action="cluster.delete",
        actor=actor,
        status="success",
        target_type="cluster",
        target_id=cluster_id,
        details=snapshot,
        request=request,
    )
    return None


@router.get("/{cluster_id}/kubeconfig", response_model=KubeconfigResponse)
def get_kubeconfig(cluster_id: UUID, db: Session = Depends(get_db)):
    """클러스터 kubeconfig 내용 조회 — DB 우선, 파일은 폴백."""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    # 1) DB 에 kubeconfig_content 가 있으면 그것이 진실 (컨테이너 재시작 대비)
    if cluster.kubeconfig_content:
        # 파일이 없으면 재생성해서 kubectl/k8s SDK 경로 수요도 채움
        path = _ensure_kubeconfig_file(cluster) or ""
        if path and path != cluster.kubeconfig_path:
            cluster.kubeconfig_path = path
            db.commit()
        return KubeconfigResponse(content=cluster.kubeconfig_content, path=path)

    # 2) DB 에는 없고 파일만 있는 (구) 레코드 호환
    path = cluster.kubeconfig_path
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            content = f.read()
        # 다음 조회부터는 DB 에서 바로 내려주도록 백필
        cluster.kubeconfig_content = content
        db.commit()
        return KubeconfigResponse(content=content, path=path)

    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="kubeconfig 파일이 없습니다. 먼저 kubeconfig를 등록하세요.",
    )


@router.put("/{cluster_id}/kubeconfig", response_model=KubeconfigResponse)
def update_kubeconfig(
    cluster_id: UUID,
    body: KubeconfigUpdateRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """클러스터 kubeconfig 내용 저장/수정"""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    if not body.content.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="kubeconfig 내용이 비어 있습니다.",
        )

    cleaned = body.content.strip()
    saved_path = _save_kubeconfig_content(cluster_id, cleaned)
    cluster.kubeconfig_path = saved_path
    cluster.kubeconfig_content = cleaned
    db.commit()
    return KubeconfigResponse(content=cleaned, path=saved_path)


@router.post("/{cluster_id}/verify")
def verify_cluster(
    cluster_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """클러스터 연결 상태 상세 검증"""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    results = []

    # 1. API Server 연결
    try:
        healthz_url = (cluster.api_endpoint or "").rstrip("/") + "/healthz"
        with httpx.Client(verify=False, timeout=_CONNECT_TIMEOUT) as client:
            resp = client.get(healthz_url)
        ok = resp.status_code < 500
        results.append({"check": "api_server", "ok": ok, "detail": f"HTTP {resp.status_code} — {resp.text[:80].strip()}"})
    except httpx.ConnectError as e:
        results.append({"check": "api_server", "ok": False, "detail": f"연결 실패: {str(e)[:80]}"})
    except httpx.TimeoutException:
        results.append({"check": "api_server", "ok": False, "detail": f"타임아웃 ({_CONNECT_TIMEOUT}s)"})
    except Exception as e:
        results.append({"check": "api_server", "ok": False, "detail": str(e)[:80]})

    # 2. kubeconfig 인증 — 파일이 없으면 DB content 로 재생성 시도
    kc_path = _ensure_kubeconfig_file(cluster)
    if kc_path and os.path.exists(kc_path):
        try:
            api_client = k8s_config.new_client_from_config(config_file=kc_path)
            v1 = k8s_client.CoreV1Api(api_client)
            v1.list_namespace(limit=1, _request_timeout=_K8S_AUTH_TIMEOUT)
            results.append({"check": "kubeconfig_auth", "ok": True, "detail": "인증 성공"})
        except ApiException as e:
            results.append({"check": "kubeconfig_auth", "ok": False, "detail": f"HTTP {e.status}: {e.reason}"})
        except Exception as e:
            results.append({"check": "kubeconfig_auth", "ok": False, "detail": str(e)[:80]})
    else:
        results.append({"check": "kubeconfig_auth", "ok": None, "detail": "kubeconfig 파일 없음"})

    # 3. kubectl get nodes
    if kc_path and os.path.exists(kc_path):
        try:
            cmd = ["kubectl", "--kubeconfig", kc_path]
            if cluster.api_endpoint:
                cmd += ["--server", cluster.api_endpoint]
            cmd += ["get", "nodes", "--no-headers"]
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
            if res.returncode == 0:
                node_lines = [l for l in res.stdout.strip().split("\n") if l]
                results.append({"check": "kubectl_nodes", "ok": True, "detail": f"{len(node_lines)}개 노드 조회 성공"})
            else:
                results.append({"check": "kubectl_nodes", "ok": False, "detail": res.stderr.strip()[:100]})
        except Exception as e:
            results.append({"check": "kubectl_nodes", "ok": False, "detail": str(e)[:80]})
    else:
        results.append({"check": "kubectl_nodes", "ok": None, "detail": "kubeconfig 파일 없음"})

    overall_ok = all(r["ok"] is True for r in results if r["ok"] is not None)

    # 연결 확인 결과를 cluster.status 에 반영.
    # - OK   → healthy
    # - 실패 → pending (연결 불가. critical 은 "연결은 되는데 addon 이 critical" 을 위해 유지)
    cluster.status = StatusEnum.healthy if overall_ok else StatusEnum.pending
    cluster.updated_at = datetime.utcnow()
    db.commit()

    return {"cluster_id": str(cluster_id), "cluster_name": cluster.name, "ok": overall_ok, "results": results}


# ── 자동 업데이트 (kubeconfig 기반) ───────────────────────────────────────────

def _extract_flag_value(container_spec, flag: str) -> str | None:
    """kube-apiserver / kube-controller-manager 컨테이너 command/args 에서 --flag=value 또는 --flag value 추출."""
    tokens: list[str] = []
    if container_spec.command:
        tokens.extend(container_spec.command)
    if container_spec.args:
        tokens.extend(container_spec.args)
    prefix = f"--{flag}="
    for i, tok in enumerate(tokens):
        if tok.startswith(prefix):
            return tok[len(prefix):]
        if tok == f"--{flag}" and i + 1 < len(tokens):
            return tokens[i + 1]
    return None


def _cidr_range(cidr: str | None) -> tuple[str | None, str | None]:
    """CIDR 에서 first/last host 를 계산 (IPv4). 실패 시 (None, None)."""
    if not cidr:
        return None, None
    try:
        import ipaddress
        net = ipaddress.ip_network(cidr.strip(), strict=False)
        hosts = list(net.hosts()) if net.num_addresses > 2 else [net.network_address, net.broadcast_address]
        if not hosts:
            return None, None
        return str(hosts[0]), str(hosts[-1])
    except Exception:
        return None, None


def _infer_node_cidr(ips: list[str]) -> tuple[str | None, str | None, str | None]:
    """노드 InternalIP 목록에서 **최소 공통 supernet** 을 추정해
    (cidr, first_host, last_host) 반환. 실패 / 범위가 너무 넓으면 (None, None, None).

    - 1개: 해당 IP 의 /24 로 가정 (worker 1 대 환경 대비).
    - 2개+: 모든 IP 를 포함하는 가장 좁은 IPv4 네트워크.
    - 결과 prefix < 16 (10.0.0.0/8 류) 면 신뢰도 낮다고 판단해 None 반환.
    """
    import ipaddress

    valid: list[ipaddress.IPv4Address] = []
    for ip in ips or []:
        if not ip:
            continue
        try:
            addr = ipaddress.ip_address(ip.strip())
        except ValueError:
            continue
        if isinstance(addr, ipaddress.IPv4Address):
            valid.append(addr)

    if not valid:
        return None, None, None

    if len(valid) == 1:
        net = ipaddress.IPv4Network(f"{valid[0]}/24", strict=False)
    else:
        lo = min(int(a) for a in valid)
        hi = max(int(a) for a in valid)
        xor = lo ^ hi
        prefix_len = 32
        while xor:
            xor >>= 1
            prefix_len -= 1
        net_addr = lo & ~((1 << (32 - prefix_len)) - 1) & 0xFFFFFFFF
        try:
            net = ipaddress.IPv4Network((net_addr, prefix_len))
        except (ValueError, TypeError):
            return None, None, None

    if net.prefixlen < 16:
        # 너무 넓음 (예: 10.0.0.0/8) — 노드가 여러 리전/VPC 에 걸쳐 있거나
        # 부정확한 추정. 자동 갱신 안 함.
        return None, None, None

    cidr_str = str(net)
    hosts = list(net.hosts()) if net.num_addresses > 2 else [net.network_address, net.broadcast_address]
    if not hosts:
        return cidr_str, None, None
    return cidr_str, str(hosts[0]), str(hosts[-1])


def _collect_node_basics(cluster: Cluster, db: Session) -> bool:
    """클러스터 등록 직후 호출되는 노드 IP/Count/master hostname best-effort 수집기.

    auto_update_cluster 의 풀 로직 중 "k8s API 만 호출해서 안전하게 채울 수 있는" 부분만 추려
    초기 등록 시 nodeIps 가 비어있는 상태(미수집)가 발생하지 않도록 한다.

    실패 시 False 반환하고 호출부에서 swallow — 등록 자체를 막지 않는다.
    """
    import json as _json
    kc_path = _ensure_kubeconfig_file(cluster)
    if not kc_path or not os.path.exists(kc_path):
        return False
    try:
        api_client = k8s_config.new_client_from_config(config_file=kc_path)
        v1 = k8s_client.CoreV1Api(api_client)
        nodes = v1.list_node(_request_timeout=_K8S_AUTH_TIMEOUT * 4)
    except Exception:
        return False

    items = nodes.items
    cluster.node_count = len(items)

    ip_list: list[dict] = []
    for n in items:
        internal_ips: list[str] = []
        external_ip: str | None = None
        for addr in (n.status.addresses or []) if n.status else []:
            if addr.type == "InternalIP" and addr.address and addr.address not in internal_ips:
                internal_ips.append(addr.address)
            elif addr.type == "ExternalIP" and addr.address and not external_ip:
                external_ip = addr.address
        labels = n.metadata.labels or {}
        is_master = any(l in labels for l in (
            "node-role.kubernetes.io/control-plane", "node-role.kubernetes.io/master",
        ))
        ip_list.append({
            "name": n.metadata.name,
            "ip": internal_ips[0] if internal_ips else None,
            "ips": internal_ips,
            "external_ip": external_ip,
            "master": is_master,
        })
    ip_list.sort(key=lambda x: (not x["master"], x["name"]))
    cluster.node_ips = _json.dumps(ip_list, ensure_ascii=False)

    master_nodes = [r for r in ip_list if r["master"]]
    pick = (master_nodes or ip_list)[0] if ip_list else None
    if pick:
        cluster.hostname = pick["name"]

    # 등록 시 첫 메타 스냅샷 — 이후 auto-update 와 비교 가능한 baseline 이 된다.
    record_cluster_meta_snapshots(db, cluster, datetime.utcnow())

    db.commit()
    return True


@router.post("/{cluster_id}/auto-update")
def auto_update_cluster(
    cluster_id: UUID,
    dry_run: bool = False,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """kubeconfig/k8s API 만으로 얻을 수 있는 클러스터 메타데이터를 자동 수집/반영.

    채우는 필드: node_count, hostname (master 후보), max_pod, pod_cidr/first/last,
    svc_cidr/first/last, cilium_config, bgp_enabled, as_number.
    NIC (bond*), Node CIDR 비트마스크는 kubeconfig 만으로는 알 수 없어 건너뜀.

    dry_run=True 면 DB 에 반영하지 않고 {current, proposed, diff} 만 돌려준다.
    """
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    kc_path = _ensure_kubeconfig_file(cluster)
    if not kc_path or not os.path.exists(kc_path):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="kubeconfig가 없습니다. 먼저 kubeconfig를 등록하세요.",
        )

    # dry_run 시 비교 대상 스냅샷 (현재 DB 값)
    _DIFF_FIELDS = [
        ("nodeCount", "node_count"),
        ("hostname", "hostname"),
        ("maxPod", "max_pod"),
        ("cidr", "cidr"),
        ("firstHost", "first_host"),
        ("lastHost", "last_host"),
        ("svcCidr", "svc_cidr"),
        ("svcFirstHost", "svc_first_host"),
        ("svcLastHost", "svc_last_host"),
        ("podCidr", "pod_cidr"),
        ("podFirstHost", "pod_first_host"),
        ("podLastHost", "pod_last_host"),
        ("ciliumConfig", "cilium_config"),
        ("bgpEnabled", "bgp_enabled"),
        ("asNumber", "as_number"),
        ("k8sVersion", "k8s_version"),
        ("ciliumVersion", "cilium_version"),
        ("nodeIps", "node_ips"),
        ("bond0Ip",  "bond0_ip"),
        ("bond0Mac", "bond0_mac"),
        ("bond1Ip",  "bond1_ip"),
        ("bond1Mac", "bond1_mac"),
    ]
    current: dict[str, object] = {
        camel: getattr(cluster, snake) for camel, snake in _DIFF_FIELDS
    }

    updated: dict[str, object] = {}
    warnings: list[str] = []

    try:
        api_client = k8s_config.new_client_from_config(config_file=kc_path)
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"kubeconfig 로드 실패: {str(e)[:120]}")

    v1 = k8s_client.CoreV1Api(api_client)
    custom = k8s_client.CustomObjectsApi(api_client)
    version_api = k8s_client.VersionApi(api_client)

    # 0. k8s server version (VersionApi)
    #    git_version 은 배포판(RKE2/EKS/OpenShift) 에 따라 매우 길어질 수 있음 →
    #    DB 컬럼 (VARCHAR(128)) 보호 위해 truncate.
    try:
        ver = version_api.get_code(_request_timeout=_K8S_AUTH_TIMEOUT)
        k8s_ver = getattr(ver, "git_version", None) or getattr(ver, "major", None)
        if k8s_ver:
            k8s_ver = str(k8s_ver)[:128]
            cluster.k8s_version = k8s_ver
            updated["k8sVersion"] = k8s_ver
    except Exception as e:
        warnings.append(f"k8s 버전 조회 실패 ({type(e).__name__}): {str(e)[:120]}")

    # 1. nodes → node_count, hostname(master), max_pod, node_ips
    try:
        nodes = v1.list_node(_request_timeout=_K8S_AUTH_TIMEOUT * 4)
        items = nodes.items
        cluster.node_count = len(items)
        updated["nodeCount"] = len(items)

        # 노드별 IP 수집 — 노드당 InternalIP 가 여러 개 (bond0/bond1) 인 경우 모두 수집.
        # k8s API (status.addresses) 가 bonding 설정에 따라 InternalIP 를 복수 반환하는
        # 경우가 있음. 인터페이스 이름(bond0 등) 은 k8s API 로 알 수 없으므로,
        # 이전 SSH 수집(`collect-node-nics`)으로 채워둔 `interfaces[]` 를 노드명/IP 매칭으로
        # 보존해 bond0/bond1 표기가 auto-update 후에도 사라지지 않도록 한다.
        import json as _json

        existing_ifaces_by_name: dict[str, list] = {}
        existing_ifaces_by_ip: dict[str, list] = {}
        if cluster.node_ips:
            try:
                _prev = _json.loads(cluster.node_ips)
                if isinstance(_prev, list):
                    for _p in _prev:
                        _ifaces = _p.get("interfaces") if isinstance(_p, dict) else None
                        if not _ifaces:
                            continue
                        _nm = _p.get("name")
                        if _nm:
                            existing_ifaces_by_name[_nm] = _ifaces
                        _ips = _p.get("ips") or ([_p.get("ip")] if _p.get("ip") else [])
                        for _ip in _ips:
                            if _ip:
                                existing_ifaces_by_ip[_ip] = _ifaces
            except Exception:
                pass

        ip_list: list[dict] = []
        for n in items:
            internal_ips: list[str] = []
            external_ip: str | None = None
            for addr in (n.status.addresses or []) if n.status else []:
                if addr.type == "InternalIP" and addr.address:
                    if addr.address not in internal_ips:
                        internal_ips.append(addr.address)
                elif addr.type == "ExternalIP" and addr.address and not external_ip:
                    external_ip = addr.address
            labels = n.metadata.labels or {}
            is_master = any(l in labels for l in (
                "node-role.kubernetes.io/control-plane", "node-role.kubernetes.io/master",
            ))
            entry: dict = {
                "name": n.metadata.name,
                "ip": internal_ips[0] if internal_ips else None,   # 호환성: 1차 IP
                "ips": internal_ips,                               # 전체 InternalIP 배열
                "external_ip": external_ip,
                "master": is_master,
            }
            # 이전 SSH 수집의 interfaces[] 보존 — 이름 우선, IP fallback
            preserved_ifaces = existing_ifaces_by_name.get(n.metadata.name)
            if not preserved_ifaces:
                for _ip in internal_ips:
                    if _ip in existing_ifaces_by_ip:
                        preserved_ifaces = existing_ifaces_by_ip[_ip]
                        break
            if preserved_ifaces:
                entry["interfaces"] = preserved_ifaces
            ip_list.append(entry)
        # 정렬: master 먼저, 그 다음 이름
        ip_list.sort(key=lambda x: (not x["master"], x["name"]))
        node_ips_json = _json.dumps(ip_list, ensure_ascii=False)
        cluster.node_ips = node_ips_json
        updated["nodeIps"] = node_ips_json

        # Master 노드의 interfaces[] 가 살아있으면 클러스터 테이블의 bond0/bond1
        # IP/MAC 컬럼도 함께 갱신 (서버 스펙 카드/디테일 뷰 용).
        master_entry = next(
            (e for e in ip_list if e.get("master") and e.get("interfaces")),
            None,
        )
        if master_entry:
            for ifc in master_entry.get("interfaces") or []:
                if not isinstance(ifc, dict):
                    continue
                nm = (ifc.get("name") or "").lower()
                ips = [ip for ip in (ifc.get("ips") or []) if ip]
                mac = ifc.get("mac")
                if nm == "bond0":
                    if ips and cluster.bond0_ip != ips[0]:
                        cluster.bond0_ip = ips[0]
                        updated["bond0Ip"] = ips[0]
                    if mac and cluster.bond0_mac != mac:
                        cluster.bond0_mac = mac
                        updated["bond0Mac"] = mac
                elif nm == "bond1":
                    if ips and cluster.bond1_ip != ips[0]:
                        cluster.bond1_ip = ips[0]
                        updated["bond1Ip"] = ips[0]
                    if mac and cluster.bond1_mac != mac:
                        cluster.bond1_mac = mac
                        updated["bond1Mac"] = mac

        # Node CIDR 추정 — 실제 노드 InternalIP 들의 최소 공통 supernet.
        # 노드당 여러 IP 가 있으면 전부 평탄화해서 계산 → bond0/bond1 모두 포함하는 subnet 도출.
        all_ips: list[str] = [ip for row in ip_list for ip in (row.get("ips") or [])]
        inferred_cidr, first_h, last_h = _infer_node_cidr(all_ips)
        if inferred_cidr:
            cluster.cidr = inferred_cidr
            updated["cidr"] = inferred_cidr
            if first_h:
                cluster.first_host = first_h
                updated["firstHost"] = first_h
            if last_h:
                cluster.last_host = last_h
                updated["lastHost"] = last_h
        elif node_ips_only:
            warnings.append(
                f"Node CIDR 추정 실패 — 노드 IP {len(node_ips_only)}개가 너무 분산되어 있거나 "
                "IPv4 가 아닙니다 (최소 공통 subnet 이 /16 보다 넓음)."
            )

        master_labels = ("node-role.kubernetes.io/control-plane", "node-role.kubernetes.io/master")
        master_nodes = [n for n in items if any(l in (n.metadata.labels or {}) for l in master_labels)]
        pick = (master_nodes or items)[0] if items else None
        if pick:
            cluster.hostname = pick.metadata.name
            updated["hostname"] = pick.metadata.name
            allocatable = (pick.status.allocatable or {}) if pick.status else {}
            pods_str = allocatable.get("pods")
            if pods_str:
                try:
                    cluster.max_pod = int(pods_str)
                    updated["maxPod"] = int(pods_str)
                except ValueError:
                    warnings.append(f"maxPod 파싱 실패: {pods_str}")

        # pod CIDR: 노드 spec.podCIDR 들을 모아 최소 덮는 대역을 추정하기는 어렵고,
        # kube-controller-manager --cluster-cidr 를 우선 사용. 아래에서 처리.
    except Exception as e:
        warnings.append(f"nodes 조회 실패 ({type(e).__name__}): {str(e)[:120]}")

    # 2. kube-apiserver / kube-controller-manager pod 의 플래그에서 CIDR 추출.
    #    300노드 규모에서 kube-system 전체 pod list 는 수 MB~수십 MB → worker timeout 원인.
    #    → master hostname 기반 static-pod 이름으로 직접 read, 실패 시 label_selector+limit=1 fallback.
    def _fetch_control_plane_pod(component: str):
        # static-pod 이름 규칙: "{component}-{master-hostname}"
        if cluster.hostname:
            candidate = f"{component}-{cluster.hostname}"
            try:
                return v1.read_namespaced_pod(
                    candidate, "kube-system",
                    _request_timeout=_K8S_AUTH_TIMEOUT,
                )
            except ApiException as _e:
                if _e.status != 404:
                    warnings.append(f"{candidate} read 실패 ({type(_e).__name__}): HTTP {_e.status}")
            except Exception as _e:
                warnings.append(f"{candidate} read 실패 ({type(_e).__name__}): {str(_e)[:80]}")

        # fallback — label_selector + limit=1 (전체 pod 을 훑지 않음)
        try:
            res = v1.list_namespaced_pod(
                "kube-system",
                label_selector=f"component={component}",
                limit=1,
                _request_timeout=_K8S_AUTH_TIMEOUT * 2,
            )
            return res.items[0] if res.items else None
        except Exception as _e:
            warnings.append(f"{component} pod 조회 실패 ({type(_e).__name__}): {str(_e)[:120]}")
            return None

    try:
        api_pod = _fetch_control_plane_pod("kube-apiserver")
        ctrl_pod = _fetch_control_plane_pod("kube-controller-manager")

        if api_pod and api_pod.spec and api_pod.spec.containers:
            svc_range = _extract_flag_value(api_pod.spec.containers[0], "service-cluster-ip-range")
            if svc_range:
                cluster.svc_cidr = svc_range
                first, last = _cidr_range(svc_range)
                cluster.svc_first_host = first
                cluster.svc_last_host = last
                updated["svcCidr"] = svc_range
                if first: updated["svcFirstHost"] = first
                if last: updated["svcLastHost"] = last

        if ctrl_pod and ctrl_pod.spec and ctrl_pod.spec.containers:
            pod_range = _extract_flag_value(ctrl_pod.spec.containers[0], "cluster-cidr")
            if pod_range:
                cluster.pod_cidr = pod_range
                first, last = _cidr_range(pod_range)
                cluster.pod_first_host = first
                cluster.pod_last_host = last
                updated["podCidr"] = pod_range
                if first: updated["podFirstHost"] = first
                if last: updated["podLastHost"] = last
    except Exception as e:
        warnings.append(f"system pods 플래그 조회 실패 ({type(e).__name__}): {str(e)[:120]}")

    # 3. Cilium config — ConfigMap/kube-system/cilium-config
    try:
        cm = v1.read_namespaced_config_map("cilium-config", "kube-system", _request_timeout=_K8S_AUTH_TIMEOUT * 2)
        data = cm.data or {}
        # 핵심만 보여주기 (tunnel, kube-proxy-replacement, ipv4-native-routing-cidr, enable-bgp-control-plane 등)
        interesting_keys = [
            "tunnel", "routing-mode", "kube-proxy-replacement",
            "ipv4-native-routing-cidr", "ipv6-native-routing-cidr",
            "enable-bgp-control-plane", "bpf-lb-mode", "cluster-pool-ipv4-cidr",
        ]
        lines = [f"{k}: {data[k]}" for k in interesting_keys if k in data]
        if lines:
            cluster.cilium_config = "\n".join(lines)
            updated["ciliumConfig"] = cluster.cilium_config
        if data.get("enable-bgp-control-plane", "").lower() == "true":
            cluster.bgp_enabled = True
            updated["bgpEnabled"] = True
        # Cilium 버전 — ConfigMap 에 cilium-version 키 있으면 우선. VARCHAR(128) 보호.
        cv = data.get("cilium-version") or data.get("cni-version")
        if cv:
            cluster.cilium_version = cv.strip()[:128]
            updated["ciliumVersion"] = cluster.cilium_version
    except ApiException as e:
        if e.status != 404:
            warnings.append(f"cilium-config 조회 실패 (ApiException): HTTP {e.status}")
    except Exception as e:
        warnings.append(f"cilium-config 조회 실패 ({type(e).__name__}): {str(e)[:120]}")

    # 3.5 Cilium 버전 — ConfigMap 에 없으면 cilium-agent 이미지 태그로 fallback
    #     300노드에서 label_selector 있어도 300개 pod 반환되므로 limit=1 로 제한.
    if not updated.get("ciliumVersion"):
        try:
            cpods = v1.list_namespaced_pod(
                "kube-system",
                label_selector="k8s-app=cilium",
                limit=1,
                _request_timeout=_K8S_AUTH_TIMEOUT * 2,
            )
            agent_pod = next((p for p in cpods.items if p.spec and p.spec.containers), None)
            if agent_pod:
                img = agent_pod.spec.containers[0].image or ""
                # `quay.io/cilium/cilium:v1.16.3` → `v1.16.3`
                last = img.rsplit("/", 1)[-1]
                if ":" in last:
                    tag = last.rsplit(":", 1)[1][:128]
                    cluster.cilium_version = tag
                    updated["ciliumVersion"] = tag
        except Exception as e:
            warnings.append(f"cilium-agent pod 조회 실패 ({type(e).__name__}): {str(e)[:120]}")

    # 4. Cilium BGP — CiliumBGPClusterConfig (신규) 또는 CiliumBGPPeeringPolicy (구) CR
    try:
        # 신규 CRD (Cilium 1.16+)
        crs = custom.list_cluster_custom_object(
            group="cilium.io", version="v2alpha1", plural="ciliumbgpclusterconfigs",
            _request_timeout=_K8S_AUTH_TIMEOUT * 2,
        )
        items = crs.get("items") or []
        for item in items:
            for inst in (item.get("spec", {}).get("bgpInstances") or []):
                local_asn = inst.get("localASN")
                if local_asn:
                    cluster.bgp_enabled = True
                    cluster.as_number = str(local_asn)
                    updated["bgpEnabled"] = True
                    updated["asNumber"] = str(local_asn)
                    break
    except ApiException:
        # 신규 CRD 없으면 구 버전 시도
        try:
            crs = custom.list_cluster_custom_object(
                group="cilium.io", version="v2alpha1", plural="ciliumbgppeeringpolicies",
                _request_timeout=_K8S_AUTH_TIMEOUT * 2,
            )
            for item in (crs.get("items") or []):
                for vr in (item.get("spec", {}).get("virtualRouters") or []):
                    local_asn = vr.get("localASN")
                    if local_asn:
                        cluster.bgp_enabled = True
                        cluster.as_number = str(local_asn)
                        updated["bgpEnabled"] = True
                        updated["asNumber"] = str(local_asn)
                        break
        except ApiException:
            pass  # BGP 미설정 클러스터
        except Exception as e:
            warnings.append(f"BGP 조회 실패 ({type(e).__name__}): {str(e)[:120]}")
    except Exception as e:
        warnings.append(f"BGP 조회 실패: {str(e)[:120]}")

    if dry_run:
        # ORM 변경사항은 버리고 현재 DB 값 유지
        db.rollback()
        diff = []
        for camel, _snake in _DIFF_FIELDS:
            if camel in updated:
                diff.append({
                    "field": camel,
                    "current": current.get(camel),
                    "proposed": updated[camel],
                    "changed": current.get(camel) != updated[camel],
                })
        return {
            "cluster_id": str(cluster_id),
            "cluster_name": cluster.name,
            "dry_run": True,
            "current": current,
            "proposed": updated,
            "diff": diff,
            "warnings": warnings,
        }

    now_ts = datetime.utcnow()
    cluster.updated_at = now_ts

    # 메타 변경 히스토리 — 논리 그룹별 hash 가 다를 때만 새 스냅샷 추가.
    # auto-update 가 매번 호출돼도 실제 변경된 그룹 수만 카운트되어 누적된다.
    snapshot_changed = record_cluster_meta_snapshots(db, cluster, now_ts)

    db.commit()
    db.refresh(cluster)

    return {
        "cluster_id": str(cluster_id),
        "cluster_name": cluster.name,
        "dry_run": False,
        "updated": updated,
        "snapshots_recorded": snapshot_changed,
        "warnings": warnings,
    }


@router.get("/{cluster_id}/cilium-config")
def get_cluster_cilium_config(cluster_id: UUID, db: Session = Depends(get_db)):
    """Cilium ConfigMap 조회 (kubectl 또는 저장된 설정)"""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    live_config = None
    error_msg = None
    kc_path = cluster.kubeconfig_path
    if kc_path and os.path.exists(kc_path):
        try:
            cmd = ["kubectl", "--kubeconfig", kc_path]
            if cluster.api_endpoint:
                cmd += ["--server", cluster.api_endpoint]
            cmd += ["-n", "kube-system", "get", "configmap", "cilium-config", "-o", "yaml"]
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
            if res.returncode == 0:
                live_config = res.stdout
            else:
                error_msg = res.stderr.strip()[:200]
        except Exception as e:
            error_msg = str(e)[:100]

    return {
        "live": live_config,
        "stored": cluster.cilium_config,
        "source": "live" if live_config else ("stored" if cluster.cilium_config else "none"),
        "error": error_msg,
    }
