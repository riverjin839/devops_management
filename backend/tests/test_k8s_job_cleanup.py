"""Unit tests for the k8s_job_cleanup batch-job executor (DB-free).

Covers:
  - executor registration + non-SSH descriptor flag
  - select_cleanup_targets() 필터링 (상태/경과 시간/네임스페이스 제외/active 보호)
  - non-SSH 잡의 cron invariant 완화 (_require_cron_credentials)
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.routers.batch_jobs import _require_cron_credentials
from app.services.batch_jobs import get_executor, list_executors
from app.services.batch_jobs.k8s_job_cleanup import select_cleanup_targets

NOW = datetime(2026, 7, 24, 12, 0, 0, tzinfo=timezone.utc)


def _job(name, ns="default", state=None, finished_hours_ago=48, active=False):
    """kubectl get jobs -o json 의 item 한 개를 흉내낸다."""
    finished = (NOW - timedelta(hours=finished_hours_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")
    status = {}
    if active:
        status["active"] = 1
    elif state == "succeeded":
        status["completionTime"] = finished
        status["conditions"] = [
            {"type": "Complete", "status": "True", "lastTransitionTime": finished}
        ]
    elif state == "failed":
        status["conditions"] = [
            {"type": "Failed", "status": "True", "lastTransitionTime": finished}
        ]
    return {
        "metadata": {
            "name": name,
            "namespace": ns,
            "creationTimestamp": finished,
        },
        "status": status,
    }


class TestExecutorRegistration:
    def test_registered_and_non_ssh(self):
        ex = get_executor("k8s_job_cleanup")
        assert ex is not None
        assert ex.requires_ssh is False

    def test_descriptor_exposes_requires_ssh(self):
        by_type = {d["job_type"]: d for d in list_executors()}
        assert by_type["k8s_job_cleanup"]["requires_ssh"] is False
        # 기존 SSH executor 는 계속 True 를 노출해야 한다.
        assert by_type["shell_command"]["requires_ssh"] is True
        assert by_type["etcdctl_defrag"]["requires_ssh"] is True

    def test_dry_run_is_default(self):
        ex = get_executor("k8s_job_cleanup")
        assert ex.default_params["dry_run"] is True
        assert ex.default_params["delete_failed"] is False


class TestSelectCleanupTargets:
    def _select(self, items, **kwargs):
        defaults = dict(
            delete_succeeded=True,
            delete_failed=False,
            older_than_hours=24,
            exclude_namespaces={"kube-system"},
            now=NOW,
        )
        defaults.update(kwargs)
        return select_cleanup_targets(items, **defaults)

    def test_succeeded_old_job_selected(self):
        targets = self._select([_job("done", state="succeeded", finished_hours_ago=48)])
        assert [(t["namespace"], t["name"], t["state"]) for t in targets] == [
            ("default", "done", "succeeded")
        ]

    def test_recent_job_protected_by_age(self):
        targets = self._select([_job("fresh", state="succeeded", finished_hours_ago=1)])
        assert targets == []

    def test_active_job_never_selected(self):
        targets = self._select(
            [_job("busy", active=True)], delete_succeeded=True, delete_failed=True
        )
        assert targets == []

    def test_failed_requires_opt_in(self):
        items = [_job("boom", state="failed", finished_hours_ago=48)]
        assert self._select(items) == []
        targets = self._select(items, delete_failed=True)
        assert [t["state"] for t in targets] == ["failed"]

    def test_exclude_namespaces(self):
        items = [
            _job("sys-job", ns="kube-system", state="succeeded"),
            _job("app-job", ns="batch", state="succeeded"),
        ]
        targets = self._select(items)
        assert [t["namespace"] for t in targets] == ["batch"]

    def test_age_hours_reported(self):
        targets = self._select([_job("done", state="succeeded", finished_hours_ago=48)])
        assert targets[0]["age_hours"] == pytest.approx(48, abs=0.1)


class TestCronInvariantForNonSshJobs:
    def test_non_ssh_type_allows_cron_without_creds_or_host(self):
        """k8s_job_cleanup 은 host/자격증명 없이 cron 등록이 가능해야 한다."""
        _require_cron_credentials(
            cron="0 4 * * *",
            has_password=False,
            has_private_key=False,
            default_host=None,
            job_type="k8s_job_cleanup",
        )

    def test_ssh_type_still_blocked_without_creds(self):
        with pytest.raises(HTTPException) as exc:
            _require_cron_credentials(
                cron="0 4 * * *",
                has_password=False,
                has_private_key=False,
                default_host="h",
                job_type="shell_command",
            )
        assert exc.value.status_code == 422

    def test_unknown_type_treated_as_ssh(self):
        with pytest.raises(HTTPException):
            _require_cron_credentials(
                cron="0 4 * * *",
                has_password=False,
                has_private_key=False,
                default_host="h",
                job_type="no_such_type",
            )


class TestStepTraceAndClassification:
    """단계별 trace + kubectl 실패 분류 — "연결안됨 오진" 해소의 실행기 측 검증."""

    def _ctx(self, **kwargs):
        from app.services.batch_jobs import ExecutionContext
        defaults = dict(params={}, timeout=5)
        defaults.update(kwargs)
        return ExecutionContext(**defaults)

    def test_missing_kubeconfig_records_failed_step_with_reason(self):
        import asyncio
        ex = get_executor("k8s_job_cleanup")
        ctx = self._ctx(kubeconfig_note="kubeconfig 가 경로로만 등록돼 있고 DB 에 내용이 없습니다.")
        r = asyncio.run(ex.run(ctx))
        assert r.status == "error"
        assert "경로로만 등록" in (r.error or "")
        assert [s["id"] for s in r.steps] == ["resolve_kubeconfig"]
        assert r.steps[0]["status"] == "failed"
        assert "경로로만 등록" in r.steps[0]["detail"]

    def test_connect_failure_classified_and_steps_recorded(self, monkeypatch):
        """kubectl 이 dial tcp 로 죽으면 status=connect_error + 원인 headline."""
        import asyncio
        import subprocess as sp
        from app.services.batch_jobs import k8s_job_cleanup as mod

        def fake_kubectl(args, timeout, cancel_token=None):
            return sp.CompletedProcess(
                ["kubectl", *args], 1, "",
                "Unable to connect to the server: dial tcp 10.0.0.9:6443: connect: connection refused",
            )

        monkeypatch.setattr(mod, "_run_kubectl", fake_kubectl)
        ex = get_executor("k8s_job_cleanup")
        ctx = self._ctx(kubeconfig_path="/tmp/fake-kubeconfig.yaml", cluster_name="prod")
        r = asyncio.run(ex.run(ctx))
        assert r.status == "connect_error"
        assert "Unable to connect" in (r.error or "")
        step_map = {s["id"]: s for s in r.steps}
        assert step_map["resolve_kubeconfig"]["status"] == "success"
        assert step_map["kubectl_query"]["status"] == "failed"
        # 실측 명령 기록 — kubeconfig 경로는 마스킹
        assert r.commands, "commands trace 가 비어있으면 안 됨"
        assert "<kubeconfig>" in r.commands[0]["command"]
        assert r.commands[0]["exit_code"] == 1

    def test_auth_failure_classified(self, monkeypatch):
        import asyncio
        import subprocess as sp
        from app.services.batch_jobs import k8s_job_cleanup as mod

        def fake_kubectl(args, timeout, cancel_token=None):
            return sp.CompletedProcess(
                ["kubectl", *args], 1, "",
                "error: You must be logged in to the server (Unauthorized)",
            )

        monkeypatch.setattr(mod, "_run_kubectl", fake_kubectl)
        ex = get_executor("k8s_job_cleanup")
        r = asyncio.run(ex.run(self._ctx(kubeconfig_path="/tmp/kc.yaml")))
        assert r.status == "auth_error"

    def test_dry_run_success_marks_delete_step_skipped(self, monkeypatch):
        import asyncio
        import json as _json
        import subprocess as sp
        from app.services.batch_jobs import k8s_job_cleanup as mod

        def fake_kubectl(args, timeout, cancel_token=None):
            return sp.CompletedProcess(["kubectl", *args], 0, _json.dumps({"items": []}), "")

        monkeypatch.setattr(mod, "_run_kubectl", fake_kubectl)
        ex = get_executor("k8s_job_cleanup")
        r = asyncio.run(ex.run(self._ctx(kubeconfig_path="/tmp/kc.yaml", params={"dry_run": True})))
        assert r.status == "ok"
        step_map = {s["id"]: s for s in r.steps}
        assert step_map["delete_jobs"]["status"] == "skipped"
        assert [s["id"] for s in r.steps] == [
            "resolve_kubeconfig", "kubectl_query", "select_targets", "delete_jobs",
        ]

    def test_step_plan_exposed_in_descriptor(self):
        by_type = {d["job_type"]: d for d in list_executors()}
        ids = [s["id"] for s in by_type["k8s_job_cleanup"]["step_plan"]]
        assert ids == ["resolve_kubeconfig", "kubectl_query", "select_targets", "delete_jobs"]
        # SSH executor 도 계획이 노출된다
        assert by_type["shell_command"]["step_plan"]
