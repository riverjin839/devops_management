import { useEffect, useRef } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { useToastSafe } from '@/components/common/Toast';
import { getJwtExpiryMs } from '@/lib/jwt';

/** 만료 이만큼 전에 경고 토스트를 띄운다. */
const WARN_BEFORE_MS = 5 * 60 * 1000;
/** 만료 시각에서 이만큼 지난 뒤 선제 로그아웃 — 서버 시계 오차 여유. */
const EXPIRE_GRACE_MS = 5 * 1000;
/** setTimeout 은 32bit ms 를 넘으면 즉시 발화하므로 긴 대기는 잘라서 건다. */
const MAX_TIMER_MS = 2_147_000_000;

/**
 * D-079 — 세션 만료 임박 경고 + 만료 시 선제 로그아웃.
 *
 * 백엔드 토큰은 고정 만료(`ACCESS_TOKEN_EXPIRE_MINUTES`, 기본 24h) 이고 refresh 가 없다
 * (R-7 과제). 그래서 프론트가 할 수 있는 최선은 ①만료 5분 전에 "작성 중인 내용을 저장하라"
 * 고 알리고 ②만료 시각이 지나면 다음 401 을 기다리지 않고 바로 로그인 화면으로 보내되
 * 사유·복귀 경로를 남기는 것이다(`markSessionExpired`). AppShell 안(PageStyleProvider)에서
 * 한 번만 호출한다.
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

    let warnTimer: number | undefined;
    let expireTimer: number | undefined;
    let cancelled = false;

    const expire = () => {
      if (cancelled) return;
      const here = `${window.location.pathname}${window.location.search}`;
      useAuthStore.getState().markSessionExpired(here);
    };
    const warn = () => {
      if (cancelled) return;
      const minutes = Math.max(1, Math.round((expMs - Date.now()) / 60_000));
      toastRef.current.warning(
        `세션이 약 ${minutes}분 후 만료됩니다`,
        '작성 중인 내용을 저장하세요. 만료되면 로그인 화면으로 이동하고, 다시 로그인하면 이 화면으로 돌아옵니다.',
      );
    };
    // 긴 대기를 안전하게 거는 재귀 타이머.
    const schedule = (at: number, fn: () => void, assign: (id: number) => void) => {
      const delay = at - Date.now();
      if (delay <= 0) { fn(); return; }
      assign(window.setTimeout(() => {
        if (Date.now() >= at) fn();
        else schedule(at, fn, assign);
      }, Math.min(delay, MAX_TIMER_MS)));
    };

    const now = Date.now();
    if (now >= expMs + EXPIRE_GRACE_MS) { expire(); return; }
    if (now < expMs - WARN_BEFORE_MS) schedule(expMs - WARN_BEFORE_MS, warn, (id) => { warnTimer = id; });
    else warn();
    schedule(expMs + EXPIRE_GRACE_MS, expire, (id) => { expireTimer = id; });

    return () => {
      cancelled = true;
      if (warnTimer !== undefined) window.clearTimeout(warnTimer);
      if (expireTimer !== undefined) window.clearTimeout(expireTimer);
    };
  }, [token]);
}
