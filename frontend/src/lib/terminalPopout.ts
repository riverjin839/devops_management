import { generateUUID } from '@/lib/utils';

/**
 * 웹 터미널 세션을 별도 브라우저 창으로 이관하기 위한 1회용 handoff — 모든 SSH 콘솔
 * (k9s 콘솔 · 노드 SSH 터미널)이 공유하는 base 툴.
 *
 * SSH 자격증명을 URL 에 싣지 않기 위해 localStorage 에 랜덤 키로 저장하고, 팝업 창이
 * 읽는 즉시 삭제한다(잔존 최소화). 같은 origin 이므로 창 간 공유·인증 토큰 접근이
 * 가능하고, 메인 창이 다른 페이지로 이동해도 handoff 는 유지된다.
 */
const PREFIX = 'pep:popout:';

export interface TerminalPopoutOptions<P> {
  /** 팝업 라우트 (예: `/k9s/popup`) — 핸드오프 키가 `?h=` 로 붙는다. */
  route: string;
  /** window.open 의 창 이름 — 같은 이름이면 브라우저가 기존 창을 재사용한다. */
  windowName: string;
  payload: P;
  width?: number;
  height?: number;
}

/** 팝업 창으로 세션을 연다. 반환: 열린 window(성공) | null(팝업 차단/실패). */
export function openTerminalPopout<P>({
  route, windowName, payload, width = 1280, height = 820,
}: TerminalPopoutOptions<P>): Window | null {
  // crypto.randomUUID 는 보안 컨텍스트(HTTPS/localhost) 전용 — HTTP(NodePort 등) 접속에서
  // TypeError 가 나므로 폴백 있는 generateUUID 를 쓴다.
  const key = PREFIX + generateUUID();
  try {
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    return null;
  }
  const win = window.open(
    `${route}?h=${encodeURIComponent(key)}`,
    windowName,
    `popup=yes,width=${width},height=${height}`,
  );
  if (!win) {
    // 팝업 차단 — 저장한 키를 즉시 정리.
    try { localStorage.removeItem(key); } catch { /* ignore */ }
    return null;
  }
  // 팝업이 payload 를 읽지 못한 경우를 대비해 60초 뒤 정리.
  window.setTimeout(() => {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }, 60_000);
  return win;
}

/** 팝업 창에서 호출 — 키로 payload 를 꺼내고 즉시 삭제. */
export function consumeTerminalPopout<P>(key: string): P | null {
  try {
    const raw = localStorage.getItem(key);
    localStorage.removeItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as P;
  } catch {
    return null;
  }
}
