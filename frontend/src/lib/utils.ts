import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { Status } from '@/types';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** RichTextEditor 가 만든 HTML 을 테이블/칸반 미리보기용 plain text 로.
 *  &nbsp; 같은 entity 는 단순 디코딩 (브라우저 textarea 트릭).
 */
export function stripHtml(html?: string | null): string {
  if (!html) return '';
  const noTags = String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  // 흔한 HTML entity 디코딩
  if (typeof document !== 'undefined' && /&[a-z#0-9]+;/i.test(noTags)) {
    const ta = document.createElement('textarea');
    ta.innerHTML = noTags;
    return ta.value.trim();
  }
  return noTags.trim();
}

/**
 * 폐쇄망(HTTP) 및 구형 브라우저 호환 UUID v4 생성
 *
 * 우선순위:
 *   1. crypto.randomUUID()     — HTTPS + Chromium 92+ / Firefox 95+ / Safari 15.4+
 *   2. crypto.getRandomValues() — HTTP 포함 대부분의 모던 브라우저 (보안 컨텍스트 불필요)
 *   3. Math.random()            — 최후 폴백 (엔트로피 낮음, 고유성만 보장)
 */
export function generateUUID(): string {
  // 1순위: 네이티브 randomUUID (보안 컨텍스트 필요)
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // 2순위: getRandomValues (HTTP에서도 동작)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant RFC 4122
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join('-');
  }
  // 3순위: Math.random 폴백
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function getStatusColor(status: Status): string {
  switch (status) {
    case 'healthy':
      return 'text-status-healthy';
    case 'warning':
      return 'text-status-warning';
    case 'critical':
      return 'text-status-critical';
    default:
      return 'text-muted-foreground';
  }
}

export function getStatusBgColor(status: Status): string {
  switch (status) {
    case 'healthy':
      return 'bg-status-healthy/10';
    case 'warning':
      return 'bg-status-warning/10';
    case 'critical':
      return 'bg-status-critical/10';
    default:
      return 'bg-muted';
  }
}

export function getStatusIcon(status: Status): string {
  switch (status) {
    case 'healthy':
      return '🟢';
    case 'warning':
      return '🟠';
    case 'critical':
      return '🔴';
    default:
      return '⚪';
  }
}

// Backend는 datetime.utcnow() (UTC)로 저장하지만 timezone suffix 없이 반환
// JavaScript new Date()는 suffix 없으면 로컬 시간으로 해석 → UTC 'Z' 붙여서 보정
export function parseUTC(dateString: string): Date {
  if (!dateString) return new Date();
  // 이미 timezone info가 있으면 그대로 사용
  if (dateString.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(dateString)) {
    return new Date(dateString);
  }
  // timezone 없으면 UTC로 해석
  return new Date(dateString + 'Z');
}

export function formatDateTime(dateString: string): string {
  const date = parseUTC(dateString);
  return date.toLocaleString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatRelativeTime(dateString: string): string {
  const date = parseUTC(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return `${diffSec}초 전`;
  if (diffMin < 60) return `${diffMin}분 전`;
  if (diffHour < 24) return `${diffHour}시간 전`;
  return `${diffDay}일 전`;
}

/**
 * axios 에러를 **항상 문자열**로 변환. JSX 에서 직접 렌더 가능.
 *
 * FastAPI 422 는 `detail` 이 객체 배열 형태 (`[{type, loc, msg, input, ctx}, ...]`) 로
 * 돌아옴. JSX 에 객체를 그대로 넣으면 React error #31 발생 → 이 함수를 통해
 * 안전하게 문자열화.
 */
export function formatApiError(err: unknown, fallback = '요청 실패'): string {
  if (!err) return fallback;
  const e = err as {
    response?: { data?: { detail?: unknown; message?: unknown } };
    message?: string;
    name?: string;
    code?: string;
  };
  // axios CanceledError (사용자 취소)
  if (e.name === 'CanceledError' || e.code === 'ERR_CANCELED' || e.name === 'AbortError') {
    return '취소됨';
  }
  const detail = e?.response?.data?.detail;
  if (typeof detail === 'string') return detail;

  if (Array.isArray(detail)) {
    // FastAPI validation: [{type, loc, msg, input, ctx}, ...]
    const parts = detail.map((d): string => {
      if (typeof d === 'string') return d;
      if (d && typeof d === 'object') {
        const dd = d as { msg?: string; loc?: unknown[]; type?: string; ctx?: Record<string, unknown> };
        const loc = Array.isArray(dd.loc) ? dd.loc.filter((x) => x !== 'body').join('.') : '';
        const ctxNote =
          dd.ctx && typeof dd.ctx === 'object'
            ? ' (' + Object.entries(dd.ctx).map(([k, v]) => `${k}=${String(v)}`).join(', ') + ')'
            : '';
        const msg = dd.msg ?? dd.type ?? JSON.stringify(d);
        return `${loc ? `${loc}: ` : ''}${msg}${ctxNote}`;
      }
      return String(d);
    });
    return parts.join(' · ');
  }

  if (detail && typeof detail === 'object') {
    // 우리 백엔드 커스텀 에러: detail = { error, message, ... } → 친절한 message 우선.
    const dm = detail as { message?: unknown; error?: unknown };
    if (typeof dm.message === 'string' && dm.message) return dm.message;
    if (typeof dm.error === 'string' && dm.error) return dm.error;
    try { return JSON.stringify(detail); } catch { /* ignore */ }
  }

  const bodyMsg = e?.response?.data?.message;
  if (typeof bodyMsg === 'string') return bodyMsg;

  return e.message ?? fallback;
}
