"""D-114 / D-115 — AI 장애 분석(`POST /analyze/incident`)·컨텍스트 수집 회귀 테스트.

- 입력 길이 상한(422), 클러스터 접근 권한(403), 테넌트 LLM 컨텍스트, 감사 로그 1행
- 분석기 결과 정규화(confidence clamp·severity 정규화)와 degraded 전달
- 컨텍스트 수집의 컨테이너 선택 규칙·pod 조회 예외 매핑·init 컨테이너 이상 판정

실제 DB 를 쓰고, 분석기·LLM·K8s 는 monkeypatch 로 대체한다.
"""
import asyncio
import json
import os
import uuid
from types import SimpleNamespace

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from kubernetes.client.exceptions import ApiException  # noqa: E402

import app.routers.analyze as analyze  # noqa: E402
from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension  # noqa: E402
from app.models.audit_log import AuditLog  # noqa: E402
from app.models.cluster import Cluster  # noqa: E402
from app.models.tenant import ClusterBinding, Tenant, TenantMember  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.analyzers.base import AnalysisResult, clamp_confidence, normalize_severity  # noqa: E402
from app.services.llm.service import current_llm_tenant  # noqa: E402

LOG_MARKER = "SECRET-LOG-BODY-should-not-be-audited"


# ── fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture
def db():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def world(db):
    """열린 클러스터 + 테넌트 바인딩 클러스터, 멤버/비멤버 operator."""
    tag = uuid.uuid4().hex[:8]
    c_open = Cluster(name=f"an-open-{tag}", api_endpoint="https://open:6443")
    c_bound = Cluster(name=f"an-bound-{tag}", api_endpoint="https://bound:6443")
    member = User(username=f"an-member-{tag}", hashed_password="x", role="operator")
    outsider = User(username=f"an-outsider-{tag}", hashed_password="x", role="operator")
    tenant = Tenant(name=f"an-team-{tag}", llm_routing={"incident_analysis": {"profile": "x"}})
    db.add_all([c_open, c_bound, member, outsider, tenant])
    db.commit()
    db.add_all([
        TenantMember(tenant_id=tenant.id, user_id=member.id),
        ClusterBinding(tenant_id=tenant.id, cluster_id=c_bound.id, access="read"),
    ])
    db.commit()
    w = {"open": c_open, "bound": c_bound, "member": member, "outsider": outsider, "tenant": tenant,
         "user": member}
    yield w
    uids = [member.id, outsider.id]
    db.query(AuditLog).filter(AuditLog.actor_user_id.in_(uids)).delete(synchronize_session=False)
    db.query(ClusterBinding).filter(ClusterBinding.tenant_id == tenant.id).delete(synchronize_session=False)
    db.query(TenantMember).filter(TenantMember.tenant_id == tenant.id).delete(synchronize_session=False)
    db.query(Tenant).filter(Tenant.id == tenant.id).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id.in_([c_open.id, c_bound.id])).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_(uids)).delete(synchronize_session=False)
    db.commit()


class _FakeAnalyzer:
    """고정 결과를 돌려주고, 호출 시점의 LLM 테넌트 컨텍스트를 기록한다."""

    def __init__(self, result_kwargs: dict | None = None, raises: Exception | None = None):
        self.result_kwargs = result_kwargs or {}
        self.raises = raises
        self.seen_tenant = "unset"
        self.calls = 0

    async def analyze(self, ctx):
        self.calls += 1
        self.seen_tenant = current_llm_tenant()
        if self.raises:
            raise self.raises
        kw = {
            "severity": "warning",
            "root_cause": "rc",
            "suggested_actions": ["a"],
            "confidence": 0.7,
            "analyzed_by": "local_llm:prof:model",
            "analyzed_at": "2026-10-16T00:00:00Z",
        }
        kw.update(self.result_kwargs)
        return AnalysisResult(**kw)

    async def health_check(self):
        return True


@pytest.fixture
def client(world, monkeypatch):
    from fastapi.testclient import TestClient

    from app.auth.deps import get_current_user
    from app.main import app

    fake = _FakeAnalyzer()
    monkeypatch.setattr(analyze, "get_analyzer", lambda db=None: fake)
    app.dependency_overrides[get_current_user] = lambda: world["user"]
    try:
        tc = TestClient(app)
        tc.fake = fake  # type: ignore[attr-defined]
        yield tc
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def _body(**over) -> dict:
    b = {
        "pod_name": "api-0",
        "namespace": "prod",
        "timestamp": "2026-10-16T00:00:00Z",
        "events": [{"reason": "BackOff", "message": "back-off restarting"}],
        "current_logs": LOG_MARKER,
        "describe_output": "Name: api-0",
    }
    b.update(over)
    return b


