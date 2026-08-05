// 클러스터 아이콘 빌더 — 업무명 / 속성 (+ 지역, 옵션) 정보로 SVG 아이콘을 생성한다.
// 결과는 data:image/svg+xml;base64 URL 로, 기존 Cluster.icon 컬럼에 그대로 저장되고
// resolveClusterIcon() 이 image 로 렌더한다 (백엔드 무변경).
//
// 시각 구성 (64 viewBox):
//   운영타입은 색상으로만 구분되고(테두리 ring + 배경 bg + 밴드 명도 계통이 전부 운영레벨
//   색 1개에서 파생), 그 자체로는 판독 가능한 텍스트 정보가 없다 — 그래서 아이콘 내부에
//   운영타입 전용 밴드(2층)를 따로 할당하지 않는다. 확보된 공간은 실제로 값을 담는
//   업무명 / 속성 밴드에 재배분하고, 지역은 입력이 있을 때만 세 번째 밴드로 추가한다.
//     - 지역 있음: 업무명(26) / 속성(22) / 지역(16)
//     - 지역 없음: 업무명(34) / 속성(30)
//   ※ 우상단은 사이드바 레일의 status dot 오버레이 자리이므로 텍스트를 넣지 않는다.

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
  /** k8s 휠 워터마크 표시 (기본 true) */
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

/** hex 색 → target 색으로 ratio(0~1) 만큼 섞기. 0=원본, 1=target. 밴드별 명도 단계를
 *  같은 계통 색에서 생성하는 데 쓴다. */
function mixHex(hex: string, target: string, ratio: number): string {
  const h = hex.replace('#', '');
  const t = target.replace('#', '');
  const hr = parseInt(h.slice(0, 2), 16), hg = parseInt(h.slice(2, 4), 16), hb = parseInt(h.slice(4, 6), 16);
  const tr = parseInt(t.slice(0, 2), 16), tg = parseInt(t.slice(2, 4), 16), tb = parseInt(t.slice(4, 6), 16);
  const mixCh = (a: number, b: number) => Math.round(a + (b - a) * ratio);
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(mixCh(hr, tr))}${toHex(mixCh(hg, tg))}${toHex(mixCh(hb, tb))}`;
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

/** k8s 7-spoke 휠 워터마크 — 중심 원 + 7방향 스포크 + 외곽 칠각형 링(단순화). */
function k8sWheel(cx: number, cy: number, r: number, color: string, opacity: number): string {
  const spokes: string[] = [];
  for (let i = 0; i < 7; i++) {
    const a = (Math.PI * 2 * i) / 7 - Math.PI / 2;
    const x2 = cx + Math.cos(a) * r;
    const y2 = cy + Math.sin(a) * r;
    spokes.push(`<line x1="${cx}" y1="${cy}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="2.4"/>`);
  }
  // 칠각형 외곽
  const pts: string[] = [];
  for (let i = 0; i < 7; i++) {
    const a = (Math.PI * 2 * i) / 7 - Math.PI / 2;
    pts.push(`${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`);
  }
  return `<g opacity="${opacity}">${spokes.join('')}<polygon points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2.4"/><circle cx="${cx}" cy="${cy}" r="${(r * 0.28).toFixed(1)}" fill="${color}"/></g>`;
}

/** 밴드 텍스트 폰트 크기 — 밴드 높이(bandH)에 맞춰 글자를 최대한 키우되 넘치지 않게 캡. */
function bandFontSize(text: string, bandH: number): number {
  const wide = hasWideChar(text);
  const len = Math.max(1, [...text].length);
  const base = wide ? (len >= 3 ? 12 : 14) : (len >= 5 ? 11 : len >= 4 ? 12 : 14);
  return Math.min(base, Math.round(bandH * 0.6));
}

interface Band {
  text: string;
  fill: string;
  dark: boolean;
  h: number;
}

/** 옵션 조합으로 64×64 SVG 문자열 생성 — 업무명/속성(+지역, 옵션) 밴드를 위→아래로 쌓는다.
 *  운영타입은 밴드가 아니라 테두리(ring)/배경(bg)/밴드 명도로만 반영된다. */
export function buildClusterIconSvg(opts: ClusterIconBuildOptions): string {
  const pal = paletteOf(opts.colorToken, opts.customHex);
  const watermark = opts.k8sWatermark !== false;
  const circle = opts.shape === 'circle';
  const region = opts.regionAbbr.trim();
  const hasRegion = region.length > 0;

  // 운영타입 전용 밴드를 없애고 확보한 공간을 업무명/속성(+지역)에 재배분한다.
  const bands: Band[] = hasRegion
    ? [
        { text: escapeXml(opts.workName.trim().slice(0, 5)), fill: mixHex(pal.band, '#ffffff', 0.70), dark: false, h: 26 },
        { text: escapeXml(opts.attribute.trim().slice(0, 5)), fill: mixHex(pal.band, '#ffffff', 0.28), dark: true, h: 22 },
        { text: escapeXml(region.slice(0, 5)), fill: mixHex(pal.band, '#ffffff', 0.50), dark: false, h: 16 },
      ]
    : [
        { text: escapeXml(opts.workName.trim().slice(0, 5)), fill: mixHex(pal.band, '#ffffff', 0.68), dark: false, h: 34 },
        { text: escapeXml(opts.attribute.trim().slice(0, 5)), fill: mixHex(pal.band, '#ffffff', 0.26), dark: true, h: 30 },
      ];

  // 배경 — 클립 없이 그려 테두리 링(stroke)이 온전히 보이게 한다. 운영타입 색은 여기(ring/bg)
  // 와 밴드 명도 계통에만 반영되고 별도 공간을 차지하지 않는다.
  const bgShape = circle
    ? `<circle cx="32" cy="32" r="30" fill="${pal.bg}" stroke="${pal.ring}" stroke-width="3"/>`
    : `<rect x="2" y="2" width="60" height="60" rx="14" fill="${pal.bg}" stroke="${pal.ring}" stroke-width="3"/>`;

  // 밴드 — 배경 모양 안쪽(테두리보다 살짝 안쪽)에 클립.
  const clipId = circle ? 'cibc' : 'cibs';
  const clipShape = circle
    ? `<circle cx="32" cy="32" r="28.5"/>`
    : `<rect x="3.5" y="3.5" width="57" height="57" rx="12.5"/>`;

  let y = 0;
  const bandRects = bands.map((b) => {
    const top = y;
    y += b.h;
    const textColor = b.dark ? '#ffffff' : pal.text;
    const label = b.text
      ? `<text x="32" y="${top + b.h / 2}" text-anchor="middle" dominant-baseline="central" ` +
        `font-family="system-ui,-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif" ` +
        `font-size="${bandFontSize(b.text, b.h)}" font-weight="700" fill="${textColor}">${b.text}</text>`
      : '';
    return `<rect x="0" y="${top}" width="64" height="${b.h}" fill="${b.fill}"/>${label}`;
  }).join('');

  const wheel = watermark ? k8sWheel(32, 32, 24, pal.ring, 0.12) : '';

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">` +
    `<defs><clipPath id="${clipId}">${clipShape}</clipPath></defs>` +
    bgShape +
    `<g clip-path="url(#${clipId})">${bandRects}${wheel}</g>` +
    `</svg>`
  );
}

/** SVG 문자열 → data URL (base64 — 한글 포함 대비 UTF-8 인코딩). */
export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}
