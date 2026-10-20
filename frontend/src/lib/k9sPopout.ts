import type { K9sConnectParams } from '@/components/k8s';
import { openTerminalPopout, requestTerminalPopout } from '@/lib/terminalPopout';

// k9s 세션의 창 간 handoff — 공용 base 툴(`lib/terminalPopout.ts`)에 라우트/창 이름만
// 고정한 얇은 래퍼. 전달 방식(저장소 없는 postMessage 왕복)과 보안 근거는 그쪽 주석 참고.

export interface K9sPopoutPayload {
  clusterId: string;
  params: K9sConnectParams;
}

/** 팝업 창으로 세션을 연다. 반환: 열린 window(성공) | null(팝업 차단/실패). */
export function openK9sPopout(
  payload: K9sPopoutPayload,
  onHandoffResult?: (delivered: boolean) => void,
): Window | null {
  return openTerminalPopout({
    route: '/k9s/popup',
    windowName: `k9s_${payload.clusterId}`,
    payload,
    onHandoffResult,
  });
}

/** 팝업 창에서 호출 — 원래 창에 payload 를 요청한다(1회용, 실패 시 null). */
export function requestK9sPopout(id: string): Promise<K9sPopoutPayload | null> {
  return requestTerminalPopout<K9sPopoutPayload>(id);
}
