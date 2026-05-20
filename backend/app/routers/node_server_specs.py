"""NodeServerSpec CRUD + 클러스터에서 자동 임포트 엔드포인트.

대장(ledger) 관점 자산 관리 — 등록/수정/삭제 + 노드 정보를 k8s API 로 일괄
끌어와 신규/upsert 한다.
"""
from typing import Optional
from uuid import UUID
import json

from fastapi import APIRouter, Depends, HTTPException, Query, status
from kubernetes import client as k8s_client, config as k8s_config
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Cluster, NodeServerSpec
from app.schemas.node_server_spec import (
    NodeServerSpecCreate,
    NodeServerSpecList,
    NodeServerSpecOut,
    NodeServerSpecUpdate,
    NodeSpecCsvApplyResponse,
    NodeSpecCsvDiff,
    NodeSpecCsvPreviewResponse,
    NodeSpecCsvUploadRequest,
    NodeSpecImportRequest,
    NodeSpecImportResult,
    NodeSpecHostFactsCollectRequest,
    NodeSpecHostFactsCollectResponse,
    NodeSpecHostFactsItem,
)
from app.services.kubeconfig import ensure_kubeconfig_file
from app.services.ssh_runner import SSHTarget, run_bulk

router = APIRouter(prefix="/node-specs", tags=["node-specs"])

_K8S_TIMEOUT = 10


# ── 헬퍼 ──────────────────────────────────────────────────────────────────────

def _to_out(spec: NodeServerSpec) -> NodeServerSpecOut:
    out = NodeServerSpecOut.model_validate(spec)
    if spec.cluster is not None:
        out.cluster_name = spec.cluster.name
    return out


# ── List / Get ────────────────────────────────────────────────────────────────

@router.get("", response_model=NodeServerSpecList)
def list_specs(
    cluster_id: Optional[UUID] = Query(default=None),
    status: Optional[str] = Query(default=None, description="active / spare / maintenance / decommission"),
    role: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None, description="hostname / serial / asset_tag / IP 부분일치"),
    db: Session = Depends(get_db),
):
    q = db.query(NodeServerSpec)
    if cluster_id is not None:
        q = q.filter(NodeServerSpec.cluster_id == cluster_id)
    if status:
        q = q.filter(NodeServerSpec.status == status)
    if role:
        q = q.filter(NodeServerSpec.role == role)
    if search:
        like = f"%{search.lower()}%"
        q = q.filter(
            (NodeServerSpec.hostname.ilike(like))
            | (NodeServerSpec.serial_number.ilike(like))
            | (NodeServerSpec.asset_tag.ilike(like))
            | (NodeServerSpec.internal_ip.ilike(like))
            | (NodeServerSpec.bmc_ip.ilike(like))
            | (NodeServerSpec.bond0_ip.ilike(like))
            | (NodeServerSpec.bond1_ip.ilike(like))
            | (NodeServerSpec.vendor.ilike(like))
            | (NodeServerSpec.model.ilike(like))
        )
    rows = q.order_by(NodeServerSpec.cluster_id.nulls_last(), NodeServerSpec.hostname).all()
    return NodeServerSpecList(data=[_to_out(r) for r in rows], total=len(rows))


@router.get("/{spec_id}", response_model=NodeServerSpecOut)
def get_spec(spec_id: UUID, db: Session = Depends(get_db)):
    spec = db.query(NodeServerSpec).filter(NodeServerSpec.id == spec_id).first()
    if not spec:
        raise HTTPException(status_code=404, detail="NodeServerSpec not found")
    return _to_out(spec)


# ── Create / Update / Delete ─────────────────────────────────────────────────

