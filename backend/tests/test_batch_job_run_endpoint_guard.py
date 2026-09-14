"""DB-free unit test for `POST /batch-jobs/{id}/run` respecting `BatchJob.enabled`.

회귀 방지: 스케줄 디스패처(`run_batch_job_dispatcher`)와 일괄 실행(`bulk_run_jobs`)은
`enabled=False` 인 잡을 걸러냈지만, 단일 잡 "즉시 실행" 버튼이 호출하는 이 엔드포인트는
그 검사가 없어 꺼둔 잡도 클릭 한 번으로 실행할 수 있었다(D-급 버그 — "껐는데 실행된다"는
사용자 제보의 원인).
"""
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.models import BatchJob
from app.routers.batch_jobs import run_job
from app.schemas.batch_job import BatchJobRunRequest


@pytest.mark.asyncio
async def test_run_job_rejects_disabled_job():
    job = BatchJob(id=uuid4(), name="t", job_type="k8s_job_cleanup", enabled=False)
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = job

    with pytest.raises(HTTPException) as exc_info:
        await run_job(
            job_id=job.id,
            payload=BatchJobRunRequest(),
            request=MagicMock(),
            db=db,
            actor=MagicMock(),
        )
    assert exc_info.value.status_code == 400
    assert "비활성화" in exc_info.value.detail