URL = "/api/v1/analyze/incident"


# ── 입력 상한 (D-114) ───────────────────────────────────────────────────────

@pytest.mark.parametrize("field", ["current_logs", "previous_logs", "describe_output"])
def test_text_over_limit_is_422(client, field):
    r = client.post(URL, json=_body(**{field: "x" * 200_001}))
    assert r.status_code == 422, r.text
    assert client.fake.calls == 0


def test_text_at_limit_is_accepted(client):
    r = client.post(URL, json=_body(current_logs="x" * 200_000))
    assert r.status_code == 200, r.text


def test_too_many_events_is_422(client):
    ev = {"reason": "X", "message": "m"}
    assert client.post(URL, json=_body(events=[ev] * 501)).status_code == 422
    assert client.post(URL, json=_body(events=[ev] * 500)).status_code == 200


def test_invalid_cluster_id_is_422(client):
    assert client.post(URL, json=_body(cluster_id="not-a-uuid")).status_code == 422


# ── 클러스터 접근 (D-114) ───────────────────────────────────────────────────

def test_bound_cluster_outsider_is_403(client, world):
    world["user"] = world["outsider"]
    r = client.post(URL, json=_body(cluster_id=str(world["bound"].id)))
    assert r.status_code == 403, r.text
    assert client.fake.calls == 0


def test_bound_cluster_read_member_is_allowed(client, world):
    # 바인딩이 read 여도 분석은 조회 성격이라 허용된다.
    r = client.post(URL, json=_body(cluster_id=str(world["bound"].id)))
    assert r.status_code == 200, r.text


def test_open_cluster_and_no_cluster_are_allowed(client, world):
    world["user"] = world["outsider"]
    assert client.post(URL, json=_body(cluster_id=str(world["open"].id))).status_code == 200
    assert client.post(URL, json=_body()).status_code == 200


# ── 테넌트 LLM 컨텍스트 (D-114) ─────────────────────────────────────────────

def test_analysis_runs_inside_tenant_llm_context(client, world):
    r = client.post(URL, json=_body())
    assert r.status_code == 200
    seen = client.fake.seen_tenant
    assert isinstance(seen, dict) and seen["id"] == str(world["tenant"].id)
    assert current_llm_tenant() is None  # 요청 밖으로 새지 않는다


def test_non_member_has_no_tenant_context(client, world):
    world["user"] = world["outsider"]
    assert client.post(URL, json=_body()).status_code == 200
    assert client.fake.seen_tenant is None


# ── 감사 로그 (D-114) ───────────────────────────────────────────────────────

def test_audit_log_one_row_without_log_body(client, world, db):
    r = client.post(URL, json=_body(cluster_id=str(world["bound"].id), previous_logs="prev"))
    assert r.status_code == 200
    rows = (
        db.query(AuditLog)
        .filter(AuditLog.actor_user_id == world["member"].id, AuditLog.action == "incident.analyze")
        .all()
    )
    assert len(rows) == 1
    row = rows[0]
    assert row.status == "success"
    assert row.target_type == "cluster" and row.target_id == str(world["bound"].id)
    d = row.details
    assert d["namespace"] == "prod" and d["pod"] == "api-0"
    assert d["input"] == {
        "current_logs_chars": len(LOG_MARKER), "previous_logs_chars": 4,
        "describe_chars": len("Name: api-0"), "events": 1,
    }
    assert d["analyzer"] == "local_llm:prof:model"
    assert d["degraded"] is False
    assert LOG_MARKER not in json.dumps(d, ensure_ascii=False)