@router.post("", response_model=NodeServerSpecOut, status_code=status.HTTP_201_CREATED)
def create_spec(payload: NodeServerSpecCreate, db: Session = Depends(get_db)):
    if payload.cluster_id is not None:
        if not db.query(Cluster).filter(Cluster.id == payload.cluster_id).first():
            raise HTTPException(status_code=422, detail="Cluster not found")

    # unique (cluster_id, hostname) 검증
    existing = (
        db.query(NodeServerSpec)
        .filter(
            NodeServerSpec.cluster_id == payload.cluster_id,
            NodeServerSpec.hostname == payload.hostname,
        )
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"이미 존재하는 호스트: {payload.hostname} (cluster={payload.cluster_id})",
        )

    spec = NodeServerSpec(**payload.model_dump(exclude_none=True))
    db.add(spec)
    db.commit()
    db.refresh(spec)
    return _to_out(spec)


@router.put("/{spec_id}", response_model=NodeServerSpecOut)
def update_spec(spec_id: UUID, payload: NodeServerSpecUpdate, db: Session = Depends(get_db)):
    spec = db.query(NodeServerSpec).filter(NodeServerSpec.id == spec_id).first()
    if not spec:
        raise HTTPException(status_code=404, detail="NodeServerSpec not found")
    data = payload.model_dump(exclude_unset=True)
    if "cluster_id" in data and data["cluster_id"] is not None:
        if not db.query(Cluster).filter(Cluster.id == data["cluster_id"]).first():
            raise HTTPException(status_code=422, detail="Cluster not found")
    for k, v in data.items():
        setattr(spec, k, v)
    db.commit()
    db.refresh(spec)
    return _to_out(spec)


