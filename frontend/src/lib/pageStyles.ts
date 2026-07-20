import type { CSSProperties } from 'react';
import type { PageStyle } from '@/types';

/** 전 페이지 공통 기본값을 담는 특수 키. 그 외 키는 라우트 경로('/path'). */
export const PAGE_STYLE_DEFAULT_KEY = '__default__';

/** 폰트 선택지 — 시스템 폰트 스택 + 자체 호스팅(번들 포함) 웹폰트.
 *  자체 호스팅 폰트(Outfit/Geist)는 CDN 요청 없이 빌드 산출물에 포함되므로
 *  폐쇄망(airgap) 배포에서도 안전하게 동작한다(main.tsx 에서 import).
 *  단, 두 폰트 모두 라틴 문자만 포함 — 한글은 자동으로 스택의 다음 폰트로 폴백된다. */
export const PAGE_FONT_OPTIONS: { label: string; value: string }[] = [
  { label: '기본 (테마 폰트)', value: '' },
  { label: '산세리프 (System Sans)', value: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { label: '명조 (Serif)', value: 'Georgia, "Times New Roman", "Noto Serif KR", serif' },
  { label: '고딕 (Korean Gothic)', value: '"Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif' },
  { label: '모노스페이스', value: 'ui-monospace, "JetBrains Mono", "Courier New", monospace' },
  { label: 'Outfit (개성있는 지오메트릭 산세리프)', value: '"Outfit Variable", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif' },
  { label: 'Geist (모던 산세리프)', value: '"Geist Variable", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif' },
];

/** 폰트 배율 선택지 (본문 영역 zoom). */
export const PAGE_FONT_SCALES: { label: string; value: number }[] = [
  { label: '90%', value: 0.9 },
  { label: '100%', value: 1 },
  { label: '110%', value: 1.1 },
  { label: '125%', value: 1.25 },
  { label: '150%', value: 1.5 },
];

/** default(전체 기본) 위에 path 별 오버라이드를 병합한 유효 스타일. */
export function resolvePageStyle(
  map: Record<string, PageStyle> | undefined,
  path: string,
): PageStyle {
  const base = map?.[PAGE_STYLE_DEFAULT_KEY] ?? {};
  const override = map?.[path] ?? {};
  return { ...base, ...override };
}

/** 유효 스타일 → 본문 래퍼에 적용할 inline CSS. font scale 은 zoom 으로(rem 기반 Tailwind 도 확대). */
export function pageStyleToCss(s: PageStyle): CSSProperties {
  const css: CSSProperties = {};
  if (s.fontFamily) css.fontFamily = s.fontFamily;
  if (s.textColor) css.color = s.textColor;
  if (s.bgColor) css.backgroundColor = s.bgColor;
  if (s.fontScale && s.fontScale !== 1) {
    (css as Record<string, unknown>).zoom = s.fontScale;
  }
  return css;
}

/** 스타일에 실제 지정된 필드가 하나라도 있는지. */
export function hasAnyStyle(s: PageStyle | undefined): boolean {
  return !!s && (!!s.fontFamily || !!s.textColor || !!s.bgColor || (!!s.fontScale && s.fontScale !== 1));
}
