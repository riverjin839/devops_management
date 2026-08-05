"""DeepCheckerBase 의 K8s API 타임아웃 보호(``_TimeoutGuardedApi``) 단위 테스트.

배경: 여러 deep checker 가 ``self._v1(ctx)`` 로 받은 CoreV1Api 클라이언트에
``_request_timeout`` 없이 호출하고 있었다. kubernetes 파이썬 클라이언트는 호출마다
넘기지 않으면 무한 대기하는데, 다운된 API 서버(포트 6443)에 물리면 Celery soft time
limit(240s)까지 블로킹하다 ``SoftTimeLimitExceeded`` 로 죽는다(사용자 리포트:
"HTTPSConnectionPool(host=.., port=6443): Max retries exceeded" + softTimeLimitExceeded).
``_v1()``/``_wrap_api()`` 가 반환하는 프록시가 모든 호출에 기본 타임아웃을 강제로
주입해 이 실수를 구조적으로 막는다 — 이 파일은 그 프록시 자체를 DB-free 로 검증한다.
"""
from app.services.deep_checkers.base import (
    DeepCheckerBase,
    _CONNECTION_ERROR_HINTS,
    _K8S_API_TIMEOUT_SECONDS,
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