@router.delete("/{spec_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_spec(spec_id: UUID, db: Session = Depends(get_db)):
    spec = db.query(NodeServerSpec).filter(NodeServerSpec.id == spec_id).first()
    if not spec:
        raise HTTPException(status_code=404, detail="NodeServerSpec not found")
    db.delete(spec)
    db.commit()


# ── 클러스터 자동 임포트 ────────────────────────────────────────────────────

# 자동 수집 가능한 필드 (k8s API 만으로) — 이 키들은 import 시 항상 새 값으로 갱신.
_AUTOSYNC_FIELDS = {
    "node_name", "internal_ip", "external_ip",
    "cpu_cores", "cpu_threads", "memory_gb",
    "os_image", "kernel_version", "kubelet_version", "container_runtime",
    "role",
    "disk_type", "is_ssd",
    "is_vm", "bond0_ip", "bond0_mac", "bond1_ip", "bond1_mac",
}


# NFD (Node Feature Discovery) 가 노드에 붙이는 storage 라벨 prefix.
# 예: feature.node.kubernetes.io/storage-nonrotationaldisk-nvme0n1=true
_NFD_NONROTATIONAL_PREFIX = "feature.node.kubernetes.io/storage-nonrotationaldisk-"

# 관리자가 자주 쓰는 일반 디스크 종류 라벨 키.
_DISK_TYPE_LABEL_KEYS = (
    "disktype",
    "disk-type",
    "node.kubernetes.io/disk-type",
    "topology.kubernetes.io/disk-type",
)


def _detect_disk_info(labels: dict) -> tuple[Optional[str], Optional[bool]]:
    """노드 라벨에서 디스크 종류와 SSD 여부를 추정.

    1) NFD 라벨 (`feature.node.kubernetes.io/storage-nonrotationaldisk-<dev>=true`)
       을 우선 활용해 어떤 볼륨이 SSD/NVMe 인지 식별.
    2) 없으면 관리자 일반 라벨 (`disktype=ssd|nvme|hdd` 등) fallback.
    3) 둘 다 없으면 (None, None) — 자동수집 실패, 수기 입력 필요.

    반환: (disk_type 문자열, is_ssd 불리언)
      - disk_type 예: "NVMe (nvme0n1)" / "SSD (sda)" / "Mixed: NVMe (nvme0n1) + SSD (sda)" / "HDD"
    """
    nvme_devs: list[str] = []
    ssd_devs: list[str] = []

    for k, v in labels.items():
        if not isinstance(k, str):
            continue
        if k.startswith(_NFD_NONROTATIONAL_PREFIX) and str(v).lower() in ("true", "1"):
            dev = k[len(_NFD_NONROTATIONAL_PREFIX):].strip()
            if not dev:
                continue
            # nvme* 는 NVMe, 그 외(sda, sdb, vda …)는 SSD 로 분류.
            if dev.lower().startswith("nvme"):
                nvme_devs.append(dev)
            else:
                ssd_devs.append(dev)

    if nvme_devs or ssd_devs:
        parts: list[str] = []
        if nvme_devs:
            parts.append(f"NVMe ({', '.join(sorted(set(nvme_devs)))})")
        if ssd_devs:
            parts.append(f"SSD ({', '.join(sorted(set(ssd_devs)))})")
        return (" + ".join(parts), True)

    # Fallback: 관리자 라벨
    for key in _DISK_TYPE_LABEL_KEYS:
        raw = labels.get(key)
        if not raw:
            continue
        val = str(raw).strip().lower()
        if val in ("nvme", "nvmessd", "ssd-nvme"):
            return ("NVMe", True)
        if val in ("ssd", "sata-ssd", "sas-ssd"):
            return ("SSD", True)
        if val in ("hdd", "sas", "sata", "spinning"):
            return ("HDD", False)
        if val in ("hybrid", "mixed"):
            return ("Hybrid", None)

    return (None, None)


def _gi_to_gb(qty: str) -> Optional[int]:
    """k8s 자원 quantity → GB (정수). '64Gi' / '65536Mi' / '67108864Ki'."""
    if not qty:
        return None
    qty = qty.strip()
    try:
        if qty.endswith("Gi"):
            return int(float(qty[:-2]))
        if qty.endswith("Mi"):
            return int(float(qty[:-2]) / 1024)
        if qty.endswith("Ki"):
            return int(float(qty[:-2]) / 1024 / 1024)
        if qty.endswith("G"):
            return int(float(qty[:-1]) * 0.931)  # 1G = 0.931 GiB
        if qty.endswith("M"):
            return int(float(qty[:-1]) / 1024 * 0.931)
        return int(float(qty) / 1024 / 1024 / 1024)
    except (ValueError, IndexError):
        return None


def _node_role(labels: dict) -> Optional[str]:
    if any(k in labels for k in ("node-role.kubernetes.io/control-plane", "node-role.kubernetes.io/master")):
        return "control-plane"
    for k in labels:
        if k.startswith("node-role.kubernetes.io/"):
            r = k.split("/", 1)[1]
            if r:
                return r
    return "worker"


def _detect_vm(labels: dict) -> Optional[bool]:
    """노드 라벨에서 VM 여부를 추정."""
    vm_truthy = {"true", "1", "yes", "y"}
    vm_falsy = {"false", "0", "no", "n"}
    vm_keys = (
        "node.kubernetes.io/instance-type",
        "beta.kubernetes.io/instance-type",
        "feature.node.kubernetes.io/system-product_name",
    )
    for key in vm_keys:
        raw = labels.get(key)
        if raw is None:
            continue
        v = str(raw).strip().lower()
        if v in vm_truthy:
            return True
        if v in vm_falsy:
            return False
        if any(x in v for x in ("vm", "virtual", "kvm", "qemu", "openstack", "ec2", "gce", "azure", "hyper-v", "vsphere")):
            return True
    return None


def _bond_info_from_cluster_node_ips(
    cluster: Cluster,
    hostname: str,
    internal_ip: Optional[str] = None,
) -> dict[str, Optional[str]]:
    """Cluster.node_ips(collect-node-nics 결과)에서 bond0/bond1 IP/MAC 추출.

    매칭 전략 — 둘 중 하나라도 일치하면 해당 entry 채택:
      1) entry["name"] == hostname  (k8s 노드 이름 기준)
      2) internal_ip ∈ entry["ips"] OR entry["ip"] == internal_ip  (IP 기준)

    NIC 수집(/clusters/.../collect-node-nics) 이 k8s 자동수집보다 먼저 실행된
    클러스터는 entry["name"] 이 hostname 이 아니라 IP 로 박혀있을 수 있다
    (versions.py 의 name = name_by_ip.get(host, host) 폴백). 이 경우 hostname
    매칭만으로는 거의 모든 노드가 미매칭 → bond 정보가 전혀 안 채워졌음.
    """
    empty = {"bond0_ip": None, "bond0_mac": None, "bond1_ip": None, "bond1_mac": None}
    raw = cluster.node_ips
    if not raw:
        return dict(empty)
    try:
        nodes = json.loads(raw)
    except Exception:
        return dict(empty)
    if not isinstance(nodes, list):
        return dict(empty)

    target: Optional[dict] = None
    # 1차 — hostname 일치
    for n in nodes:
        if not isinstance(n, dict):
            continue
        if n.get("name") == hostname:
            target = n
            break
    # 2차 — IP 일치 (NIC 수집이 hostname 없이 IP 로 저장한 케이스 폴백)
    if target is None and internal_ip:
        for n in nodes:
            if not isinstance(n, dict):
                continue
            ips = n.get("ips")
            if isinstance(ips, list) and internal_ip in ips:
                target = n
                break
            if n.get("ip") == internal_ip:
                target = n
                break

    if not target:
        return dict(empty)
    ifaces = target.get("interfaces") or []
    if not isinstance(ifaces, list):
        return dict(empty)
    out = dict(empty)
    for ifc in ifaces:
        if not isinstance(ifc, dict):
            continue
        name = str(ifc.get("name") or "").lower()
        ips = ifc.get("ips") or []
        if name == "bond0":
            out["bond0_ip"] = ips[0] if isinstance(ips, list) and ips else None
            out["bond0_mac"] = ifc.get("mac")
        elif name == "bond1":
            out["bond1_ip"] = ips[0] if isinstance(ips, list) and ips else None
            out["bond1_mac"] = ifc.get("mac")
    return out


def _parse_host_fact_stdout(stdout: str) -> dict:
    """SSH 수집 결과 파싱."""
    parts = stdout.split("\n__NODE_SPEC_SPLIT__\n")
    if len(parts) != 3:
        raise ValueError("수집 출력 파싱 실패")
    ip_raw, lsblk_raw, vm_raw = parts
    ip_data = json.loads(ip_raw.strip() or "[]")
    lsblk_data = json.loads(lsblk_raw.strip() or "{}")
    vm_type = (vm_raw or "").strip().lower()

    out = {
        "bond0_ip": None, "bond0_mac": None, "bond1_ip": None, "bond1_mac": None,
        "disk_count": 0, "disk_total_gb": 0, "non_os_disk_gb": 0, "disk_type": None, "is_ssd": None, "is_vm": None,
    }
    for ifc in ip_data if isinstance(ip_data, list) else []:
        name = str(ifc.get("ifname") or "").lower()
        if name not in ("bond0", "bond1"):
            continue
        addr_info = ifc.get("addr_info") or []
        ipv4s = [a.get("local") for a in addr_info if isinstance(a, dict) and a.get("family") == "inet" and a.get("local")]
        if name == "bond0":
            out["bond0_ip"] = ipv4s[0] if ipv4s else None
            out["bond0_mac"] = ifc.get("address")
        elif name == "bond1":
            out["bond1_ip"] = ipv4s[0] if ipv4s else None
            out["bond1_mac"] = ifc.get("address")

    disks = (lsblk_data or {}).get("blockdevices") or []
    types: set[str] = set()
    ssd_flag: Optional[bool] = None
    for d in disks:
        if not isinstance(d, dict):
            continue
        typ = str(d.get("type") or "")
        name = str(d.get("name") or "")
        if typ != "disk" or not name:
            continue
        size_b = int(d.get("size") or 0)
        tran = str(d.get("tran") or "").lower()
        mountpoint = str(d.get("mountpoint") or "")
        model = str(d.get("model") or "").strip()
        rota = str(d.get("rota") or "")
        if mountpoint == "/":
            out["disk_total_gb"] += round(size_b / (1024 ** 3))
            continue
        out["disk_count"] += 1
        gb = round(size_b / (1024 ** 3))
        out["disk_total_gb"] += gb
        out["non_os_disk_gb"] += gb
        if tran == "nvme":
            types.add(f"NVMe ({name})")
            ssd_flag = True
        elif tran in ("sata", "sas"):
            if rota == "0":
                types.add(f"SSD ({name})")
                ssd_flag = True if ssd_flag is None else ssd_flag
            elif rota == "1":
                types.add(f"HDD ({name})")
                if ssd_flag is None:
                    ssd_flag = False
        else:
            types.add(f"{(tran or 'unknown').upper()} ({name}{', ' + model if model else ''})")
    out["disk_type"] = " + ".join(sorted(types)) if types else None
    out["is_ssd"] = ssd_flag
    if vm_type and vm_type not in ("none", "no", "n/a"):
        out["is_vm"] = True
    elif vm_type == "none":
        out["is_vm"] = False
    return out


@router.post("/import/{cluster_id}", response_model=NodeSpecImportResult)
def import_from_cluster(
    cluster_id: UUID,
    payload: NodeSpecImportRequest = NodeSpecImportRequest(),
    db: Session = Depends(get_db),
):
    """k8s API 로 노드 메타데이터를 끌어와 NodeServerSpec 에 upsert.

    수집 필드: hostname, node_name, internal_ip, external_ip, role, cpu_cores,
    cpu_threads (k8s 노드는 logical CPU 개수만 노출), memory_gb, os_image,
    kernel_version, kubelet_version, container_runtime.
    벤더/모델/시리얼/랙위치/자산태그 등은 덮어쓰지 않음 (overwrite_user_fields=True 시는 예외).
    """
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")

    kc_path = ensure_kubeconfig_file(cluster)
    if not kc_path:
        raise HTTPException(status_code=422, detail="kubeconfig 가 등록돼 있지 않습니다.")

    try:
        api_client = k8s_config.new_client_from_config(config_file=kc_path)
        v1 = k8s_client.CoreV1Api(api_client)
        nodes = v1.list_node(_request_timeout=_K8S_TIMEOUT)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"k8s 노드 조회 실패: {str(e)[:200]}")

    inserted = 0
    updated_n = 0
    skipped = 0
    errors: list[str] = []
    out_items: list[NodeServerSpec] = []

    for n in nodes.items:
        try:
            host = n.metadata.name
            labels = n.metadata.labels or {}
            ni = n.status.node_info
            cap = (n.status.capacity or {}) if n.status else {}
            alloc = (n.status.allocatable or {}) if n.status else {}

            internal_ip = None
            external_ip = None
            for addr in (n.status.addresses or []) if n.status else []:
                if addr.type == "InternalIP" and not internal_ip:
                    internal_ip = addr.address
                elif addr.type == "ExternalIP" and not external_ip:
                    external_ip = addr.address

            cpu_threads = None
            try:
                cpu_threads = int(cap.get("cpu") or alloc.get("cpu") or 0) or None
            except (ValueError, TypeError):
                cpu_threads = None
            memory_gb = _gi_to_gb(cap.get("memory") or alloc.get("memory") or "")

            disk_type, is_ssd_detected = _detect_disk_info(labels)
            vm_detected = _detect_vm(labels)
            # internal_ip 까지 같이 넘겨서 hostname 매핑이 깨진 클러스터(NIC 수집을
            # k8s 자동수집보다 먼저 실행한 케이스)에서도 IP 기준 폴백 매칭이 동작.
            bond_info = _bond_info_from_cluster_node_ips(cluster, host, internal_ip)

            collected = {
                "node_name": host,
                "internal_ip": internal_ip,
                "external_ip": external_ip,
                "role": _node_role(labels),
                "cpu_cores": cpu_threads,    # k8s 는 thread 단위. 사용자가 sockets/cores 별도 입력 가능.
                "cpu_threads": cpu_threads,
                "memory_gb": memory_gb,
                "os_image": getattr(ni, "os_image", None),
                "kernel_version": getattr(ni, "kernel_version", None),
                "kubelet_version": getattr(ni, "kubelet_version", None),
                "container_runtime": getattr(ni, "container_runtime_version", None),
                "disk_type": disk_type,
                "is_ssd": is_ssd_detected,
                "is_vm": vm_detected,
                "bond0_ip": bond_info.get("bond0_ip"),
                "bond0_mac": bond_info.get("bond0_mac"),
                "bond1_ip": bond_info.get("bond1_ip"),
                "bond1_mac": bond_info.get("bond1_mac"),
            }
            collected = {k: v for k, v in collected.items() if v is not None and v != ""}

            existing = (
                db.query(NodeServerSpec)
                .filter(NodeServerSpec.cluster_id == cluster_id, NodeServerSpec.hostname == host)
                .first()
            )

            if existing is None:
                spec = NodeServerSpec(
                    cluster_id=cluster_id,
                    hostname=host,
                    status="active",
                    **collected,
                )
                db.add(spec)
                db.flush()
                out_items.append(spec)
                inserted += 1
            elif payload.upsert:
                changed = False
                for k, v in collected.items():
                    if payload.overwrite_user_fields or k in _AUTOSYNC_FIELDS:
                        if getattr(existing, k) != v:
                            setattr(existing, k, v)
                            changed = True
                if changed:
                    out_items.append(existing)
                    updated_n += 1
                else:
                    skipped += 1
            else:
                skipped += 1
        except Exception as e:
            errors.append(f"{n.metadata.name if n.metadata else '?'}: {str(e)[:160]}")

    if inserted or updated_n:
        db.commit()
        for s in out_items:
            db.refresh(s)

    return NodeSpecImportResult(
        inserted=inserted,
        updated=updated_n,
        skipped=skipped,
        errors=errors,
        items=[_to_out(s) for s in out_items],
    )


