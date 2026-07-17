// 시드 hex 1개 → bg/ring/band/text 4단계 톤 세트를 자동 산출한다.
// Material Theme Builder 의 "seed color → tonal palette" 아이디어를 단순화한 버전 —
// 같은 hue/saturation 을 유지한 채 lightness 만 조절해 4개 톤을 뽑는다(HCT 대신 HSL 근사).
// 클러스터 운영레벨에 프리셋 13색 대신 임의의 hex 를 지정할 때(customHex) 쓴다.

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
    case gn: h = (bn - rn) / d + 2; break;
    default: h = (rn - gn) / d + 4;
  }
  return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hn = h / 360;
  return [
    hue2rgb(p, q, hn + 1 / 3) * 255,
    hue2rgb(p, q, hn) * 255,
    hue2rgb(p, q, hn - 1 / 3) * 255,
  ];
}

/** L(0~1) 고정, S 는 최소치 보장(너무 탁한 회색 방지) 해서 새 hex 를 만든다. */
function tone(h: number, s: number, l: number, minS = 0.15): string {
  const [r, g, b] = hslToRgb(h, Math.max(s, minS), l);
  return rgbToHex(r, g, b);
}

export interface ToneSet {
  /** 연한 배경(카드/뱃지 배경) */
  bg: string;
  /** 테두리/포인트 색 — 시드에 가장 가까움 */
  ring: string;
  /** 가장 진한 톤 — 아이콘 밴드 기준색 등 */
  band: string;
  /** 밝은 배경 위 텍스트 색 */
  text: string;
}

/** 임의의 seed hex 로부터 bg/ring/band/text 톤 세트를 산출한다.
 *  hue/saturation 은 seed 를 따르고 lightness 축만 이동시켜 4단계를 만든다. */
export function deriveToneSet(seedHex: string): ToneSet {
  const [r, g, b] = hexToRgb(seedHex);
  const [h, s] = rgbToHsl(r, g, b);
  return {
    bg: tone(h, s, 0.93, 0.08),
    ring: tone(h, s, 0.52),
    band: tone(h, s, 0.42),
    text: tone(h, s, 0.24),
  };
}

/** hex 유효성 체크 (#RGB 또는 #RRGGBB). */
export function isValidHex(v: string | null | undefined): v is string {
  return !!v && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
}
