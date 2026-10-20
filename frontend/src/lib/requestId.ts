/**
 * 요청 추적 ID — 요청마다 `X-Request-ID` 를 만들어 보내고, 서버는 같은 ID 를 응답 헤더·서버 로그·
 * 서버 오류 기록(Settings ▸ 서버 오류)·감사 로그에 남긴다. 응답이 오지 않은 요청(타임아웃·끊김)도 이 ID 로 찾는다.
 */
export const REQUEST_ID_HEADER = 'X-Request-ID';

/** 오류 문구 안의 "요청 ID xxx" — 토스트가 이걸 찾아 복사·원인 보기 버튼을 붙인다. */
export const REQUEST_ID_PATTERN = /요청 ID ([A-Za-z0-9._-]{8,64})/;

export function newRequestId(): string {
  // crypto.randomUUID 는 보안 컨텍스트(https/localhost) 전용이라 폐쇄망 http 접속에서 없다 — getRandomValues 는 어디서나 된다.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function extractRequestId(text: string | undefined | null): string | null {
  if (!text) return null;
  const m = REQUEST_ID_PATTERN.exec(text);
  return m ? m[1] : null;
}

/** Settings ▸ 서버 오류 탭에서 이 요청 ID 로 찾는 경로. */
export function serverErrorsPath(requestId: string): string {
  return `/settings?tab=server-errors&rid=${encodeURIComponent(requestId)}`;
}
