"""Playbook 실행 서비스 — DB 의 Playbook 행과 ``playbook_executor`` 를 잇는다.

라우터(``routers/playbooks.py``)의 수동 "실행" 버튼과 점검 매트릭스(``check_matrix_service``)의
자동(cron)/수동 셀 실행이 모두 이 모듈의 ``execute_playbook_run()`` 하나를 거친다 — 실행 로직이
두 곳에 중복되지 않게 하고, 어느 경로로 실행되든 예외 없이 ``PlaybookRun`` 이력에 남게 하기
위해서다(D-066 — 이전에는 ``Playbook.last_result`` 1행 덮어쓰기만 있어 실행할 때마다 이전
기록이 사라졌다).
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime
from typing import Any, Optional

from kubernetes import client as k8s_client
from sqlalchemy.orm import Session

from app.config import settings
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


# R1 실시간 로그 — 실행 1건당 쌓는 줄 수 상한(넘으면 앞부분을 버리고 생략 표시를 남긴다).
LOG_LINE_LIMIT = 2000
# 이 시간이 지나도록 끝나지 않은 running 행은 실행 스레드가 사라진 것으로 본다(파드 재시작 등).
STALE_GRACE_SECONDS = 300


class RunLogBuffer:
    """ansible 콜백 이벤트를 [ts, level, message] 줄로 모은다.

    ``add`` 는 executor 의 stderr 리더 스레드에서 불리므로 DB 를 만지지 않고 리스트만 갱신한다
    (Session 은 스레드 안전하지 않다). DB 반영은 실행 루프 스레드의 ``snapshot`` 으로 한다.
    """

    def __init__(self, limit: int = LOG_LINE_LIMIT):
        self._lines: list[list[Any]] = []
        self._dropped = 0
        self._limit = limit
        self._lock = threading.Lock()
        self.dirty = False

    def add(self, level: str, message: str) -> None:
        line = [datetime.utcnow().isoformat() + "Z", level if level in ("info", "warn", "error") else "info", message[:1000]]
        with self._lock:
            self._lines.append(line)
            if len(self._lines) > self._limit:
                drop = len(self._lines) - self._limit
                del self._lines[:drop]
                self._dropped += drop
            self.dirty = True

    def snapshot(self) -> list[list[Any]]:
        with self._lock:
            self.dirty = False
            head = [[self._lines[0][0], "warn", f"앞부분 {self._dropped}줄 생략(상한 {self._limit}줄)"]] if self._dropped and self._lines else []
            return head + [list(x) for x in self._lines]


def merged_extra_vars(
    playbook: Playbook,
    *,
    ssh_username: Optional[str] = None,
    ssh_password: Optional[str] = None,
    ssh_port: Optional[int] = None,
    become: Optional[bool] = None,
    become_password: Optional[str] = None,
) -> dict[str, Any]:
    """SSH 자격증명을 extra_vars 로 머지 — playbook 의 hostvars 기본값을 덮는다(값은 저장하지 않는다)."""
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
    return merged_vars


def begin_playbook_run(
    db: Session,
    playbook: Playbook,
    *,
    trigger: str = "manual",
    triggered_by_user_id: Optional[str] = None,
    triggered_by_username: Optional[str] = None,
) -> tuple[PlaybookRun, Optional[str]]:
    """``running`` 상태의 실행 행을 만들고 커밋한다. 돌려주는 두 번째 값은 실행 전 플레이북 상태
    (취소되면 그 상태로 되돌린다 — 취소는 판정이 아니다)."""
    prev_status = playbook.status if playbook.status != "running" else None
    playbook.status = "running"
    run = PlaybookRun(
        playbook_id=playbook.id,
        status="running",
        trigger=trigger,
        triggered_by_user_id=triggered_by_user_id,
        triggered_by_username=triggered_by_username,
        message="실행 중",
        started_at=datetime.utcnow(),
        log_lines=[],
        cancel_requested=False,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run, prev_status


def perform_playbook_run(
    db: Session,
    playbook: Playbook,
    run: PlaybookRun,
    *,
    prev_status: Optional[str] = None,
    ssh_private_key: Optional[str] = None,
    flush_interval: float = 1.0,
    **creds: Any,
) -> PlaybookResult:
    """``begin_playbook_run`` 으로 만든 행을 실제로 실행한다 — 진행 줄을 ``flush_interval`` 마다
    ``run.log_lines`` 에 커밋하고, 같은 주기로 ``cancel_requested`` 를 읽어 참이면 프로세스를 끊는다.
    """
    buf = RunLogBuffer()
    last_flush = [0.0]
    last_check = [0.0]
    cancelled = [False]

    def flush(force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - last_flush[0] < flush_interval:
            return
        last_flush[0] = now
        try:
            if buf.dirty or force:
                run.log_lines = buf.snapshot()
                db.commit()
        except Exception as e:  # noqa: BLE001 — 로그 반영 실패가 실행을 깨면 안 된다
            logger.warning("playbook run %s log flush failed: %s", run.id, str(e)[:200])
            db.rollback()

    def should_cancel() -> bool:
        flush()
        # 취소 플래그도 같은 주기로만 읽는다(executor 는 0.5초마다 묻는다).
        now = time.monotonic()
        if cancelled[0] or now - last_check[0] < flush_interval:
            return cancelled[0]
        last_check[0] = now
        try:
            db.refresh(run, attribute_names=["cancel_requested"])
        except Exception:  # noqa: BLE001
            db.rollback()
            return False
        cancelled[0] = bool(run.cancel_requested)
        return cancelled[0]

    # 실행 시 inventory 우선순위:
    #   1) DB 관리형 Inventory  (playbook.inventory.content)
    #   2) inventory_path        (구 호환 — 실행 호스트의 ini 파일 경로)
    #   3) K8s 전체 노드          (위 둘 다 없을 때 cluster 의 노드 IP 로 동적 생성)
    pb_content = playbook.playbook_file.content if playbook.playbook_file else None
    inv_content = playbook.inventory.content if playbook.inventory else None
    inventory_hosts: Optional[list[str]] = None
    if not inv_content and not playbook.inventory_path:
        buf.add("info", "인벤토리가 없어 클러스터 노드 목록으로 동적 인벤토리를 만든다")
        inventory_hosts = cluster_node_hosts(playbook.cluster) or None
        buf.add("info" if inventory_hosts else "warn",
                f"동적 인벤토리 호스트 {len(inventory_hosts or [])}개" if inventory_hosts else "노드 목록을 가져오지 못했다 — 정적 기본 인벤토리로 실행")
    else:
        buf.add("info", f"인벤토리: {playbook.inventory.name if playbook.inventory else playbook.inventory_path}")

    result = run_playbook(
        playbook_path=playbook.playbook_path,
        inventory_path=playbook.inventory_path,
        playbook_content=pb_content,
        inventory_content=inv_content,
        extra_vars=merged_extra_vars(playbook, **creds) or None,
        tags=playbook.tags,
        inventory_hosts=inventory_hosts,
        ssh_private_key=ssh_private_key,
        timeout=playbook.timeout_seconds or None,
        on_event=buf.add,
        should_cancel=should_cancel,
    )
    finished_at = datetime.utcnow()
    buf.add(
        "warn" if result.status in ("warning", "cancelled") else "error" if result.status == "critical" else "info",
        f"종료 · {result.status} · {result.message}",
    )

    if result.status == "cancelled":
        # 취소는 판정이 아니다 — 플레이북 상태·최신 스냅샷(last_result)은 실행 전 그대로 둔다.
        playbook.status = prev_status or "unknown"
    else:
        # 기존 UI(PlaybookLogDialog)가 읽는 최신 스냅샷 — 하위 호환을 위해 계속 갱신한다.
        playbook.status = result.status
        playbook.last_run_at = finished_at
        playbook.last_result = {
            "message": result.message,
            "stats": result.stats,
            "duration_ms": result.duration_ms,
            "raw_output": result.raw_output[:5000] if result.raw_output else None,
        }

    run.status = result.status
    run.message = (result.message or "")[:1000]
    run.stats = result.stats or None
    run.raw_output = result.raw_output[:5000] if result.raw_output else None
    run.duration_ms = result.duration_ms
    run.finished_at = finished_at
    run.log_lines = buf.snapshot()
    db.commit()
    db.refresh(playbook)
    db.refresh(run)
    return result


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
    """Playbook 1회 동기 실행 — 결과를 ``PlaybookRun`` 이력으로 남기고 ``Playbook.last_result``
    (기존 UI ``PlaybookLogDialog`` 가 읽는 최신 스냅샷)도 함께 갱신한다. 점검 매트릭스·운영 점검과
    구 ``POST /playbooks/{id}/run`` 이 쓴다(화면의 실행 버튼은 ``playbook_run_jobs`` 의 백그라운드 실행).

    SSH 자격증명은 DB 에 저장하지 않는다(휘발성) — 요청 시에만 ``extra_vars`` 로 합쳐
    ``ansible-playbook -e`` 에 전달되고, 호출부가 값을 갖고 있는 동안만 메모리에 존재한다
    (CLAUDE.md UI-First 원칙 §3).
    """
    run, prev_status = begin_playbook_run(
        db, playbook, trigger=trigger,
        triggered_by_user_id=triggered_by_user_id, triggered_by_username=triggered_by_username,
    )
    result = perform_playbook_run(
        db, playbook, run, prev_status=prev_status, ssh_private_key=ssh_private_key,
        ssh_username=ssh_username, ssh_password=ssh_password, ssh_port=ssh_port,
        become=become, become_password=become_password,
    )
    return run, result


def reap_if_stale(db: Session, run: PlaybookRun, playbook: Optional[Playbook] = None) -> bool:
    """실행 스레드가 사라진(파드 재시작 등) ``running`` 행을 실패로 마감한다. 마감했으면 True."""
    if run.status != "running" or run.finished_at is not None:
        return False
    pb = playbook or run.playbook
    limit = (pb.timeout_seconds if pb and pb.timeout_seconds else settings.check_timeout_seconds) + STALE_GRACE_SECONDS
    if not run.started_at or (datetime.utcnow() - run.started_at).total_seconds() < limit:
        return False
    run.status = "critical"
    run.message = "실행이 중단됐습니다 — 실행하던 서버 프로세스가 사라졌습니다(재시작·배포 등). 다시 실행하세요."
    run.finished_at = datetime.utcnow()
    lines = list(run.log_lines or [])
    lines.append([run.finished_at.isoformat() + "Z", "error", run.message])
    run.log_lines = lines
    if pb is not None and pb.status == "running":
        pb.status = "critical"
    db.commit()
    return True
