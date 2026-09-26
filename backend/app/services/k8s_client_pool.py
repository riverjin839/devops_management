"""대상 K8s 클러스터용 ApiClient 공용 풀 — 성능·안정성 기본값을 한 곳에서 강제한다.

왜 필요한가:

1. **요청마다 `new_client_from_config()`** 를 부르면 kubeconfig 파싱 + 새 urllib3 풀 +
   TCP/TLS(mTLS) 핸드셰이크가 매번 일어난다. kubeconfig 에 `exec` 인증 플러그인이 있으면
   요청마다 외부 프로세스까지 뜬다. 호출부가 close 를 빠뜨리면 소켓이 GC 전까지 남는다.
   → 클러스터(kubeconfig 내용)별로 ApiClient 를 캐시해 keep-alive 연결을 재사용한다.
2. **`_request_timeout` 미지정 호출** 은 urllib3 기본(무한 대기)이라, 느려진 apiserver 앞에서
   FastAPI 스레드풀을 붙잡아 K8s 와 무관한 API 까지 멈추게 한다.
   → `_request_timeout` 이 없으면 기본 (connect, read) 타임아웃을 주입한다.
3. **urllib3 기본 `Retry(3)`** 은 read timeout 난 GET 을 3번 더 보낸다 — 과부하로 느려진
   apiserver 에 같은 무거운 LIST 를 4배로 보내는 증폭기다.
   → read 재시도 0, connect 재시도 1회로 고정한다.
4. **전역 `config.load_kube_config()`** 는 프로세스 전역 Configuration 을 덮어써, 동시 요청이
   다른 클러스터로 나가는 race 를 만든다. → 여기서는 항상 격리된 Configuration 만 쓴다.

사용법:
    from app.services.k8s_client_pool import get_api_client
    api = get_api_client(cluster)            # 풀 공유 — close() 는 no-op 이므로 불러도 무해
    v1 = client.CoreV1Api(api)

    new_api_client(path)                      # 1회성(등록 전 검증 등) — 호출부가 close()
    get_incluster_api_client()                # PEP 가 떠 있는 관리 클러스터 자신
"""
from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from typing import Any, Optional

import urllib3
from kubernetes import client as k8s_client, config as k8s_config

from app.services.k8s_concurrency import cluster_slots
from app.services.kubeconfig import resolve_kubeconfig

logger = logging.getLogger(__name__)


def _envf(name: str, default: float) -> float:
    try:
        v = os.getenv(name)
        return float(v) if v not in (None, "") else default
    except (TypeError, ValueError):
        return default


# `_request_timeout` 을 지정하지 않은 호출에 주입할 기본값(초). 명시값이 있으면 그걸 쓴다.
DEFAULT_CONNECT_TIMEOUT = _envf("K8S_API_CONNECT_TIMEOUT", 5.0)
DEFAULT_READ_TIMEOUT = _envf("K8S_API_TIMEOUT", 30.0)
DEFAULT_TIMEOUT = (DEFAULT_CONNECT_TIMEOUT, DEFAULT_READ_TIMEOUT)
# 캐시 수명 — exec/OIDC 토큰 만료보다 짧게 잡아 오래된 자격증명을 계속 쓰지 않게 한다.
CACHE_TTL = _envf("K8S_CLIENT_CACHE_TTL", 300.0)
CACHE_MAX = int(_envf("K8S_CLIENT_CACHE_MAX", 64))
# 클러스터 1개당 동시 keep-alive 연결 상한(= urllib3 풀 maxsize).
POOL_MAXSIZE = int(_envf("K8S_CLIENT_POOL_MAXSIZE", 8))


class K8sClientError(Exception):
    """kubeconfig 해석/로드 실패 — 운영자에게 보여줄 사유를 담는다."""


def _retry_policy() -> urllib3.Retry:
    """read 재시도 0 — 느린 apiserver 에 같은 요청을 반복하지 않는다.
    connect 실패(연결 수립 전)만 1회 재시도: 요청이 서버에 도달하지 않았으므로 부하 증폭 없음."""
    return urllib3.Retry(
        total=3, connect=1, read=0, status=0, other=0, redirect=2,
        backoff_factor=0.2, raise_on_status=False,
    )


def harden_configuration(cfg: k8s_client.Configuration) -> k8s_client.Configuration:
    cfg.retries = _retry_policy()
    cfg.connection_pool_maxsize = POOL_MAXSIZE
    return cfg


def _slot_hold(timeout: Any) -> float:
    """슬롯 만료(초) — 요청 최대 소요(connect+read)보다 약간 길게. 반납 못 한 슬롯의 자동 회수 시각."""
    try:
        if isinstance(timeout, (tuple, list)):
            return float(sum(t for t in timeout if t)) + 15.0
        if timeout:
            return float(timeout) + 15.0
    except (TypeError, ValueError):
        pass
    return DEFAULT_CONNECT_TIMEOUT + DEFAULT_READ_TIMEOUT + 15.0


