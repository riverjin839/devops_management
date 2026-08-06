"""DeepCheckerBase 의 K8s API 타임아웃 보호(``_TimeoutGuardedApi``) 단위 테스트.

배경: 여러 deep checker 가 ``self._v1(ctx)`` 로 받은 CoreV1Api 클라이언트에
``_request_timeout`` 없이 호출하고 있었다. kubernetes 파이썬 클라이언트는 호출마다
넘기지 않으면 무한 대기하는데, 다운된 API 서버(포트 6443)에 물리면 Celery soft time
limit(240s)까지 블로킹하다 ``SoftTimeLimitExceeded`` 로 죽는다(사용자 리포트:
"HTTPSConnectionPool(host=.., port=6443): Max retries exceeded" + softTimeLimitExceeded).
``_v1()``/``_wrap_api()`` 가 반환하는 프록시가 모든 호출에 기본 타임아웃을 강제로
주입해 이 실수를 구조적으로 막는다 — 이 파일은 그 프록시 자체를 DB-free 로 검증한다.
"""
from app.models import StatusEnum
from app.services.deep_checkers.base import (
    DeepCheckContext,
    DeepCheckerBase,
    DeepCheckOutcome,
    _CONNECTION_ERROR_HINTS,
    _K8S_API_TIMEOUT_SECONDS,
    _TLS_ERROR_HINTS,
    _TimeoutGuardedApi,
)


class _FakeApi:
    """kubernetes CoreV1Api 를 흉내낸 더블 — 호출 kwargs 를 그대로 기록만 한다."""

    def __init__(self):
        self.api_client = object()  # 실제 라이브러리처럼 non-callable 속성도 하나 둔다.
        self.calls = []

    def list_namespaced_pod(self, namespace, **kwargs):
        self.calls.append(("list_namespaced_pod", namespace, kwargs))
        return kwargs.get("_request_timeout")


class TestTimeoutGuardedApi:
    def test_injects_default_timeout_when_caller_omits_it(self):
        fake = _FakeApi()
        wrapped = _TimeoutGuardedApi(fake)

        result = wrapped.list_namespaced_pod("default")

        assert result == _K8S_API_TIMEOUT_SECONDS
        assert fake.calls[0][2]["_request_timeout"] == _K8S_API_TIMEOUT_SECONDS

    def test_respects_caller_supplied_timeout(self):
        fake = _FakeApi()
        wrapped = _TimeoutGuardedApi(fake)

        result = wrapped.list_namespaced_pod("default", _request_timeout=5)

        assert result == 5
        assert fake.calls[0][2]["_request_timeout"] == 5

    def test_non_callable_attribute_passthrough(self):
        fake = _FakeApi()
        wrapped = _TimeoutGuardedApi(fake)

        # RbacAuthorizationV1Api(api_client=v1.api_client) 같은 패턴이 깨지지 않아야 한다.
        assert wrapped.api_client is fake.api_client

    def test_wrap_api_helper_wraps_arbitrary_api_object(self):
        fake = _FakeApi()
        wrapped = DeepCheckerBase._wrap_api(fake)

        assert isinstance(wrapped, _TimeoutGuardedApi)
        wrapped.list_namespaced_pod("kube-system")
        assert fake.calls[0][2]["_request_timeout"] == _K8S_API_TIMEOUT_SECONDS


class TestConnectionErrorHints:
    def test_soft_time_limit_exceeded_is_classified_as_connection_style(self):
        # SoftTimeLimitExceeded 의 기본 str() 은 "SoftTimeLimitExceeded()" 정도라
        # 기존 힌트("timeout" 등)에 안 걸렸다 — safe_run() 이 critical 대신 pending 으로
        # 분류하도록 힌트에 추가했는지 확인.
        assert any(h in "softtimelimitexceeded()" for h in _CONNECTION_ERROR_HINTS)


def _raising_checker(exc: Exception):
    class _RaisingChecker(DeepCheckerBase):
        check_type = "raising_fake"
        display_name = "가짜 체커"

        def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
            raise exc

    return _RaisingChecker()


