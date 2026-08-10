"""클러스터 컴포넌트 버전 / 파라미터 수집 + 히스토리 관리.

수집하는 범위 (kubeconfig 만으로 가능한 것):
- K8s server (apiserver version)
- 각 노드의 kubelet / kube-proxy / container-runtime / kernel / OS 버전
- kube-system 의 core component (apiserver, controller-manager, scheduler,
  kube-proxy, coredns, etcd) — image tag + command/args 플래그
- cilium-agent / cilium-operator — image tag + args
- cilium-config ConfigMap — data 전체

SSH 가 필요한 NIC/호스트 파라미터는 여기서 수집하지 않음.
"""
import json
import os
import re
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any, Callable
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from kubernetes import client as k8s_client, config as k8s_config
from kubernetes.client import ApiException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import require_operator
from app.database import get_db
from app.models import Cluster, ClusterConfigSnapshot, User
from app.services.kubeconfig import ensure_kubeconfig_file as _ensure_kubeconfig_file_for
from app.services.ssh_runner import SSHTarget, _exec_ssh  # noqa: PLC2701 — 내부 재사용
from app.services.config_snapshot import (
    hash_payload as _hash_payload,
    store_if_changed as _store_if_changed,
    record_cluster_meta_snapshots,
)

router = APIRouter(prefix="/clusters", tags=["versions"])

_K8S_TIMEOUT = 10


# ── helpers ──────────────────────────────────────────────────────────────────


def _parse_container_args(container) -> dict[str, str]:
    """container.command + args 에서 --flag=value / --flag value 를 dict 로."""
    tokens: list[str] = []
    if container.command:
        tokens.extend(container.command)
    if container.args:
        tokens.extend(container.args)
    out: dict[str, str] = {}
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok.startswith("--"):
            if "=" in tok:
                k, v = tok[2:].split("=", 1)
                out[k] = v
            else:
                key = tok[2:]
                if i + 1 < len(tokens) and not tokens[i + 1].startswith("--"):
                    out[key] = tokens[i + 1]
                    i += 1
                else:
                    out[key] = "true"
        i += 1
    return out


def _image_tag(image: str) -> str:
    """registry.io/ns/name:tag → tag. 없으면 'latest'."""
    # 포트 콜론 분리 대비: 마지막 '/' 뒤에서 확인
    last = image.rsplit("/", 1)[-1]
    if ":" in last:
        return last.rsplit(":", 1)[1]
    return "latest"


# ── 수집 로직 ────────────────────────────────────────────────────────────────

def _collect_all(cluster: Cluster, kc_path: str, db: Session) -> dict:
    """실제 수집 수행. 반환은 요약(각 카테고리별 변경 개수)."""
    api_client = k8s_config.new_client_from_config(config_file=kc_path)
    v1 = k8s_client.CoreV1Api(api_client)
    version_api = k8s_client.VersionApi(api_client)

    now = datetime.utcnow()
    changed = 0
    errors: list[str] = []

    # 1. K8s server version
    try:
        info = version_api.get_code(_request_timeout=_K8S_TIMEOUT)
        if _store_if_changed(db, cluster.id, "k8s_server", "control_plane",
                             info.git_version, {
                                 "major": info.major,
                                 "minor": info.minor,
                                 "platform": info.platform,
                                 "buildDate": info.build_date,
                                 "goVersion": info.go_version,
                             }, now):
            changed += 1
    except Exception as e:
        errors.append(f"k8s_server: {str(e)[:120]}")

    # 2. Nodes — kubelet, kube-proxy (container-runtime, kernel, os)
    # 모든 값은 K8s API 의 Node.status.nodeInfo 에서 옴 — 출처를 명시해 사용자가
    # SSH 기반 수집(`kubelet_config:{host}`) 결과와 구분할 수 있게 한다.
    try:
        nodes = v1.list_node(_request_timeout=_K8S_TIMEOUT)
        for node in nodes.items:
            ni = node.status.node_info
            name = node.metadata.name
            kubelet_fields = {
                "kubeletVersion":         getattr(ni, "kubelet_version", None),
                "kubeProxyVersion":       getattr(ni, "kube_proxy_version", None),
                "containerRuntime":       getattr(ni, "container_runtime_version", None),
                "kernelVersion":          getattr(ni, "kernel_version", None),
                "osImage":                getattr(ni, "os_image", None),
                "operatingSystem":        getattr(ni, "operating_system", None),
                "architecture":           getattr(ni, "architecture", None),
            }
            data = {
                **kubelet_fields,
                # 모든 필드의 출처는 동일 — Node.status.nodeInfo (kubeconfig 로 K8s API 조회)
                "_sources": {k: "k8s_api:Node.status.nodeInfo" for k in kubelet_fields},
            }
            if _store_if_changed(db, cluster.id, f"kubelet:{name}", "kubelet",
                                 data.get("kubeletVersion"), data, now):
                changed += 1
    except Exception as e:
        errors.append(f"nodes: {str(e)[:120]}")

    # 3. kube-system core components — image tag + flags
    CORE_COMPONENTS = [
        ("kube-apiserver",          "kube_apiserver",          "control_plane"),
        ("kube-controller-manager", "kube_controller_manager", "control_plane"),
        ("kube-scheduler",          "kube_scheduler",          "control_plane"),
        ("kube-proxy",              "kube_proxy",              "control_plane"),
        ("coredns",                 "coredns",                 "control_plane"),
        ("etcd",                    "etcd",                    "control_plane"),
    ]

    try:
        sys_pods = v1.list_namespaced_pod("kube-system", _request_timeout=_K8S_TIMEOUT)
    except Exception as e:
        sys_pods = None
        errors.append(f"kube-system pods: {str(e)[:120]}")

    if sys_pods is not None:
        for prefix, comp_key, category in CORE_COMPONENTS:
            # 각 컴포넌트의 첫 pod 하나만 대표로 (모든 replica 거의 동일)
            pod = next(
                (p for p in sys_pods.items
                 if p.metadata.name.startswith(prefix) and p.spec and p.spec.containers),
                None,
            )
            if not pod:
                continue
            main = pod.spec.containers[0]
            data = {
                "image": main.image,
                "flags": _parse_container_args(main),
                "podName": pod.metadata.name,
            }
            version = _image_tag(main.image)
            _store_if_changed(db, cluster.id, comp_key, category, version, data, now) and (changed := changed + 1)

        # 4. Cilium — agent + operator (kube-system, labels k8s-app 또는 app.kubernetes.io/name)
        for label_key, label_val, comp_key in [
            ("k8s-app", "cilium",          "cilium_agent"),
            ("io.cilium/app", "operator",  "cilium_operator"),
            ("name", "cilium-operator",    "cilium_operator"),
        ]:
            # 이미 cilium_operator 가 채워졌으면 건너뛰기
            pod = next(
                (p for p in sys_pods.items
                 if (p.metadata.labels or {}).get(label_key) == label_val and p.spec and p.spec.containers),
                None,
            )
            if not pod:
                continue
            main = pod.spec.containers[0]
            data = {
                "image": main.image,
                "flags": _parse_container_args(main),
                "podName": pod.metadata.name,
                "namespace": pod.metadata.namespace,
            }
            version = _image_tag(main.image)
            if _store_if_changed(db, cluster.id, comp_key, "cni", version, data, now):
                changed += 1

    # 5. cilium-config ConfigMap
    try:
        cm = v1.read_namespaced_config_map("cilium-config", "kube-system",
                                           _request_timeout=_K8S_TIMEOUT)
        data = {"data": dict(cm.data or {})}
        version = (cm.data or {}).get("cilium-version") or (cm.data or {}).get("cni-version")
        if _store_if_changed(db, cluster.id, "cilium_config", "cni", version, data, now):
            changed += 1
    except ApiException as e:
        if e.status != 404:
            errors.append(f"cilium-config: HTTP {e.status}")
    except Exception as e:
        errors.append(f"cilium-config: {str(e)[:120]}")

    db.commit()
    return {"changed": changed, "errors": errors, "collectedAt": now.isoformat()}


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/{cluster_id}/collect-versions")
def collect_versions(
    cluster_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """kubeconfig 를 이용해 현재 버전/설정 스냅샷을 수집. 변경된 항목만 저장."""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    kc_path = _ensure_kubeconfig_file_for(cluster)
    if not kc_path or not os.path.exists(kc_path):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="kubeconfig가 없습니다. 먼저 kubeconfig를 등록하세요.",
        )

    try:
        summary = _collect_all(cluster, kc_path, db)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"수집 실패: {str(e)[:200]}",
        )
    return {"cluster_id": str(cluster_id), **summary}


# ── 공통: 병렬 SSH 수집 헬퍼 ─────────────────────────────────────────────────

async def _parallel_collect(
    hosts: list[str],
    *,
    worker: Callable[[str], Any],
    parallelism: int = 10,
    chunk_size: int = 30,
    chunk_pause_ms: int = 200,
) -> list[Any]:
    """호스트 리스트를 청크 단위로 병렬 실행하는 공통 헬퍼.
    - paramiko 기반 sync 함수를 ThreadPool + asyncio.gather 로 파라랠.
    - Semaphore 로 동시 실행 수 엄격 상한.
    - 청크 사이에 짧은 pause (베스천 burst 완화).
    순서는 입력 호스트 순서와 일치하게 반환.
    """
    n = len(hosts)
    if n == 0:
        return []
    workers = max(1, min(parallelism, n))
    chunk = max(1, chunk_size)
    loop = asyncio.get_event_loop()
    results: list[Any] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        sem = asyncio.Semaphore(workers)

        async def bounded(h: str) -> Any:
            async with sem:
                return await loop.run_in_executor(pool, worker, h)

        for i in range(0, n, chunk):
            batch = hosts[i:i + chunk]
            batch_res = await asyncio.gather(*[bounded(h) for h in batch])
            results.extend(batch_res)
            if i + chunk < n and chunk_pause_ms > 0:
                await asyncio.sleep(chunk_pause_ms / 1000.0)
    return results


# ── etcd (systemd) 수집 ──────────────────────────────────────────────────────

