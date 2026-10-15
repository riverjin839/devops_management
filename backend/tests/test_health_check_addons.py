"""POST /health/check/{id} 응답의 애드온별 요약(D-128 실행 로그 줄의 원천)."""
import uuid
from datetime import datetime
from types import SimpleNamespace

from app.models import StatusEnum
from app.routers.health import addon_check_summaries


def _addon(**kw):
    base = dict(
        id=uuid.uuid4(), name="etcd", type="etcd-leader", status=StatusEnum.healthy,
        response_time=12, details=None, last_check=datetime(2026, 10, 14, 9, 0, 0),
    )
    base.update(kw)
    return SimpleNamespace(**base)


def test_summary_has_name_status_and_message():
    rows = addon_check_summaries([
        _addon(),
        _addon(name="argocd", type="argocd", status=StatusEnum.critical, details={"error": "timeout"}),
    ])
    assert [r["name"] for r in rows] == ["etcd", "argocd"]
    assert rows[0]["status"] == "healthy" and rows[0]["message"] is None
    assert rows[1]["status"] == "critical" and rows[1]["message"] == "timeout"
    assert rows[0]["last_check"].startswith("2026-10-14")


def test_summary_tolerates_non_dict_details_and_missing_check():
    rows = addon_check_summaries([_addon(details=["x"], last_check=None, status="warning")])
    assert rows[0]["message"] is None
    assert rows[0]["last_check"] is None
    assert rows[0]["status"] == "warning"
