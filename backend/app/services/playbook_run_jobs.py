"""플레이북 백그라운드 실행 — 화면의 "실행" 버튼(R1 실시간 로그 · R2 취소).

``POST /playbooks/{id}/runs`` 가 ``running`` 실행 행을 만들고 이 모듈로 실행을 넘긴 뒤 바로
``run_id`` 를 돌려준다. 실행은 **요청을 받은 backend 프로세스의 스레드**에서 돈다:

- SSH 자격증명이 Celery 브로커(Redis) 메시지로 나가지 않게 한다 — 값은 이 프로세스 메모리에만
  있다가 실행이 끝나면 사라진다(CLAUDE.md UI-First §3 "자격증명은 저장하지 않는다").
- 진행 줄은 ``PlaybookRun.log_lines`` 에, 취소 요청은 ``PlaybookRun.cancel_requested`` 에 있어서
  다른 replica 가 조회·취소 요청을 받아도 같은 행을 본다.
- 프로세스가 사라지면(재시작·배포) 행이 ``running`` 에 남는다 — 조회 시
  ``playbook_service.reap_if_stale`` 이 제한 시간 + 유예가 지난 행을 실패로 마감한다.
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from app.database import SessionLocal
from app.models import Playbook, PlaybookRun
from app.services import playbook_service

logger = logging.getLogger(__name__)


def _worker(run_id: UUID, prev_status: Optional[str], creds: dict[str, Any]) -> None:
    db = SessionLocal()
    try:
        run = db.query(PlaybookRun).filter(PlaybookRun.id == run_id).first()
        playbook = db.query(Playbook).filter(Playbook.id == run.playbook_id).first() if run else None
        if run is None or playbook is None:
            logger.warning("playbook run %s vanished before start", run_id)
            return
        playbook_service.perform_playbook_run(db, playbook, run, prev_status=prev_status, **creds)
    except Exception as e:  # noqa: BLE001 — 스레드 예외는 행에 남기고 끝낸다(빈 running 방지)
        logger.exception("playbook run %s failed", run_id)
        try:
            db.rollback()
            run = db.query(PlaybookRun).filter(PlaybookRun.id == run_id).first()
            if run is not None and run.status == "running":
                run.status = "critical"
                run.message = f"실행 오류: {str(e)[:500]}"
                run.finished_at = datetime.utcnow()
                run.log_lines = list(run.log_lines or []) + [[run.finished_at.isoformat() + "Z", "error", run.message]]
                pb = db.query(Playbook).filter(Playbook.id == run.playbook_id).first()
                if pb is not None and pb.status == "running":
                    pb.status = "critical"
                db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
    finally:
        db.close()


def start_background_run(run_id: UUID, prev_status: Optional[str], creds: dict[str, Any]) -> None:
    """실행 스레드를 띄운다. ``creds`` 는 이 스레드의 지역 변수로만 남는다."""
    threading.Thread(
        target=_worker, args=(run_id, prev_status, dict(creds)),
        name=f"playbook-run-{run_id}", daemon=True,
    ).start()
