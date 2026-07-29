/**
 * 점검 매트릭스 행 색 프리셋 — 차트 토큰(--chart-1..8) 기반이라 테마(default/light/dark)를
 * 자동으로 따라간다. raw hex 를 저장/렌더하지 않는 이유: 테마마다 값이 달라져야 하기
 * 때문(디자인 시스템 불변 규칙 — 고정 팔레트 금지).
 *
 * 백엔드는 프리셋 키('chart-1'..'chart-8')만 검증·저장한다 (routers/check_matrix.py).
 * Tailwind JIT 가 클래스를 수집할 수 있도록 전부 리터럴 문자열로 적는다.
 */
export interface RowColorPreset {
  key: string;
  label: string;
  /** 행 라벨 셀 배경 틴트 */
  bg: string;
  /** 좌측 컬러 바 */
  bar: string;
  /** 영역 칩(배경+글자+보더) */
  chip: string;
  /** 색상 피커 스와치 */
  swatch: string;
}

export const ROW_COLOR_PRESETS: RowColorPreset[] = [
  {
    key: 'chart-1', label: '블루',
    bg: 'bg-[hsl(var(--chart-1)/0.07)]',
    bar: 'border-l-[hsl(var(--chart-1)/0.6)]',
    chip: 'bg-[hsl(var(--chart-1)/0.12)] text-[hsl(var(--chart-1))] border-[hsl(var(--chart-1)/0.35)]',
    swatch: 'bg-[hsl(var(--chart-1))]',
  },
  {
    key: 'chart-2', label: '틸',
    bg: 'bg-[hsl(var(--chart-2)/0.07)]',
    bar: 'border-l-[hsl(var(--chart-2)/0.6)]',
    chip: 'bg-[hsl(var(--chart-2)/0.12)] text-[hsl(var(--chart-2))] border-[hsl(var(--chart-2)/0.35)]',
    swatch: 'bg-[hsl(var(--chart-2))]',
  },
  {
    key: 'chart-3', label: '앰버',
    bg: 'bg-[hsl(var(--chart-3)/0.07)]',
    bar: 'border-l-[hsl(var(--chart-3)/0.6)]',
    chip: 'bg-[hsl(var(--chart-3)/0.12)] text-[hsl(var(--chart-3))] border-[hsl(var(--chart-3)/0.35)]',
    swatch: 'bg-[hsl(var(--chart-3))]',
  },
  {
    key: 'chart-4', label: '바이올렛',
    bg: 'bg-[hsl(var(--chart-4)/0.07)]',
    bar: 'border-l-[hsl(var(--chart-4)/0.6)]',
    chip: 'bg-[hsl(var(--chart-4)/0.12)] text-[hsl(var(--chart-4))] border-[hsl(var(--chart-4)/0.35)]',
    swatch: 'bg-[hsl(var(--chart-4))]',
  },
  {
    key: 'chart-5', label: '로즈',
    bg: 'bg-[hsl(var(--chart-5)/0.07)]',
    bar: 'border-l-[hsl(var(--chart-5)/0.6)]',
    chip: 'bg-[hsl(var(--chart-5)/0.12)] text-[hsl(var(--chart-5))] border-[hsl(var(--chart-5)/0.35)]',
    swatch: 'bg-[hsl(var(--chart-5))]',
  },
  {
    key: 'chart-6', label: '시안',
    bg: 'bg-[hsl(var(--chart-6)/0.07)]',
    bar: 'border-l-[hsl(var(--chart-6)/0.6)]',
    chip: 'bg-[hsl(var(--chart-6)/0.12)] text-[hsl(var(--chart-6))] border-[hsl(var(--chart-6)/0.35)]',
    swatch: 'bg-[hsl(var(--chart-6))]',
  },
  {
    key: 'chart-7', label: '오렌지',
    bg: 'bg-[hsl(var(--chart-7)/0.07)]',
    bar: 'border-l-[hsl(var(--chart-7)/0.6)]',
    chip: 'bg-[hsl(var(--chart-7)/0.12)] text-[hsl(var(--chart-7))] border-[hsl(var(--chart-7)/0.35)]',
    swatch: 'bg-[hsl(var(--chart-7))]',
  },
  {
    key: 'chart-8', label: '슬레이트',
    bg: 'bg-[hsl(var(--chart-8)/0.07)]',
    bar: 'border-l-[hsl(var(--chart-8)/0.6)]',
    chip: 'bg-[hsl(var(--chart-8)/0.12)] text-[hsl(var(--chart-8))] border-[hsl(var(--chart-8)/0.35)]',
    swatch: 'bg-[hsl(var(--chart-8))]',
  },
];

const BY_KEY = new Map(ROW_COLOR_PRESETS.map((p) => [p.key, p]));

export function rowColor(key?: string | null): RowColorPreset | null {
  return key ? (BY_KEY.get(key) ?? null) : null;
}

/** 영역 자유 입력 시 추천 목록 — 백엔드 시드 카테고리와 일치. */
export const CATEGORY_SUGGESTIONS = ['k8s', 'network', 'storage', 'os', 'app'];