@router.post("/collect-host-facts/{cluster_id}", response_model=NodeSpecHostFactsCollectResponse)
async def collect_host_facts(
    cluster_id: UUID,
    payload: NodeSpecHostFactsCollectRequest,
    db: Session = Depends(get_db),
):
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")
    if not payload.password and not payload.private_key:
        raise HTTPException(status_code=422, detail="password 또는 private_key 중 하나는 필수입니다.")

    sudo = "sudo -n " if payload.use_sudo else ""
    # k8s 워커는 pod 마다 veth*, calico cali*, cilium_*, kube-ipvs0, flannel.1 등으로
    # ip -j addr show JSON 이 수십 KB 이상까지 커진다. 다음 두 출력(lsblk / systemd-
    # detect-virt) 와 함께 합치면 _exec_ssh 의 stdout truncation 에 걸려 split marker
    # 까지 잘려나갈 수 있다 → "수집 출력 파싱 실패". 원격에서 jq 로 사전 필터링하여
    # bond/eth/en*/em* 만 보내고, max_stdout_chars 도 충분히 늘림. jq 미설치 노드는
    # raw 그대로 흘리되, _parse_host_fact_stdout 가 큰 raw 도 받을 수 있도록 buffer 확보.
    iface_regex = "^(bond[0-9]+|eth[0-9]+|en[oxsp][^.]*|em[0-9]+)$"
    ip_cmd = (
        f"out=$({sudo}ip -j addr show 2>&1); "
        f"printf '%s' \"$out\" | "
        f"jq -c '[.[] | select(.ifname | test(\"{iface_regex}\"))]' 2>/dev/null "
        f"|| printf '%s' \"$out\""
    )
    command = (
        f"{ip_cmd}; "
        "echo; echo __NODE_SPEC_SPLIT__; "
        f"{sudo}lsblk -b -J -o NAME,TYPE,MODEL,SIZE,TRAN,ROTA,MOUNTPOINT 2>/dev/null; "
        "echo __NODE_SPEC_SPLIT__; "
        f"{sudo}systemd-detect-virt 2>/dev/null || echo none"
    )
    targets = [SSHTarget(host=h, port=payload.port, username=payload.username, password=payload.password, private_key=payload.private_key) for h in payload.hosts]
    results = await run_bulk(
        targets,
        action="ssh",
        command=command,
        mode="parallel",
        connect_timeout=payload.connect_timeout,
        exec_timeout=payload.exec_timeout,
        parallelism=payload.parallelism,
        chunk_size=payload.chunk_size,
        chunk_pause_ms=payload.chunk_pause_ms,
        max_stdout_chars=2_000_000,
    )
    inserted = updated = skipped = 0
    errors: list[str] = []
    items: list[NodeSpecHostFactsItem] = []
    for r in results:
        if r.status != "ok":
            msg = r.error or r.stderr or r.status
            errors.append(f"{r.host}: {msg}")
            items.append(NodeSpecHostFactsItem(host=r.host, status="error", message=msg))
            continue
        try:
            facts = _parse_host_fact_stdout(r.stdout)
        except Exception as e:
            errors.append(f"{r.host}: {str(e)[:160]}")
            items.append(NodeSpecHostFactsItem(host=r.host, status="error", message=str(e)[:160]))
            continue
        existing = db.query(NodeServerSpec).filter(NodeServerSpec.cluster_id == cluster_id, NodeServerSpec.hostname == r.host).first()
        if not existing and payload.upsert:
            existing = NodeServerSpec(cluster_id=cluster_id, hostname=r.host, status="active")
            db.add(existing)
            db.flush()
            inserted += 1
        if not existing:
            skipped += 1
            items.append(NodeSpecHostFactsItem(host=r.host, status="skipped", message="hostname 미등록(upsert=false)"))
            continue
        for k in ("bond0_ip", "bond0_mac", "bond1_ip", "bond1_mac", "disk_count", "disk_total_gb", "non_os_disk_gb", "disk_type", "is_ssd", "is_vm"):
            setattr(existing, k, facts.get(k))
        updated += 1
        items.append(NodeSpecHostFactsItem(host=r.host, status="updated", spec_id=existing.id, hostname=existing.hostname, **facts))
    if inserted or updated:
        db.commit()
    return NodeSpecHostFactsCollectResponse(cluster_id=cluster_id, updated=updated, inserted=inserted, skipped=skipped, errors=errors, items=items)


