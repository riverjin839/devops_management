"""k8s_client_pool — 대상 K8s 호출의 성능·안정성 기본값 검증 (클러스터 연결 없이)."""
import threading
from types import SimpleNamespace

import pytest
from kubernetes import client as k8s_client, config as k8s_config
from kubernetes.stream.stream import _websocket_request

from app.services import k8s_client_pool as pool

_KUBECONFIG = """apiVersion: v1
kind: Config
clusters:
- name: c
  cluster:
    server: https://{host}:6443
    insecure-skip-tls-verify: true
contexts:
- name: c
  context: {{cluster: c, user: u}}
current-context: c
users:
- name: u
  user: {{token: abc}}
"""


@pytest.fixture(autouse=True)
def _clean_pool():
    pool.invalidate()
    yield
    pool.invalidate()


@pytest.fixture
def kc(tmp_path):
    p = tmp_path / "kc.yaml"
    p.write_text(_KUBECONFIG.format(host="a.example"), encoding="utf-8")
    return p


@pytest.fixture
def captured(monkeypatch):
    """ApiClient.request 를 가로채 네트워크 없이 넘겨받은 인자를 기록."""
    calls: list[dict] = []

    def fake(self, method, url, **kw):
        calls.append({"method": method, "url": url, **kw})
        return "ok"

    monkeypatch.setattr(k8s_client.ApiClient, "request", fake)
    return calls


def test_default_timeout_injected_when_missing(kc, captured):
    c = pool.get_api_client_for_path(str(kc))
    c.request("GET", "/api/v1/pods")
    assert captured[-1]["_request_timeout"] == pool.DEFAULT_TIMEOUT


def test_explicit_timeout_and_streaming_are_respected(kc, captured):
    c = pool.get_api_client_for_path(str(kc))
    c.request("GET", "/x", _request_timeout=3)
    assert captured[-1]["_request_timeout"] == 3
    # watch / 로그 follow(_preload_content=False)는 긴 수명이 정상 — 기본값 주입 안 함
    c.request("GET", "/watch", _preload_content=False)
    assert captured[-1]["_request_timeout"] is None


def test_retry_policy_never_retries_reads(kc):
    c = pool.get_api_client_for_path(str(kc))
    r = c.configuration.retries
    assert r.read == 0          # 느린 apiserver 에 같은 LIST 를 반복하지 않는다
    assert r.connect == 1
    assert c.configuration.connection_pool_maxsize == pool.POOL_MAXSIZE


def test_client_is_reused_and_close_is_noop(kc):
    a = pool.get_api_client_for_path(str(kc))
    a.close()  # 호출부의 close() 가 공유 클라이언트를 망가뜨리지 않아야 함
    b = pool.get_api_client_for_path(str(kc))
    assert a is b
    assert pool.cache_size() == 1


def test_kubeconfig_content_change_rebuilds_and_evicts_old(kc):
    a = pool.get_api_client_for_path(str(kc))
    kc.write_text(_KUBECONFIG.format(host="b.example"), encoding="utf-8")
    b = pool.get_api_client_for_path(str(kc))
    assert a is not b
    assert b.configuration.host == "https://b.example:6443"
    assert pool.cache_size() == 1   # 같은 경로의 이전 내용 항목은 퇴출


def test_ttl_expiry_rebuilds(kc, monkeypatch):
    a = pool.get_api_client_for_path(str(kc))
    monkeypatch.setattr(pool, "CACHE_TTL", -1.0)
    pool.invalidate()
    b = pool.get_api_client_for_path(str(kc))
    c = pool.get_api_client_for_path(str(kc))  # TTL 음수 → 매번 재생성
    assert a is not b and b is not c


def test_cache_max_evicts_least_recently_used(tmp_path, monkeypatch):
    monkeypatch.setattr(pool, "CACHE_MAX", 2)
    paths = []
    for i in range(3):
        p = tmp_path / f"kc{i}.yaml"
        p.write_text(_KUBECONFIG.format(host=f"h{i}.example"), encoding="utf-8")
        paths.append(str(p))
        pool.get_api_client_for_path(str(p))
    assert pool.cache_size() == 2


def test_stream_override_is_thread_local(kc, captured):
    """kubernetes.stream 은 api_client.request 를 websocket 으로 바꿔치기한다 — 공유 클라이언트에서
    다른 스레드의 일반 요청이 websocket 으로 새면 안 된다."""
    c = pool.get_api_client_for_path(str(kc))
    in_stream = threading.Event()
    release = threading.Event()

    def fake_ws(configuration, *a, **kw):
        in_stream.set()
        release.wait(2)
        return "ws"

    class _Api:
        api_client = c

        def call(self):
            return c.request("GET", "/exec")

    out: dict = {}
    t = threading.Thread(target=lambda: out.setdefault("stream", _websocket_request(fake_ws, None, _Api().call)))
    t.start()
    assert in_stream.wait(2)
    out["other"] = c.request("GET", "/api/v1/nodes")   # 다른 스레드 — 일반 경로여야 함
    release.set()
    t.join(2)
    assert out == {"stream": "ws", "other": "ok"}
    assert c.request("GET", "/after") == "ok"          # stream 종료 후 원복


def test_get_api_client_without_kubeconfig_raises_reason():
    cluster = SimpleNamespace(id="x", name="c1", kubeconfig_path=None, kubeconfig_content=None)
    with pytest.raises(pool.K8sClientError) as ei:
        pool.get_api_client(cluster)
    assert "kubeconfig" in str(ei.value)


def test_incluster_strict_does_not_fall_back_to_local_kubeconfig(monkeypatch):
    def not_incluster(**_kw):
        raise k8s_config.ConfigException("not in cluster")

    called = {"local": False}

    def local(**_kw):
        called["local"] = True

    monkeypatch.setattr(pool.k8s_config, "load_incluster_config", not_incluster)
    monkeypatch.setattr(pool.k8s_config, "load_kube_config", local)
    with pytest.raises(pool.K8sClientError):
        pool.get_incluster_api_client(allow_local_fallback=False)
    assert called["local"] is False
    # 기본 모드는 로컬 kubeconfig 로 폴백(로컬 개발)
    pool.get_incluster_api_client()
    assert called["local"] is True


def test_incluster_does_not_touch_global_default(monkeypatch):
    before = k8s_client.Configuration.get_default_copy().host

    def fake_incluster(client_configuration=None, **_kw):
        assert client_configuration is not None   # 반드시 격리된 Configuration 에 로드
        client_configuration.host = "https://incluster:443"

    monkeypatch.setattr(pool.k8s_config, "load_incluster_config", fake_incluster)
    c = pool.get_incluster_api_client()
    assert c.configuration.host == "https://incluster:443"
    assert k8s_client.Configuration.get_default_copy().host == before
