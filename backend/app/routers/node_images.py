import re
import time
from datetime import datetime
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.cluster import Cluster
from app.models.user import User
from app.auth.deps import require_operator
from app.schemas.node_image_distribute import (
    NodeImageDistributeRequest,
    NodeImageDistributeResponse,
    DistributeResultItem,
)
from app.services import audit_logger
from app.services.k8s_node_image_service import NodeImageService
from app.services.kubeconfig import ensure_kubeconfig_file
from app.services.snapshot_jobs import SnapshotManager
from app.services.ssh_runner import SSHTarget, run_bulk

router = APIRouter(prefix="/clusters/{cluster_id}/node-images", tags=["node-images"])

# 노드 이미지 수집(거대 응답)을 백그라운드로 수행 → 요청 비블로킹(ingress 60s 타임아웃과 분리).
_mgr = SnapshotManager(ttl=60.0)


@router.get("")
def get_node_images(cluster_id: UUID, db: Session = Depends(get_db)):
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")

    # 백그라운드 스레드의 detached 인스턴스 접근을 피하려 요청 스레드에서 kubeconfig 구체화.
    try:
        ensure_kubeconfig_file(cluster)
    except Exception:  # noqa: BLE001
        pass

    view = _mgr.get(
        f"{cluster_id}:node-images",
        lambda prog: NodeImageService(cluster).list_node_images(prog),
    )
    data = view["data"]
    if data is None:
        if view["status"] == "error":
            raise HTTPException(status_code=502, detail=f"노드 이미지 수집 실패: {view['error']}")
        data = []
    return {
        "data": data,
        "status": view["status"],         # computing | ready | error
        "progress": view["progress"],     # 0..1 또는 null
        "processed": view["processed"],
        "total": view["total"],
        "stale": view["stale"],
    }


# ── CSV export ───────────────────────────────────────────────────────────────

def _csv_cell(v) -> str:
    """CSV 셀 이스케이프."""
    if v is None:
        return ""
    s = str(v)
    if any(c in s for c in (',', '"', '\n', '\r')):
        return '"' + s.replace('"', '""') + '"'
    return s


def _human_size(n: int) -> str:
    size = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.1f}{unit}" if unit != "B" else f"{int(size)}{unit}"
        size /= 1024
    return f"{size:.1f}TB"


@router.get("/export.csv")
def export_node_images_csv(
    cluster_id: UUID,
    sort: str = Query(
        "default", regex="^(default|size|lines)$",
        description="default=노드 순서, size=이미지 용량(bytes) 내림차순, lines=노드당 이미지 개수(라인 수) 내림차순",
    ),
    db: Session = Depends(get_db),
):
    """가장 최근에 수집된(캐시된) 노드 이미지 스냅샷을 CSV 로 내보낸다.

    한 행 = 노드 1개의 이미지 1개. sort 로 행 정렬 기준을 바꾼다.
    아직 수집 중이거나(캐시 없음) 실패했으면 409 로 알려 — 상세 화면에서 먼저 로드를 기다리게 한다.
    """
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    try:
        ensure_kubeconfig_file(cluster)
    except Exception:  # noqa: BLE001
        pass

    # 이미 수집된 캐시가 있으면 그대로 사용 — 없으면(최초 진입) 여기서 트리거되지만
    # export 요청이 먼저 도착한 경우 아직 준비되지 않았을 수 있다.
    view = _mgr.get(
        f"{cluster_id}:node-images",
        lambda prog: NodeImageService(cluster).list_node_images(prog),
    )
    nodes = view["data"]
    if nodes is None:
        if view["status"] == "error":
            raise HTTPException(status_code=502, detail=f"노드 이미지 수집 실패: {view['error']}")
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="노드 이미지를 아직 수집 중입니다. 화면에서 로드가 끝난 뒤 다시 시도하세요.",
        )

    # sort='lines' 일 때 쓸 노드 순서 (image_count 내림차순).
    node_order = {n["node"]: i for i, n in enumerate(
        sorted(nodes, key=lambda n: n.get("image_count", 0), reverse=True)
    )}

    cols = ["node", "role", "status", "image_names", "size_bytes", "size_human"]
    rows: list[dict] = []
    for n in nodes:
        for img in n.get("images", []):
            rows.append({
                "node": n["node"],
                "role": n.get("role", ""),
                "status": n.get("status", ""),
                "image_names": "; ".join(img.get("names") or []),
                "size_bytes": img.get("size_bytes", 0),
                "size_human": _human_size(img.get("size_bytes", 0)),
                "_node_order": node_order.get(n["node"], 0),
            })

    if sort == "size":
        rows.sort(key=lambda r: r["size_bytes"], reverse=True)
    elif sort == "lines":
        # 노드 순서(이미지 많은 노드 먼저) → 노드 내부는 이미 용량 내림차순(서비스에서 정렬됨).
        rows.sort(key=lambda r: r["_node_order"])

    out_lines = [",".join(cols)]
    for r in rows:
        out_lines.append(",".join(_csv_cell(r.get(c)) for c in cols))

    csv_text = "\n".join(out_lines) + "\n"
    body = "﻿" + csv_text  # 엑셀 한글 호환 UTF-8 BOM
    fname = f"node-images-{cluster.name}-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}.csv"
    # 응답 헤더는 latin-1 로 인코딩되므로 클러스터명에 한글 등 non-ASCII 가 있으면 raw filename 사용 시 500 발생.
    # ASCII-only fallback(filename) + RFC 5987 인코딩(filename*)을 함께 제공.
    ascii_fname = re.sub(r'[^\x20-\x7e]', '_', fname).replace('"', "'")
    headers = {
        "Content-Disposition": (
            f'attachment; filename="{ascii_fname}"; '
            f"filename*=UTF-8''{quote(fname, safe='')}"
        ),
    }
    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers=headers,
    )


