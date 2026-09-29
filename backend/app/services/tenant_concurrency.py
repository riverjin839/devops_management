"""테넌트별 백그라운드 실행 동시성 상한 — 멀티테넌시 5단계.

왜 필요한가: Celery 워커는 모든 테넌트가 함께 쓴다. 한 팀이 배치잡·운영 점검·효율화 적용을 한꺼번에
수십 건 걸면 워커가 그 팀 작업으로 꽉 차 다른 팀의 실행이 줄을 선다. ``tenants.max_concurrent_runs``
로 "이 테넌트 클러스터에 대해 동시에 도는 실행 수"를 묶고, 넘치는 실행은 워커를 붙잡지 않고
**재시도 큐로 돌려보내** 기다리게 한다(워커 슬롯을 비워 다른 테넌트 작업이 돈다).

규칙:
- 실행이 어느 테넌트 몫인지는 **대상 클러스터의 소유 테넌트**로 정한다(``owner_tenant``):
  바인딩된 테넌트 중 operate 우선, 같은 등급이면 이름순 첫 번째. 바인딩이 없으면 제한 없음.
- ``max_concurrent_runs`` 가 NULL/0 이면 제한 없음(기존 설치 영향 없음).
- 적용 대상은 사용자·스케줄이 거는 **실행형** 태스크다(배치잡, 운영 점검 묶음, 점검 매트릭스 일괄
  수행 셀, 클러스터 심층 점검, 효율화 적용/롤백). 주기 모니터링(core bundle·매트릭스 cron 셀)과
  수집(리소스 카운트·효율화 샘플)은 막지 않는다 — 모니터링이 한 팀의 부하 때문에 밀리면 안 된다.
- 슬롯은 Redis ZSET 세마포어(``tenantrun:slots:{tenant}``, 점수=만료 시각)다. 워커가 죽어 반납하지
  못한 슬롯은 ``SLOT_HOLD`` 뒤 자동 회수된다. Redis 가 없으면 **제한하지 않는다**(fail-open, 경고 로그).
- 슬롯을 못 얻으면 ``WAIT_INTERVAL`` 초 뒤 재시도한다. ``MAX_WAIT_RETRIES`` 번(약 1시간) 넘게 못 얻으면
  ``TenantRunLimitTimeout`` — 각 태스크가 실행 기록에 사유를 남기고 끝낸다.
- 대기 중인 실행은 ``tenantrun:wait:{tenant}`` 에 등록돼 Settings ▸ 테넌트의 "실행 슬롯" 카드와
  각 실행 로그에 보인다.
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

WAIT_INTERVAL = 15          # 슬롯 재시도 간격(초)
MAX_WAIT_RETRIES = 240      # 최대 대기 = WAIT_INTERVAL × MAX_WAIT_RETRIES ≈ 1시간
SLOT_HOLD = 3600            # 슬롯 최대 보유(초) — 반납 못 한 슬롯의 자동 회수 시각
WAITING_STALE = 120         # 대기 표시가 이 시간 동안 갱신되지 않으면(워커 사라짐) 목록에서 뺀다
WAIT_LOG_EVERY = 20         # 대기 로그는 첫 대기 + 이 재시도 횟수마다(≈5분) 한 줄

KIND_LABELS = {
    "batch_job": "배치잡",
    "ops_check": "운영 점검",
    "check_matrix_run": "점검 매트릭스 수행",
    "deep_check": "심층 점검",
    "k8s_efficiency_run": "효율화 적용",
}

_ACQUIRE_LUA = """
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZSCORE', KEYS[1], ARGV[4]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
  return 1
end
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
  redis.call('EXPIRE', KEYS[1], ARGV[5])
  return 1