def test_audit_failure_does_not_block_analysis(client, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("audit down")

    monkeypatch.setattr(analyze.audit_logger, "record", boom)
    assert client.post(URL, json=_body()).status_code == 200


def test_analyzer_exception_is_502_and_audited_as_failure(client, world, db):
    client.fake.raises = RuntimeError("kaboom")
    r = client.post(URL, json=_body())
    assert r.status_code == 502
    assert "kaboom" in r.json()["detail"]
    row = (
        db.query(AuditLog)
        .filter(AuditLog.actor_user_id == world["member"].id, AuditLog.action == "incident.analyze")
        .one()
    )
    assert row.status == "failure"
    assert row.target_type == "pod" and row.target_id == "prod/api-0"


# ── 결과 정규화·degraded (D-115) ────────────────────────────────────────────

def test_degraded_and_citations_are_returned(client):
    client.fake.result_kwargs = {
        "degraded": True, "degraded_reason": "LLM 호출 실패 (offline)",
        "citations": [{"title": "런북", "source_type": "work_guide", "ref_id": "1",
                       "route": "/x", "snippet": "s", "similarity": 0.9}],
    }
    r = client.post(URL, json=_body())
    assert r.status_code == 200
    res = r.json()["result"]
    assert r.json()["status"] == "ok"
    assert res["degraded"] is True
    assert res["degraded_reason"] == "LLM 호출 실패 (offline)"
    assert res["citations"][0]["title"] == "런북"


def test_default_not_degraded(client):
    res = client.post(URL, json=_body()).json()["result"]
    assert res["degraded"] is False and res["degraded_reason"] is None


@pytest.mark.parametrize("raw, expected", [
    (0.7, 0.7), (1, 1.0), (85, 0.85), ("85%", 0.85), (250, 1.0), (-0.3, 0.0), (float("nan"), 0.0),
    # 1 초과 맨 숫자는 퍼센트로 낮게 읽는다(5 → 5%, 50% 로 부풀리지 않는다). 10점 척도는 분수로만.
    (8, 0.08), (5, 0.05), ("7.5", 0.075), (10, 0.1), (40, 0.4), ("8/10", 0.8), ("3/0", 0.5),
    # NaN·inf 는 최고 신뢰도로 올리지 않는다, bool 은 숫자로 보지 않는다.
    ("nan%", 0.0), ("nan/1", 0.0), (float("inf"), 0.0), ("inf", 0.0), ("1/inf", 0.5), (True, 0.5),
    ("High", 0.8), ("very low", 0.1), ("0.9", 0.9),
    # 해석 불가는 중립값 — 0.0 은 degraded 표식과 겹친다.
    ("abc", 0.5), (None, 0.5), ("x/10", 0.5),
])
def test_clamp_confidence(raw, expected):
    assert clamp_confidence(raw) == pytest.approx(expected)


@pytest.mark.parametrize("raw, expected", [
    ("critical", "critical"), ("Warning ", "warning"), (None, "info"), ("", "info"), ("bogus", "info"),
    # LLM 동의어는 위험도를 낮추지 않는다
    ("high", "critical"), ("Error", "critical"), ("severe", "critical"),
    ("medium", "warning"), ("moderate", "warning"), ("low", "info"),
])
def test_normalize_severity(raw, expected):
    assert normalize_severity(raw) == expected


def test_out_of_range_llm_values_do_not_500(client):
    client.fake.result_kwargs = {"severity": "HIGH", "confidence": 92, "suggested_actions": "재시작"}
    r = client.post(URL, json=_body())
    assert r.status_code == 200, r.text
    res = r.json()["result"]
    assert res["severity"] == "critical"  # HIGH → critical (동의어)
    assert res["confidence"] == pytest.approx(0.92)
    assert res["suggested_actions"] == ["재시작"]


def test_local_llm_unavailable_is_degraded(monkeypatch):
    from app.services.analyzers import local_llm_analyzer as mod
    from app.services.analyzers.base import IncidentContext

    async def fake_chat(purpose, prompt):
        return SimpleNamespace(status="offline", error="connection refused", profile="p", model="m", text="")

    monkeypatch.setattr(mod.llm_service, "chat_for_purpose", fake_chat)
    ctx = IncidentContext(pod_name="p", namespace="n", timestamp="t", events=[], current_logs="",
                          describe_output="")
    res = asyncio.run(mod.LocalLLMAnalyzer().analyze(ctx))
    assert res.degraded is True
    assert "offline" in (res.degraded_reason or "")


def test_local_llm_unparseable_is_degraded_and_parsed_is_clamped(monkeypatch):
    from app.services.analyzers import local_llm_analyzer as mod
    from app.services.analyzers.base import IncidentContext

    replies = iter(["이건 JSON 이 아닙니다",
                    '{"severity":"severe","root_cause":"x","suggested_actions":[],"confidence":75}'])

    async def fake_chat(purpose, prompt):
        return SimpleNamespace(status="ok", error=None, profile="p", model="m", text=next(replies))

    monkeypatch.setattr(mod.llm_service, "chat_for_purpose", fake_chat)
    ctx = IncidentContext(pod_name="p", namespace="n", timestamp="t", events=[], current_logs="",
                          describe_output="")
    bad = asyncio.run(mod.LocalLLMAnalyzer().analyze(ctx))
    assert bad.degraded is True and "파싱" in (bad.degraded_reason or "")
    ok = asyncio.run(mod.LocalLLMAnalyzer().analyze(ctx))
    assert ok.degraded is False
    assert ok.severity == "critical" and ok.confidence == pytest.approx(0.75)


def test_claude_api_error_and_bad_json_are_degraded():
    from app.services.analyzers.base import IncidentContext
    from app.services.analyzers.claude_analyzer import ClaudeAnalyzer

    ctx = IncidentContext(pod_name="p", namespace="n", timestamp="t", events=[], current_logs="",
                          describe_output="")
    an = ClaudeAnalyzer(api_key="test")

    async def raising(_msg):
        raise ConnectionError("network down")

    an._create = raising  # type: ignore[method-assign]
    res = asyncio.run(an.analyze(ctx))
    assert res.degraded is True and "network down" in (res.degraded_reason or "")
    assert res.analyzed_by == "claude"

    async def junk(_msg):
        return SimpleNamespace(content=[SimpleNamespace(type="text", text="not json")])

    an._create = junk  # type: ignore[method-assign]
    res = asyncio.run(an.analyze(ctx))
    assert res.degraded is True and "파싱" in (res.degraded_reason or "")


# ── 컨텍스트 수집: 컨테이너 선택·예외 매핑·init 이상 (D-115) ───────────────

def _cs(name, *, waiting=None, terminated=None, exit_code=0, restarts=0, running=False):
    state = SimpleNamespace(
        running=SimpleNamespace(started_at="t") if running else None,
        waiting=SimpleNamespace(reason=waiting, message=None) if waiting else None,
        terminated=(SimpleNamespace(reason=terminated, exit_code=exit_code, message=None)
                    if terminated else None),
    )
    return SimpleNamespace(name=name, state=state, restart_count=restarts, ready=running)


def _pod(containers, inits=(), statuses=(), init_statuses=(), annotations=None, phase="Running"):
    return SimpleNamespace(
        metadata=SimpleNamespace(name="api-0", namespace="prod", annotations=annotations,
                                 creation_timestamp=None, labels=None),
        spec=SimpleNamespace(
            containers=[SimpleNamespace(name=n, image="img") for n in containers],
            init_containers=[SimpleNamespace(name=n, image="img") for n in inits],
            node_name="node-1",
        ),
        status=SimpleNamespace(phase=phase, container_statuses=list(statuses),
                               init_container_statuses=list(init_statuses), pod_ip=None, start_time=None),
    )


def test_pick_container_prefers_annotation():
    pod = _pod(["app", "sidecar"], statuses=[_cs("app", waiting="CrashLoopBackOff", restarts=9)],
               annotations={"kubectl.kubernetes.io/default-container": "sidecar"})
    assert analyze._pick_container(pod, prefer_failing=True) == "sidecar"


def test_pick_container_ignores_unknown_annotation():
    pod = _pod(["app"], annotations={"kubectl.kubernetes.io/default-container": "ghost"})
    assert analyze._pick_container(pod, prefer_failing=True) == "app"


def test_pick_container_prefers_failing_then_restarts():
    pod = _pod(["app", "proxy"], statuses=[
        _cs("app", running=True, restarts=3),
        _cs("proxy", waiting="CrashLoopBackOff", restarts=1),
    ])
    assert analyze._pick_container(pod, prefer_failing=True) == "proxy"
    pod2 = _pod(["app", "proxy"], statuses=[_cs("app", running=True), _cs("proxy", running=True, restarts=4)])
    assert analyze._pick_container(pod2, prefer_failing=True) == "proxy"


def test_pick_container_failing_init_wins():
    pod = _pod(["app"], inits=["migrate"],
               statuses=[_cs("app", waiting="PodInitializing")],
               init_statuses=[_cs("migrate", terminated="Error", exit_code=1, restarts=2)],
               phase="Pending")
    assert analyze._pick_container(pod, prefer_failing=True) == "migrate"
    # 셀렉터 기본값(containers 엔드포인트)은 실패 우선을 쓰지 않는다
    assert analyze._pick_container(pod, prefer_failing=False) == "app"


def test_pick_container_skips_completed_init_with_restarts():
    # 재시작 끝에 정상 완료한 init 은 분석 대상이 아니다(_pod_issue 와 같은 규칙)
    pod = _pod(["app"], inits=["wait-db"],
               statuses=[_cs("app", running=True)],
               init_statuses=[_cs("wait-db", terminated="Completed", exit_code=0, restarts=3)])
    assert analyze._pick_container(pod, prefer_failing=True) == "app"
    # 일반 컨테이너가 재시작 중이면 그쪽을 고른다
    pod2 = _pod(["app"], inits=["wait-db"],
                statuses=[_cs("app", running=True, restarts=2)],
                init_statuses=[_cs("wait-db", terminated="Completed", exit_code=0, restarts=5)])
    assert analyze._pick_container(pod2, prefer_failing=True) == "app"


def test_pick_container_falls_back_to_first():
    pod = _pod(["app", "sidecar"], statuses=[_cs("app", running=True), _cs("sidecar", running=True)])
    assert analyze._pick_container(pod, prefer_failing=True) == "app"


def test_pod_issue_sees_init_containers():
    pod = _pod(["app"], inits=["migrate"],
               statuses=[_cs("app", waiting="PodInitializing")],
               init_statuses=[_cs("migrate", waiting="CrashLoopBackOff", restarts=6)],
               phase="Pending")
    assert analyze._pod_issue(pod) == (True, "Init:CrashLoopBackOff")
    pod2 = _pod(["app"], inits=["migrate"],
                statuses=[_cs("app", running=True)],
                init_statuses=[_cs("migrate", terminated="Completed", exit_code=0)])
    assert analyze._pod_issue(pod2) == (False, None)


def test_pod_issue_ignores_completed_init_with_many_restarts():
    # DB 를 기다리며 여러 번 재시작했지만 결국 정상 완료한 init — 계속 이상으로 남지 않는다
    pod = _pod(["app"], inits=["wait-db"],
               statuses=[_cs("app", running=True)],
               init_statuses=[_cs("wait-db", terminated="Completed", exit_code=0, restarts=7)])
    assert analyze._pod_issue(pod) == (False, None)
    # 아직 완료하지 못한 채 재시작이 많으면 여전히 이상
    pod2 = _pod(["app"], inits=["wait-db"],
                statuses=[_cs("app", waiting="PodInitializing")],
                init_statuses=[_cs("wait-db", running=True, restarts=7)],
                phase="Pending")
    assert analyze._pod_issue(pod2) == (True, "Init:Restarts=7")


class _FakeV1:
    def __init__(self, pod=None, exc=None):
        self.pod = pod
        self.exc = exc
        self.log_calls: list[dict] = []

    def read_namespaced_pod(self, name, namespace, **kw):
        if self.exc:
            raise self.exc
        return self.pod

    def read_namespaced_pod_log(self, name, namespace, **kw):
        self.log_calls.append(kw)
        if kw.get("previous"):
            raise ApiException(status=400, reason="previous terminated container not found")
        return f"log of {kw.get('container')}"

    def list_namespaced_event(self, namespace, **kw):
        return SimpleNamespace(items=[])


@pytest.mark.parametrize("exc, code", [
    (ApiException(status=404, reason="Not Found"), 404),
    (ApiException(status=403, reason="Forbidden"), 403),
    (ApiException(status=500, reason="Internal"), 502),
    (ConnectionError("refused"), 502),
])
def test_context_pod_errors_are_mapped(client, world, monkeypatch, exc, code):
    monkeypatch.setattr(analyze, "_get_core_v1", lambda cluster: _FakeV1(exc=exc))
    r = client.get(f"/api/v1/analyze/clusters/{world['open'].id}/namespaces/prod/pods/api-0/context")
    assert r.status_code == code, r.text
    assert r.json()["detail"]


def test_context_returns_selected_container(client, world, monkeypatch):
    pod = _pod(["app", "proxy"], statuses=[_cs("app", running=True),
                                         _cs("proxy", waiting="CrashLoopBackOff", restarts=2)])
    v1 = _FakeV1(pod=pod)
    monkeypatch.setattr(analyze, "_get_core_v1", lambda cluster: v1)
    base = f"/api/v1/analyze/clusters/{world['open'].id}/namespaces/prod/pods/api-0/context"

    r = client.get(base)
    assert r.status_code == 200, r.text
    assert r.json()["container"] == "proxy"
    assert r.json()["current_logs"] == "log of proxy"

    r = client.get(base, params={"container": "app"})
    assert r.json()["container"] == "app"

    r = client.get(base, params={"container": "ghost"})
    assert r.status_code == 422


def test_containers_endpoint_maps_pod_errors(client, world, monkeypatch):
    monkeypatch.setattr(analyze, "_get_core_v1",
                        lambda cluster: _FakeV1(exc=ApiException(status=404, reason="Not Found")))
    r = client.get(f"/api/v1/analyze/clusters/{world['open'].id}/namespaces/prod/pods/api-0/containers")
    assert r.status_code == 404


# ── D-114 잔여: Claude 분석기의 테넌트 라우팅·사용량 귀속 ───────────────────────

def _settings_with_profiles(*names):
    return {"profiles": [{"name": n} for n in names], "routing": {}, "analyzer_backend": "claude"}


@pytest.mark.parametrize("routing, profiles, expected", [
    ({"incident_analysis": {"primary": "onprem"}}, ("onprem",), "LocalLLMAnalyzer"),  # 테넌트 지정 → 게이트웨이
    ({"incident_analysis": {"primary": "gone"}}, ("onprem",), "ClaudeAnalyzer"),      # 없는 프로필은 무시
    ({"chat": {"primary": "onprem"}}, ("onprem",), "ClaudeAnalyzer"),                  # 다른 용도 지정은 무관
    (None, ("onprem",), "ClaudeAnalyzer"),                                             # 테넌트 없음
])
def test_factory_honours_tenant_incident_llm(monkeypatch, routing, profiles, expected):
    from app.services.analyzers import factory
    from app.services.llm.service import llm_tenant_context

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(factory, "get_analyzer_backend", lambda db=None: "claude")
    monkeypatch.setattr(factory.llm_service, "resolve_settings", lambda db=None: _settings_with_profiles(*profiles))
    tenant = None if routing is None else {"id": "t1", "name": "t", "routing": routing}
    with llm_tenant_context(tenant):
        analyzer = factory.get_analyzer()
    assert type(analyzer).__name__ == expected


def test_analyzer_is_selected_inside_tenant_context(world, monkeypatch):
    """분석기 선택(get_analyzer)이 사용자 테넌트 컨텍스트 안에서 일어나야 factory 가 테넌트 지정을 본다."""
    from fastapi.testclient import TestClient

    from app.auth.deps import get_current_user
    from app.main import app

    seen: list = []

    def _get(db=None):
        seen.append(current_llm_tenant())
        return _FakeAnalyzer()

    monkeypatch.setattr(analyze, "get_analyzer", _get)
    app.dependency_overrides[get_current_user] = lambda: world["member"]
    try:
        r = TestClient(app).post(URL, json=_body())
    finally:
        app.dependency_overrides.pop(get_current_user, None)
    assert r.status_code == 200, r.text
    assert seen and seen[0] is not None and seen[0]["id"] == str(world["tenant"].id)


def test_claude_analyzer_records_usage(monkeypatch):
    from app.services.analyzers import claude_analyzer as mod
    from app.services.analyzers.base import IncidentContext
    from app.services.llm.service import llm_tenant_context

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    calls: list = []
    monkeypatch.setattr(mod.llm_service, "record_external_usage",
                        lambda profile, purpose, result: calls.append((profile, purpose, result, current_llm_tenant())))
    ctx = IncidentContext(pod_name="p", namespace="n", timestamp="t", events=[], current_logs="", describe_output="")

    ok_resp = SimpleNamespace(
        content=[SimpleNamespace(type="text", text='{"severity":"warning","root_cause":"x","suggested_actions":[],"confidence":0.6}')],
        usage=SimpleNamespace(input_tokens=120, output_tokens=30),
    )
    a = mod.ClaudeAnalyzer()

    async def ok_create(_msg):
        return ok_resp
    monkeypatch.setattr(a, "_create", ok_create)
    with llm_tenant_context({"id": "t1", "name": "t", "routing": {}}):
        res = asyncio.run(a.analyze(ctx))
    assert res.degraded is False
    profile, purpose, result, tenant = calls[-1]
    assert (profile, purpose, result.status) == ("claude", "incident_analysis", "ok")
    assert (result.prompt_tokens, result.completion_tokens) == (120, 30)
    assert tenant and tenant["id"] == "t1"  # 테넌트 사용량에 귀속

    async def boom(_msg):
        raise RuntimeError("api down")
    monkeypatch.setattr(a, "_create", boom)
    res = asyncio.run(a.analyze(ctx))
    assert res.degraded is True
    assert calls[-1][2].status == "error" and "api down" in (calls[-1][2].error or "")
