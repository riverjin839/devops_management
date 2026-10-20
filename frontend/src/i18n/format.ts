import { dateKeyOf, fmtKoreanDate } from '@/lib/utils';
import type { Locale } from './index';

/** 셸 날짜 표기 — ko `2026-10-20 (화)`, en `2026-10-20 (Tue)`. 날짜 키 모양은 로케일과 무관하게 같다. */
export function fmtShellDate(d: Date, locale: Locale): string {
  if (locale === 'ko') return fmtKoreanDate(d);
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(d);
  return `${dateKeyOf(d)} (${weekday})`;
}