end
return 0
"""


class TenantRunLimitTimeout(Exception):
    """테넌트 동시 실행 상한 대기 시간 초과 — 실행 기록에 사유 그대로 남긴다."""


# ── 소유 테넌트 ──────────────────────────────────────────────────────────────

def owner_tenant(db: Session, cluster_id) -> Any:
    """클러스터의 소유 테넌트 — operate 바인딩 우선, 같은 등급이면 이름순. 바인딩 없으면 None."""
    from app.models.tenant import ClusterBinding, Tenant

    if cluster_id is None:
        return None
    try:
        cluster_id = cluster_id if isinstance(cluster_id, uuid.UUID) else uuid.UUID(str(cluster_id))
    except (TypeError, ValueError):
        return None
    rows = (
        db.query(Tenant, ClusterBinding.access)
        .join(ClusterBinding, ClusterBinding.tenant_id == Tenant.id)
        .filter(ClusterBinding.cluster_id == cluster_id)
        .order_by(Tenant.name)
        .all()
    )
    if not rows:
        return None
    return sorted(rows, key=lambda r: r[1] != "operate")[0][0]


# ── Redis 슬롯 저장소 ────────────────────────────────────────────────────────

_redis_client: Any = None


def _default_redis():
    """login_rate_limiter / llm 통계와 같은 fail-open 패턴. 연결 불가면 False 를 캐시."""
    global _redis_client
    if _redis_client is not None:
        return _redis_client or None
    try:
        import redis as _redis

        from app.config import settings

        _redis_client = _redis.Redis.from_url(
            settings.redis_url, socket_connect_timeout=1, socket_timeout=2,
        )
    except Exception:  # noqa: BLE001
        _redis_client = False
    return _redis_client or None


class TenantRunSlots:
    def __init__(self, redis_getter: Callable[[], Any] = _default_redis) -> None:
        self._get = redis_getter
        self._script = None
        self._warned = False

    @staticmethod
    def _k(kind: str, tenant_id) -> str:
        return f"tenantrun:{kind}:{tenant_id}"

    def _r(self):
        try:
            return self._get()
        except Exception:  # noqa: BLE001
            return None

    def _warn_once(self, e: Exception | str) -> None:
        if not self._warned:
            self._warned = True
            logger.warning("테넌트 동시 실행 상한: Redis 사용 불가 — 제한 없이 실행한다(fail-open): %s", e)

    def try_acquire(self, tenant_id, limit: int, token: str, meta: dict) -> Optional[bool]:
        """True=획득, False=상한 도달, None=Redis 사용 불가(호출부는 제한 없이 진행)."""
        r = self._r()
        if r is None:
            self._warn_once("client 없음")
            return None
        now = time.time()
        try:
            if self._script is None:
                self._script = r.register_script(_ACQUIRE_LUA)
            ok = self._script(
                keys=[self._k("slots", tenant_id)],
                args=[now, now + SLOT_HOLD, int(limit), token, SLOT_HOLD + 60],
            )
            if int(ok) == 1:
                meta = {**meta, "since": meta.get("since") or now}
                r.hset(self._k("meta", tenant_id), token, json.dumps(meta, default=str))
                r.expire(self._k("meta", tenant_id), SLOT_HOLD + 60)
                r.hdel(self._k("wait", tenant_id), token)
                return True
            return False
        except Exception as e:  # noqa: BLE001
            self._script = None
            self._warn_once(e)
            return None

    def release(self, tenant_id, token: str) -> None:
        r = self._r()
        if r is None:
            return
        try:
            r.zrem(self._k("slots", tenant_id), token)
            r.hdel(self._k("meta", tenant_id), token)
        except Exception:  # noqa: BLE001 — 반납 실패는 SLOT_HOLD 뒤 만료로 회수된다
            pass

    def mark_waiting(self, tenant_id, token: str, meta: dict) -> None:
        r = self._r()
        if r is None:
            return
        try:
            key = self._k("wait", tenant_id)
            prev = r.hget(key, token)
            since = json.loads(prev).get("since") if prev else None
            r.hset(key, token, json.dumps({**meta, "since": since or time.time(), "updated": time.time()},
                                          default=str))
            r.expire(key, SLOT_HOLD + 60)
        except Exception:  # noqa: BLE001
            pass

    def clear_waiting(self, tenant_id, token: str) -> None:
        r = self._r()
        if r is None:
            return
        try:
            r.hdel(self._k("wait", tenant_id), token)
        except Exception:  # noqa: BLE001
            pass

    def snapshot(self, tenant_id) -> Optional[dict[str, list[dict]]]:
        """{"running": [...], "waiting": [...]} — Redis 사용 불가면 None."""
        r = self._r()
        if r is None:
            return None
        now = time.time()
        try:
            r.zremrangebyscore(self._k("slots", tenant_id), "-inf", now)
            tokens = [t.decode() if isinstance(t, bytes) else t
                      for t in r.zrange(self._k("slots", tenant_id), 0, -1)]
            metas = r.hgetall(self._k("meta", tenant_id)) or {}
            metas = {(k.decode() if isinstance(k, bytes) else k): v for k, v in metas.items()}
            running = []
            for t in tokens:
                raw = metas.get(t)
                running.append({"token": t, **(json.loads(raw) if raw else {})})
            waiting = []
            stale = []
            for k, v in (r.hgetall(self._k("wait", tenant_id)) or {}).items():
                k = k.decode() if isinstance(k, bytes) else k
                m = json.loads(v)
                if now - float(m.get("updated") or 0) > WAITING_STALE:
                    stale.append(k)
                    continue
                waiting.append({"token": k, **m})
            if stale:
                r.hdel(self._k("wait", tenant_id), *stale)
            running.sort(key=lambda m: float(m.get("since") or 0))
            waiting.sort(key=lambda m: float(m.get("since") or 0))
            return {"running": running, "waiting": waiting}
        except Exception:  # noqa: BLE001
            return None


tenant_run_slots = TenantRunSlots()


# ── 태스크용 헬퍼 ────────────────────────────────────────────────────────────

@dataclass
class RunSlot:
    """획득한 슬롯 — ``release()`` 를 finally 에서 부른다. 제한이 없으면 no-op."""

    tenant_id: Optional[str] = None
    tenant_name: Optional[str] = None
    token: Optional[str] = None
    slots: Optional[TenantRunSlots] = None

    def release(self) -> None:
        if self.slots is not None and self.tenant_id and self.token:
            self.slots.release(self.tenant_id, self.token)


def acquire_run_slot(
    task,
    db: Session,
    *,
    cluster_id,
    kind: str,
    ref: str,
    label: Optional[str] = None,
    on_wait: Optional[Callable[[str], None]] = None,
    slots: Optional[TenantRunSlots] = None,
    max_wait_retries: int = MAX_WAIT_RETRIES,
) -> RunSlot:
    """Celery 태스크 시작부에서 호출 — 슬롯을 얻으면 ``RunSlot``, 못 얻으면 재시도 예외를 raise.

    - 제한이 없으면(바인딩 없음 / 상한 NULL·0 / Redis 불가) no-op ``RunSlot`` 을 돌려준다.
    - 상한에 걸리면 ``on_wait(메시지)`` 로 실행 로그에 대기 사유를 남기고 ``task.retry`` 를 raise 한다.
      재시도는 같은 task id 로 돌아오므로 대기 등록·로그가 한 실행에 이어진다.
    - ``max_wait_retries``(기본 ``MAX_WAIT_RETRIES``) 를 넘기면 ``TenantRunLimitTimeout``. 실행 기록에
      자체 stale 스위퍼가 있는 경우(점검 매트릭스 30분) 그보다 짧게 넘긴다.
    """
    slots = slots or tenant_run_slots
    tenant = owner_tenant(db, cluster_id)
    limit = int(getattr(tenant, "max_concurrent_runs", None) or 0) if tenant is not None else 0
    if tenant is None or limit <= 0:
        return RunSlot()

    tid = str(tenant.id)
    token = str(getattr(task.request, "id", None) or uuid.uuid4().hex)
    retries = int(getattr(task.request, "retries", 0) or 0)
    meta = {"kind": kind, "ref": str(ref), "label": label, "cluster_id": str(cluster_id)}
    got = slots.try_acquire(tid, limit, token, meta)
    if got is None:
        return RunSlot()
    if got:
        if retries and on_wait is not None:
            _safe(on_wait, f"테넌트 '{tenant.name}' 실행 슬롯 확보 — 대기 {retries * WAIT_INTERVAL}초 후 실행을 시작한다.")
        return RunSlot(tenant_id=tid, tenant_name=tenant.name, token=token, slots=slots)

    kind_label = KIND_LABELS.get(kind, kind)
    if retries >= max_wait_retries:
        slots.clear_waiting(tid, token)
        raise TenantRunLimitTimeout(
            f"테넌트 '{tenant.name}' 의 동시 실행 상한({limit}건)이 {retries * WAIT_INTERVAL // 60}분 넘게 "
            f"차 있어 {kind_label} 실행을 포기했다. Settings ▸ 테넌트에서 상한이나 실행 중인 작업을 확인한다."
        )
    slots.mark_waiting(tid, token, meta)
    if on_wait is not None and (retries == 0 or retries % WAIT_LOG_EVERY == 0):
        _safe(on_wait, (
            f"테넌트 '{tenant.name}' 의 동시 실행 상한({limit}건)이 차 있어 대기 중이다 "
            f"— {WAIT_INTERVAL}초마다 다시 시도한다 (경과 {retries * WAIT_INTERVAL}초, 최대 "
            f"{max_wait_retries * WAIT_INTERVAL // 60}분)."
        ))
    raise task.retry(countdown=WAIT_INTERVAL, max_retries=max_wait_retries + 1)


def _safe(fn: Callable[[str], None], msg: str) -> None:
    try:
        fn(msg)
    except Exception as e:  # noqa: BLE001 — 로그 기록 실패가 실행을 막으면 안 된다
        logger.debug("tenant slot on_wait 실패: %s", e)