# ── CSV 업로드 (dry-run diff + apply) ──────────────────────────────────────

_CSV_SKIP_KEYS_ON_APPLY = {"hostname"}  # unique key — update 시 건너뜀


def _coerce_empty_to_none(v):
    """빈 문자열을 None 으로 정규화. bool/int 등 비문자열은 그대로."""
    if isinstance(v, str) and v.strip() == "":
        return None
    return v


def _compute_diffs(
    payload: NodeSpecCsvUploadRequest,
    db: Session,
) -> tuple[list[NodeSpecCsvDiff], list[tuple[NodeSpecCsvDiff, dict, Optional[NodeServerSpec]]]]:
    """업로드 요청을 받아 행별 diff 를 계산.

    반환:
      - diffs: 응답용 요약 diff 목록
      - actions: (diff, clean_payload_dict, existing_or_None) — apply 시 사용
    """
    diffs: list[NodeSpecCsvDiff] = []
    actions: list[tuple[NodeSpecCsvDiff, dict, Optional[NodeServerSpec]]] = []

    # 클러스터 캐시 (행마다 재조회 방지)
    cluster_cache: dict = {}

    for idx, row in enumerate(payload.rows):
        diff = NodeSpecCsvDiff(row_index=idx, hostname=row.hostname, action="skip")
        row_dict = row.model_dump(exclude_unset=False)
        # 빈 문자열 → None 정규화
        row_dict = {k: _coerce_empty_to_none(v) for k, v in row_dict.items()}

        # cluster_id 유효성
        cid = row_dict.get("cluster_id")
        if cid is not None:
            if cid not in cluster_cache:
                cluster_cache[cid] = db.query(Cluster).filter(Cluster.id == cid).first()
            if cluster_cache[cid] is None:
                diff.action = "error"
                diff.error = f"존재하지 않는 cluster_id: {cid}"
                diffs.append(diff)
                actions.append((diff, row_dict, None))
                continue

        # 기존 매칭
        q = db.query(NodeServerSpec).filter(NodeServerSpec.hostname == row.hostname)
        if payload.match_cluster_scope:
            q = q.filter(NodeServerSpec.cluster_id == cid)
        existing = q.first()

        if existing is None:
            diff.action = "insert"
            # 신규는 전부 추가로 본다 — changes 에 new 값만 표시
            for k, v in row_dict.items():
                if v is None or v == "":
                    continue
                diff.changes[k] = {"old": None, "new": v}
        else:
            diff.existing_id = existing.id
            changed = False
            for k, v in row_dict.items():
                if k in _CSV_SKIP_KEYS_ON_APPLY:
                    continue
                old = getattr(existing, k, None)
                # date 객체 비교를 위해 문자열로 변환
                old_cmp = old.isoformat() if hasattr(old, "isoformat") else old
                new_cmp = v.isoformat() if hasattr(v, "isoformat") else v
                if payload.ignore_empty_on_update and (v is None or v == ""):
                    continue
                if old_cmp != new_cmp:
                    changed = True
                    diff.changes[k] = {"old": old_cmp, "new": new_cmp}
            diff.action = "update" if changed else "skip"

        diffs.append(diff)
        actions.append((diff, row_dict, existing))

    return diffs, actions


