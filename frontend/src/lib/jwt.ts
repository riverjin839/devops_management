/**
 * JWT payload 를 서명 검증 없이 읽는다 — 만료 시각(`exp`) 을 UX 용(임박 경고·선제 로그아웃)
 * 으로만 쓰므로 검증은 서버(`decode_access_token`)에 맡긴다. 파싱 실패는 null.
 */
export function readJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = decodeURIComponent(
      Array.from(atob(padded), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''),
    );
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 토큰 만료 시각(ms epoch). `exp` 가 없거나 파싱 실패면 null. */
export function getJwtExpiryMs(token: string | null | undefined): number | null {
  const exp = readJwtPayload(token)?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
}
