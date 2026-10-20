import { useEffect, useRef } from 'react';
import { peekStoredToken, useAuthStore } from '@/stores/authStore';
import { useToastSafe } from '@/components/common/Toast';
import { getJwtExpiryMs, readJwtPayload } from '@/lib/jwt';
import { authApi } from '@/services/api';

/** 활동 중이면 만료 이만큼 전에 조용히 재발급한다(TTL 이 짧으면 TTL 의 1/3 전). */
const REFRESH_BEFORE_MS = 10 * 60 * 1000;
/** 활동이 없으면 만료 이만큼 전에 "세션 연장" 동작이 달린 경고 토스트를 띄운다(TTL 이 짧으면 1/6 전). */
const WARN_BEFORE_MS = 5 * 60 * 1000;
/** 만료 시각에서 이만큼 지난 뒤 선제 로그아웃 — 서버 시계 오차 여유. */
const EXPIRE_GRACE_MS = 5 * 1000;
/** setTimeout 은 32bit ms 를 넘으면 즉시 발화하므로 긴 대기는 잘라서 건다. */
const MAX_TIMER_MS = 2_147_000_000;
/** 활동 이벤트 기록 간격 — pointerdown/keydown 마다 일하지 않도록. */
const ACTIVITY_THROTTLE_MS = 30 * 1000;
/** 재발급이 네트워크 오류로 실패한 뒤 활동으로 다시 시도하기까지의 간격. */
const RETRY_AFTER_FAIL_MS = 60 * 1000;
/** 재발급해도 만료가 이만큼도 늘지 않으면 세션 최대 유지 시간(SESSION_MAX_HOURS)에 닿은 것으로 본다. */
const MIN_EXTENSION_MS = 60 * 1000;
/** 탭이 여럿이어도 재발급은 한 번만 — Web Locks 이름. */
const REFRESH_LOCK = 'k8s:auth:refresh';

type RefreshOutcome = 'ok' | 'expired' | 'failed';

/** 이 탭의 마지막 사용자 활동 시각 — 페이지를 연 것도 활동으로 본다. */
let lastActivityAt = Date.now();
/** 재발급해도 더 늘지 않은(=최대 유지 시간에 닿은) 토큰의 만료 시각. 이 토큰은 조용히 재발급하지 않는다. */
let cappedExpMs: number | null = null;

/**
 * 토큰 재발급 — `POST /auth/refresh`. 다른 탭과 동시에 돌지 않도록 Web Locks 로 감싸고,
 * 락을 얻은 뒤 localStorage 의 토큰을 다시 확인해 이미 다른 탭이 갱신했으면 그것을 채택만 한다.
 * 401(최대 유지 시간 초과·무효 토큰)은 axios 인터셉터가 기존 만료 흐름(`markSessionExpired`)으로 넘긴다.
 */
async function refreshSession(): Promise<RefreshOutcome> {
  const startToken = useAuthStore.getState().token;
  if (!startToken) return 'expired';
  const startExp = getJwtExpiryMs(startToken);

  const run = async (): Promise<RefreshOutcome> => {
    const stored = peekStoredToken();
    const storedExp = getJwtExpiryMs(stored);
    if (
      stored && stored !== startToken && storedExp != null && storedExp > Date.now()
      && (startExp == null || storedExp > startExp)
    ) {
      if (useAuthStore.getState().token !== stored) useAuthStore.getState().setToken(stored);
      return 'ok';
    }
    const current = useAuthStore.getState().token;
    if (!current) return 'expired';
    if (current !== startToken) return 'ok'; // 기다리는 동안 storage 동기화로 이미 바뀜
    try {
      const res = await authApi.refresh();
      const next = res.data.accessToken;
      const nextExp = getJwtExpiryMs(next);
      if (nextExp != null && startExp != null && nextExp - startExp < MIN_EXTENSION_MS) cappedExpMs = nextExp;
      useAuthStore.getState().setToken(next, res.data.user);
      return 'ok';
    } catch (err) {
      const status = (err as { response?: { status?: number } } | null)?.response?.status;
      return status === 401 ? 'expired' : 'failed';
    }
  };

  const locks = typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : undefined;
  if (locks) {
    try {
      return await locks.request(REFRESH_LOCK, run);
    } catch {
      return run();
    }
  }
  return run();
}

/**
 * D-079 / R-7 — 세션 슬라이딩 재발급 + 만료 임박 경고 + 만료 시 선제 로그아웃.
 *
 * 백엔드 토큰 수명(`ACCESS_TOKEN_EXPIRE_MINUTES`, 기본 2h)이 곧 유휴 타임아웃이다.
 * ①이 탭에서 최근 TTL 안에 활동(클릭·키 입력·휠·탭 복귀)이 있었으면 만료 10분 전에
 * `POST /auth/refresh` 로 조용히 재발급한다(로그인 시각은 유지 — `SESSION_MAX_HOURS` 상한).
 * ②활동이 없으면 만료 5분 전에 "세션 연장" 버튼이 달린 경고 토스트를 띄운다.
 * ③만료 시각이 지나면 다음 401 을 기다리지 않고 사유·복귀 경로를 남겨 로그아웃한다
 * (`markSessionExpired` — 다른 탭이 갱신한 유효 토큰이 있으면 그것을 채택한다).
 * AppShell 안(PageStyleProvider)에서 한 번만 호출한다.
 */