class EtcdSystemdCollectRequest(BaseModel):
    """사내 kubeadm 외 환경에서 etcd 가 systemd 로 기동될 때, 각 master 노드에
    SSH 로 접속해 `systemctl show etcd` + `etcd --version` + env 파일 내용을
    모아 호스트별 스냅샷으로 저장한다. 자격증명은 요청에만 존재.
    """
    hosts: list[str] = Field(..., min_length=1, max_length=2000)
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(default="root", min_length=1, max_length=64)
    password: str | None = None
    private_key: str | None = None
    use_sudo: bool = True
    connect_timeout: int = Field(default=8, ge=1, le=60)
    # systemd unit 이름만 허용 — 이 값이 그대로 원격 셸 명령(`systemctl show {unit}`)에
    # 삽입되므로 셸 메타문자를 허용하면 명령 인젝션으로 이어진다.
    unit: str = Field(default="etcd", max_length=64, pattern=r"^[A-Za-z0-9_.@-]+$")
    # etcd 환경변수 파일 — 기본 /etcd/etcd.env (사내 표준), 다른 배포판은 edit 가능.
    # 순서대로 존재하는 첫 파일을 읽음.
    env_files: list[str] = Field(
        default_factory=lambda: ["/etcd/etcd.env", "/etc/etcd.env", "/etc/default/etcd", "/etc/sysconfig/etcd"],
        description="SSH 로 cat 해볼 etcd 환경파일 후보 (첫 존재 파일만 저장)",
    )
    # 병렬 수집 옵션 — 대규모 클러스터에서 timeout 방지
    parallelism: int = Field(default=10, ge=1, le=50)
    chunk_size: int = Field(default=30, ge=1, le=200)
    chunk_pause_ms: int = Field(default=200, ge=0, le=5000)


_SYSTEMCTL_SHOW_PROPS = [
    "ActiveState", "SubState", "MainPID", "FragmentPath", "ExecStart",
    "UnitFileState", "LoadState",
    # systemd 가 기록한 EnvironmentFile (`/etc/etcd.env` 같은 경로) — 직접 보여줄 출처.
    "EnvironmentFile", "Environment",
]


