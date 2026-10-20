import { generateUUID } from '@/lib/utils';

/**
 * 웹 터미널 세션을 별도 브라우저 창으로 이관하기 위한 1회용 handoff — 모든 SSH 콘솔
 * (k9s 콘솔 · 노드 SSH 터미널)이 공유하는 base 툴.
 *
 * **저장소를 쓰지 않는다(정책 8, D-176).** SSH 비밀번호·개인키를 URL·localStorage 에 남기지
 * 않도록 `postMessage` 왕복으로 넘긴다:
 *   1. 원래 창이 랜덤 handoff id 로 팝업을 열고(`?h=<id>`) `message` 리스너를 건다.
 *   2. 팝업이 부팅되면 `window.opener` 로 `ready(id)` 를 보낸다(받을 때까지 짧게 재전송).
 *   3. 원래 창은 출처(같은 origin)·발신 창(방금 연 팝업)·id 를 모두 확인한 뒤에만 payload 를
 *      그 팝업 하나에 같은 origin 으로 보내고 리스너를 즉시 내린다(1회용).
 * payload 는 두 창의 메모리에만 있다. 원래 창이 먼저 닫혔거나 팝업이 새로고침되면 handoff 가
 * 없으므로 팝업은 "다시 열기" 안내를 띄우고, 원래 창은 시간 안에 `ready` 를 못 받으면
 * `onHandoffResult(false)` 로 알려 "다시 열기" 버튼을 보여준다.
 */
const MSG_READY = 'pep:terminal-popout:ready';
const MSG_PAYLOAD = 'pep:terminal-popout:payload';

/** 원래 창이 팝업의 `ready` 를 기다리는 시간. 넘기면 handoff 실패로 본다. */
const OPENER_WAIT_MS = 20_000;
/** 팝업이 payload 를 기다리는 시간. */
const POPUP_WAIT_MS = 8_000;
const POPUP_RETRY_MS = 300;

export interface TerminalPopoutOptions<P> {
  /** 팝업 라우트 (예: `/k9s/popup`) — handoff id 가 `?h=` 로 붙는다(비밀값 아님). */
  route: string;
  /** window.open 의 창 이름 — 같은 이름이면 브라우저가 기존 창을 재사용한다. */
  windowName: string;
  payload: P;
  width?: number;
  height?: number;
  /**
   * handoff 결과 — true: 팝업이 payload 를 받아 갔다. false: 시간 안에 팝업이 요청하지 않았다
   * (팝업이 열리자마자 닫혔으면 호출하지 않는다 — 사용자가 취소한 것이므로).
   */
  onHandoffResult?: (delivered: boolean) => void;
}

/** 팝업 창으로 세션을 연다. 반환: 열린 window(성공) | null(팝업 차단/실패). */
export function openTerminalPopout<P>({
  route, windowName, payload, width = 1280, height = 820, onHandoffResult,
}: TerminalPopoutOptions<P>): Window | null {
  // crypto.randomUUID 는 보안 컨텍스트(HTTPS/localhost) 전용 — HTTP(NodePort 등) 접속에서
  // TypeError 가 나므로 폴백 있는 generateUUID 를 쓴다.
  const id = generateUUID();
  let win: Window | null = null;
  let done = false;

  const finish = (delivered: boolean | null) => {
    if (done) return;
    done = true;
    window.removeEventListener('message', onMessage);
    window.clearTimeout(timer);
    if (delivered !== null) onHandoffResult?.(delivered);
  };

  function onMessage(ev: MessageEvent) {
    if (ev.origin !== window.location.origin) return;
    if (!win || ev.source !== win) return;
    const data = ev.data as { type?: unknown; id?: unknown } | null;
    if (!data || data.type !== MSG_READY || data.id !== id) return;
    try {
      win.postMessage({ type: MSG_PAYLOAD, id, payload }, window.location.origin);
      finish(true);
    } catch {
      finish(false);
    }
  }

  // 리스너는 window.open 전에 건다 — 팝업이 아주 빨리 ready 를 보내도 놓치지 않게.
  window.addEventListener('message', onMessage);
  const timer = window.setTimeout(() => {
    // 팝업을 사용자가 바로 닫았으면 실패 안내를 띄우지 않는다.
    finish(win && !win.closed ? false : null);
  }, OPENER_WAIT_MS);

  win = window.open(
    `${route}?h=${encodeURIComponent(id)}`,
    windowName,
    `popup=yes,width=${width},height=${height}`,
  );
  if (!win) {
    finish(null);
    return null;
  }
  return win;
}

// 같은 handoff id 의 요청은 하나로 합친다 — StrictMode 의 이중 effect 가 두 번 요청하면
// 1회용 payload 를 첫 요청이 받아 가고 두 번째는 실패로 끝나기 때문이다(팝업 창 메모리에만 있다).
const pendingRequests = new Map<string, Promise<unknown>>();

/**
 * 팝업 창에서 호출 — 원래 창(`window.opener`)에 payload 를 요청한다.
 * 반환 Promise 는 payload 또는 null(원래 창 없음·시간 초과·새로고침으로 handoff 소진).
 */
export function requestTerminalPopout<P>(id: string): Promise<P | null> {
  const existing = pendingRequests.get(id);
  if (existing) return existing as Promise<P | null>;
  const req = createRequest<P>(id);
  pendingRequests.set(id, req);
  return req;
}

function createRequest<P>(id: string): Promise<P | null> {
  return new Promise((resolve) => {
    const opener = window.opener as Window | null;
    if (!id || !opener || opener.closed) {
      resolve(null);
      return;
    }
    let settled = false;
    const settle = (v: P | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      window.clearInterval(retry);
      window.clearTimeout(timer);
      resolve(v);
    };
    function onMessage(ev: MessageEvent) {
      if (ev.origin !== window.location.origin || ev.source !== opener) return;
      const data = ev.data as { type?: unknown; id?: unknown; payload?: unknown } | null;
      if (!data || data.type !== MSG_PAYLOAD || data.id !== id) return;
      settle((data.payload ?? null) as P | null);
    }
    const ping = () => {
      try {
        if (opener.closed) { settle(null); return; }
        opener.postMessage({ type: MSG_READY, id }, window.location.origin);
      } catch {
        settle(null);
      }
    };
    window.addEventListener('message', onMessage);
    const retry = window.setInterval(ping, POPUP_RETRY_MS);
    const timer = window.setTimeout(() => settle(null), POPUP_WAIT_MS);
    ping();
  });
}
