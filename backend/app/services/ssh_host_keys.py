"""SSH 호스트 키 TOFU(Trust On First Use) 저장소 — MITM 탐지용.

``ssh_runner.py`` 는 사내망의 임의 호스트(운영자가 매번 IP 를 직접 입력)에 접속하므로
고정 known_hosts 파일을 미리 배포할 수 없다. 그렇다고 ``AutoAddPolicy()`` 로 모든 호스트
키를 무조건 수락하면, 같은 호스트에 재접속할 때 키가 바뀌어도(MITM 또는 재설치) 알아챌
방법이 없다.

이 모듈은 "처음 보는 호스트는 수락하고 키를 기억, 이미 아는 호스트는 키가 같은지
검증"(TOFU) 을 Redis 에 저장된 키로 구현한다. Redis 를 쓰는 이유: 이 백엔드는 여러
replica 로 뜨고 로컬 파일(/tmp)은 replica 마다 따로 놀고 재시작하면 사라지므로, 이미
Celery 브로커로 쓰고 있는 Redis(다소 지속적, replica 간 공유)가 로컬 파일보다 낫다.

**한계**: Redis 자체가 재시작/재배포되면 기록된 키가 사라지고, 그 이후 첫 연결은
다시 TOFU 로 수락된다 — 완벽한 영속 known_hosts 는 아니다. 그래도 "지금 이 순간부터
호스트 키가 바뀌는" 활성 MITM은 Redis 가 살아있는 동안 계속 탐지된다. Redis 자체가
불가용하면 이 검증 계층은 조용히 우회되고 기존 AutoAddPolicy 동작(항상 수락)으로
fail-open 한다 — SSH 연결성 자체가 이 보안 강화 때문에 끊기면 안 되므로.
"""
from __future__ import annotations

import base64
import logging

import paramiko

from app.config import settings

logger = logging.getLogger("k8s_monitor.ssh_host_keys")

_REDIS_KEY_PREFIX = "ssh_known_host:"

_KEY_CLASSES = {
    "ssh-rsa": paramiko.RSAKey,
    "ssh-ed25519": paramiko.Ed25519Key,
    "ecdsa-sha2-nistp256": paramiko.ECDSAKey,
    "ecdsa-sha2-nistp384": paramiko.ECDSAKey,
    "ecdsa-sha2-nistp521": paramiko.ECDSAKey,
    "ssh-dss": paramiko.DSSKey,
}

_redis_client = None


def _get_redis():
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    try:
        import redis as _redis
        _redis_client = _redis.Redis.from_url(
            settings.redis_url, socket_connect_timeout=1, socket_timeout=1,
        )
    except Exception:  # noqa: BLE001
        _redis_client = False
    return _redis_client


def _redis_field(host: str, port: int) -> str:
    return f"{_REDIS_KEY_PREFIX}{host}:{port}"


def _load(host: str, port: int) -> paramiko.PKey | None:
    """Redis 에 기록된 키를 로드. 없거나 Redis 불가면 None(=TOFU 로 새로 수락)."""
    client = _get_redis()
    if not client:
        return None
    try:
        raw = client.get(_redis_field(host, port))
        if not raw:
            return None
        key_type, _, b64_data = raw.decode("ascii").partition(":")
        key_cls = _KEY_CLASSES.get(key_type)
        if key_cls is None:
            return None
        return key_cls(data=base64.b64decode(b64_data))
    except Exception:  # noqa: BLE001
        return None


def _save(host: str, port: int, key: paramiko.PKey) -> None:
    client = _get_redis()
    if not client:
        return
    try:
        b64_data = base64.b64encode(key.asbytes()).decode("ascii")
        # TTL 90일 — 장기 미사용 호스트의 기록을 무기한 쌓아두지 않으면서도,
        # 정기적으로(배치잡/버전수집 등) 접속하는 호스트는 계속 갱신되어 만료 안 됨.
        client.set(_redis_field(host, port), f"{key.get_name()}:{b64_data}", ex=60 * 60 * 24 * 90)
    except Exception:  # noqa: BLE001
        pass


class TofuHostKeyPolicy(paramiko.MissingHostKeyPolicy):
    """미확인 호스트는 수락 + 기록. 이미 기록된 호스트는 connect() 이전에 paramiko
    의 in-memory host_keys 에 미리 심어둬서(아래 apply_known_key 참고) paramiko 자체가
    키 불일치 시 ``BadHostKeyException`` 을 던지게 한다 — 이 클래스는 "처음 보는
    호스트"에서만 호출된다.
    """

    def missing_host_key(self, client: paramiko.SSHClient, hostname: str, key: paramiko.PKey) -> None:
        port = getattr(client, "_pep_ssh_port", 22)
        _save(hostname, port, key)


def apply_known_key(client: paramiko.SSHClient, host: str, port: int) -> None:
    """connect() 호출 전에 Redis 에 기록된 키가 있으면 paramiko 의 host_keys 에
    미리 로드한다 — 있으면 paramiko 가 스스로 비교해서 다르면 BadHostKeyException,
    같으면 통과(콜백 호출 없음). 기록이 없으면 아무 것도 안 해서 missing_host_key
    (TofuHostKeyPolicy)가 호출되게 둔다.
    """
    key = _load(host, port)
    if key is not None:
        client.get_host_keys().add(host, key.get_name(), key)
    # missing_host_key 에서 port 를 알 수 있도록 클라이언트에 임시로 실어둠.
    client._pep_ssh_port = port  # noqa: SLF001
