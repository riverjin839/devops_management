// 클러스터 아이콘 빌더 — 업무명 / 속성 (+ 지역, 옵션) 정보로 SVG 아이콘을 생성한다.
// 결과는 data:image/svg+xml;base64 URL 로, 기존 Cluster.icon 컬럼에 그대로 저장되고
// resolveClusterIcon() 이 image 로 렌더한다 (백엔드 무변경).
//
// 시각 구성 (64 viewBox) — 앱 셸과 같은 결의 무채색 타일:
//   - 바탕/테두리/글자색은 활성 UI 테마 토큰(--secondary/--border/--foreground/
//     --muted-foreground)을 렌더 시점에 읽어 쓴다 → 테마를 바꾸면 아이콘도 같이 바뀐다.
//   - 업무명 = 큰 굵은 글씨 1줄, 속성 · 지역 = muted 작은 글씨 1줄.
//   - 운영타입 색은 하단 얇은 바에만 쓴다(색 면을 쌓지 않음).
//   ※ 우상단은 사이드바 레일의 status dot 오버레이 자리이므로 아무것도 그리지 않는다.

import { parseClusterName } from './clusterName';
import { deriveToneSet, isValidHex } from './colorTone';

export interface ClusterIconBuildOptions {
  /** 업무명 (1~5자 권장, 이상은 잘림) — 상단 밴드 */
  workName: string;
  /** 속성 — 클러스터 기능 구분 (예: Computing/Storage) */
  attribute: string;
  /** 지역 약어 — 옵션. 비우면 지역 밴드를 만들지 않고 남는 공간을 업무명/속성에 재할당한다. */
  regionAbbr: string;
  /** 운영타입(환경) 색 토큰 — useOperationLevels 의 color 토큰과 동일 키 (red/amber/blue/…).
   *  아이콘 안에는 전용 공간을 할당하지 않고 테두리(ring)/배경(bg)/밴드 명도로만 표시한다. */
  colorToken: string;
  /** 지정되면 colorToken 프리셋 대신 이 hex 를 시드로 톤을 자동 산출한다(운영레벨 customHex). */
  customHex?: string | null;
  /** 구버전 레시피 호환용 — 레일 크기(30~40px)에서 얼룩으로만 보여 더 이상 그리지 않는다. */
  k8sWatermark?: boolean;
  /** 모양 — rounded-square(기본) 또는 원 */
  shape?: 'square' | 'circle';
}

/** 환경 색 토큰 → SVG HEX 팔레트. COLOR_BADGE(useOperationLevels)의 13색 토큰과 동일 키.
 *  bg=연한 배경(비클립 테두리 영역), ring=테두리, band=밴드 색의 기준(가장 진한 색),
 *  text=밝은 배경 밴드의 글자색. */
export const COLOR_HEX: Record<string, { bg: string; ring: string; band: string; text: string }> = {
  red:     { bg: '#fee2e2', ring: '#ef4444', band: '#dc2626', text: '#7f1d1d' },
  amber:   { bg: '#fef3c7', ring: '#f59e0b', band: '#d97706', text: '#78350f' },
  emerald: { bg: '#d1fae5', ring: '#10b981', band: '#059669', text: '#064e3b' },
  sky:     { bg: '#e0f2fe', ring: '#0ea5e9', band: '#0284c7', text: '#0c4a6e' },
  blue:    { bg: '#dbeafe', ring: '#3b82f6', band: '#2563eb', text: '#1e3a8a' },
  purple:  { bg: '#f3e8ff', ring: '#a855f7', band: '#9333ea', text: '#581c87' },
  pink:    { bg: '#fce7f3', ring: '#ec4899', band: '#db2777', text: '#831843' },
  yellow:  { bg: '#fef9c3', ring: '#eab308', band: '#ca8a04', text: '#713f12' },
  cyan:    { bg: '#cffafe', ring: '#06b6d4', band: '#0891b2', text: '#164e63' },
  violet:  { bg: '#ede9fe', ring: '#8b5cf6', band: '#7c3aed', text: '#4c1d95' },
  orange:  { bg: '#ffedd5', ring: '#f97316', band: '#ea580c', text: '#7c2d12' },
  slate:   { bg: '#e2e8f0', ring: '#64748b', band: '#475569', text: '#1e293b' },
  muted:   { bg: '#e5e5e5', ring: '#737373', band: '#525252', text: '#262626' },
};