class TestSafeRunClassification:
    """safe_run() 의 예외 → StatusEnum 분류. TLS 문제는 "연결 실패"와 겹쳐 보이는
    문자열(Max retries exceeded)을 공유하지만, 실제로는 재시도로 낫지 않는 지속적
    설정 오류라 pending 이 아니라 critical + 구체적 안내로 분류돼야 한다."""

    def test_pure_connection_error_is_pending(self):
        exc = Exception("HTTPSConnectionPool(host='10.0.0.5', port=6443): Max retries exceeded (Connection refused)")
        outcome = _raising_checker(exc).safe_run(DeepCheckContext())

        assert outcome.status == StatusEnum.pending

    def test_tls_certificate_error_is_critical_with_guidance_not_pending(self):
        exc = Exception(
            "HTTPSConnectionPool(host='10.0.0.5', port=6443): Max retries exceeded with url: /api/v1/nodes "
            "(Caused by SSLError(SSLCertVerificationError(1, '[SSL: CERTIFICATE_VERIFY_FAILED] "
            "certificate verify failed: unable to get local issuer certificate')))"
        )
        outcome = _raising_checker(exc).safe_run(DeepCheckContext())

        assert outcome.status == StatusEnum.critical
        assert "kubeconfig" in outcome.message
        assert "TLS" in outcome.message or "인증서" in outcome.message

    def test_x509_error_is_critical_with_guidance(self):
        exc = Exception("x509: certificate signed by unknown authority")
        outcome = _raising_checker(exc).safe_run(DeepCheckContext())

        assert outcome.status == StatusEnum.critical
        assert "kubeconfig" in outcome.message

    def test_generic_exception_is_critical_without_tls_guidance(self):
        exc = ValueError("unexpected null field in response")
        outcome = _raising_checker(exc).safe_run(DeepCheckContext())

        assert outcome.status == StatusEnum.critical
        assert "kubeconfig" not in outcome.message

    def test_soft_time_limit_exceeded_end_to_end_is_pending_not_critical(self):
        exc = Exception("SoftTimeLimitExceeded()")
        outcome = _raising_checker(exc).safe_run(DeepCheckContext())

        assert outcome.status == StatusEnum.pending


class TestTlsErrorHints:
    def test_hints_cover_common_openssl_and_x509_messages(self):
        samples = [
            "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed",
            "x509: certificate signed by unknown authority",
            "certificate has expired or is not yet valid",
        ]
        for s in samples:
            lowered = s.lower()
            assert any(h in lowered for h in _TLS_ERROR_HINTS), s


class TestStepFailureLogging:
    """_step() 이 실패로 끝나면(예외든, 체커가 직접 status="failed" 만 세팅하고 정상
    반환하든) 서버 로그에 한 곳에서 남는지 검증한다.

    배경: 각 체커가 흔히 쓰는 "권한 부족/바이너리 없음 등으로 st.status='failed' 를
    직접 세팅하고 pending DeepCheckOutcome 을 반환"하는 경로는 예외를 던지지 않아
    safe_run() 의 일반 예외 로깅을 타지 않는다 — 실사례(cert_expiry 의 kubectl exec
    실패)에서 DB/steps 에만 기록되고 서버 로그(journalctl 등)에는 아무 흔적도 없었다.
    개별 체커마다 logger 호출을 추가하는 대신 _step() 한 곳에서 잡아야 앞으로 추가될
    체커도 별도 조치 없이 커버된다.
    """

    def _checker_with_manual_failure(self):
        class _ManualFailChecker(DeepCheckerBase):
            check_type = "manual_fail_fake"
            display_name = "가짜 체커"

            def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
                with self._step("probe", "프로브 실행") as st:
                    st.status = "failed"
                    st.detail = "권한 부족: RBAC forbidden"
                return DeepCheckOutcome(status=StatusEnum.pending, message="probe 실패")

        return _ManualFailChecker()

    def _checker_with_raising_step(self):
        class _RaisingStepChecker(DeepCheckerBase):
            check_type = "raising_step_fake"
            display_name = "가짜 체커"

            def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
                with self._step("probe", "프로브 실행"):
                    raise RuntimeError("boom")

        return _RaisingStepChecker()

    def test_manual_status_failed_without_exception_is_logged(self, caplog):
        from types import SimpleNamespace

        ctx = DeepCheckContext(cluster=SimpleNamespace(name="prod-a"))

        with caplog.at_level("WARNING", logger="app.services.deep_checkers.base"):
            self._checker_with_manual_failure().safe_run(ctx)

        assert any(
            "manual_fail_fake" in r.message and "prod-a" in r.message
            and "probe" in r.message and "RBAC forbidden" in r.message
            for r in caplog.records
        ), [r.message for r in caplog.records]

    def test_exception_inside_step_is_also_logged_with_step_context(self, caplog):
        from types import SimpleNamespace

        ctx = DeepCheckContext(cluster=SimpleNamespace(name="prod-b"))

        with caplog.at_level("WARNING", logger="app.services.deep_checkers.base"):
            self._checker_with_raising_step().safe_run(ctx)

        assert any(
            "raising_step_fake" in r.message and "prod-b" in r.message and "probe" in r.message
            for r in caplog.records
        ), [r.message for r in caplog.records]

    def test_missing_cluster_label_falls_back_without_crashing(self):
        ctx = DeepCheckContext(cluster=None)

        outcome = self._checker_with_manual_failure().safe_run(ctx)

        assert outcome.status == StatusEnum.pending

    def test_successful_step_is_not_logged(self, caplog):
        class _OkChecker(DeepCheckerBase):
            check_type = "ok_fake"
            display_name = "가짜 체커"

            def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
                with self._step("probe", "프로브 실행") as st:
                    st.detail = "정상"
                return DeepCheckOutcome(status=StatusEnum.healthy, message="ok")

        with caplog.at_level("WARNING", logger="app.services.deep_checkers.base"):
            _OkChecker().safe_run(DeepCheckContext())

        assert caplog.records == []
