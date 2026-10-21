// 공개 API 의 공유 링크 거절(403 detail {code, message}) 해석 — 화면이 빈 상태 안내로 바꿔 보여준다.
export interface ShareDenied { code: string; message: string }

export function shareDenied(err: unknown): ShareDenied | null {
  const r = (err as { response?: { status?: number; data?: { detail?: unknown } } })?.response;
  if (r?.status !== 403) return null;
  const d = r.data?.detail as { code?: string; message?: string } | undefined;
  if (d && typeof d === 'object' && typeof d.code === 'string' && d.code.startsWith('share_link')) {
    return { code: d.code, message: d.message ?? '공유 링크가 필요합니다.' };
  }
  return null;
}

export const SHARE_TITLES: Record<string, string> = {
  share_link_required: '공유 링크로만 열 수 있는 화면입니다',
  share_link_invalid: '유효하지 않은 공유 링크입니다',
  share_link_expired: '만료된 공유 링크입니다',
  share_link_scope: '이 링크로는 열 수 없는 화면입니다',
};
