"""D-089 잔여 — 인프라 K8s 동기화·노드 검증 SSE 실시간 로그 회귀 테스트.

"K8s 동기화" 는 kubectl 재시도·노드별 upsert·신규 노드 자동 검증을 한 요청으로 끝낼 때까지 아무
정보도 주지 않았고, "검증" 은 체커 단계가 끝난 뒤에야 결과를 돌려줬다. 이제 `/stream` 엔드포인트가
단계·로그를 진행되는 대로 흘린다. 실제 클러스터 대신 가짜 kubectl·가짜 체커로 검증한다(실제 DB 사용).
"""
import json
import os
import subprocess
import uuid

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.database import SessionLocal, Base, engine
from app.main import _ensure_pgvector_extension
from app.models import StatusEnum
from app.models.audit_log import AuditLog
from app.models.cluster import Cluster
from app.models.infra_node import InfraNode
from app.models.topology_audit_log import TopologyAuditLog
from app.models.user import User
from app.services.registered_checks.base import DeepCheckContext, DeepCheckOutcome, DeepCheckerBase

SYNC = {"X-API-Scopes": "infra_topology.sync"}


def _k8s_node(name: str, *, master: bool = False, ip: str = "10.0.0.1") -> dict:
    labels = {"node-role.kubernetes.io/control-plane": ""} if master else {}
    return {
        "metadata": {"name": name, "labels": labels},
        "status": {
            "capacity": {"cpu": "8", "memory": "32Gi"},
            "addresses": [{"type": "InternalIP", "address": ip}],
            "nodeInfo": {"osImage": "Ubuntu 22.04"},
        },
    }


class _FakeDeepCheckService:
    """node_health 대신 단계 2개를 on_step 으로 흘리고 healthy 결과를 돌려준다."""

    def __init__(self, db):
        self.db = db

    def run_node_health_once(self, cluster, *, node_name, on_step=None, **_kw):
        steps = [
            {"id": "ready", "label": "Ready 확인", "status": "success", "detail": "Ready=True", "duration_ms": 3},
            {"id": "cni", "label": "CNI 확인", "status": "failed", "detail": "cilium 미기동", "duration_ms": 5},
        ]
        for st in steps:
            if on_step:
                on_step({**st, "status": "running", "detail": "", "duration_ms": 0})
                on_step(st)
        return {
            "status": "warning",
            "message": f"{node_name}: CNI 이상",
            "details": {"nodes": [{"name": node_name, "ok": False}]},
            "steps": steps,
            "step_plan": [],
            "duration_ms": 8,
        }


@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def world(db):
    tag = uuid.uuid4().hex[:8]
    cluster = Cluster(name=f"infra-sync-{tag}", api_endpoint="https://c:6443")
    op = User(username=f"sync-op-{tag}", hashed_password="x", role="operator")
    db.add_all([cluster, op])
    db.commit()
    yield {"cluster": cluster, "op": op}
    db.query(TopologyAuditLog).filter(TopologyAuditLog.cluster_id == cluster.id).delete(synchronize_session=False)
    db.query(InfraNode).filter(InfraNode.cluster_id == cluster.id).delete(synchronize_session=False)
    db.query(AuditLog).filter(AuditLog.actor_user_id == op.id).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id == cluster.id).delete(synchronize_session=False)
    db.query(User).filter(User.id == op.id).delete(synchronize_session=False)
    db.commit()


@pytest.fixture
def kubectl(monkeypatch):
    """가짜 kubectl — calls 에 명령을 남기고 state['responses'] 를 차례로 돌려준다."""
    import app.routers.infra_nodes as infra

    state: dict = {"calls": [], "responses": []}

    def fake_run(cmd, **_kw):
        state["calls"].append(cmd)
        rc, out, err = state["responses"].pop(0) if state["responses"] else (1, "", "no response")
        return subprocess.CompletedProcess(cmd, rc, stdout=out, stderr=err)

    monkeypatch.setattr(infra.subprocess, "run", fake_run)
    monkeypatch.setattr(infra.time, "sleep", lambda _s: None)
    monkeypatch.setattr(infra, "DeepCheckService", _FakeDeepCheckService)
    return state


@pytest.fixture
def client(world):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth.deps import get_current_user

    app.dependency_overrides[get_current_user] = lambda: world["op"]
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def _events(text: str) -> list[dict]:
    out = []
    for block in text.split("\n\n"):
        for ln in block.splitlines():
            if ln.startswith("data:"):
                out.append(json.loads(ln[5:].strip()))
    return out


