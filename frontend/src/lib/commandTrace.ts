// 실행 명령 추적 — 서버가 노드·클러스터에 실제로 날린 명령을 실행 로그에 `CMD` 줄로 붙인다(관리자 전용).
//
// - 단건 요청: 서버(`services/command_trace.py` CommandTraceMiddleware)가 관리자 요청에만 응답 헤더
//   `X-PEP-Commands`(base64url JSON 문자열 배열)를 붙인다. axios 응답 인터셉터가 `publishCommands` 로 흘리고,
//   진행 중인 실행 로그(useRunLog)가 받아 `cmd` 줄로 기록한다.
// - SSE 실행: 서버가 `log{level:"cmd"}` 이벤트를 스트림에 직접 넣는다(applyRunEvent 가 그대로 기록).
// 비관리자에게는 서버가 아예 보내지 않는다. 보일지 말지는 관리자가 RunLogPanel 의 "명령" 토글로 정한다.

export const COMMANDS_HEADER = 'x-pep-commands';

type Listener = (commands: string[]) => void;
const listeners = new Set<Listener>();

/** 헤더 값(base64url JSON) → 명령 줄 목록. 형식이 이상하면 빈 배열. */
export function decodeCommandsHeader(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (raw.length % 4)) % 4);
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

export function publishCommands(commands: string[]): void {
  if (commands.length === 0) return;
  listeners.forEach((fn) => {
    try { fn(commands); } catch { /* 구독자 오류가 응답 처리를 막지 않게 */ }
  });
}

/** 명령 수신 구독 — 해지 함수를 돌려준다. */
export function subscribeCommands(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** axios 응답(성공·실패)의 헤더에서 명령을 꺼내 흘린다. */
export function publishFromHeaders(headers: unknown): void {
  if (!headers || typeof headers !== 'object') return;
  const h = headers as Record<string, unknown> & { get?: (k: string) => unknown };
  const raw = typeof h.get === 'function' ? h.get(COMMANDS_HEADER) : h[COMMANDS_HEADER];
  publishCommands(decodeCommandsHeader(raw));
}
