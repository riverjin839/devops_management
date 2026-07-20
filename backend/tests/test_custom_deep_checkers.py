"""커스텀(템플릿형) deep checker 단위 테스트 — 클러스터/DB 불필요.

custom_http / custom_kubectl / custom_promql 은 admin 이 UI 에서 params 만으로
새 점검을 정의하는 범용 체커다. registry 등록/시드 제외 플래그와 판정 로직을 검증한다.
"""
from types import SimpleNamespace as NS

from app.models import StatusEnum
from app.services.deep_checkers.base import DeepCheckContext
from app.services.deep_checkers.custom_http_checker import CustomHttpChecker, _parse_status_range
from app.services.deep_checkers.custom_kubectl_checker import CustomKubectlChecker
from app.services.deep_checkers.custom_promql_checker import CustomPromqlChecker
from app.services.deep_checkers.registry import REGISTRY, get_step_plan, list_check_types


# ── registry 계약 ─────────────────────────────────────────────────────────

def test_custom_types_registered_and_not_seeded():
    for ct in ("custom_http", "custom_kubectl", "custom_promql"):
        assert ct in REGISTRY
        spec = REGISTRY[ct][1]
        assert spec.seed_default is False
        assert spec.default_enabled is False
        assert get_step_plan(ct), f"{ct} step plan missing"

    serialized = {t["check_type"]: t for t in list_check_types()}
    assert serialized["custom_http"]["seed_default"] is False
    # 내장 체커는 seed_default True 유지
    assert serialized["cert_expiry"]["seed_default"] is True


# ── custom_http ──────────────────────────────────────────────────────────

def test_parse_status_range():
    assert _parse_status_range("200-399") == (200, 399)
    assert _parse_status_range("200") == (200, 200)
    assert _parse_status_range("garbage") == (200, 399)


def test_custom_http_pending_without_endpoints():
    out = CustomHttpChecker().safe_run(DeepCheckContext(thresholds={}, params={}))
    assert out.status == StatusEnum.pending


def test_custom_http_failure_pct_verdict(monkeypatch):
    calls = iter([
        {"kind": "http", "ok": True, "latency_ms": 10},
        {"kind": "http", "ok": False, "error": "boom"},
    ])
    monkeypatch.setattr(
        CustomHttpChecker, "_probe_http",
        staticmethod(lambda url, **kw: next(calls)),
    )
    ctx = DeepCheckContext(
        thresholds={"warning_failure_pct": 10, "critical_failure_pct": 60},
        params={"endpoints": ["http://a", "http://b"]},
    )
    out = CustomHttpChecker().safe_run(ctx)
    assert out.status == StatusEnum.warning
    assert out.details["failure_pct"] == 50.0
    assert [s["id"] for s in out.steps] == ["resolve", "probe", "verdict"]


def test_custom_http_latency_threshold(monkeypatch):
    monkeypatch.setattr(
        CustomHttpChecker, "_probe_http",
        staticmethod(lambda url, **kw: {"kind": "http", "ok": True, "latency_ms": 900}),
    )
    ctx = DeepCheckContext(
        thresholds={
            "warning_failure_pct": 10, "critical_failure_pct": 60,
            "warning_latency_ms": 500, "critical_latency_ms": 2000,
        },
        params={"endpoints": ["http://a"]},
    )
    out = CustomHttpChecker().safe_run(ctx)
    assert out.status == StatusEnum.warning


# ── custom_kubectl ───────────────────────────────────────────────────────

def _kubectl_ctx(thresholds=None, **params):
    return DeepCheckContext(thresholds=thresholds or {}, params=params)


def test_custom_kubectl_pending_without_args():
    out = CustomKubectlChecker().safe_run(_kubectl_ctx())
    assert out.status == StatusEnum.pending


def test_custom_kubectl_blocks_mutating_verbs():
    out = CustomKubectlChecker().safe_run(_kubectl_ctx(args="delete pod x"))
    assert out.status == StatusEnum.critical
    assert "차단" in out.message


def test_custom_kubectl_lines_parse_and_verdict(monkeypatch):
    monkeypatch.setattr(
        CustomKubectlChecker, "_kubectl",
        lambda self, ctx, *a, **kw: NS(returncode=0, stdout="pod/a\npod/b\npod/c\n", stderr=""),
    )
    out = CustomKubectlChecker().safe_run(_kubectl_ctx(
        thresholds={"warning_value": 1, "critical_value": 3, "compare": "gte"},
        args="get pods -o name", parse_mode="lines",
    ))
    assert out.status == StatusEnum.critical
    assert out.details["value"] == 3.0


def test_custom_kubectl_lte_compare(monkeypatch):
    monkeypatch.setattr(
        CustomKubectlChecker, "_kubectl",
        lambda self, ctx, *a, **kw: NS(returncode=0, stdout="5", stderr=""),
    )
    out = CustomKubectlChecker().safe_run(_kubectl_ctx(
        thresholds={"warning_value": 3, "critical_value": 1, "compare": "lte"},
        args="get nodes", parse_mode="number",
    ))
    assert out.status == StatusEnum.healthy


def test_custom_kubectl_nonzero_exit(monkeypatch):
    monkeypatch.setattr(
        CustomKubectlChecker, "_kubectl",
        lambda self, ctx, *a, **kw: NS(returncode=1, stdout="", stderr="forbidden"),
    )
    out = CustomKubectlChecker().safe_run(_kubectl_ctx(args="get pods"))
    assert out.status == StatusEnum.critical
    assert "forbidden" in out.message


# ── custom_promql ────────────────────────────────────────────────────────

def test_custom_promql_pending_without_query():
    out = CustomPromqlChecker().safe_run(DeepCheckContext(thresholds={}, params={}))
    assert out.status == StatusEnum.pending


def test_custom_promql_extract_and_aggregate():
    data = {
        "resultType": "vector",
        "result": [
            {"metric": {"pod": "a"}, "value": [0, "3"]},
            {"metric": {"pod": "b"}, "value": [0, "7"]},
        ],
    }
    samples = CustomPromqlChecker._extract_samples(data)
    assert [s["value"] for s in samples] == [3.0, 7.0]
    assert CustomPromqlChecker._aggregate(samples, "max") == 7.0
    assert CustomPromqlChecker._aggregate(samples, "sum") == 10.0
    assert CustomPromqlChecker._aggregate(samples, "count") == 2.0
    assert CustomPromqlChecker._aggregate([], "max") is None


def test_custom_promql_verdict(monkeypatch):
    class _FakeResp:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "status": "success",
                "data": {"resultType": "vector",
                         "result": [{"metric": {}, "value": [0, "9"]}]},
            }

    class _FakeClient:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url, params=None):
            return _FakeResp()

    import app.services.deep_checkers.custom_promql_checker as mod
    monkeypatch.setattr(mod.httpx, "Client", _FakeClient)
    out = CustomPromqlChecker().safe_run(DeepCheckContext(
        thresholds={"warning_value": 5, "critical_value": 10, "compare": "gte"},
        params={"query": "up"},
    ))
    assert out.status == StatusEnum.warning
    assert out.details["value"] == 9.0