def _parse_systemctl_show(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def _parse_etcd_version(text: str) -> str | None:
    # `etcd Version: 3.5.12` 또는 `etcdctl version: 3.5.12`
    m = re.search(r"Version:\s*([0-9][^\s]+)", text)
    return m.group(1) if m else None


def _clean_exec_start(val: str) -> str:
    """systemctl show 의 ExecStart 는 전체 구조체 문자열. argv[...] 부분 추출."""
    m = re.search(r"argv\[\]=([^;]*);", val)
    if m:
        return m.group(1).strip()
    return val.strip()


def _extract_cli_arg(cmdline: str, *flag_names: str) -> str | None:
    """프로세스 커맨드라인에서 `--flag=value` 또는 `--flag value` 형태로 값 추출.
    여러 별칭(예: `--config`, `--config-file`, `-c`)을 차례로 시도.
    """
    if not cmdline:
        return None
    tokens = cmdline.split()
    for flag in flag_names:
        for i, tok in enumerate(tokens):
            if tok == flag and i + 1 < len(tokens):
                return tokens[i + 1].strip().strip('"').strip("'")
            prefix = flag + "="
            if tok.startswith(prefix):
                return tok[len(prefix):].strip().strip('"').strip("'")
    return None


def _systemd_env_file_path(prop: str | None) -> str | None:
    """systemctl show EnvironmentFile 출력은 `path (ignore_errors=no)` 또는
    여러 줄을 합친 형태. 첫 path 만 깔끔하게 뽑는다.
    """
    if not prop:
        return None
    s = prop.strip()
    # 다중 — 줄바꿈/공백/ ; 으로 분리해 첫 토큰 후보를 본다
    first = re.split(r"[\s;]+", s, maxsplit=1)[0]
    # `(ignore_errors=...)` suffix 제거
    return first.split("(", 1)[0].strip() or None


@router.post("/{cluster_id}/collect-etcd-systemd")
async def collect_etcd_systemd(
    cluster_id: UUID,
    payload: EtcdSystemdCollectRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """SSH 로 각 master 노드의 etcd (systemd unit) 상태 + env 파일 + 버전 수집.

    수집 항목(호스트별):
      - systemctl show etcd → ActiveState / MainPID / FragmentPath / ExecStart / UnitFileState
      - etcd --version → 버전 문자열
      - env 파일 내용 (env_files 중 처음 존재하는 것, 기본 /etcd/etcd.env)
    **호스트별로 component 키 `etcd_systemd:{host}` 로 스냅샷을 저장** 해 값 변경 추적.
    병렬 SSH + 청크 실행으로 대규모 클러스터에서도 timeout 없이 수집.
    """
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    if not payload.password and not payload.private_key:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="password 또는 private_key 중 하나는 필수입니다.",
        )

    now = datetime.utcnow()
    sudo = "sudo -n " if payload.use_sudo else ""
    show_cmd = f"{sudo}systemctl show {payload.unit} -p {',-p '.join(_SYSTEMCTL_SHOW_PROPS)}"
    ver_cmd = f"{sudo}etcd --version 2>/dev/null | head -2"
    # ps -ef 에서 etcd 프로세스의 전체 cmdline → 실행 시 사용된 --config-file / EnvironmentFile 경로 추정.
    # `[e]tcd` 트릭으로 grep 자기자신 제외.
    ps_cmd = "ps -eo pid,args 2>/dev/null | grep -E '/usr.*[e]tcd($| )' | head -1"

    # env 파일 후보를 한 번에 체크 — 단일 SSH 세션에서 처음 존재하는 것의 내용을 출력.
    # 경로 검증: 허용된 문자만.
    safe_envs: list[str] = [
        p for p in (payload.env_files or [])
        if re.match(r"^[A-Za-z0-9_./-]+$", p)
    ]
    env_cmd: str | None = None
    if safe_envs:
        parts = " || ".join([
            f'(test -f {p} && echo "===ENVFILE===:{p}" && {sudo}cat {p})' for p in safe_envs
        ])
        env_cmd = f"{sudo}sh -c '{parts}' 2>/dev/null || true"

    def _one(host: str) -> dict:
        target = SSHTarget(
            host=host, port=payload.port, username=payload.username,
            password=payload.password, private_key=payload.private_key,
        )
        r_show = _exec_ssh(target, show_cmd, connect_timeout=payload.connect_timeout, exec_timeout=15)
        r_ver  = _exec_ssh(target, ver_cmd,  connect_timeout=payload.connect_timeout, exec_timeout=10)
        r_ps   = _exec_ssh(target, ps_cmd,   connect_timeout=payload.connect_timeout, exec_timeout=10)
        r_env  = (
            _exec_ssh(target, env_cmd, connect_timeout=payload.connect_timeout, exec_timeout=10)
            if env_cmd else None
        )

        entry: dict = {"host": host, "status": r_show.status}
        # 실행-로그 규칙 — systemctl show 의 원본 출력을 성공/실패 무관하게 첨부해
        # 모달에서 per-host 로 열람 가능하게 한다.
        entry["raw_stdout"] = (r_show.stdout or "")[:1500]
        entry["raw_stderr"] = (r_show.stderr or "")[:800]
        entry["exit_code"] = r_show.exit_code

        if r_show.status != "ok":
            entry["error"] = r_show.error or r_show.stderr[:200]
            return entry

        props = _parse_systemctl_show(r_show.stdout)
        entry["active_state"]    = props.get("ActiveState")
        entry["sub_state"]       = props.get("SubState")
        entry["unit_file_state"] = props.get("UnitFileState")
        entry["main_pid"]        = int(props["MainPID"]) if props.get("MainPID", "").isdigit() else None
        entry["fragment_path"]   = props.get("FragmentPath")
        entry["exec_start"]      = _clean_exec_start(props.get("ExecStart", ""))
        # 출처를 명시 — 사용자가 "이 값이 어디서 왔는지" 한눈에 파악 가능.
        sources: dict[str, str] = {
            "active_state":    "systemctl show",
            "sub_state":       "systemctl show",
            "unit_file_state": "systemctl show",
            "main_pid":        "systemctl show",
            "fragment_path":   "systemctl show",
            "exec_start":      "systemctl show:ExecStart",
        }
        # systemd 가 기록한 EnvironmentFile (다중일 수 있음 — 첫 경로만)
        systemd_env_path = _systemd_env_file_path(props.get("EnvironmentFile"))
        if systemd_env_path:
            entry["systemd_env_file"] = systemd_env_path
            sources["systemd_env_file"] = "systemctl show:EnvironmentFile"
        entry["raw"] = props
        if r_ver and r_ver.status == "ok":
            entry["version"] = _parse_etcd_version(r_ver.stdout)
            sources["version"] = "etcd --version"
        # ps -ef 결과 → cmdline + --config-file 추출
        if r_ps and r_ps.status == "ok" and r_ps.stdout.strip():
            ps_line = r_ps.stdout.strip().splitlines()[0]
            entry["ps_cmdline"] = ps_line
            sources["ps_cmdline"] = "ps -eo pid,args"
            cfg = _extract_cli_arg(ps_line, "--config-file", "--config")
            if cfg:
                entry["config_file_arg"] = cfg
                sources["config_file_arg"] = "ps -ef:--config-file"
        if r_env and r_env.status == "ok" and r_env.stdout.strip():
            # "===ENVFILE===:/path" 마커 파싱
            m = re.match(r"===ENVFILE===:([^\n]+)\n(.*)", r_env.stdout, re.DOTALL)
            if m:
                entry["env_file"] = m.group(1).strip()
                entry["env_content"] = m.group(2)
                sources["env_file"] = f"file:{entry['env_file']}"
                sources["env_content"] = f"file:{entry['env_file']}"
        entry["_sources"] = sources
        return entry

    per_host: list[dict] = await _parallel_collect(
        payload.hosts,
        worker=_one,
        parallelism=payload.parallelism,
        chunk_size=payload.chunk_size,
        chunk_pause_ms=payload.chunk_pause_ms,
    )

    # 호스트별 스냅샷 저장 — 각 host 단위로 content-hash dedup.
    changed = 0
    errors: list[str] = []
    for entry in per_host:
        host = entry.get("host")
        if not host:
            continue
        if entry.get("status") != "ok":
            errors.append(f"{host}: {entry.get('error') or entry.get('status')}")
            continue
        data = {
            "source": "systemd",
            "unit": payload.unit,
            "host": host,
            "active_state": entry.get("active_state"),
            "sub_state": entry.get("sub_state"),
            "main_pid": entry.get("main_pid"),
            "fragment_path": entry.get("fragment_path"),
            "exec_start": entry.get("exec_start"),
            "unit_file_state": entry.get("unit_file_state"),
            "version": entry.get("version"),
            "env_file": entry.get("env_file"),
            "env_content": entry.get("env_content"),
            # 신규 — 어디서 환경 파일/설정 경로를 알아냈는지를 모두 기록 (출처가 다를 수 있음)
            "systemd_env_file": entry.get("systemd_env_file"),
            "ps_cmdline": entry.get("ps_cmdline"),
            "config_file_arg": entry.get("config_file_arg"),
            "_sources": entry.get("_sources"),
            "raw": entry.get("raw"),
        }
        if _store_if_changed(
            db, cluster_id,
            component=f"etcd_systemd:{host}",
            category="os",
            version=entry.get("version"),
            data=data, now=now,
        ):
            changed += 1

    if changed:
        db.commit()

    return {
        "cluster_id": str(cluster_id),
        "stored": changed > 0,
        "changed": changed,
        "hosts": per_host,
        "component_key": "etcd_systemd:{host}",
        "errors": errors,
    }


# ── kernel params 수집 ───────────────────────────────────────────────────────

class KernelParamsCollectRequest(BaseModel):
    """각 노드에 SSH 로 접속해 sysctl 결과를 수집해 스냅샷 저장. 각 노드별로
    `kernel_params:{host}` component 키로 저장, 내용 해시가 이전과 같으면
    저장 생략 (최신 일자 기준 uniq). 병렬/청크 수집으로 대규모 클러스터 대응.
    """
    hosts: list[str] = Field(..., min_length=1, max_length=2000)
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(default="root", min_length=1, max_length=64)
    password: str | None = None
    private_key: str | None = None
    use_sudo: bool = False
    connect_timeout: int = Field(default=8, ge=1, le=60)
    params: list[str] = Field(default_factory=list, max_length=200)
    default_prefixes: list[str] = Field(default_factory=lambda: [
        "net.ipv4", "net.bridge", "net.core", "vm",
        "fs.file-max", "fs.nr_open", "kernel.pid_max",
    ])
    parallelism: int = Field(default=10, ge=1, le=50)
    chunk_size: int = Field(default=30, ge=1, le=200)
    chunk_pause_ms: int = Field(default=200, ge=0, le=5000)


def _parse_sysctl(text: str) -> dict[str, str]:
    """`key = value\\nkey2 = value2` → dict. 파이프라인 출력 안정화를 위해
    '=' 공백 변형까지 허용."""
    out: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


@router.post("/{cluster_id}/collect-kernel-params")
async def collect_kernel_params(
    cluster_id: UUID,
    payload: KernelParamsCollectRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """노드별 sysctl 값을 병렬로 수집해 히스토리에 누적. 내용 동일시 저장 생략."""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")
    if not payload.password and not payload.private_key:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="password 또는 private_key 중 하나는 필수입니다.",
        )

    now = datetime.utcnow()
    sudo = "sudo -n " if payload.use_sudo else ""
    if payload.params:
        cmds = " && ".join([
            f"{sudo}sysctl -n {p!r} 2>/dev/null | sed 's#^#{p} = #'"
            for p in payload.params if re.match(r"^[A-Za-z0-9_.-]+$", p)
        ])
        cmd = cmds
    else:
        # 주의: 여기서 '\\.' (Python raw 두 글자) 를 쓰면 bash 에서 grep -E 가
        # "백슬래시 + 임의 문자" 를 찾게 되어 sysctl 출력 (`vm.swappiness=60`)에
        # 단 한 줄도 매칭되지 않음 → 수집된 정보가 비어보이는 원인.
        # ERE 에서 literal dot 은 '\.' 한 글자만 필요하다.
        grep_expr = "|".join(re.escape(p) + r"\." for p in payload.default_prefixes if "." not in p)
        exact_expr = "|".join(re.escape(p) for p in payload.default_prefixes if "." in p)
        parts = [e for e in (grep_expr, exact_expr) if e]
        regex = "|".join(parts) if parts else "."
        cmd = f"{sudo}sysctl -a 2>/dev/null | grep -E '^({regex})' || true"

    def _one(host: str) -> dict:
        target = SSHTarget(
            host=host, port=payload.port, username=payload.username,
            password=payload.password, private_key=payload.private_key,
        )
        res = _exec_ssh(target, cmd, connect_timeout=payload.connect_timeout, exec_timeout=20)
        entry: dict = {"host": host, "status": res.status}
        # 실행-로그 규칙 — sysctl 원본 출력 첨부 (성공/실패 무관).
        entry["raw_stdout"] = (res.stdout or "")[:1500]
        entry["raw_stderr"] = (res.stderr or "")[:800]
        entry["exit_code"] = res.exit_code
        if res.status != "ok":
            entry["error"] = res.error or res.stderr[:200]
            return entry
        parsed = _parse_sysctl(res.stdout)
        entry["param_count"] = len(parsed)
        entry["_parsed"] = parsed   # 저장용 임시
        return entry

    per_host: list[dict] = await _parallel_collect(
        payload.hosts,
        worker=_one,
        parallelism=payload.parallelism,
        chunk_size=payload.chunk_size,
        chunk_pause_ms=payload.chunk_pause_ms,
    )

    changed = 0
    errors: list[str] = []
    for entry in per_host:
        if entry.get("status") != "ok":
            errors.append(f"{entry.get('host')}: {entry.get('error') or entry.get('status')}")
            continue
        host = entry["host"]
        parsed = entry.pop("_parsed", {})
        data = {"host": host, "params": parsed, "collected_at": now.isoformat()}
        stored = _store_if_changed(
            db, cluster_id,
            component=f"kernel_params:{host}",
            category="os",
            version=None,
            data=data,
            now=now,
        )
        entry["stored"] = stored
        if stored:
            changed += 1

    if changed:
        db.commit()

    return {
        "cluster_id": str(cluster_id),
        "changed": changed,
        "hosts": per_host,
        "errors": errors,
    }


# ── kubelet config 수집 (SSH) ───────────────────────────────────────────────

class KubeletConfigCollectRequest(BaseModel):
    """각 노드에 SSH 로 접속해 kubelet 의 실행 인자 + 설정 파일을 수집한다.

    1) `ps -ef` 에서 kubelet 프로세스의 cmdline 추출 → `--config=<path>` 인자에서
       config 파일 경로 추출. (없으면 fallback 후보 경로를 차례로 시도)
    2) 그 경로의 YAML 내용을 그대로 읽어 `config_content` 에 저장.
    3) 다른 주요 인자(--kubeconfig, --container-runtime-endpoint 등)도 추출.

    K8s API 가 노출하지 않는 *실제 디스크 위에 어떤 config 가 적용 중인지* 를
    드러내는 게 핵심 — 사용자가 자주 묻는 "kubelet config 어디서 오는데?"
    에 대한 답.

    저장: `kubelet_config:{host}` (category=kubelet)
    """
    hosts: list[str] = Field(..., min_length=1, max_length=2000)
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(default="root", min_length=1, max_length=64)
    password: str | None = None
    private_key: str | None = None
    use_sudo: bool = False
    connect_timeout: int = Field(default=8, ge=1, le=60)
    # ps 추출 실패 시 차례로 시도할 fallback 경로들 (k8s 배포판마다 다를 수 있음)
    fallback_paths: list[str] = Field(default_factory=lambda: [
        "/var/lib/kubelet/config.yaml",
        "/etc/kubernetes/kubelet-config.yaml",
        "/etc/kubernetes/kubelet/kubelet-config.yaml",
        "/etc/kubernetes/kubelet/config.yaml",
    ])
    # 본문 길이 안전상한 — 이상한 거대한 파일을 통째로 저장하지 않도록 컷.
    max_content_bytes: int = Field(default=64 * 1024, ge=1024, le=1024 * 1024)
    parallelism: int = Field(default=10, ge=1, le=50)
    chunk_size: int = Field(default=30, ge=1, le=200)
    chunk_pause_ms: int = Field(default=200, ge=0, le=5000)


def _extract_kubelet_version_from_ps(cmdline: str) -> str | None:
    """`ps` 결과에서 kubelet 바이너리 경로의 버전을 끌어내기는 어려우니
    그 대신 `--v=<level>` 같은 보조 정보는 무시하고 None 반환. (kubelet:{name}
    스냅샷이 K8s API 로 이미 버전을 갖고 있음.)
    """
    return None


@router.post("/{cluster_id}/collect-kubelet-config")
async def collect_kubelet_config(
    cluster_id: UUID,
    payload: KubeletConfigCollectRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """kubelet 의 실제 사용중 config 파일 경로 + 내용을 SSH 로 호스트별 수집.

    - `ps -eo args` 에서 kubelet 프로세스 발견 → `--config=` 추출
    - 추출 못하면 fallback_paths 중 처음 존재하는 파일
    - 모든 출처(`_sources`)가 결과 dict 에 명시적으로 기록됨
    """
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")
    if not payload.password and not payload.private_key:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="password 또는 private_key 중 하나는 필수입니다.",
        )

    now = datetime.utcnow()
    sudo = "sudo -n " if payload.use_sudo else ""

    # ps 출력은 args 컬럼이 끝까지 잘리지 않도록 args 만 뽑는다.
    # `[k]ubelet` 트릭으로 grep 자기자신 제외.
    ps_cmd = "ps -eo pid,args 2>/dev/null | grep -E '(/|^)[k]ubelet( |$)' | head -1"

    # fallback path 안전성 검증 — sh 인터폴레이션 사고 방지.
    safe_fallbacks = [
        p for p in (payload.fallback_paths or [])
        if re.match(r"^[A-Za-z0-9_./-]+$", p)
    ]

    def _read_file_cmd(path: str) -> str:
        # 길이 컷오프는 head -c 로 적용해 거대한 파일 통째로 읽는 위험 차단
        return (
            f"(test -f {path} && echo '===KCFG_FILE===:{path}' && "
            f"{sudo}head -c {payload.max_content_bytes} {path}) 2>/dev/null"
        )

    def _try_files_cmd(paths: list[str]) -> str:
        if not paths:
            return "true"
        return " || ".join([_read_file_cmd(p) for p in paths]) + " || true"

    fallback_cmd = _try_files_cmd(safe_fallbacks)

    def _one(host: str) -> dict:
        target = SSHTarget(
            host=host, port=payload.port, username=payload.username,
            password=payload.password, private_key=payload.private_key,
        )
        r_ps = _exec_ssh(target, ps_cmd, connect_timeout=payload.connect_timeout, exec_timeout=10)
        entry: dict = {"host": host, "status": "ok"}
        # 실행-로그 규칙 — 1차 probe(ps) 원본 출력 첨부 (성공/실패 무관).
        entry["raw_stdout"] = (r_ps.stdout or "")[:1500]
        entry["raw_stderr"] = (r_ps.stderr or "")[:800]
        entry["exit_code"] = r_ps.exit_code
        sources: dict[str, str] = {}

        ps_line: str | None = None
        if r_ps.status == "ok" and r_ps.stdout.strip():
            ps_line = r_ps.stdout.strip().splitlines()[0]
            entry["ps_cmdline"] = ps_line
            sources["ps_cmdline"] = "ps -eo pid,args"

        # cmdline 인자에서 핵심 path 들 추출
        config_path_from_ps = _extract_cli_arg(ps_line or "", "--config")
        kubeconfig_path     = _extract_cli_arg(ps_line or "", "--kubeconfig")
        runtime_endpoint    = _extract_cli_arg(ps_line or "", "--container-runtime-endpoint")
        node_ip             = _extract_cli_arg(ps_line or "", "--node-ip")
        cgroup_driver       = _extract_cli_arg(ps_line or "", "--cgroup-driver")
        if kubeconfig_path:
            entry["kubeconfig"] = kubeconfig_path
            sources["kubeconfig"] = "ps -ef:--kubeconfig"
        if runtime_endpoint:
            entry["container_runtime_endpoint"] = runtime_endpoint
            sources["container_runtime_endpoint"] = "ps -ef:--container-runtime-endpoint"
        if node_ip:
            entry["node_ip"] = node_ip
            sources["node_ip"] = "ps -ef:--node-ip"
        if cgroup_driver:
            entry["cgroup_driver"] = cgroup_driver
            sources["cgroup_driver"] = "ps -ef:--cgroup-driver"

        # 1) ps 에서 추출된 경로가 있으면 그것을 우선 시도, 2) 안 되면 fallback 순회
        config_attempts: list[str] = []
        if config_path_from_ps and re.match(r"^[A-Za-z0-9_./-]+$", config_path_from_ps):
            config_attempts.append(config_path_from_ps)
        config_attempts.extend([p for p in safe_fallbacks if p not in config_attempts])

        cfg_cmd = _try_files_cmd(config_attempts) if config_attempts else fallback_cmd
        r_cfg = _exec_ssh(target, cfg_cmd, connect_timeout=payload.connect_timeout, exec_timeout=15)

        chosen_path: str | None = None
        chosen_content: str | None = None
        if r_cfg.status == "ok" and r_cfg.stdout.strip():
            m = re.match(r"===KCFG_FILE===:([^\n]+)\n(.*)", r_cfg.stdout, re.DOTALL)
            if m:
                chosen_path = m.group(1).strip()
                chosen_content = m.group(2)
        if chosen_path:
            entry["config_file"] = chosen_path
            entry["config_content"] = chosen_content or ""
            # 출처를 명시 — `--config=` 로 발견됐는지 fallback 으로 발견됐는지 구분.
            if config_path_from_ps and chosen_path == config_path_from_ps:
                sources["config_file"] = "ps -ef:--config"
            else:
                sources["config_file"] = "fallback path probe"
            sources["config_content"] = f"file:{chosen_path}"

        if not entry.get("ps_cmdline") and not entry.get("config_file"):
            entry["status"] = "error"
            entry["error"] = "kubelet 프로세스/설정 파일을 찾지 못했습니다 (ps + fallback 모두 실패)"
        entry["_sources"] = sources
        return entry

    per_host: list[dict] = await _parallel_collect(
        payload.hosts,
        worker=_one,
        parallelism=payload.parallelism,
        chunk_size=payload.chunk_size,
        chunk_pause_ms=payload.chunk_pause_ms,
    )

    changed = 0
    errors: list[str] = []
    for entry in per_host:
        if entry.get("status") != "ok":
            errors.append(f"{entry.get('host')}: {entry.get('error') or entry.get('status')}")
            continue
        host = entry["host"]
        data = {
            "source": "ssh",
            "host": host,
            "ps_cmdline":                 entry.get("ps_cmdline"),
            "config_file":                entry.get("config_file"),
            "config_content":             entry.get("config_content"),
            "kubeconfig":                 entry.get("kubeconfig"),
            "container_runtime_endpoint": entry.get("container_runtime_endpoint"),
            "node_ip":                    entry.get("node_ip"),
            "cgroup_driver":              entry.get("cgroup_driver"),
            "_sources":                   entry.get("_sources"),
            "collected_at":               now.isoformat(),
        }
        stored = _store_if_changed(
            db, cluster_id,
            component=f"kubelet_config:{host}",
            category="kubelet",
            version=None,
            data=data, now=now,
        )
        entry["stored"] = stored
        if stored:
            changed += 1

    if changed:
        db.commit()

    return {
        "cluster_id": str(cluster_id),
        "changed": changed,
        "hosts": per_host,
        "component_key": "kubelet_config:{host}",
        "errors": errors,
    }


# ── etcdctl config 수집 ─────────────────────────────────────────────────────

class EtcdctlConfigCollectRequest(BaseModel):
    """etcd 가 systemd 로 동작 중일 때 `/etc/etcd.env` 등 설정 파일과 endpoint
    status 를 수집해 스냅샷 저장. 내용 해시 기준 dedup.
    """
    hosts: list[str] = Field(..., min_length=1, max_length=2000)
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(default="root", min_length=1, max_length=64)
    password: str | None = None
    private_key: str | None = None
    use_sudo: bool = True
    connect_timeout: int = Field(default=8, ge=1, le=60)
    # 읽을 설정파일 후보 (첫 존재하는 것 사용)
    env_files: list[str] = Field(default_factory=lambda: [
        "/etc/etcd.env", "/etc/default/etcd", "/etc/sysconfig/etcd",
    ])
    # etcdctl endpoint status 호출 여부
    query_endpoint_status: bool = True
    etcdctl_path: str = Field(default="etcdctl", max_length=256)
    # endpoint status 에 사용할 환경변수 파일 (ETCDCTL_CACERT 등). 비어있으면 env_files 사용.
    source_env_file: str | None = None


@router.post("/{cluster_id}/collect-etcdctl-config")
def collect_etcdctl_config(
    cluster_id: UUID,
    payload: EtcdctlConfigCollectRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """etcd 설정 (env 파일 + endpoint status) 을 수집해 histor 에 누적. dedup."""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")
    if not payload.password and not payload.private_key:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="password 또는 private_key 중 하나는 필수입니다.",
        )

    now = datetime.utcnow()
    sudo = "sudo -n " if payload.use_sudo else ""

    changed = 0
    per_host: list[dict] = []
    errors: list[str] = []

    for host in payload.hosts:
        target = SSHTarget(
            host=host, port=payload.port, username=payload.username,
            password=payload.password, private_key=payload.private_key,
        )
        # 1) 설정파일 내용
        env_content: str | None = None
        env_file_used: str | None = None
        for candidate in payload.env_files:
            # 경로 검증 — shell 메타문자 금지
            if not re.match(r"^[A-Za-z0-9_./-]+$", candidate):
                continue
            check = _exec_ssh(
                target,
                f"{sudo}test -f {candidate} && {sudo}cat {candidate} 2>/dev/null || true",
                connect_timeout=payload.connect_timeout, exec_timeout=8,
            )
            if check.status == "ok" and check.stdout.strip():
                env_content = check.stdout
                env_file_used = candidate
                break

        # 2) endpoint status (JSON)
        endpoint_status: str | None = None
        if payload.query_endpoint_status:
            src = payload.source_env_file or env_file_used
            src_expr = f"set -a; . {src}; set +a; " if src and re.match(r"^[A-Za-z0-9_./-]+$", src) else ""
            safe_etcdctl = payload.etcdctl_path if re.match(r"^[A-Za-z0-9_./-]+$", payload.etcdctl_path) else "etcdctl"
            r = _exec_ssh(
                target,
                f"{sudo}bash -c '{src_expr}{safe_etcdctl} endpoint status -w json 2>/dev/null'",
                connect_timeout=payload.connect_timeout, exec_timeout=15,
            )
            if r.status == "ok":
                endpoint_status = r.stdout.strip()

        entry: dict = {
            "host": host,
            "env_file": env_file_used,
            "has_endpoint_status": bool(endpoint_status),
        }

        if env_content is None and endpoint_status is None:
            entry["error"] = "env 파일/endpoint status 모두 읽지 못함"
            errors.append(f"{host}: 데이터 없음")
            per_host.append(entry)
            continue

        data = {
            "host": host,
            "env_file": env_file_used,
            "env_content": env_content,
            "endpoint_status_json": endpoint_status,
            "collected_at": now.isoformat(),
        }
        stored = _store_if_changed(
            db, cluster_id,
            component=f"etcdctl_config:{host}",
            category="os",
            version=None,
            data=data,
            now=now,
        )
        entry["stored"] = stored
        if stored:
            changed += 1
        per_host.append(entry)

    if changed:
        db.commit()

    return {
        "cluster_id": str(cluster_id),
        "changed": changed,
        "hosts": per_host,
        "errors": errors,
    }


# ── kubeadm 인증서 만료 수집 (Ops Checks cert_expiry 의 snapshot 경로용) ─────────

class KubeadmCertsCollectRequest(BaseModel):
    """컨트롤 플레인 인증서 잔여일을 호스트에서 직접 확인해 스냅샷 저장.

    kube-apiserver 파드 이미지는 distroless(쉘조차 없음)라 ``kubectl exec`` 로는
    호스트에 설치된 ``kubeadm`` 바이너리를 실행할 수 없다 — 그래서 이 체크는
    etcd_defrag 의 데몬(systemd) 경로와 마찬가지로 SSH 로 호스트에서 직접 확인한다.
    """
    hosts: list[str] = Field(..., min_length=1, max_length=2000)
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(default="root", min_length=1, max_length=64)
    password: str | None = None
    private_key: str | None = None
    use_sudo: bool = True
    connect_timeout: int = Field(default=8, ge=1, le=60)


@router.post("/{cluster_id}/collect-kubeadm-certs")
def collect_kubeadm_certs(
    cluster_id: UUID,
    payload: KubeadmCertsCollectRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """``kubeadm certs check-expiration`` 을 컨트롤 플레인 호스트에서 SSH 로 실행해
    스냅샷 저장. Ops Checks 의 `cert_expiry` 체커가 `source=snapshot`(또는 auto 폴백)
    일 때 이 스냅샷(component=`kubeadm_certs:{host}`)을 읽는다. 자격증명은 이
    요청에만 존재하고 저장되지 않는다."""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")
    if not payload.password and not payload.private_key:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="password 또는 private_key 중 하나는 필수입니다.",
        )

    now = datetime.utcnow()
    sudo = "sudo -n " if payload.use_sudo else ""

    changed = 0
    per_host: list[dict] = []
    errors: list[str] = []

    for host in payload.hosts:
        target = SSHTarget(
            host=host, port=payload.port, username=payload.username,
            password=payload.password, private_key=payload.private_key,
        )
        r = _exec_ssh(
            target, f"{sudo}kubeadm certs check-expiration",
            connect_timeout=payload.connect_timeout, exec_timeout=20,
        )
        entry: dict = {"host": host}
        # 실행-로그 규칙 — check-expiration 원본 출력(인증서 표) 첨부 (성공/실패 무관).
        entry["raw_stdout"] = (r.stdout or "")[:1500]
        entry["raw_stderr"] = (r.stderr or "")[:800]
        entry["exit_code"] = r.exit_code
        if r.status != "ok" or not (r.stdout or "").strip():
            entry["error"] = r.error or "kubeadm certs check-expiration 실패 (kubeadm 미설치 또는 권한 부족)"
            errors.append(f"{host}: {entry['error']}")
            per_host.append(entry)
            continue

        data = {
            "host": host,
            "check_expiration_output": r.stdout,
            "collected_at": now.isoformat(),
        }
        stored = _store_if_changed(
            db, cluster_id,
            component=f"kubeadm_certs:{host}",
            category="k8s",
            version=None,
            data=data,
            now=now,
        )
        entry["stored"] = stored
        if stored:
            changed += 1
        per_host.append(entry)

    if changed:
        db.commit()

    return {
        "cluster_id": str(cluster_id),
        "changed": changed,
        "hosts": per_host,
        "errors": errors,
    }


@router.get("/{cluster_id}/versions/current")
def get_current_versions(cluster_id: UUID, db: Session = Depends(get_db)):
    """각 component 별 가장 최근 스냅샷 반환."""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    # component 별 가장 최근 한 건씩 — cluster_config_snapshots 는 LOG_TABLES 로 분류될
    # 만큼 무한 증가하는 로그성 테이블이라, 클러스터 전체 이력을 Python 으로 읽어와
    # dedup 하면 운영 기간이 길어질수록 이 엔드포인트 비용이 선형으로 커진다.
    # DISTINCT ON 으로 component 당 최신 1건만 DB 에서 골라온다.
    latest_snaps = (
        db.query(ClusterConfigSnapshot)
        .filter(ClusterConfigSnapshot.cluster_id == cluster_id)
        .order_by(ClusterConfigSnapshot.component, ClusterConfigSnapshot.collected_at.desc())
        .distinct(ClusterConfigSnapshot.component)
        .all()
    )
    current = [
        {
            "id": str(s.id),
            "component": s.component,
            "category": s.category,
            "version": s.version,
            "data": s.data,
            "collectedAt": s.collected_at.isoformat(),
        }
        for s in latest_snaps
    ]
    return {"cluster_id": str(cluster_id), "components": current}


@router.get("/{cluster_id}/versions/history")
def get_versions_history(
    cluster_id: UUID,
    component: str | None = Query(default=None, description="특정 component 만 필터"),
    limit: int = Query(default=200, ge=1, le=1000),
    db: Session = Depends(get_db),
):
    """스냅샷 히스토리. component 지정 시 해당 컴포넌트만."""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    q = db.query(ClusterConfigSnapshot).filter(ClusterConfigSnapshot.cluster_id == cluster_id)
    if component:
        q = q.filter(ClusterConfigSnapshot.component == component)
    snaps = q.order_by(ClusterConfigSnapshot.collected_at.desc()).limit(limit).all()

    return {
        "cluster_id": str(cluster_id),
        "component": component,
        "snapshots": [
            {
                "id": str(s.id),
                "component": s.component,
                "category": s.category,
                "version": s.version,
                "data": s.data,
                "contentHash": s.content_hash,
                "collectedAt": s.collected_at.isoformat(),
            }
            for s in snaps
        ],
    }


@router.get("/{cluster_id}/versions/diff")
def diff_snapshots(
    cluster_id: UUID,
    from_id: UUID = Query(..., alias="from"),
    to_id: UUID = Query(..., alias="to"),
    db: Session = Depends(get_db),
):
    """두 스냅샷 간 필드 단위 diff. data dict 가 flat 이 아니면 재귀적으로 비교."""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    from_snap = db.query(ClusterConfigSnapshot).filter(
        ClusterConfigSnapshot.id == from_id,
        ClusterConfigSnapshot.cluster_id == cluster_id,
    ).first()
    to_snap = db.query(ClusterConfigSnapshot).filter(
        ClusterConfigSnapshot.id == to_id,
        ClusterConfigSnapshot.cluster_id == cluster_id,
    ).first()
    if not from_snap or not to_snap:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="스냅샷을 찾을 수 없습니다")

    def flatten(d: dict, prefix: str = "") -> dict:
        out = {}
        for k, v in (d or {}).items():
            key = f"{prefix}.{k}" if prefix else str(k)
            if isinstance(v, dict):
                out.update(flatten(v, key))
            else:
                out[key] = v
        return out

    a = flatten(from_snap.data or {})
    b = flatten(to_snap.data or {})
    keys = sorted(set(a.keys()) | set(b.keys()))

    changes = []
    for k in keys:
        va, vb = a.get(k), b.get(k)
        if va != vb:
            changes.append({"key": k, "from": va, "to": vb})

    return {
        "from": {
            "id": str(from_snap.id),
            "component": from_snap.component,
            "version": from_snap.version,
            "collectedAt": from_snap.collected_at.isoformat(),
        },
        "to": {
            "id": str(to_snap.id),
            "component": to_snap.component,
            "version": to_snap.version,
            "collectedAt": to_snap.collected_at.isoformat(),
        },
        "versionChanged": from_snap.version != to_snap.version,
        "changes": changes,
    }