class HardenedApiClient(k8s_client.ApiClient):
    """`_request_timeout` 기본값 주입 + 스트림(exec) 안전성을 갖춘 ApiClient.

    `kubernetes.stream.stream()` 은 호출 동안 **인스턴스 속성** `api_client.request` 를
    websocket 함수로 바꿔치기했다가 되돌린다. 풀로 공유되는 클라이언트에서 그대로 두면 exec 중
    다른 스레드의 일반 GET 이 websocket 으로 나간다. 그래서 `request` 를 property 로 두고
    바꿔치기는 **그 스레드에만** 적용한다(thread-local override).
    """

    def __init__(self, configuration=None, *, pooled: bool = False) -> None:
        # property setter 가 쓰는 thread-local 을 super().__init__ 보다 먼저 준비.
        object.__setattr__(self, "_tls", threading.local())
        object.__setattr__(self, "_pooled", pooled)
        super().__init__(configuration=configuration)

    def _default_request(self, method, url, query_params=None, headers=None,
                         post_params=None, body=None, _preload_content=True,
                         _request_timeout=None):
        # _preload_content=False 는 watch / 로그 follow 같은 스트리밍 응답 — 긴 수명이
        # 정상이므로 기본 read timeout 을 주입하지 않는다(명시값은 그대로 존중).
        if _request_timeout is None and _preload_content:
            _request_timeout = DEFAULT_TIMEOUT
        # 대상 apiserver 별 동시 호출 상한(PEP 전체 합산, Redis). 스트리밍은 응답 헤더를 받는
        # 순간까지만 슬롯을 잡는다 — watch/follow 가 슬롯을 오래 점유하지 않게.
        with cluster_slots.slot(self.configuration.host or "", hold=_slot_hold(_request_timeout)):
            return k8s_client.ApiClient.request(
                self, method, url, query_params=query_params, headers=headers,
                post_params=post_params, body=body, _preload_content=_preload_content,
                _request_timeout=_request_timeout,
            )

    @property
    def request(self):  # type: ignore[override]
        override = getattr(self._tls, "override", None)
        return override if override is not None else self._default_request

    @request.setter
    def request(self, value) -> None:
        # stream() 의 finally 가 원래 값(= 이 스레드의 _default_request)을 되돌려 놓으면 해제.
        if getattr(value, "__func__", None) is HardenedApiClient._default_request:
            self._tls.override = None
        else:
            self._tls.override = value

    def close(self) -> None:
        """풀 공유 클라이언트는 호출부 close() 를 무시한다(다른 요청이 쓰는 중). 퇴출은 풀이 한다."""
        if self._pooled:
            return
        self._really_close()

    def _really_close(self) -> None:
        try:
            super().close()
        finally:
            try:
                self.rest_client.pool_manager.clear()
            except Exception:  # noqa: BLE001
                pass


def _load_file_config(path: str) -> k8s_client.Configuration:
    cfg = type.__call__(k8s_client.Configuration)
    # persist_config=False — 토큰 갱신 결과를 파일에 쓰지 않는다(파일은 DB content 로 재생성되는
    # 사본이고, 쓰면 내용 해시가 바뀌어 캐시가 무의미해진다).
    k8s_config.load_kube_config(config_file=path, client_configuration=cfg, persist_config=False)
    return harden_configuration(cfg)


def new_api_client(kubeconfig_path: str) -> HardenedApiClient:
    """캐시하지 않는 1회성 클라이언트(등록 전 검증 등). 호출부가 close() 해야 한다."""
    return HardenedApiClient(configuration=_load_file_config(kubeconfig_path))


# ── 풀 ─────────────────────────────────────────────────────────────────────────
class _Entry:
    __slots__ = ("client", "expires", "last_used")

    def __init__(self, api_client: HardenedApiClient, expires: float) -> None:
        self.client = api_client
        self.expires = expires
        self.last_used = time.monotonic()


_cache: dict[tuple[str, str], _Entry] = {}
_cache_lock = threading.Lock()


