"""Helm 릴리스 뷰어 (읽기 전용).

`helm` 바이너리를 클러스터 kubeconfig 로 실행해 릴리스/히스토리/values 를 조회한다.
install/upgrade/rollback 같은 쓰기 동작은 이 스코프에 포함하지 않는다(추후 require_operator
+ 감사 로그로 확장 가능). helm 미설치 시 503 으로 graceful degrade.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Cluster
from app.services.kubeconfig import ensure_kubeconfig_file

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/k8s", tags=["k8s-helm"])

_HELM_TIMEOUT = 30


def _require_cluster(cluster_id: UUID, db: Session) -> Cluster:
    c = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if c is None:
        raise HTTPException(status_code=404, detail="Cluster not found")
    return c


def _kubeconfig_or_422(cluster: Cluster) -> str:
    kc = ensure_kubeconfig_file(cluster)
    if not kc or not os.path.exists(kc):
        raise HTTPException(status_code=422, detail="kubeconfig 가 등록되지 않은 클러스터입니다.")
    return kc


def _run_helm(args: list[str], kubeconfig: str) -> tuple[int, str, str]:
    helm_bin = shutil.which("helm")
    if not helm_bin:
        raise HTTPException(status_code=503, detail="helm 바이너리가 설치되어 있지 않습니다(백엔드 이미지).")
    cmd = [helm_bin, *args, "--kubeconfig", kubeconfig]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=_HELM_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="helm 명령이 시간 초과되었습니다.")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"helm 실행 실패: {str(e)[:200]}")
    return proc.returncode, proc.stdout, proc.stderr


def _parse_json(stdout: str):
    try:
        return json.loads(stdout) if stdout.strip() else []
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"helm 출력 파싱 실패: {str(e)[:200]}")


@router.get("/{cluster_id}/helm/releases")
def list_helm_releases(cluster_id: UUID, namespace: str | None = None, db: Session = Depends(get_db)):
    """모든(또는 특정 네임스페이스) Helm 릴리스 목록."""
    cluster = _require_cluster(cluster_id, db)
    kc = _kubeconfig_or_422(cluster)
    args = ["list", "-o", "json"]
    if namespace:
        args += ["-n", namespace]
    else:
        args += ["-A"]
    rc, out, err = _run_helm(args, kc)
    if rc != 0:
        raise HTTPException(status_code=502, detail=f"helm list 실패: {err[:200]}")
    data = _parse_json(out)
    items = [
        {
            "name": r.get("name"),
            "namespace": r.get("namespace"),
            "revision": r.get("revision"),
            "status": r.get("status"),
            "chart": r.get("chart"),
            "appVersion": r.get("app_version"),
            "updated": r.get("updated"),
        }
        for r in (data or [])
    ]
    return {"count": len(items), "items": items}


@router.get("/{cluster_id}/helm/releases/{namespace}/{name}/history")
def helm_release_history(cluster_id: UUID, namespace: str, name: str, db: Session = Depends(get_db)):
    """릴리스 리비전 히스토리."""
    cluster = _require_cluster(cluster_id, db)
    kc = _kubeconfig_or_422(cluster)
    rc, out, err = _run_helm(["history", name, "-n", namespace, "-o", "json"], kc)
    if rc != 0:
        raise HTTPException(status_code=502, detail=f"helm history 실패: {err[:200]}")
    data = _parse_json(out)
    items = [
        {
            "revision": r.get("revision"),
            "status": r.get("status"),
            "chart": r.get("chart"),
            "appVersion": r.get("app_version"),
            "updated": r.get("updated"),
            "description": r.get("description"),
        }
        for r in (data or [])
    ]
    return {"count": len(items), "items": items}


@router.get("/{cluster_id}/helm/releases/{namespace}/{name}/values")
def helm_release_values(cluster_id: UUID, namespace: str, name: str, db: Session = Depends(get_db)):
    """릴리스의 사용자 지정 values (YAML)."""
    cluster = _require_cluster(cluster_id, db)
    kc = _kubeconfig_or_422(cluster)
    rc, out, err = _run_helm(["get", "values", name, "-n", namespace, "-o", "yaml"], kc)
    if rc != 0:
        raise HTTPException(status_code=502, detail=f"helm get values 실패: {err[:200]}")
    return {"name": name, "namespace": namespace, "yaml": out}
