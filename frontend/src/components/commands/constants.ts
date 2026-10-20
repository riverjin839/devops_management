import type { CommandImportance } from '@/types';

export const IMPORTANCE_OPTIONS: CommandImportance[] = ['info', 'low', 'medium', 'high', 'critical'];

export const IMPORTANCE_META: Record<CommandImportance, {
  label: string; badge: string; rowAccent: string;
}> = {
  info:     { label: '정보',  badge: 'bg-status-unknown/15  text-status-unknown  border-status-unknown/30',  rowAccent: 'border-l-status-unknown/60' },
  low:      { label: '낮음',  badge: 'bg-status-info/15    text-status-info    border-status-info/30',    rowAccent: 'border-l-status-info/70' },
  medium:   { label: '보통',  badge: 'bg-status-warning/15  text-status-warning  border-status-warning/30',  rowAccent: 'border-l-status-warning/70' },
  high:     { label: '높음',  badge: 'bg-chart-7/15 text-chart-7 border-chart-7/30', rowAccent: 'border-l-chart-7/80' },
  critical: { label: '치명',  badge: 'bg-status-critical/20    text-status-critical    border-status-critical/40 font-semibold', rowAccent: 'border-l-status-critical' },
};
