// SSE(POST) 소비 헬퍼 — 실행 버튼의 실시간 로그(CLAUDE.md "실행 = 상세·실시간 로그")용.
// EventSource 는 GET 만 되므로 fetch + ReadableStream 으로 `data: <json>\n\n` 블록을 읽는다.
// 이 본문은 axios 인터셉터를 타지 않으므로 서버는 snake_case 원문 JSON 을 보내고,
// 요청 본문도 호출자가 snake_case 로 만들어 넘긴다(k8s_rbac `/provision/stream` 과 같은 규약).
import { getAuthToken } from '@/stores/authStore';

export type SseEvent = Record<string, unknown> & { type?: string };

/** 스트림을 끝까지 읽으며 이벤트마다 onEvent 를 호출한다.
 *  스트림 시작 전 거절(403/404/422 등)은 서버 detail 을 담아 Error 로 던진다. */
export async function postSse(
  url: string,
  body: unknown,
  onEvent: (evt: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = getAuthToken();
  const resp = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let detail = `서버 오류 ${resp.status}`;
    try {
      const data = await resp.json();
      const d = data?.detail;
      if (typeof d === 'string') detail = d;
      else if (d && typeof d === 'object' && 'message' in d) detail = String((d as { message: unknown }).message);
      else if (d) detail = JSON.stringify(d);
    } catch {
      /* 본문이 JSON 이 아니면 상태코드만 */
    }
    throw new Error(detail);
  }
  if (!resp.body) throw new Error('스트림 본문이 비어 있습니다.');
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const ln of block.split('\n')) {
        if (!ln.startsWith('data:')) continue;
        try {
          onEvent(JSON.parse(ln.slice(5).replace(/^ /, '')) as SseEvent);
        } catch {
          /* 깨진 줄은 건너뛴다 — 스트림 전체를 죽이지 않는다 */
        }
      }
    }
  }
}
