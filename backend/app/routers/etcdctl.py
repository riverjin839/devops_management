"""etcdctl 명령을 master (control-plane) 노드에 SSH로 수행 + etcd 서비스 로그 조회.

기본 전제:
- control-plane master1 서버에 etcd 가 systemd 유닛(`etcd.service`) 로 동작
- etcd 환경 변수는 `/etc/etcd.env` 에 저장 (ETCDCTL_API, ETCDCTL_ENDPOINTS,
  ETCDCTL_CACERT, ETCDCTL_CERT, ETCDCTL_KEY 등)
- 이 가정이 맞지 않아도 `env_file` 파라미터로 경로를 바꾸거나
  `use_env=false` 로 비워둘 수 있음

보안:
- SSH 인증정보는 요청에만 존재, DB 저장 안 함
- etcdctl 내부에서 신뢰된 CA/cert 만 사용 (TLS 자동)
"""
import os
import shlex
import time
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from kubernetes import client as k8s_client, config as k8s_config
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Cluster
from app.models.user import User
from app.auth.deps import require_operator
from app.services.kubeconfig import ensure_kubeconfig_file
from app.services.ssh_runner import SSHTarget, run_bulk
from app.services import audit_logger

router = APIRouter(tags=["etcdctl"])


# ── 프리셋 etcdctl 서브커맨드 ────────────────────────────────────────────────

PRESETS: dict[str, dict[str, str]] = {
    "endpoint-health": {
        "label": "엔드포인트 Health",
        "args": "endpoint health --write-out=table",
    },
    "endpoint-status": {
        "label": "엔드포인트 Status",
        "args": "endpoint status --write-out=table",
    },
    "member-list": {
        "label": "Member List",
        "args": "member list --write-out=table",
    },
    "alarm-list": {
        "label": "Alarm List",
        "args": "alarm list",
    },
    "db-size": {
        "label": "DB 크기 조회",
        "args": "endpoint status --write-out=json",
    },
    "defrag": {
        "label": "DB Defrag (주의: write lock)",
        "args": "defrag --cluster",
    },
    "compact-rev": {
        "label": "compact — 현재 revision",
        "args": "compact $(etcdctl endpoint status --write-out=\"json\" | grep -oE '\"Revision\":[0-9]+' | head -1 | cut -d: -f2)",
    },
    "snapshot-save": {
        "label": "Snapshot 저장 /tmp/etcd-snapshot-$(date +%s).db",
        "args": "snapshot save /tmp/etcd-snapshot-$(date +%s).db",
    },
    "watch-key-range": {
        "label": "get /registry (prefix, keys only, 처음 20개)",
        "args": "get /registry/ --prefix --keys-only --limit=20",
    },
}


# ── schemas ──────────────────────────────────────────────────────────────────

class EtcdMasterCandidate(BaseModel):
    name: str
    internal_ip: Optional[str] = None
    external_ip: Optional[str] = None


class EtcdMasterCandidatesResponse(BaseModel):
    cluster_id: UUID
    cluster_name: str
    candidates: list[EtcdMasterCandidate]


class EtcdCtlRequest(BaseModel):
    # 타겟 — host (IP/FQDN) 중 하나 직접 지정, 아니면 master-candidates 에서 선택된 값
    host: str = Field(..., description="master (etcd 실행) 호스트 IP/FQDN")
    port: int = 22
    username: str = "root"
    password: Optional[str] = None
    private_key: Optional[str] = None

    # etcdctl 구성
    args: str = Field(..., description="etcdctl 뒤에 붙을 인자 (예: 'endpoint health')")
    env_file: str = Field(default="/etc/etcd.env", description="env 파일 경로. 비우면 env 로드 없이 실행.")
    use_env: bool = Field(default=True, description="env_file 을 source 할지 여부")
    extra_env: dict[str, str] = Field(default_factory=dict, description="추가 환경변수")
    etcdctl_path: str = Field(default="etcdctl", description="etcdctl 바이너리 경로 (PATH 에 있다는 전제)")

    timeout: int = Field(default=30, ge=1, le=300)


class EtcdCtlResponse(BaseModel):
    host: str
    status: Literal["ok", "error", "timeout", "auth_error", "connect_error"]
    exit_code: Optional[int] = None
    stdout: str = ""
    stderr: str = ""
    duration_ms: int = 0
    error: Optional[str] = None
    executed_command: str = ""


class EtcdLogsRequest(BaseModel):
    host: str
    port: int = 22
    username: str = "root"
    password: Optional[str] = None
    private_key: Optional[str] = None

    unit: str = Field(default="etcd.service", description="systemd unit 이름")
    tail: int = Field(default=200, ge=1, le=5000, description="마지막 N줄")
    since: Optional[str] = Field(default=None, description="journalctl --since (예: '10 min ago')")
    grep: Optional[str] = Field(default=None, description="필터 키워드 (대소문자 무시)")


class EtcdLogsResponse(BaseModel):
    host: str
    status: Literal["ok", "error", "timeout", "auth_error", "connect_error"]
    exit_code: Optional[int] = None
    stdout: str = ""
    stderr: str = ""
    duration_ms: int = 0
    error: Optional[str] = None
    executed_command: str = ""


# ── endpoints ────────────────────────────────────────────────────────────────

@router.get("/clusters/{cluster_id}/etcdctl/presets")
def list_presets():
    """UI 에서 보여줄 프리셋 etcdctl 명령 목록."""
    return {"presets": [{"key": k, **v} for k, v in PRESETS.items()]}