def _file_digest(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def _retire(entry: _Entry) -> None:
    """퇴출된 클라이언트는 진행 중 요청이 끝나도록 바로 닫지 않고 GC 에 맡긴다.
    (keep-alive 소켓은 urllib3 가 GC 시 정리한다.)"""
    entry.client._pooled = False  # 이후 누가 close() 를 불러도 실제로 닫히게


def _get_or_build(key: tuple[str, str], build) -> HardenedApiClient:
    now = time.monotonic()
    with _cache_lock:
        ent = _cache.get(key)
        if ent is not None and ent.expires > now:
            ent.last_used = now
            return ent.client
        if ent is not None:
            _cache.pop(key, None)
            _retire(ent)
    # 빌드(파일 파싱·exec 플러그인)는 락 밖에서 — 느린 exec 플러그인이 다른 클러스터를 막지 않게.
    api_client = build()
    with _cache_lock:
        ent = _cache.get(key)
        if ent is not None and ent.expires > now:  # 경합에서 다른 스레드가 먼저 넣었으면 그것을 쓴다
            return ent.client
        # 같은 경로의 이전 내용(kubeconfig 교체) 항목은 즉시 퇴출
        for k in [k for k in _cache if k[0] == key[0] and k != key]:
            _retire(_cache.pop(k))
        if len(_cache) >= CACHE_MAX:
            oldest = min(_cache, key=lambda k: _cache[k].last_used)
            _retire(_cache.pop(oldest))
        _cache[key] = _Entry(api_client, now + CACHE_TTL)
    return api_client


def get_api_client_for_path(kubeconfig_path: str) -> HardenedApiClient:
    """kubeconfig 파일 경로 기준 풀 클라이언트. 키 = (실경로, 내용 sha256) — 내용이 바뀌면 새로 만든다."""
    real = os.path.realpath(kubeconfig_path)
    try:
        digest = _file_digest(real)
    except OSError as e:
        raise K8sClientError(f"kubeconfig 파일을 읽을 수 없습니다({kubeconfig_path}): {e}") from e

    def _build() -> HardenedApiClient:
        try:
            return HardenedApiClient(configuration=_load_file_config(real), pooled=True)
        except Exception as e:  # noqa: BLE001
            raise K8sClientError(f"kubeconfig 로드 실패: {str(e)[:200]}") from e

    return _get_or_build((real, digest), _build)


def get_api_client(cluster: Any) -> HardenedApiClient:
    """등록된 클러스터의 풀 클라이언트. kubeconfig 해석 실패 시 사유를 담은 K8sClientError.

    in-cluster 폴백은 하지 않는다 — kubeconfig 가 사라졌을 때 조용히 PEP 자신의 클러스터를
    조회하는 오답을 막기 위함. 관리 클러스터 자신이 필요하면 get_incluster_api_client().
    """
    path, reason = resolve_kubeconfig(cluster)
    if not path or not os.path.exists(path):
        raise K8sClientError(reason or "kubeconfig 파일이 없습니다.")
    return get_api_client_for_path(path)


def get_incluster_api_client(*, allow_local_fallback: bool = True) -> HardenedApiClient:
    """PEP 가 떠 있는 관리 클러스터용(ServiceAccount). 로컬 개발이면 기본 kubeconfig 로 폴백.

    allow_local_fallback=False 면 in-cluster 가 아닐 때 폴백 없이 K8sClientError —
    "등록된 클러스터의 kubeconfig 가 없을 때" 엉뚱한 기본 kubeconfig 를 조회하지 않게 할 때 쓴다.

    `config.load_incluster_config()` 를 인자 없이 부르면 전역 default Configuration 을 바꾸므로
    항상 격리된 Configuration 에 로드한다.
    """
    def _build() -> HardenedApiClient:
        cfg = type.__call__(k8s_client.Configuration)
        try:
            k8s_config.load_incluster_config(client_configuration=cfg)
        except k8s_config.ConfigException as e:
            if not allow_local_fallback:
                raise K8sClientError(f"in-cluster 환경이 아닙니다: {str(e)[:200]}") from e
            try:
                k8s_config.load_kube_config(client_configuration=cfg, persist_config=False)
            except Exception as e:  # noqa: BLE001
                raise K8sClientError(f"in-cluster/기본 kubeconfig 로드 실패: {str(e)[:200]}") from e
        return HardenedApiClient(configuration=harden_configuration(cfg), pooled=True)

    # key[0] 이 다르면 서로 퇴출하지 않는다(_get_or_build 는 같은 key[0] 의 이전 내용을 퇴출).
    key = ("__incluster__", "") if allow_local_fallback else ("__incluster_strict__", "")
    return _get_or_build(key, _build)


def invalidate(kubeconfig_path: Optional[str] = None) -> None:
    """캐시 퇴출. 경로를 주면 그 kubeconfig 항목만, 없으면 전부(테스트·kubeconfig 교체 시)."""
    with _cache_lock:
        if kubeconfig_path is None:
            keys = list(_cache)
        else:
            real = os.path.realpath(kubeconfig_path)
            keys = [k for k in _cache if k[0] == real]
        for k in keys:
            _retire(_cache.pop(k))


def cache_size() -> int:
    with _cache_lock:
        return len(_cache)