def test_sync_stream_emits_phases_node_logs_and_result(client, world, db, kubectl):
    db.add(InfraNode(cluster_id=world["cluster"].id, hostname="n-old", role="worker"))
    db.commit()
    payload = {"items": [_k8s_node("n-old", ip="10.0.0.2"), _k8s_node("n-new", master=True, ip="10.0.0.3")]}
    kubectl["responses"] = [(1, "", "connection refused"), (0, json.dumps(payload), "")]

    res = client.post(f"/api/v1/infra-nodes/sync/{world['cluster'].id}/stream", headers=SYNC)
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    evts = _events(res.text)
    types = [e["type"] for e in evts]
    assert "error" not in types, evts

    steps = {(e["name"], e["status"]) for e in evts if e["type"] == "step"}
    assert {("kubeconfig", "done"), ("kubectl", "running"), ("kubectl", "done"),
            ("upsert", "done"), ("verify", "running"), ("verify", "failed")} <= steps

    logs = [e["message"] for e in evts if e["type"] == "log"]
    assert any("시도 1/3" in m for m in logs) and any("시도 2/3" in m for m in logs)
    assert any("connection refused" in m for m in logs)
    assert any(m.startswith("[n-old] 갱신") for m in logs)
    assert any(m.startswith("[n-new] 신규 추가") and "master" in m for m in logs)
    # 신규 노드 자동 검증의 체커 단계가 노드 접두사와 함께 실시간으로 나온다
    assert any(m.startswith("[n-new] Ready 확인 — success") for m in logs)
    assert any(m.startswith("[n-new] CNI 확인 — failed") and "cilium 미기동" in m for m in logs)

    # kubeconfig 미등록 클러스터는 기본 설정으로 시도(--kubeconfig 없음)
    assert kubectl["calls"][0] == ["kubectl", "get", "nodes", "-o", "json"]

    result = evts[-1]
    assert result["type"] == "result"
    body = result["result"]
    assert body["created"] == 1 and body["updated"] == 1 and body["retry_count"] == 1
    assert [v["hostname"] for v in body["verifications"]] == ["n-new"]
    db.expire_all()
    rows = db.query(InfraNode).filter(InfraNode.cluster_id == world["cluster"].id).all()
    assert {r.hostname: r.ip_address for r in rows} == {"n-old": "10.0.0.2", "n-new": "10.0.0.3"}


def test_sync_stream_reports_kubectl_failure_as_error_event(client, world, db, kubectl):
    kubectl["responses"] = [(1, "", "Unauthorized")] * 3
    res = client.post(f"/api/v1/infra-nodes/sync/{world['cluster'].id}/stream", headers=SYNC)
    assert res.status_code == 200
    evts = _events(res.text)
    assert evts[-1]["type"] == "error"
    assert "kubectl error" in evts[-1]["message"]
    assert ("kubectl", "failed") in {(e["name"], e["status"]) for e in evts if e["type"] == "step"}
    assert len(kubectl["calls"]) == 3
    audit = db.query(TopologyAuditLog).filter(
        TopologyAuditLog.cluster_id == world["cluster"].id, TopologyAuditLog.action == "sync",
    ).all()
    assert [a.status for a in audit] == ["failed"]


def test_sync_stops_when_registered_kubeconfig_is_unresolvable(client, world, db, kubectl):
    world["cluster"].kubeconfig_path = f"/nonexistent/{uuid.uuid4().hex}.yaml"
    db.commit()
    res = client.post(f"/api/v1/infra-nodes/sync/{world['cluster'].id}/stream", headers=SYNC)
    evts = _events(res.text)
    assert evts[-1]["type"] == "error"
    assert "kubeconfig" in evts[-1]["message"]
    # 다른 클러스터(기본 컨텍스트)를 읽지 않도록 kubectl 을 아예 부르지 않는다
    assert kubectl["calls"] == []


def test_plain_sync_shares_the_same_core(client, world, kubectl):
    kubectl["responses"] = [(0, json.dumps({"items": [_k8s_node("n-a")]}), "")]
    res = client.post(f"/api/v1/infra-nodes/sync/{world['cluster'].id}", headers=SYNC)
    assert res.status_code == 200, res.text
    assert res.json()["created"] == 1
    kubectl["responses"] = [(1, "", "boom")] * 3
    res = client.post(f"/api/v1/infra-nodes/sync/{world['cluster'].id}", headers=SYNC)
    assert res.status_code == 502
    assert "boom" in res.json()["detail"]


def test_verify_stream_emits_checker_steps_live(client, world, db, kubectl):
    node = InfraNode(cluster_id=world["cluster"].id, hostname="n-v", role="worker")
    db.add(node)
    db.commit()
    res = client.post(f"/api/v1/infra-nodes/{node.id}/verify/stream", headers=SYNC)
    assert res.status_code == 200
    evts = _events(res.text)
    steps = [(e["name"], e["status"]) for e in evts if e["type"] == "step"]
    assert steps == [("check:ready", "running"), ("check:ready", "done"),
                     ("check:cni", "running"), ("check:cni", "failed")]
    result = evts[-1]
    assert result["type"] == "result"
    assert result["result"]["status"] == "warning" and result["result"]["hostname"] == "n-v"
    audit = db.query(TopologyAuditLog).filter(
        TopologyAuditLog.cluster_id == world["cluster"].id, TopologyAuditLog.action == "verify",
    ).count()
    assert audit == 1


def test_verify_stream_unknown_node_is_plain_404(client, kubectl):
    res = client.post(f"/api/v1/infra-nodes/{uuid.uuid4()}/verify/stream", headers=SYNC)
    assert res.status_code == 404


class _TwoStepChecker(DeepCheckerBase):
    check_type = "test_two_step"
    display_name = "Two Step"

    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        with self._step("a", "첫 단계") as st:
            st.detail = "ok"
        with self._step("b", "둘째 단계") as st:
            st.status = "skipped"
        return DeepCheckOutcome(status=StatusEnum.healthy, message="done")


def test_checker_on_step_hook_reports_enter_and_exit():
    seen: list[tuple[str, str]] = []
    checker = _TwoStepChecker()
    checker._on_step = lambda rec: seen.append((rec["id"], rec["status"]))
    outcome = checker.safe_run(DeepCheckContext())
    assert outcome.status == StatusEnum.healthy
    assert seen == [("a", "running"), ("a", "success"), ("b", "running"), ("b", "skipped")]


def test_checker_on_step_hook_errors_do_not_break_the_check():
    def boom(_rec):
        raise RuntimeError("subscriber down")

    checker = _TwoStepChecker()
    checker._on_step = boom
    outcome = checker.safe_run(DeepCheckContext())
    assert outcome.status == StatusEnum.healthy
    assert [s["status"] for s in outcome.steps] == ["success", "skipped"]