@router.get("/clusters/{cluster_id}/etcdctl/master-candidates", response_model=EtcdMasterCandidatesResponse)
def list_master_candidates(cluster_id: UUID, db: Session = Depends(get_db)):
    """etcd 가 돌 가능성이 높은 master(control-plane) 노드 후보 리스트."""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    kc_path = ensure_kubeconfig_file(cluster)
    if not kc_path or not os.path.exists(kc_path):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="kubeconfig 가 없습니다. 먼저 kubeconfig 를 등록하세요.",
        )

    try:
        api_client = k8s_config.new_client_from_config(config_file=kc_path)
        v1 = k8s_client.CoreV1Api(api_client)
        nodes = v1.list_node(_request_timeout=10)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"노드 조회 실패: {str(e)[:200]}",
        )

    master_labels = ("node-role.kubernetes.io/control-plane", "node-role.kubernetes.io/master")
    candidates: list[EtcdMasterCandidate] = []
    for n in nodes.items:
        labels = n.metadata.labels or {}
        if not any(k in labels for k in master_labels):
            continue
        internal_ip = external_ip = None
        for addr in (n.status.addresses or []):
            if addr.type == "InternalIP" and not internal_ip:
                internal_ip = addr.address
            elif addr.type == "ExternalIP" and not external_ip:
                external_ip = addr.address
        candidates.append(EtcdMasterCandidate(
            name=n.metadata.name, internal_ip=internal_ip, external_ip=external_ip,
        ))

    # 이름 오름차순 (master-1, master-2, ...) — 관례상 첫 번째가 master1
    candidates.sort(key=lambda c: c.name)

    return EtcdMasterCandidatesResponse(
        cluster_id=cluster_id, cluster_name=cluster.name, candidates=candidates,
    )


def _build_etcdctl_command(req: EtcdCtlRequest) -> str:
    """안전하게 합쳐진 bash 명령 문자열 생성.

    env 파일 source + extra env 설정 + etcdctl 실행.
    """
    parts: list[str] = []
    # /etc/etcd.env 같은 파일은 ENV=VALUE 포맷이므로 `set -a; source file; set +a` 로 export.
    if req.use_env and req.env_file:
        parts.append(f"set -a && source {shlex.quote(req.env_file)} && set +a")
    for k, v in (req.extra_env or {}).items():
        # 환경변수 이름은 영문/숫자/언더스코어만 허용
        if not k.replace("_", "").isalnum():
            continue
        parts.append(f"export {k}={shlex.quote(v)}")
    # etcdctl 인자 — 사용자가 직접 입력하므로 shell 해석을 허용 (예: $(date +%s))
    parts.append(f"{shlex.quote(req.etcdctl_path)} {req.args}")
    return " && ".join(parts)


@router.post("/clusters/{cluster_id}/etcdctl/run", response_model=EtcdCtlResponse)
async def run_etcdctl(
    cluster_id: UUID,
    payload: EtcdCtlRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """master 노드에 SSH 로 접속해서 etcdctl 명령 수행."""
    if not payload.password and not payload.private_key:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="password 또는 private_key 중 하나는 필수입니다.",
        )
    if not payload.args.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="etcdctl 인자는 비어있을 수 없습니다.",
        )
    # cluster 존재 확인만 (미등록/타사용자 cluster_id 방지)
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    bash_cmd = _build_etcdctl_command(payload)
    audit_logger.record(
        db,
        action="etcdctl.run",
        actor=actor,
        status="success",
        target_type="cluster",
        target_id=cluster_id,
        details={"args": payload.args[:200]},
        request=request,
    )
    # bash -c "..." 로 한 번에 실행. source 지원을 위해 bash 강제.
    remote_cmd = f"bash -lc {shlex.quote(bash_cmd)}"

    target = SSHTarget(
        host=payload.host, port=payload.port, username=payload.username,
        password=payload.password, private_key=payload.private_key,
    )
    start = time.monotonic()
    results = await run_bulk(
        [target],
        action="ssh",
        command=remote_cmd,
        mode="sequential",
        connect_timeout=min(payload.timeout, 10),
        exec_timeout=payload.timeout,
        parallelism=1,
    )
    r = results[0]
    return EtcdCtlResponse(
        host=r.host, status=r.status, exit_code=r.exit_code,
        stdout=r.stdout, stderr=r.stderr, duration_ms=r.duration_ms,
        error=r.error, executed_command=bash_cmd,
    )


@router.post("/clusters/{cluster_id}/etcdctl/logs", response_model=EtcdLogsResponse)
async def get_etcd_logs(
    cluster_id: UUID,
    payload: EtcdLogsRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """master 노드에서 etcd 서비스 journalctl 로그를 가져온다."""
    if not payload.password and not payload.private_key:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="password 또는 private_key 중 하나는 필수입니다.",
        )
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    # journalctl -u etcd.service -n <tail> --no-pager [--since "..."] [ | grep -i "..." ]
    cmd_parts = [f"journalctl -u {shlex.quote(payload.unit)} -n {int(payload.tail)} --no-pager"]
    if payload.since:
        cmd_parts.append(f"--since {shlex.quote(payload.since)}")
    bash_cmd = " ".join(cmd_parts)
    if payload.grep:
        bash_cmd = f"{bash_cmd} | grep -i {shlex.quote(payload.grep)}"

    remote_cmd = f"bash -lc {shlex.quote(bash_cmd)}"

    target = SSHTarget(
        host=payload.host, port=payload.port, username=payload.username,
        password=payload.password, private_key=payload.private_key,
    )
    results = await run_bulk(
        [target],
        action="ssh",
        command=remote_cmd,
        mode="sequential",
        connect_timeout=10,
        exec_timeout=60,
        parallelism=1,
    )
    r = results[0]
    return EtcdLogsResponse(
        host=r.host, status=r.status, exit_code=r.exit_code,
        stdout=r.stdout, stderr=r.stderr, duration_ms=r.duration_ms,
        error=r.error, executed_command=bash_cmd,
    )