@router.post("/csv/preview", response_model=NodeSpecCsvPreviewResponse)
def csv_preview(payload: NodeSpecCsvUploadRequest, db: Session = Depends(get_db)):
    """CSV 업로드 dry-run — 어떤 행이 insert/update 될지 diff 만 돌려준다."""
    # dry_run 은 preview 엔드포인트 자체가 읽기전용이므로 강제
    payload.dry_run = True
    diffs, _ = _compute_diffs(payload, db)
    return NodeSpecCsvPreviewResponse(
        dry_run=True,
        insert_count=sum(1 for d in diffs if d.action == "insert"),
        update_count=sum(1 for d in diffs if d.action == "update"),
        skip_count=sum(1 for d in diffs if d.action == "skip"),
        error_count=sum(1 for d in diffs if d.action == "error"),
        diffs=diffs,
    )


@router.post("/csv/apply", response_model=NodeSpecCsvApplyResponse)
def csv_apply(payload: NodeSpecCsvUploadRequest, db: Session = Depends(get_db)):
    """CSV 업로드 실제 반영 — preview 와 동일한 로직으로 insert/update."""
    payload.dry_run = False
    diffs, actions = _compute_diffs(payload, db)

    inserted = 0
    updated = 0
    skipped = 0
    errors: list[str] = []
    applied: list[NodeServerSpec] = []

    for diff, row_dict, existing in actions:
        try:
            if diff.action == "error":
                errors.append(f"행 {diff.row_index} ({diff.hostname}): {diff.error}")
                continue
            if diff.action == "skip":
                skipped += 1
                continue
            if diff.action == "insert":
                clean = {k: v for k, v in row_dict.items() if v is not None and v != ""}
                spec = NodeServerSpec(**clean)
                db.add(spec)
                db.flush()
                applied.append(spec)
                inserted += 1
            elif diff.action == "update" and existing is not None:
                for k, chg in diff.changes.items():
                    if k in _CSV_SKIP_KEYS_ON_APPLY:
                        continue
                    # row_dict 에서 원본 값(타입 보존) 가져오기
                    setattr(existing, k, row_dict.get(k))
                applied.append(existing)
                updated += 1
        except Exception as e:
            errors.append(f"행 {diff.row_index} ({diff.hostname}): {str(e)[:160]}")

    if inserted or updated:
        db.commit()
        for s in applied:
            db.refresh(s)

    return NodeSpecCsvApplyResponse(
        inserted=inserted,
        updated=updated,
        skipped=skipped,
        errors=errors,
        items=[_to_out(s) for s in applied],
    )
