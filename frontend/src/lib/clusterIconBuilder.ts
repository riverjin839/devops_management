// 클러스터 아이콘 빌더 — 서비스 이니셜 + 환경(운영등급) 색 + 지역 약어를 조합한
// SVG 아이콘을 생성한다. 결과는 data:image/svg+xml;base64 URL 로, 기존 Cluster.icon
// 컬럼에 그대로 저장되고 resolveClusterIcon() 이 image 로 렌더한다 (백엔드 무변경).
//
// 시각 구성 (64 viewBox):
//   배경  — 환경색 연한 톤 + 환경색 진한 테두리 링 (rounded-square 또는 원)
//   워터마크 — k8s 7-spoke 휠 (옅게, 토글)
//   중앙  — 서비스 이니셜 1~3자
//   하단  — 환경색 진한 밴드 + 지역 약어 (흰 글씨)
//   ※ 우상단은 사이드바 레일의 status dot 오버레이 자리이므로 비워둔다.

export interface ClusterIconBuildOptions {
  /** 중앙 이니셜 (1~3자 권장, 이상은 잘림) */
  initials: string;
  /** 하단 밴드 지역 약어 (1~3자 권장, 빈 값이면 밴드 생략) */
  regionAbbr: string;
  /** 환경 색 토큰 — useOperationLevels 의 color 토큰과 동일 키 (red/amber/blue/…) */
  colorToken: string;
  /** k8s 휠 워터마크 표시 (기본 true) */
  k8sWatermark?: boolean;
  /** 모양 — rounded-square(기본) 또는 원 */
  shape?: 'square' | 'circle';
}

/** 환경 색 토큰 → SVG HEX 팔레트. COLOR_BADGE(useOperationLevels)의 13색 토큰과 동일 키.
 *  bg=연한 배경, ring=테두리, band=하단 밴드/강조, text=이니셜 색. */
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

function paletteOf(token: string) {
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

/** 서비스명 → 이니셜 자동 제안. 영문 단어 첫 글자 대문자 조합(최대 3자), 한글이면 앞 2자. */
export function suggestInitials(name: string | null | undefined): string {
  const n = (name ?? '').trim();
  if (!n) return 'K8S';
  if (hasWideChar(n)) {
    // 한글/한자 — 공백/구분자 제거 후 앞 2자
    const compact = n.replace(/[\s\-_./]+/g, '');
    return compact.slice(0, 2) || 'K8S';
  }
  const words = n.split(/[\s\-_./]+/).filter(Boolean);
  if (words.length >= 2) {
    return words.slice(0, 3).map((w) => w[0]!.toUpperCase()).join('');
  }
  return n.slice(0, 3).toUpperCase();
}

/** 지역 → 하단 밴드 약어 자동 제안. 한글이면 앞 2자(이천/용인/청주/우시 그대로), 영문이면 대문자 3자. */
export function suggestRegionAbbr(region: string | null | undefined): string {
  const r = (region ?? '').trim();
  if (!r) return '';
  if (hasWideChar(r)) {
    return r.replace(/[\s\-_./]+/g, '').slice(0, 2);
  }
  return r.replace(/[\s\-_./]+/g, '').slice(0, 3).toUpperCase();
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

/** 옵션 조합으로 64×64 SVG 문자열 생성. */
export function buildClusterIconSvg(opts: ClusterIconBuildOptions): string {
  const pal = paletteOf(opts.colorToken);
  const initials = escapeXml(opts.initials.trim().slice(0, 3));
  const regionAbbr = escapeXml(opts.regionAbbr.trim().slice(0, 3));
  const watermark = opts.k8sWatermark !== false;
  const circle = opts.shape === 'circle';

  const hasBand = regionAbbr.length > 0;
  const bandH = 18;

  // 이니셜 폰트 크기 — 글자 수/폭 기준. 밴드가 없으면 중앙 확대.
  const wide = hasWideChar(initials);
  const len = Math.max(1, [...initials].length);
  let fontSize: number;
  if (wide) fontSize = len >= 2 ? 22 : 30;
  else fontSize = len >= 3 ? 20 : len === 2 ? 26 : 34;
  if (!hasBand) fontSize += 4;
  const initialsY = hasBand ? 26 : 32; // 중앙(밴드 있으면 위로 살짝)

  // 배경 모양
  const bgShape = circle
    ? `<circle cx="32" cy="32" r="30" fill="${pal.bg}" stroke="${pal.ring}" stroke-width="3"/>`
    : `<rect x="2" y="2" width="60" height="60" rx="14" fill="${pal.bg}" stroke="${pal.ring}" stroke-width="3"/>`;

  // 하단 밴드 — 배경 모양 안쪽에 클립.
  // id 는 모양별로 분리 — 한 페이지에 여러 아이콘이 인라인 SVG 로 놓여 id 가 충돌해도
  // 같은 모양끼리는 동일 정의라 무해하다 (실제 렌더는 <img> 라 격리되지만 방어적으로).
  const clipId = circle ? 'cibc' : 'cibs';
  const clipShape = circle
    ? `<circle cx="32" cy="32" r="28.5"/>`
    : `<rect x="3.5" y="3.5" width="57" height="57" rx="12.5"/>`;
  const band = hasBand
    ? `<g clip-path="url(#${clipId})"><rect x="0" y="${64 - bandH - 2}" width="64" height="${bandH + 2}" fill="${pal.band}"/>` +
      `<text x="32" y="${64 - 2 - bandH / 2}" text-anchor="middle" dominant-baseline="central" ` +
      `font-family="system-ui,-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif" ` +
      `font-size="${hasWideChar(regionAbbr) ? 12 : 12}" font-weight="700" fill="#ffffff">${regionAbbr}</text></g>`
    : '';

  const wheel = watermark ? k8sWheel(32, hasBand ? 26 : 32, 22, pal.ring, 0.14) : '';

  const initialsText =
    `<text x="32" y="${initialsY}" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="system-ui,-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif" ` +
    `font-size="${fontSize}" font-weight="800" fill="${pal.text}" letter-spacing="${wide ? 0 : 0.5}">${initials}</text>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">` +
    `<defs><clipPath id="${clipId}">${clipShape}</clipPath></defs>` +
    bgShape + wheel + band + initialsText +
    `</svg>`
  );
}

/** SVG 문자열 → data URL (base64 — 한글 포함 대비 UTF-8 인코딩). */
export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}