# ── CSV export ───────────────────────────────────────────────────────────────

def _csv_cell(v) -> str:
    """CSV 셀 이스케이프. dict/list 는 JSON 직렬화."""
    if v is None:
        return ""
    if isinstance(v, (dict, list)):
        v = json.dumps(v, ensure_ascii=False, default=str)
    s = str(v)
    if any(c in s for c in (',', '"', '\n', '\r')):
        return '"' + s.replace('"', '""') + '"'
    return s


@router.get("/{cluster_id}/versions/export.csv")
def export_versions_csv(
    cluster_id: UUID,
    detail: str = Query("summary", regex="^(summary|full|none)$",
                        description="summary=주요 필드, full=data 전체 JSON, none=메타만"),
    categories: str | None = Query(None, description="콤마로 구분한 카테고리 필터"),
    components: str | None = Query(None, description="콤마로 구분한 component 키 필터"),
    db: Session = Depends(get_db),
):
    """현재 스냅샷을 CSV 로 내보낸다. detail 로 컬럼 풍부도를 조절.

    - summary: cluster, component, category, version, collected_at, host, config_path, brief
    - full:    summary 컬럼 + data_json (전체 data dict 직렬화)
    - none:    cluster, component, category, version, collected_at 만
    """
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    # 카테고리/컴포넌트 화이트리스트 — 비면 전체.
    cat_set = {c.strip() for c in (categories or "").split(",") if c.strip()}
    comp_set = {c.strip() for c in (components or "").split(",") if c.strip()}

    # cluster_config_snapshots 는 LOG_TABLES(무한 증가) — component 당 최신 1건만
    # DISTINCT ON 으로 DB 에서 골라오고, 클러스터 전체 이력은 읽지 않는다.
    latest_snaps = (
        db.query(ClusterConfigSnapshot)
        .filter(ClusterConfigSnapshot.cluster_id == cluster_id)
        .order_by(ClusterConfigSnapshot.component, ClusterConfigSnapshot.collected_at.desc())
        .distinct(ClusterConfigSnapshot.component)
        .all()
    )
    rows: list[ClusterConfigSnapshot] = [
        s for s in latest_snaps
        if (not cat_set or (s.category or "") in cat_set)
        and (not comp_set or s.component in comp_set)
    ]

    # 컬럼 정의 — detail 별로 분기
    if detail == "none":
        cols = ["cluster", "component", "category", "version", "collected_at"]
    elif detail == "summary":
        cols = ["cluster", "component", "category", "version", "collected_at",
                "host", "config_path", "brief"]
    else:  # full
        cols = ["cluster", "component", "category", "version", "collected_at",
                "host", "config_path", "brief", "data_json"]

    def _summary(d: dict) -> tuple[str | None, str | None, str]:
        """data 에서 사람이 읽을 수 있는 (host, config_path, brief) 추출.
        component 별 데이터 모양이 달라 best-effort.
        """
        if not isinstance(d, dict):
            return (None, None, "")
        host = d.get("host")
        # config 경로 후보 (kubelet_config / etcd_systemd / 일반 image+flag 컴포넌트)
        config_path = (
            d.get("config_file")
            or d.get("config_file_arg")
            or d.get("env_file")
            or d.get("systemd_env_file")
            or d.get("fragment_path")
        )
        brief_parts: list[str] = []
        for k in ("kubeletVersion", "version", "image", "active_state", "container_runtime_endpoint"):
            v = d.get(k)
            if v:
                brief_parts.append(f"{k}={v}")
        # flags 가 있으면 갯수만
        flags = d.get("flags")
        if isinstance(flags, dict) and flags:
            brief_parts.append(f"flags={len(flags)}")
        return (host, config_path, "; ".join(brief_parts))

    out_lines = [",".join(cols)]
    for s in rows:
        d = s.data if isinstance(s.data, dict) else {}
        host, config_path, brief = _summary(d)
        record = {
            "cluster":      cluster.name,
            "component":    s.component,
            "category":     s.category or "",
            "version":      s.version or "",
            "collected_at": s.collected_at.isoformat() if s.collected_at else "",
            "host":         host or "",
            "config_path":  config_path or "",
            "brief":        brief,
            "data_json":    d,
        }
        out_lines.append(",".join(_csv_cell(record.get(c)) for c in cols))

    csv_text = "\n".join(out_lines) + "\n"
    # 한글 호환을 위한 UTF-8 BOM
    body = "﻿" + csv_text
    fname = f"versions-{cluster.name}-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}.csv"
    from fastapi.responses import Response
    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("/{cluster_id}/versions/graph")
