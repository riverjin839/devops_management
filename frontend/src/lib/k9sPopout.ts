import type { K9sConnectParams } from '@/components/k8s';
import { consumeTerminalPopout, openTerminalPopout } from '@/lib/terminalPopout';

// k9s 세션의 창 간 handoff — 공용 base 툴(`lib/terminalPopout.ts`)에 라우트/창 이름만
// 고정한 얇은 래퍼. 저장 방식(localStorage 1회용 키)과 보안 근거는 그쪽 주석 참고.

export interface K9sPopoutPayload {
  clusterId: string;
  params: K9sConnectParams;
}

/** 팝업 창으로 세션을 연다. 반환: 열린 window(성공) | null(팝업 차단/실패). */
export function openK9sPopout(payload: K9sPopoutPayload): Window | null {
  return openTerminalPopout({
    route: '/k9s/popup',
    windowName: `k9s_${payload.clusterId}`,
    payload,
  });
}

/** 팝업 창에서 호출 — 키로 payload 를 꺼내고 즉시 삭제. */
export function consumeK9sPopout(key: string): K9sPopoutPayload | null {
  return consumeTerminalPopout<K9sPopoutPayload>(key);
}
