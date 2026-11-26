// 실행 명령 추적 — 서버가 노드·클러스터에 실제로 날린 명령을 실행 로그에 `CMD` 줄로 붙인다(관리자 전용).
//
// - 단건 요청: 서버(`services/command_trace.py` CommandTraceMiddleware)가 관리자 요청에만 응답 헤더
//   `X-PEP-Commands`(base64url JSON 문자열 배열)를 붙인다. axios 응답 인터셉터가 `publishFromResponse` 로 흘린다.
// - SSE 실행: 서버가 `log{level:"cmd"}` 이벤트를 스트림에 직접 넣는다(applyRunEvent 가 그대로 기록).
// 비관리자에게는 서버가 아예 보내지 않는다. 보일지 말지는 관리자가 RunLogPanel 의 "명령" 토글로 정한다.
//
// ── 요청 ↔ 실행 연결 ─────────────────────────────────────────────────────────
// 한 화면에 실행 로그가 여럿이고 동시에 돌아도 명령이 섞이지 않게, 명령은 **그 요청을 보낸 실행**에만 붙인다.
// `useRunLog.begin` 이 실행마다 owner 를 등록하고 `claimRequests(owner)` 로 "지금부터 이번 매크로태스크 안에 나가는
// 요청은 이 실행 것" 이라고 표시한다(runLogged 의 `fn` 처럼 begin 직후 바로 부르는 요청 — TanStack `mutateAsync` 의
// 내부 await 도 마이크로태스크라 같은 창 안이다). 요청 인터셉터가 그 owner 를 config 에 찍고, 응답의 명령은 그 owner
// 에게만 간다. owner 가 없는 요청(배경 갱신·폴링 등)의 명령은 진행 중인 실행이 하나뿐일 때만 그 실행에 붙이고,
// 여럿이면 어느 실행 것인지 알 수 없으므로 버린다. 큐잉 실행의 폴링은 `pollIntoRunLog` 가 매번 다시 claim 한다.

export const COMMANDS_HEADER = 'x-pep-commands';

type Deliver = (commands: string[]) => void;
const owners = new Map<string, Deliver>();
let seq = 0;
let currentOwner: string | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

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

/** 실행 1건 등록 — 그 실행에 명령을 넘길 함수를 받고 owner id 를 돌려준다. 끝나면 `unregisterRun`. */
export function registerRun(deliver: Deliver): string {
  seq += 1;
  const owner = `run-${seq}`;
  owners.set(owner, deliver);
  return owner;
}

export function unregisterRun(owner: string): void {
  owners.delete(owner);
  if (currentOwner === owner) currentOwner = null;
}

/** 지금부터 이번 매크로태스크가 끝날 때까지 나가는 요청을 `owner` 의 것으로 표시한다. */
export function claimRequests(owner: string): void {
  currentOwner = owner;
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    if (currentOwner === owner) currentOwner = null;
    releaseTimer = null;
  }, 0);
}

/** 요청 인터셉터가 config 에 찍을 현재 owner(없으면 null). */
export function currentRequestOwner(): string | null {
  return currentOwner && owners.has(currentOwner) ? currentOwner : null;
}

/** 명령을 그 요청을 보낸 실행에 넘긴다(owner 없음 = 진행 중 실행이 하나일 때만 그 실행에). */
export function publishCommands(commands: string[], owner: string | null): void {
  if (commands.length === 0) return;
  let target: Deliver | undefined;
  if (owner) target = owners.get(owner); // 이미 끝난 실행의 늦은 응답이면 버린다
  else if (owners.size === 1) target = owners.values().next().value;
  if (!target) return;
  try { target(commands); } catch { /* 기록 오류가 응답 처리를 막지 않게 */ }
}

/** 요청 config 에 owner 를 실어 둘 필드 이름(axios config 확장). */
export const OWNER_FIELD = '__pepRunOwner';

/** axios 응답(성공·실패)의 헤더에서 명령을 꺼내 그 요청의 실행에 흘린다. */
export function publishFromResponse(
  resp: { headers?: unknown; config?: unknown } | undefined,
): void {
  const headers = resp?.headers;
  if (!headers || typeof headers !== 'object') return;
  const h = headers as Record<string, unknown> & { get?: (k: string) => unknown };
  const raw = typeof h.get === 'function' ? h.get(COMMANDS_HEADER) : h[COMMANDS_HEADER];
  const cmds = decodeCommandsHeader(raw);
  if (cmds.length === 0) return;
  const cfg = resp?.config as Record<string, unknown> | undefined;
  const owner = typeof cfg?.[OWNER_FIELD] === 'string' ? (cfg[OWNER_FIELD] as string) : null;
  publishCommands(cmds, owner);
}