export function useSessionExpiryWatch() {
  const token = useAuthStore((s) => s.token);
  const toast = useToastSafe();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  useEffect(() => {
    if (!token) return;
    const expMs = getJwtExpiryMs(token);
    if (expMs == null) return; // exp 없는 토큰은 감시 대상 아님

    const iat = readJwtPayload(token)?.iat;
    const ttlMs = typeof iat === 'number' && iat * 1000 < expMs
      ? expMs - iat * 1000
      : Math.max(expMs - Date.now(), 60_000);
    const capped = cappedExpMs != null && expMs <= cappedExpMs;
    const refreshAt = expMs - Math.min(REFRESH_BEFORE_MS, ttlMs / 3);
    const warnAt = capped ? expMs - WARN_BEFORE_MS : expMs - Math.min(WARN_BEFORE_MS, ttlMs / 6);

    const timers = new Set<number>();
    let cancelled = false;
    let refreshing = false;
    let lastFailAt = 0;
    let warnToastId: string | null = null;

    const expire = () => {
      if (cancelled) return;
      const here = `${window.location.pathname}${window.location.search}`;
      useAuthStore.getState().markSessionExpired(here);
    };

    const silentRefresh = async () => {
      if (cancelled || refreshing || capped) return;
      if (Date.now() - lastFailAt < RETRY_AFTER_FAIL_MS) return;
      refreshing = true;
      const outcome = await refreshSession();
      refreshing = false;
      // 성공하면 토큰이 바뀌어 이 effect 가 정리되고 새 토큰 기준으로 다시 걸린다.
      if (outcome === 'failed') {
        lastFailAt = Date.now();
        // 경고 시점이 이미 지났으면(경고를 재발급에 맡기고 건너뛴 경우) 지금 수동 연장을 안내한다.
        if (Date.now() >= warnAt) warn(true);
      }
    };

    const dismissWarn = () => {
      if (warnToastId) toastRef.current.dismiss(warnToastId);
      warnToastId = null;
    };

    const warn = (retry = false) => {
      if (cancelled) return;
      dismissWarn();
      const minutes = Math.max(1, Math.round((expMs - Date.now()) / 60_000));
      if (capped) {
        warnToastId = toastRef.current.show({
          variant: 'warning',
          title: `최대 로그인 유지 시간이 약 ${minutes}분 후 끝납니다`,
          description: '작성 중인 내용을 저장하세요. 만료되면 로그인 화면으로 이동하고, 다시 로그인하면 이 화면으로 돌아옵니다.',
          durationMs: 0,
        });
        return;
      }
      warnToastId = toastRef.current.show({
        variant: 'warning',
        title: retry ? '세션 연장에 실패했습니다' : `세션이 약 ${minutes}분 후 만료됩니다`,
        description: retry
          ? '네트워크 상태를 확인하고 다시 시도하세요. 만료되면 로그인 화면으로 이동하고, 다시 로그인하면 이 화면으로 돌아옵니다.'
          : '계속 사용하려면 세션을 연장하세요. 만료되면 로그인 화면으로 이동하고, 다시 로그인하면 이 화면으로 돌아옵니다.',
        durationMs: 0,
        action: {
          label: '세션 연장',
          onClick: () => {
            warnToastId = null; // 토스트가 클릭과 함께 닫힌다
            lastActivityAt = Date.now();
            void refreshSession().then((outcome) => {
              if (outcome === 'failed') warn(true);
            });
          },
        },
      });
    };

    const onWarnDue = () => {
      // 조용한 재발급이 진행 중이면 결과를 기다린다(실패하면 silentRefresh 가 경고를 띄운다).
      if (refreshing) return;
      warn();
    };

    const onRefreshDue = () => {
      if (Date.now() - lastActivityAt <= ttlMs) void silentRefresh();
    };

    // 긴 대기를 안전하게 거는 재귀 타이머.
    const schedule = (at: number, fn: () => void) => {
      const delay = at - Date.now();
      if (delay <= 0) { fn(); return; }
      const id = window.setTimeout(() => {
        timers.delete(id);
        if (cancelled) return;
        if (Date.now() >= at) fn();
        else schedule(at, fn);
      }, Math.min(delay, MAX_TIMER_MS));
      timers.add(id);
    };

    const onActivity = () => {
      const now = Date.now();
      if (now - lastActivityAt < ACTIVITY_THROTTLE_MS) return;
      lastActivityAt = now;
      // 재발급 시점이 지난 뒤 돌아온 활동이면(경고 전후 포함) 바로 재발급한다.
      if (now >= refreshAt && now < expMs) void silentRefresh();
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      // 백그라운드 탭은 타이머가 늦게 돈다 — 돌아왔을 때 이미 만료 시각이 지났으면 바로 정리.
      if (Date.now() >= expMs + EXPIRE_GRACE_MS) { expire(); return; }
      onActivity();
    };

    const now = Date.now();
    if (now >= expMs + EXPIRE_GRACE_MS) { expire(); return; }
    if (!capped) schedule(refreshAt, onRefreshDue);
    schedule(warnAt, onWarnDue);
    schedule(expMs + EXPIRE_GRACE_MS, expire);

    window.addEventListener('pointerdown', onActivity, { passive: true });
    window.addEventListener('keydown', onActivity, { passive: true });
    window.addEventListener('wheel', onActivity, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
      timers.clear();
      dismissWarn();
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('keydown', onActivity);
      window.removeEventListener('wheel', onActivity);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [token]);
}
