"""Playbook 실행 서비스 — DB 의 Playbook 행과 ``playbook_executor`` 를 잇는다.

라우터(``routers/playbooks.py``)의 수동 "실행" 버튼과 점검 매트릭스(``check_matrix_service``)의
자동(cron)/수동 셀 실행이 모두 이 모듈의 ``execute_playbook_run()`` 하나를 거친다 — 실행 로직이
두 곳에 중복되지 않게 하고, 어느 경로로 실행되든 예외 없이 ``PlaybookRun`` 이력에 남게 하기
위해서다(D-066 — 이전에는 ``Playbook.last_result`` 1행 덮어쓰기만 있어 실행할 때마다 이전
기록이 사라졌다).
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional

from kubernetes import client as k8s_client
from sqlalchemy.orm import Session

from app.models import Cluster, Playbook, PlaybookRun
from app.services.kubeconfig import ensure_kubeconfig_file
from app.services.playbook_executor import PlaybookResult, run_playbook
from app.services.k8s_client_pool import get_api_client_for_path

logger = logging.getLogger(__name__)


def cluster_node_hosts(cluster: Optional[Cluster]) -> list[str]:
    """클러스터의 모든 노드 InternalIP(없으면 노드명)를 반환.

    Playbook 실행 시 inventory 가 비어있으면 이 결과로 동적 inventory 가 생성된다.
    실패하면 빈 리스트를 반환(호출자가 fallback 로직을 결정).
    """
    if cluster is None:
        return []
    kc = ensure_kubeconfig_file(cluster)
    if not kc:
        return []
    try:
        api_client = get_api_client_for_path(kc)
        v1 = k8s_client.CoreV1Api(api_client)
        nodes = v1.list_node(_request_timeout=10)
    except Exception as e:  # noqa: BLE001
        logger.warning("failed to list nodes for cluster %s: %s", cluster.id, str(e)[:200])
        return []

    hosts: list[str] = []
    for n in nodes.items:
        internal_ip: Optional[str] = None
        for addr in (n.status.addresses or []):
            if addr.type == "InternalIP":
                internal_ip = addr.address
                break
        hosts.append(internal_ip or n.metadata.name)
    return hosts


def execute_playbook_run(
    db: Session,
    playbook: Playbook,
    *,
    trigger: str = "manual",
    triggered_by_user_id: Optional[str] = None,
    triggered_by_username: Optional[str] = None,
    ssh_username: Optional[str] = None,
    ssh_password: Optional[str] = None,
    ssh_port: Optional[int] = None,
    ssh_private_key: Optional[str] = None,
    become: Optional[bool] = None,
    become_password: Optional[str] = None,
) -> tuple[PlaybookRun, PlaybookResult]:
    """Playbook 1회 실행 — 결과를 ``PlaybookRun`` 이력으로 남기고 ``Playbook.last_result``
    (기존 UI ``PlaybookLogDialog`` 가 읽는 최신 스냅샷)도 함께 갱신한다.

    SSH 자격증명은 DB 에 저장하지 않는다(휘발성) — 요청 시에만 ``extra_vars`` 로 합쳐
    ``ansible-playbook -e`` 에 전달되고, 호출부가 값을 갖고 있는 동안만 메모리에 존재한다
    (CLAUDE.md UI-First 원칙 §3).
    """
    playbook.status = "running"
    db.commit()

    # 실행 시 inventory 우선순위:
    #   1) DB 관리형 Inventory  (playbook.inventory.content)
    #   2) inventory_path        (구 호환 — 실행 호스트의 ini 파일 경로)
    #   3) K8s 전체 노드          (위 둘 다 없을 때 cluster 의 노드 IP 로 동적 생성)
    pb_content = playbook.playbook_file.content if playbook.playbook_file else None
    inv_content = playbook.inventory.content if playbook.inventory else None
    inventory_hosts: Optional[list[str]] = None
    if not inv_content and not playbook.inventory_path:
        inventory_hosts = cluster_node_hosts(playbook.cluster) or None

    # SSH 자격증명을 extra_vars 로 머지 — playbook 의 hostvars 기본값을 덮는다.
    merged_vars: dict[str, Any] = dict(playbook.extra_vars or {})
    if ssh_username:
        merged_vars["ansible_user"] = ssh_username
    if ssh_password:
        merged_vars["ansible_ssh_pass"] = ssh_password
    if ssh_port:
        merged_vars["ansible_port"] = ssh_port
    if become is not None:
        merged_vars["ansible_become"] = bool(become)
    if become_password:
        merged_vars["ansible_become_pass"] = become_password

    started_at = datetime.utcnow()
    result = run_playbook(
        playbook_path=playbook.playbook_path,
        inventory_path=playbook.inventory_path,
        playbook_content=pb_content,
        inventory_content=inv_content,
        extra_vars=merged_vars or None,
        tags=playbook.tags,
        inventory_hosts=inventory_hosts,
        ssh_private_key=ssh_private_key,
    )
    finished_at = datetime.utcnow()

    # 기존 UI(PlaybookLogDialog)가 읽는 최신 스냅샷 — 하위 호환을 위해 계속 갱신한다.
    playbook.status = result.status
    playbook.last_run_at = finished_at
    playbook.last_result = {
        "message": result.message,
        "stats": result.stats,
        "duration_ms": result.duration_ms,
        "raw_output": result.raw_output[:5000] if result.raw_output else None,
    }

    run = PlaybookRun(
        playbook_id=playbook.id,
        status=result.status,
        trigger=trigger,
        triggered_by_user_id=triggered_by_user_id,
        triggered_by_username=triggered_by_username,
        message=(result.message or "")[:1000],
        stats=result.stats or None,
        raw_output=result.raw_output[:5000] if result.raw_output else None,
        duration_ms=result.duration_ms,
        started_at=started_at,
        finished_at=finished_at,
    )
    db.add(run)
    db.commit()
    db.refresh(playbook)
    db.refresh(run)
    return run, result
