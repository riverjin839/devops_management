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
const COLOR_BADGE: Record<string, string> = {
  red:     'bg-red-500/15     text-red-400     border-red-500/30',
  amber:   'bg-amber-500/15   text-amber-400   border-amber-500/30',
  emerald: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  sky:     'bg-sky-500/15     text-sky-400     border-sky-500/30',
  blue:    'bg-blue-500/15    text-blue-400    border-blue-500/30',
  purple:  'bg-purple-500/15  text-purple-400  border-purple-500/30',
  pink:    'bg-pink-500/15    text-pink-400    border-pink-500/30',
  yellow:  'bg-yellow-500/15  text-yellow-400  border-yellow-500/30',
  cyan:    'bg-cyan-500/15    text-cyan-400    border-cyan-500/30',
  violet:  'bg-violet-500/15  text-violet-400  border-violet-500/30',
  orange:  'bg-orange-500/15  text-orange-400  border-orange-500/30',
  slate:   'bg-slate-500/15   text-slate-400   border-slate-500/30',
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