function paletteOf(token: string, customHex?: string | null) {
  if (isValidHex(customHex)) return deriveToneSet(customHex);
  return COLOR_HEX[token] ?? COLOR_HEX.slate;
}

/** 한글 등 넓은 글자가 섞였는지 — 폰트 크기 계산용. */
function hasWideChar(s: string): boolean {
  return /[ᄀ-ᇿ㄰-㆏가-힯一-鿿぀-ヿ]/.test(s);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 서비스명 → 업무명 자동 제안. 영문 단어 첫 글자 대문자 조합(최대 3자), 한글이면 앞 2자.
 *  표준 이름 규칙([업무명]-[운영타입]-[속성])을 따르면 첫 세그먼트를 우선 사용한다. */
export function suggestInitials(name: string | null | undefined): string {
  const n = (name ?? '').trim();
  if (!n) return 'K8S';
  const std = parseClusterName(n);
  const biz = (std?.biz ?? n).trim();
  if (hasWideChar(biz)) {
    const compact = biz.replace(/[\s\-_./]+/g, '');
    return compact.slice(0, 2) || 'K8S';
  }
  const words = biz.split(/[\s\-_./]+/).filter(Boolean);
  if (words.length >= 2) {
    return words.slice(0, 3).map((w) => w[0]!.toUpperCase()).join('');
  }
  return biz.slice(0, 3).toUpperCase();
}

/** 지역 → 지역 약어 자동 제안(옵션). 한글이면 앞 2자(이천/용인/청주/우시 그대로), 영문이면 대문자 3자. */
export function suggestRegionAbbr(region: string | null | undefined): string {
  const r = (region ?? '').trim();
  if (!r) return '';
  if (hasWideChar(r)) {
    return r.replace(/[\s\-_./]+/g, '').slice(0, 2);
  }
  return r.replace(/[\s\-_./]+/g, '').slice(0, 3).toUpperCase();
}

/** 클러스터 이름 → 속성 자동 제안. 표준 이름 규칙([업무명]-[운영타입]-[속성])의
 *  3번째 세그먼트(클러스터 기능 — 예: computing/storage)를 추출, 표준 형식이 아니면 빈 문자열. */
export function suggestAttribute(name: string | null | undefined): string {
  const parsed = parseClusterName((name ?? '').trim());
  return parsed?.attr ? parsed.attr.slice(0, 5) : '';
}

/** 아이콘 바탕에 쓰는 UI 테마 토큰(CSS 색 문자열). SVG 를 <img> data URL 로 그리므로
 *  CSS 변수를 직접 참조할 수 없어, 렌더 시점의 계산값을 읽어 리터럴로 박는다. */
export interface IconSurfaceTokens {
  surface: string;
  border: string;
  fg: string;
  muted: string;
}

/** 라이트 테마 기본값 — document 가 없거나 토큰을 못 읽을 때의 폴백. */
const FALLBACK_SURFACE: IconSurfaceTokens = {
  surface: 'hsl(210 33% 95%)',
  border: 'hsl(214 32% 91%)',
  fg: 'hsl(222 47% 11%)',
  muted: 'hsl(215 16% 47%)',
};

/** 현재 활성 테마의 토큰(--secondary/--border/--foreground/--muted-foreground)을 읽는다.
 *  index.css 토큰은 `H S% L%` 형식이라 hsl() 로 감싼다. */
export function readIconSurfaceTokens(): IconSurfaceTokens {
  if (typeof document === 'undefined') return FALLBACK_SURFACE;
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => {
    const raw = cs.getPropertyValue(name).trim();
    return raw ? `hsl(${raw})` : fallback;
  };
  return {
    surface: read('--secondary', FALLBACK_SURFACE.surface),
    border: read('--border', FALLBACK_SURFACE.border),
    fg: read('--foreground', FALLBACK_SURFACE.fg),
    muted: read('--muted-foreground', FALLBACK_SURFACE.muted),
  };
}

/** 업무명(주 텍스트) 폰트 크기 — 글자 수가 늘수록 줄여 64 폭 안에 들어가게 한다. */
function primaryFontSize(text: string): number {
  const len = Math.max(1, [...text].length);
  if (hasWideChar(text)) return len >= 3 ? 16 : 21;
  return len >= 5 ? 14 : len === 4 ? 17 : 21;
}

/** 보조 줄(속성 · 지역) 폰트 크기. */
function secondaryFontSize(text: string): number {
  const len = [...text].length;
  const wide = hasWideChar(text);
  if (len >= (wide ? 6 : 9)) return 9;
  return 11;
}

/** 옵션 조합으로 64×64 SVG 문자열 생성.
 *  바탕은 활성 테마의 secondary 면 + 1px border(무채색), 업무명은 foreground 굵은 글씨,
 *  속성·지역은 muted 한 줄로 아래에 둔다. 운영타입 색은 하단 얇은 바 한 줄에만 쓴다 —
 *  색 면을 쌓지 않아 레일에 여러 개가 나란히 있어도 시끄럽지 않다. */
export function buildClusterIconSvg(opts: ClusterIconBuildOptions, tokens?: IconSurfaceTokens): string {
  const pal = paletteOf(opts.colorToken, opts.customHex);
  const t = tokens ?? readIconSurfaceTokens();
  const circle = opts.shape === 'circle';
  const work = opts.workName.trim().slice(0, 5);
  const sub = [opts.attribute.trim().slice(0, 5), opts.regionAbbr.trim().slice(0, 5)]
    .filter(Boolean)
    .join(' · ');

  const clipId = circle ? 'cibc' : 'cibs';
  const shapeAttrs = circle ? 'cx="32" cy="32" r="31"' : 'x="1" y="1" width="62" height="62" rx="12"';
  const shapeTag = circle ? 'circle' : 'rect';

  const font = `font-family="system-ui,-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif"`;
  const workY = sub ? 27 : 31;
  const workText = work
    ? `<text x="32" y="${workY}" text-anchor="middle" dominant-baseline="central" ${font} ` +
      `font-size="${primaryFontSize(work)}" font-weight="650" letter-spacing="-0.2" fill="${t.fg}">${escapeXml(work)}</text>`
    : '';
  const subText = sub
    ? `<text x="32" y="44" text-anchor="middle" dominant-baseline="central" ${font} ` +
      `font-size="${secondaryFontSize(sub)}" font-weight="500" fill="${t.muted}">${escapeXml(sub)}</text>`
    : '';

  // 운영타입 바 — 하단 약 6px. 원형은 클립으로 자연스럽게 호 모양이 된다.
  const levelBar = `<rect x="0" y="57" width="64" height="7" fill="${pal.ring}"/>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">` +
    `<defs><clipPath id="${clipId}"><${shapeTag} ${shapeAttrs}/></clipPath></defs>` +
    `<${shapeTag} ${shapeAttrs} fill="${t.surface}"/>` +
    `<g clip-path="url(#${clipId})">${levelBar}</g>` +
    `<${shapeTag} ${shapeAttrs} fill="none" stroke="${t.border}" stroke-width="1.5"/>` +
    workText + subText +
    `</svg>`
  );
}

/** SVG 문자열 → data URL (base64 — 한글 포함 대비 UTF-8 인코딩). */
export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}