# ── 이미지 배포 (prepull) ──────────────────────────────────────────────────────

# 이미지 참조에 허용할 문자만 통과 (레지스트리 host[:port]/path/name:tag@sha256:...).
# shell 명령에 그대로 삽입되므로 메타문자(따옴표/세미콜론/$/백틱/공백 등)를 절대 허용하지 않는다.
_IMAGE_REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@=+-]*$")
_NAMESPACE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _build_pull_command(image: str, runtime: str, namespace: str, use_sudo: bool) -> str:
    """대상 노드에서 이미지를 pull 하는 shell 명령을 생성.

    image/namespace 는 호출 전에 정규식으로 검증되므로 shell 메타문자가 없다.
    안전을 위해 추가로 작은따옴표로 감싼다 (검증에서 작은따옴표는 이미 배제됨).
    """
    sudo = "sudo " if use_sudo else ""
    img = f"'{image}'"
    ns = f"'{namespace}'"
    crictl = f"{sudo}crictl pull {img}"
    nerdctl = f"{sudo}nerdctl -n {ns} pull {img}"
    ctr = f"{sudo}ctr -n {ns} images pull {img}"

    if runtime == "crictl":
        return crictl
    if runtime == "nerdctl":
        return nerdctl
    if runtime == "ctr":
        return ctr
    # auto — 노드에 존재하는 런타임 CLI 를 우선순위대로 감지해 사용.
    return (
        f"if command -v crictl >/dev/null 2>&1; then {crictl}; "
        f"elif command -v nerdctl >/dev/null 2>&1; then {nerdctl}; "
        f"elif command -v ctr >/dev/null 2>&1; then {ctr}; "
        f"else echo 'no container runtime CLI (crictl/nerdctl/ctr) found on PATH' >&2; exit 127; fi"
    )


@router.post("/distribute", response_model=NodeImageDistributeResponse)
async def distribute_node_image(
    cluster_id: UUID,
    payload: NodeImageDistributeRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """선택한 이미지를 대상 노드(동일/타 클러스터)로 배포(prepull).

    각 대상 노드에 SSH 로 접속해 컨테이너 런타임 CLI 로 이미지를 레지스트리에서 pull 한다.
    인증 정보는 요청에만 존재하고 저장되지 않는다. cluster_id 는 이미지를 선택한 출처
    클러스터(감사/문맥용)이며, 실제 배포 대상은 payload.targets 가 결정한다.
    """
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=404, detail="Cluster not found")

    image = (payload.image or "").strip()
    if not _IMAGE_REF_RE.match(image):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="이미지 참조 형식이 올바르지 않습니다 (허용 문자: 영숫자 . _ - / : @ = +).",
        )
    if not _NAMESPACE_RE.match(payload.namespace or ""):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="namespace 형식이 올바르지 않습니다.",
        )
    if not payload.password and not payload.private_key:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="password 또는 private_key 중 하나는 필수입니다.",
        )

    command = _build_pull_command(image, payload.runtime, payload.namespace, payload.sudo)

    audit_logger.record(
        db,
        action="node_image.distribute",
        actor=actor,
        status="success",
        target_type="node_image",
        target_id=str(cluster_id),
        details={
            "image": image,
            "source_cluster": cluster.name,
            "runtime": payload.runtime,
            "target_count": len(payload.targets or []),
        },
        request=request,
    )

    targets = [
        SSHTarget(
            host=t.host,
            port=payload.port,
            username=payload.username,
            password=payload.password,
            private_key=payload.private_key,
            name=t.name,
            cluster_id=str(t.cluster_id) if t.cluster_id else None,
            cluster_name=t.cluster_name,
        )
        for t in payload.targets
    ]

    start = time.monotonic()
    results = await run_bulk(
        targets,
        action="ssh",
        command=command,
        mode=payload.mode,
        connect_timeout=payload.connect_timeout,
        exec_timeout=payload.exec_timeout,
        parallelism=payload.parallelism,
        chunk_size=payload.chunk_size,
        chunk_pause_ms=payload.chunk_pause_ms,
    )
    total_elapsed = int((time.monotonic() - start) * 1000)

    items = [DistributeResultItem(**r.to_dict()) for r in results]
    ok = sum(1 for r in results if r.status == "ok")
    err = len(results) - ok

    return NodeImageDistributeResponse(
        image=image,
        command=command,
        mode=payload.mode,
        total=len(results),
        ok_count=ok,
        error_count=err,
        total_duration_ms=total_elapsed,
        results=items,
    )