def get_versions_graph(cluster_id: UUID, db: Session = Depends(get_db)):
    """3D 그래프용: 최신 스냅샷 기반으로 노드/엣지 산출.

    Graph 구조:
      - 루트: cluster
      - 카테고리 노드: control_plane, kubelet, cni (있을 때만)
      - 각 component 노드: 그 아래
      - 설정 cross-edge: cilium_config → cilium_agent (uses), kube_proxy → cilium_agent (replaces if kube-proxy disabled)
    """
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    # cluster_config_snapshots 는 LOG_TABLES(무한 증가) — component 당 최신 1건만
    # DISTINCT ON 으로 DB 에서 골라오고, 클러스터 전체 이력은 읽지 않는다.
    latest_snaps = (
        db.query(ClusterConfigSnapshot)
        .filter(ClusterConfigSnapshot.cluster_id == cluster_id)
        .order_by(ClusterConfigSnapshot.component, ClusterConfigSnapshot.collected_at.desc())
        .distinct(ClusterConfigSnapshot.component)
        .all()
    )
    latest: dict[str, ClusterConfigSnapshot] = {s.component: s for s in latest_snaps}

    nodes: list[dict] = [{
        "id":       f"cluster:{cluster.id}",
        "label":    cluster.name,
        "type":     "cluster",
        "category": "cluster",
    }]
    edges: list[dict] = []

    categories_seen = set()
    for comp, s in latest.items():
        cat = s.category or "other"
        cat_id = f"cat:{cat}"
        if cat_id not in categories_seen:
            categories_seen.add(cat_id)
            nodes.append({"id": cat_id, "label": cat, "type": "category", "category": cat})
            edges.append({"source": f"cluster:{cluster.id}", "target": cat_id, "type": "contains"})

        node_id = f"comp:{comp}"
        nodes.append({
            "id":       node_id,
            "label":    comp,
            "type":     "component",
            "category": cat,
            "version":  s.version,
            "collectedAt": s.collected_at.isoformat(),
        })
        edges.append({"source": cat_id, "target": node_id, "type": "contains"})

        # 주요 flags 를 작은 leaf 노드로 (최대 6개만 — 그래프 폭주 방지)
        flags = (s.data or {}).get("flags") if isinstance(s.data, dict) else None
        if isinstance(flags, dict):
            for idx, (fk, fv) in enumerate(list(flags.items())[:6]):
                leaf_id = f"flag:{comp}:{fk}"
                nodes.append({
                    "id":       leaf_id,
                    "label":    f"{fk}={fv}",
                    "type":     "flag",
                    "category": cat,
                    "value":    str(fv)[:60],
                })
                edges.append({"source": node_id, "target": leaf_id, "type": "param"})

        # cilium_config data → cilium_agent 로 연결
        if comp == "cilium_config":
            agent_node = "comp:cilium_agent"
            edges.append({"source": node_id, "target": agent_node, "type": "configures"})

    # kube_proxy 가 비어있거나 Cilium kubeProxyReplacement 가 true 면 표시
    cilium_cfg = latest.get("cilium_config")
    if cilium_cfg and isinstance(cilium_cfg.data, dict):
        d = cilium_cfg.data.get("data", {}) if isinstance(cilium_cfg.data.get("data"), dict) else {}
        kpr = str(d.get("kube-proxy-replacement", "")).lower()
        if kpr in ("strict", "true", "enabled"):
            if "comp:cilium_agent" in {n["id"] for n in nodes} and "comp:kube_proxy" in {n["id"] for n in nodes}:
                edges.append({
                    "source": "comp:cilium_agent",
                    "target": "comp:kube_proxy",
                    "type":   "replaces",
                })

    return {
        "cluster_id": str(cluster_id),
        "cluster_name": cluster.name,
        "nodes": nodes,
        "edges": edges,
    }


