import type { NodeSshConnectParams } from '@/components/k8s';
import { consumeTerminalPopout, openTerminalPopout } from '@/lib/terminalPopout';

// 노드 SSH 세션의 창 간 handoff — 공용 base 툴(`lib/terminalPopout.ts`)에 라우트/창
// 이름만 고정한 얇은 래퍼(k9s 의 `lib/k9sPopout.ts` 와 동일 구조).

export interface NodeSshPopoutPayload {
  params: NodeSshConnectParams;
}

/** 팝업 창으로 노드 SSH 세션을 연다. 반환: 열린 window(성공) | null(팝업 차단/실패). */
export function openNodeSshPopout(payload: NodeSshPopoutPayload): Window | null {
  return openTerminalPopout({
    // host 별로 창 이름을 나눠 여러 노드를 동시에 띄울 수 있게 한다.
    route: '/node-ssh/popup',
    windowName: `node_ssh_${payload.params.host}_${payload.params.port}`,
    payload,
  });
}

/** 팝업 창에서 호출 — 키로 payload 를 꺼내고 즉시 삭제. */
export function consumeNodeSshPopout(key: string): NodeSshPopoutPayload | null {
  return consumeTerminalPopout<NodeSshPopoutPayload>(key);
}
