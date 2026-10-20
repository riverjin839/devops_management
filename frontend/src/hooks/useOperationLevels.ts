import type { CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { uiSettingsApi } from '@/services/api';
import type { OperationLevelItem } from '@/types';
import { deriveToneSet, isValidHex } from '@/lib/colorTone';

export const opsLevelsKeys = {
  list: ['ui-settings', 'operation-levels'] as const,
};

const FALLBACK: OperationLevelItem[] = [
  { value: 'production', label: '운영 (Production)', color: 'red',    icon: '🚀' },
  { value: 'staging',    label: '스테이징 (Staging)', color: 'amber',  icon: '✨' },
  { value: 'dev',        label: '개발 (Dev)',         color: 'blue',   icon: '💻' },
  { value: 'test',       label: '테스트 (Test)',      color: 'slate',  icon: '🧪' },
  { value: 'dr',         label: 'DR',                 color: 'purple', icon: '🛡️' },
];

/** 사용자가 운영레벨 별로 고를 수 있는 10개의 이모지. */
export const EMOJI_OPTIONS: ReadonlyArray<{ emoji: string; description: string }> = [
  { emoji: '🚀', description: '운영 · 런칭 / Live' },
  { emoji: '🏭', description: '운영 · 대규모 / Production' },
  { emoji: '✨', description: '스테이징 · 새 빌드' },
  { emoji: '💻', description: '개발 / Dev' },
  { emoji: '🧪', description: '테스트 / QA' },
  { emoji: '🛡️', description: 'DR · 재해복구' },
  { emoji: '🔧', description: '유지보수 · Maintenance' },
  { emoji: '⚙️', description: '일반 / Generic' },
  { emoji: '📦', description: '컨테이너 · 빌드' },
  { emoji: '🌐', description: '공개 · 글로벌' },
];

/** 운영레벨 value 가 EMOJI_OPTIONS 에 없을 때 쓰는 기본 fallback. */
const DEFAULT_FALLBACK_EMOJI = '⚙️';

/** 키워드 기반 fallback — icon 이 미지정인 운영레벨에 자동 매칭. */
const VALUE_HINT_EMOJI: Array<{ test: RegExp; emoji: string }> = [
  { test: /prod|운영|live/i,                emoji: '🚀' },
  { test: /stag|스테이지|스테이징/i,         emoji: '✨' },
  { test: /dev|개발/i,                      emoji: '💻' },
  { test: /test|qa|테스트/i,                emoji: '🧪' },
  { test: /dr|disaster|재해|복구/i,         emoji: '🛡️' },
  { test: /main|maint|유지/i,               emoji: '🔧' },
];

export function useOperationLevels() {
  return useQuery({
    queryKey: opsLevelsKeys.list,
    queryFn: async () => {
      const { data } = await uiSettingsApi.getOperationLevels();
      return data.levels;
    },
    staleTime: 60_000,
    placeholderData: FALLBACK,
  });
}

export function useUpdateOperationLevels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (levels: OperationLevelItem[]) => uiSettingsApi.updateOperationLevels(levels),
    onSuccess: () => qc.invalidateQueries({ queryKey: opsLevelsKeys.list }),
  });
}

// ── 색상 토큰 → 클래스 매핑 (Tailwind 동적 클래스 회피) ──────────────
// 키(이름)는 DB 저장값 호환을 위해 유지하고, 장식 팔레트 키는 카테고리 토큰 chart-N 으로 그린다(D-120).
// 상태 토큰(status-*)은 쓰지 않는다(D-119) — 색 이름에 가장 가까운 chart-N. purple·violet 은 chart-4, amber·yellow 는 chart-3 으로 수렴한다.
const COLOR_BADGE: Record<string, string> = {
  red:     'bg-chart-5/15 text-chart-5-text border-chart-5/30',
  amber:   'bg-chart-3/15 text-chart-3-text border-chart-3/30',
  emerald: 'bg-chart-2/15 text-chart-2-text border-chart-2/30',
  sky:     'bg-chart-6/15 text-chart-6-text border-chart-6/30',
  blue:    'bg-chart-1/15 text-chart-1-text border-chart-1/30',
  purple:  'bg-chart-4/15 text-chart-4-text border-chart-4/30',
  pink:    'bg-chart-5/15 text-chart-5-text border-chart-5/30',
  yellow:  'bg-chart-3/15 text-chart-3-text border-chart-3/30',
  cyan:    'bg-chart-6/15 text-chart-6-text border-chart-6/30',
  violet:  'bg-chart-4/15 text-chart-4-text border-chart-4/30',
  orange:  'bg-chart-7/15 text-chart-7-text border-chart-7/30',
  slate:   'bg-chart-8/15 text-chart-8-text border-chart-8/30',
  muted:   'bg-muted          text-muted-foreground border-border',
};

export const COLOR_OPTIONS = Object.keys(COLOR_BADGE);

export function levelBadgeClass(color: string | undefined): string {
  return COLOR_BADGE[color ?? 'slate'] ?? COLOR_BADGE.slate;
}

/** value → label 매핑 (라벨이 없으면 value 그대로) */
export function levelLabel(levels: OperationLevelItem[] | undefined, value: string | null | undefined): string {
  if (!value) return '';
  const hit = levels?.find((l) => l.value === value);
  return hit?.label ?? value;
}

/** value → color (프리셋 키, customHex 가 있어도 SVG fallback 용으로 계속 반환) */
export function levelColor(levels: OperationLevelItem[] | undefined, value: string | null | undefined): string {
  if (!value) return 'slate';
  const hit = levels?.find((l) => l.value === value);
  return hit?.color ?? 'slate';
}

/** value → 커스텀 hex (지정 안 됐으면 undefined — 이땐 프리셋 color 를 그대로 쓰면 됨) */
export function levelCustomHex(levels: OperationLevelItem[] | undefined, value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const hit = levels?.find((l) => l.value === value);
  return isValidHex(hit?.customHex) ? hit.customHex : undefined;
}

/** customHex 가 지정된 레벨의 뱃지 인라인 스타일(bg/text/border) — Tailwind 로는 표현 불가능한
 *  임의 hex 라 style 로 오버라이드한다. 미지정이면 undefined(levelBadgeClass 의 프리셋 그대로 사용). */
export function levelBadgeStyle(levels: OperationLevelItem[] | undefined, value: string | null | undefined): CSSProperties | undefined {
  const hex = levelCustomHex(levels, value);
  if (!hex) return undefined;
  const { bg, ring, text } = deriveToneSet(hex);
  return { backgroundColor: bg, color: text, borderColor: ring };
}

/** value → 이모지. 명시된 icon 우선 → value/label 키워드 hint → fallback. */
export function levelIcon(levels: OperationLevelItem[] | undefined, value: string | null | undefined): string {
  if (!value) return '';
  const hit = levels?.find((l) => l.value === value);
  if (hit?.icon && hit.icon.trim()) return hit.icon;
  const haystack = `${hit?.value ?? value} ${hit?.label ?? ''}`;
  for (const { test, emoji } of VALUE_HINT_EMOJI) {
    if (test.test(haystack)) return emoji;
  }
  return DEFAULT_FALLBACK_EMOJI;
}