# ── 노드 NIC 수집 (bond0/bond1 + public/private IP) ─────────────────────────

class NodeNicsCollectRequest(BaseModel):
    """각 노드 SSH → `ip -j addr show` 로 모든 인터페이스/IP 를 가져와
    `node_nics:{host}` 스냅샷에 저장 + Cluster.node_ips 의 풍부한 포맷으로 갱신.

    K8s API 의 InternalIP 만으로는 bond0/bond1 (public/private) 같은 다중
    NIC 환경을 표현 못해 OS 레벨 SSH 로 수집한다.
    """
    hosts: list[str] = Field(..., min_length=1, max_length=2000)
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(default="root", min_length=1, max_length=64)
    password: str | None = None
    private_key: str | None = None
    use_sudo: bool = False
    connect_timeout: int = Field(default=8, ge=1, le=60)
    # 표시할 인터페이스 prefix (loopback / docker / cni / kube-ipvs0 등 제외)
    skip_iface_patterns: list[str] = Field(default_factory=lambda: [
        "lo", "docker", "cni", "veth", "kube-ipvs",
        "flannel", "cilium_", "tunl", "calico", "br-",
    ])
    parallelism: int = Field(default=10, ge=1, le=50)
    chunk_size: int = Field(default=30, ge=1, le=200)
    chunk_pause_ms: int = Field(default=200, ge=0, le=5000)


def _parse_ip_json(raw_json: str, skip_patterns: list[str]) -> list[dict]:
    """`ip -j addr show` 출력 파싱.

    출력 예 (단일 인터페이스):
      {"ifindex": 5, "ifname": "bond0", "operstate": "UP",
       "address": "aa:bb:cc:dd:ee:ff", "mtu": 1500,
       "addr_info": [{"family": "inet", "local": "10.0.1.10", "prefixlen": 24}]}
    """
    if not raw_json or not raw_json.strip():
        return []
    try:
        data = json.loads(raw_json)
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    out: list[dict] = []
    for it in data:
        name = it.get("ifname") or ""
        if not name:
            continue
        # skip 패턴 매칭
        if any(name == p or name.startswith(p) for p in skip_patterns):
            continue
        addrs = []
        for ai in it.get("addr_info", []) or []:
            if ai.get("family") == "inet" and ai.get("local"):
                addrs.append({
                    "ip": ai["local"],
                    "prefixlen": ai.get("prefixlen"),
                    "scope": ai.get("scope"),
                })
        if not addrs:
            continue
        out.append({
            "name": name,
            "mac": it.get("address"),
            "mtu": it.get("mtu"),
            "operstate": it.get("operstate"),
            "addrs": addrs,
            # 결합 인터페이스 정보 (bond/bridge/vlan slave 등)
            "link_kind": (it.get("linkinfo") or {}).get("info_kind"),
        })
    return out


def _categorize_ip(ip: str) -> str:
    """RFC1918 / RFC6598 / 100.64.0.0/10 (CGNAT) 등 사설 vs 공인 분류.
    public / private / linklocal / unknown."""
    try:
        import ipaddress
        addr = ipaddress.IPv4Address(ip)
    except Exception:
        return "unknown"
    if addr.is_private:
        # 10/8, 172.16/12, 192.168/16 + 100.64/10 (CGNAT 도 사설로 취급)
        return "private"
    if addr.is_link_local:
        return "linklocal"
    if addr.is_loopback or addr.is_multicast or addr.is_reserved:
        return "unknown"
    return "public"


@router.post("/{cluster_id}/collect-node-nics")
async def collect_node_nics(
    cluster_id: UUID,
    payload: NodeNicsCollectRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """SSH 로 각 노드의 ip 인터페이스 정보 수집 → node_nics:{host} 스냅샷 + Cluster.node_ips 갱신."""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")
    if not payload.password and not payload.private_key:
        raise HTTPException(status_code=422, detail="password 또는 private_key 중 하나는 필수입니다.")

    sudo = "sudo -n " if payload.use_sudo else ""
    # k8s 워커는 pod 마다 veth*, calico cali*, cilium_*, kube-ipvs0, flannel.1 등이
    # 누적돼 `ip -j addr show` JSON 이 수십 KB ~ 수백 KB 까지 커진다. _exec_ssh 의
    # stdout truncation (기본 8000 chars) 에 잘리면 JSON 이 깨져 파서가 [] 를 반환,
    # "검출된 NIC 없음" 으로 표시된다. 이를 막기 위해 원격에서 jq 로 사전 필터하여
    # bond / eth / en* / em* 같은 물리 NIC 만 보낸다. jq 없는 노드는 raw 출력 그대로
    # 받되 max_stdout_chars 를 충분히 늘려 truncation 을 회피.
    #
    # 필터 정규식 (interface 이름 기준):
    #   bond[0-9]+    예: bond0, bond1
    #   eth[0-9]+     예: eth0, eth1
    #   en[oxsp][^.]* 예: ens3, eno1, enp4s0, enx00... (predictable NIC names)
    #   em[0-9]+      예: em1 (구 RHEL/Dell)
    iface_regex = "^(bond[0-9]+|eth[0-9]+|en[oxsp][^.]*|em[0-9]+)$"
    # 출력을 변수에 캡처 후 jq 시도 → 실패하면 (jq 미설치 / JSON 파싱 실패 등)
    # 캡처한 raw 를 그대로 흘려보냄. 파이프 통과 후 폴백용 cat 은 stdin 이 비어
    # 있어 동작 못 하므로 변수 캡처 방식이 정답.
    cmd = (
        f"out=$({sudo}ip -j addr show 2>&1); "
        f"printf '%s' \"$out\" | "
        f"jq -c '[.[] | select(.ifname | test(\"{iface_regex}\"))]' 2>/dev/null "
        f"|| printf '%s' \"$out\""
    )
    skip_patterns = list(payload.skip_iface_patterns or [])
    now = datetime.utcnow()

    # 기존 cluster.node_ips 에서 master 플래그 / 이름 매핑 보존
    name_master: dict[str, bool] = {}
    name_by_ip: dict[str, str] = {}
    existing_node_ips_raw = cluster.node_ips
    if existing_node_ips_raw:
        try:
            arr = json.loads(existing_node_ips_raw)
            if isinstance(arr, list):
                for n in arr:
                    nm = n.get("name")
                    # 기존 데이터에서 name 이 이미 IP 형태이면 (NIC 수집을 k8s 자동수집보다
                    # 먼저 실행한 케이스) 매핑 소스로 신뢰 못 함 — 폐기.
                    is_ip_like = isinstance(nm, str) and bool(re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", nm))
                    if nm and not is_ip_like:
                        name_master[nm] = bool(n.get("master"))
                        for ip in n.get("ips", []) or [n.get("ip")] or []:
                            if ip:
                                name_by_ip[ip] = nm
        except Exception:
            pass

    # 기존 데이터가 비어있거나 IP 만 있는 클러스터를 위해 k8s API 로도 hostname↔IP 매핑
    # 시도. 실패해도 (kubeconfig 미등록 / API 미접속) 무시 — 기존 폴백(host 그대로) 유지.
    if not name_by_ip:
        try:
            kc_path = _ensure_kubeconfig_file_for(cluster)
            if kc_path:
                api_client = k8s_config.new_client_from_config(config_file=kc_path)
                v1 = k8s_client.CoreV1Api(api_client)
                k8s_nodes = v1.list_node(_request_timeout=10)
                for kn in k8s_nodes.items:
                    nm = kn.metadata.name
                    if not nm:
                        continue
                    is_master = bool(
                        (kn.metadata.labels or {}).get("node-role.kubernetes.io/control-plane") is not None
                        or (kn.metadata.labels or {}).get("node-role.kubernetes.io/master") is not None
                    )
                    name_master.setdefault(nm, is_master)
                    for addr in (kn.status.addresses or []) if kn.status else []:
                        if addr.type == "InternalIP" and addr.address:
                            name_by_ip[addr.address] = nm
        except Exception:
            # 조회 실패는 silently 무시 — host 그대로 폴백.
            pass

    def _one(host: str) -> dict:
        target = SSHTarget(
            host=host, port=payload.port, username=payload.username,
            password=payload.password, private_key=payload.private_key,
        )
        # ip -j addr show 의 raw JSON 은 노드당 100KB 이상까지도 가능 (워커의 pod
        # veth 누적). 기본 8000 chars truncation 을 충분히 키워 JSON 손실 방지.
        res = _exec_ssh(
            target, cmd,
            connect_timeout=payload.connect_timeout, exec_timeout=15,
            max_stdout_chars=2_000_000,
        )
        entry: dict = {"host": host, "status": res.status}
        if res.status != "ok":
            entry["error"] = res.error or res.stderr[:200]
            # 진단을 위해 raw 도 같이 — 'ip' 가 사용 못 하는 옵션이라며 종료한 케이스 추적용.
            entry["raw_stdout"] = (res.stdout or "")[:1500]
            entry["raw_stderr"] = (res.stderr or "")[:800]
            entry["exit_code"] = res.exit_code
            return entry
        ifaces = _parse_ip_json(res.stdout, skip_patterns)
        entry["interfaces"] = ifaces
        # 모든 IP 수집
        all_ips: list[dict] = []
        for ifc in ifaces:
            for a in ifc.get("addrs", []):
                all_ips.append({
                    "iface": ifc["name"],
                    "ip": a["ip"],
                    "prefix": a.get("prefixlen"),
                    "mac": ifc.get("mac"),
                    "mtu": ifc.get("mtu"),
                    "operstate": ifc.get("operstate"),
                    "scope": _categorize_ip(a["ip"]),  # public / private / linklocal
                })
        entry["all_ips"] = all_ips
        # raw 출력은 성공 호스트에도 항상 첨부한다 — "파싱 결과가 맞나?" 검증은 실패했을
        # 때만 필요한 게 아니고, 실행-로그 규칙(CLAUDE.md)상 모든 수집 실행은 원본 출력을
        # 사용자에게 열람 가능해야 한다. (기존: 실패/0-NIC 케이스만 첨부)
        entry["raw_stdout"] = (res.stdout or "")[:1500]
        entry["raw_stderr"] = (res.stderr or "")[:800]
        entry["exit_code"] = res.exit_code
        return entry

    per_host = await _parallel_collect(
        payload.hosts,
        worker=_one,
        parallelism=payload.parallelism,
        chunk_size=payload.chunk_size,
        chunk_pause_ms=payload.chunk_pause_ms,
    )

    # 호스트별 스냅샷 저장 (history 추적)
    changed = 0
    errors: list[str] = []
    for entry in per_host:
        host = entry.get("host")
        if not host:
            continue
        if entry.get("status") != "ok":
            errors.append(f"{host}: {entry.get('error') or entry.get('status')}")
            continue
        data = {
            "host": host,
            "interfaces": entry.get("interfaces"),
            "all_ips": entry.get("all_ips"),
            "collected_at": now.isoformat(),
        }
        if _store_if_changed(
            db, cluster_id,
            component=f"node_nics:{host}",
            category="os",
            version=None,
            data=data, now=now,
        ):
            changed += 1

    # Cluster.node_ips 풍부한 포맷으로 갱신 — 호스트당 모든 인터페이스/IP 포함
    rich_nodes: list[dict] = []
    for entry in per_host:
        host = entry.get("host")
        if not host or entry.get("status") != "ok":
            continue
        # name 추정: 기존 매핑 → 없으면 host 그대로
        name = name_by_ip.get(host, host)
        is_master = name_master.get(name, False)
        ifaces = entry.get("interfaces") or []
        ips_flat: list[str] = []
        for ifc in ifaces:
            for a in ifc.get("addrs", []):
                ips_flat.append(a["ip"])
        rich_nodes.append({
            "name": name,
            "master": is_master,
            "ip": ips_flat[0] if ips_flat else None,
            "ips": ips_flat,
            "interfaces": [
                {
                    "name": ifc["name"],
                    "ips": [a["ip"] for a in ifc.get("addrs", [])],
                    "scopes": [_categorize_ip(a["ip"]) for a in ifc.get("addrs", [])],
                    "mac": ifc.get("mac"),
                    "operstate": ifc.get("operstate"),
                }
                for ifc in ifaces
            ],
        })
    if rich_nodes:
        rich_nodes.sort(key=lambda x: (not x.get("master"), x.get("name") or ""))
        cluster.node_ips = json.dumps(rich_nodes, ensure_ascii=False)

        # 클러스터 테이블의 bond0/bond1 컬럼도 master 노드 NIC 으로 즉시 갱신.
        # (서버 스펙 카드 / 자동수집 후 표기가 비어있던 문제 해결)
        master_entry = next(
            (e for e in rich_nodes if e.get("master") and e.get("interfaces")),
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
                    if ips:
                        cluster.bond0_ip = ips[0]
                    if mac:
                        cluster.bond0_mac = mac
                elif nm == "bond1":
                    if ips:
                        cluster.bond1_ip = ips[0]
                    if mac:
                        cluster.bond1_mac = mac

    # 클러스터 메타 변경 히스토리 (bonds / node_ips / nodes 그룹) — hash 가 다르면 자동 기록.
    meta_changed = record_cluster_meta_snapshots(db, cluster, now) if rich_nodes else 0
    if changed or rich_nodes or meta_changed:
        db.commit()

    return {
        "cluster_id": str(cluster_id),
        "changed": changed,
        "hosts": per_host,
        "errors": errors,
    }


# ── MinIO / AIStor 수집 (Operator + Tenant + DirectPV) ──────────────────────


def _ec_parity_default(drives_per_set: int) -> int:
    """MinIO 의 EC parity 기본값 추정 — 정확한 값은 erasureCodingParity 필드를 우선.

    https://min.io/docs/minio/kubernetes/upstream/operations/concepts/erasure-coding.html
    drives_per_set <  4 → 0 (EC 미적용)
    drives_per_set ==  4 → 2 (EC:2 default)
    drives_per_set ==  6 → 2 (EC:2 default)
    drives_per_set ==  8 → 4 (EC:4 default)
    drives_per_set == 12 → 4 (EC:4 default)
    drives_per_set == 16 → 4 (EC:4 default)
    """
    if drives_per_set < 4:
        return 0
    if drives_per_set <= 6:
        return 2
    return 4


def _summarize_tenant(tenant: dict) -> dict:
    """MinIO Tenant CR 에서 운영자가 알아야 할 핵심만 추출.
    pools / disks / parity / image / autoCert / 자원 스펙 등."""
    meta = tenant.get("metadata") or {}
    spec = tenant.get("spec") or {}
    status = tenant.get("status") or {}

    pools_in = spec.get("pools") or []
    pools_out: list[dict] = []
    total_drives = 0
    total_servers = 0
    drives_per_set = 0  # erasure set size (servers × volumesPerServer)

    for p in pools_in:
        servers = int(p.get("servers") or 0)
        vps = int(p.get("volumesPerServer") or 0)
        drives = servers * vps
        total_drives += drives
        total_servers += servers
        if drives_per_set == 0:
            drives_per_set = drives  # 첫 pool 기준 (보통 동일)
        vct = p.get("volumeClaimTemplate") or {}
        vct_spec = vct.get("spec") or {}
        size_req = (
            ((vct_spec.get("resources") or {}).get("requests") or {}).get("storage")
        )
        sc = vct_spec.get("storageClassName")
        access_modes = vct_spec.get("accessModes") or []
        resources = p.get("resources") or {}
        pools_out.append({
            "name": p.get("name"),
            "servers": servers,
            "volumesPerServer": vps,
            "drives": drives,
            "storageClass": sc,
            "volumeSize": size_req,
            "accessModes": access_modes,
            "nodeSelector": p.get("nodeSelector"),
            "tolerations": bool(p.get("tolerations")),
            "affinity": bool(p.get("affinity")),
            "topologySpreadConstraints": bool(p.get("topologySpreadConstraints")),
            "cpuRequest":   ((resources.get("requests") or {}).get("cpu")),
            "memoryRequest": ((resources.get("requests") or {}).get("memory")),
            "cpuLimit":     ((resources.get("limits")   or {}).get("cpu")),
            "memoryLimit":   ((resources.get("limits")   or {}).get("memory")),
            "runtimeClassName": p.get("runtimeClassName"),
        })

    # erasure-coding parity — tenant.spec.erasureCodingParity 가 명시돼 있으면 그 값,
    # 없으면 drives_per_set 기준 기본값.
    explicit_parity = spec.get("erasureCodingParity")
    parity = int(explicit_parity) if explicit_parity is not None else _ec_parity_default(drives_per_set)
    data_shards = drives_per_set - parity if drives_per_set > 0 else 0

    return {
        "namespace": meta.get("namespace"),
        "name": meta.get("name"),
        "image": spec.get("image"),
        "imagePullSecret": (spec.get("imagePullSecret") or {}).get("name"),
        "configMap":       (spec.get("configuration") or {}).get("name"),
        "credsSecret":     (spec.get("credsSecret") or {}).get("name"),
        "requestAutoCert": bool(spec.get("requestAutoCert", True)),
        "exposeServices":  spec.get("exposeServices"),
        "mountPath":       spec.get("mountPath"),
        "subPath":         spec.get("subPath"),
        "serviceAccountName": spec.get("serviceAccountName"),
        "priorityClassName":  spec.get("priorityClassName"),
        "podManagementPolicy": spec.get("podManagementPolicy"),
        "buckets":         spec.get("buckets"),
        "users":           spec.get("users"),
        "kes":             bool(spec.get("kes")),
        # 운영 핵심 — 풀/디스크/패리티
        "totalServers":    total_servers,
        "totalDrives":     total_drives,
        "drivesPerSet":    drives_per_set,   # erasure set 크기
        "ecParity":        parity,           # 패리티 디스크 수 (EC:N)
        "ecDataShards":    data_shards,      # 데이터 디스크 수 = set - parity
        "ecExplicit":      explicit_parity is not None,
        "pools":           pools_out,
        # 상태
        "currentState":    status.get("currentState"),
        "syncVersion":     status.get("syncVersion"),
        "availableReplicas": status.get("availableReplicas"),
        "drivesHealing":   status.get("drivesHealing"),
        "drivesOnline":    status.get("drivesOnline"),
        "drivesOffline":   status.get("drivesOffline"),
        "writeQuorum":     status.get("writeQuorum"),
        "healthStatus":    status.get("healthStatus"),
    }


def _collect_minio_one(api_client, db: Session, cluster: Cluster, now: datetime) -> dict:
    """MinIO Operator + Tenant + DirectPV 수집 통합 경로.
    각 컴포넌트가 없으면 그냥 건너뜀 (warnings 에 기록)."""
    apps = k8s_client.AppsV1Api(api_client)
    custom = k8s_client.CustomObjectsApi(api_client)
    v1 = k8s_client.CoreV1Api(api_client)
    changed = 0
    warnings: list[str] = []
    summary: dict[str, Any] = {
        "operator": None,
        "tenants": [],
        "directpv": None,
    }

    # 1. MinIO Operator deployment — minio-operator 네임스페이스 일반적
    op_dep = None
    op_ns = None
    for ns_candidate in ("minio-operator", "minio", "default"):
        try:
            deps = apps.list_namespaced_deployment(
                ns_candidate,
                label_selector="name=minio-operator",
                _request_timeout=_K8S_TIMEOUT,
            )
            if deps.items:
                op_dep = deps.items[0]; op_ns = ns_candidate
                break
            # fallback — 라벨 없이 이름 매칭
            deps2 = apps.list_namespaced_deployment(
                ns_candidate,
                _request_timeout=_K8S_TIMEOUT,
            )
            for d in deps2.items:
                if d.metadata.name in ("minio-operator", "minio-operator-controller"):
                    op_dep = d; op_ns = ns_candidate; break
            if op_dep:
                break
        except ApiException as e:
            if e.status not in (404, 403):
                warnings.append(f"operator search ({ns_candidate}): HTTP {e.status}")
        except Exception as e:
            warnings.append(f"operator search ({ns_candidate}): {type(e).__name__}: {str(e)[:120]}")

    if op_dep:
        c = (op_dep.spec.template.spec.containers or [None])[0]
        op_data = {
            "namespace": op_ns,
            "name":      op_dep.metadata.name,
            "image":     c.image if c else None,
            "replicas":  op_dep.spec.replicas,
            "readyReplicas": op_dep.status.ready_replicas,
            "labels":    op_dep.metadata.labels or {},
            "args":      _parse_container_args(c) if c else {},
        }
        op_version = _image_tag(c.image) if c and c.image else None
        if _store_if_changed(db, cluster.id, "minio_operator", "storage",
                             op_version, op_data, now):
            changed += 1
        summary["operator"] = {"namespace": op_ns, "name": op_dep.metadata.name,
                               "image": c.image if c else None, "version": op_version}
    else:
        warnings.append("MinIO Operator 미설치 또는 미발견")

    # 2. MinIO Tenants (CR) — minio.min.io/v2 tenants
    try:
        # 클러스터 전체 검색 — operator 가 어떤 ns 에서든 tenant 를 만들 수 있음
        tenants = custom.list_cluster_custom_object(
            group="minio.min.io",
            version="v2",
            plural="tenants",
            _request_timeout=_K8S_TIMEOUT * 2,
        )
        items = tenants.get("items") or []
        for t in items:
            ts = _summarize_tenant(t)
            comp_key = f"minio_tenant:{ts['namespace']}/{ts['name']}"
            tag = _image_tag(ts["image"]) if ts.get("image") else None
            if _store_if_changed(db, cluster.id, comp_key, "storage",
                                 tag, ts, now):
                changed += 1
            summary["tenants"].append({
                "namespace":     ts["namespace"],
                "name":          ts["name"],
                "image":         ts["image"],
                "version":       tag,
                "totalServers":  ts["totalServers"],
                "totalDrives":   ts["totalDrives"],
                "drivesPerSet":  ts["drivesPerSet"],
                "ecParity":      ts["ecParity"],
                "ecDataShards":  ts["ecDataShards"],
                "currentState":  ts["currentState"],
                "healthStatus":  ts["healthStatus"],
                "drivesOnline":  ts["drivesOnline"],
                "drivesOffline": ts["drivesOffline"],
            })
    except ApiException as e:
        if e.status == 404:
            warnings.append("MinIO Tenant CRD 미설치 (minio.min.io/v2)")
        else:
            warnings.append(f"tenants 조회 실패 ({type(e).__name__}): HTTP {e.status}")
    except Exception as e:
        warnings.append(f"tenants 조회 실패 ({type(e).__name__}): {str(e)[:120]}")

    # 3. DirectPV — directpv.min.io/v1beta1 drives / nodes
    directpv_summary: dict[str, Any] = {}
    try:
        drives = custom.list_cluster_custom_object(
            group="directpv.min.io",
            version="v1beta1",
            plural="directpvdrives",
            _request_timeout=_K8S_TIMEOUT * 2,
        )
        d_items = drives.get("items") or []
        # 노드별 그룹
        by_node: dict[str, dict] = {}
        total_size = 0
        total_alloc = 0
        ready = 0
        for d in d_items:
            st = (d.get("status") or {})
            node = st.get("nodeName") or (d.get("metadata") or {}).get("labels", {}).get("directpv.min.io/node")
            size = int(st.get("totalCapacity") or 0)
            alloc = int(st.get("allocatedCapacity") or 0)
            cond_ok = str(st.get("status") or "").lower() == "ready"
            total_size += size
            total_alloc += alloc
            if cond_ok:
                ready += 1
            n = by_node.setdefault(node or "(unknown)", {
                "drives": 0, "ready": 0, "total": 0, "allocated": 0, "fsTypes": set(),
            })
            n["drives"] += 1
            if cond_ok:
                n["ready"] += 1
            n["total"]     += size
            n["allocated"] += alloc
            fs = st.get("filesystem")
            if fs:
                n["fsTypes"].add(fs)
        directpv_summary = {
            "totalDrives":      len(d_items),
            "readyDrives":      ready,
            "totalCapacity":    total_size,
            "allocatedCapacity": total_alloc,
            "nodeCount":        len(by_node),
            "nodes":            [
                {"node": k, "drives": v["drives"], "ready": v["ready"],
                 "total": v["total"], "allocated": v["allocated"],
                 "fsTypes": sorted(v["fsTypes"])}
                for k, v in sorted(by_node.items())
            ],
        }
        if _store_if_changed(db, cluster.id, "directpv_summary", "storage",
                             None, directpv_summary, now):
            changed += 1
        summary["directpv"] = {
            "totalDrives":  directpv_summary["totalDrives"],
            "readyDrives":  directpv_summary["readyDrives"],
            "totalCapacity": directpv_summary["totalCapacity"],
            "nodeCount":    directpv_summary["nodeCount"],
        }
    except ApiException as e:
        if e.status == 404:
            warnings.append("DirectPV CRD 미설치 (directpv.min.io/v1beta1)")
        else:
            warnings.append(f"directpv 조회 실패 ({type(e).__name__}): HTTP {e.status}")
    except Exception as e:
        warnings.append(f"directpv 조회 실패 ({type(e).__name__}): {str(e)[:120]}")

    # 4. (보너스) Tenant 별 워크로드 pod 수 — Tenant 가 발견됐으면
    for t in summary["tenants"]:
        ns = t["namespace"]; name = t["name"]
        try:
            pods = v1.list_namespaced_pod(
                ns,
                label_selector=f"v1.min.io/tenant={name}",
                limit=1,
                _request_timeout=_K8S_TIMEOUT,
            )
            # pod 가 있으면 image 도 한번 더 검증
            t["podsLabelMatch"] = bool(pods.items)
        except Exception:
            pass

    return {"changed": changed, "warnings": warnings, "summary": summary}


@router.post("/{cluster_id}/collect-minio")
def collect_minio(
    cluster_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """MinIO Operator + Tenant + DirectPV 정보를 수집해 storage 카테고리 스냅샷에 저장.

    스냅샷 컴포넌트:
    - `minio_operator`         — Operator deployment (image, replicas, args)
    - `minio_tenant:{ns}/{name}` — Tenant 별 (pools, drives, parity, EC, 상태)
    - `directpv_summary`       — DirectPV 클러스터 전체 (드라이브 수, 용량, 노드 수)

    각각 content-hash dedup → 변경 시점에만 history 누적.
    """
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    kc_path = _ensure_kubeconfig_file_for(cluster)
    if not kc_path or not os.path.exists(kc_path):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="kubeconfig가 없습니다. 먼저 kubeconfig를 등록하세요.",
        )

    try:
        api_client = k8s_config.new_client_from_config(config_file=kc_path)
        now = datetime.utcnow()
        result = _collect_minio_one(api_client, db, cluster, now)
        db.commit()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"MinIO 수집 실패 ({type(e).__name__}): {str(e)[:200]}",
        )

    return {
        "cluster_id": str(cluster_id),
        "changed": result["changed"],
        "warnings": result["warnings"],
        "summary": result["summary"],
        "collectedAt": now.isoformat(),
    }
