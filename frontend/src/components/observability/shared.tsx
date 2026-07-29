/* eslint-disable react-refresh/only-export-components */
import { AlertTriangle, CheckCircle2, HelpCircle, Database, Radio, XCircle } from 'lucide-react';
import type { DataSource, LabelPair, MetricState } from '@/types';
import { parseUTC } from '@/lib/utils';

/** 지표 상태 → 색/아이콘. 전부 테마 토큰(--status-*)이라 3개 테마에서 자동 동작한다. */
const STATE_META: Record<MetricState, { cls: string; dot: string; label: string }> = {
  ok: {
    cls: 'text-[hsl(var(--status-healthy))]',
    dot: 'bg-[hsl(var(--status-healthy))]',
    label: '정상',
  },
  warning: {
    cls: 'text-[hsl(var(--status-warning))]',
    dot: 'bg-[hsl(var(--status-warning))]',
    label: '경고',
  },
  critical: {
    cls: 'text-[hsl(var(--status-critical))]',
    dot: 'bg-[hsl(var(--status-critical))]',
    label: '심각',
  },
  unknown: {
    cls: 'text-muted-foreground',
    dot: 'bg-muted-foreground/50',
    label: '알수없음',
  },
};

export function StateDot({ state, title }: { state: MetricState; title?: string }) {
  const meta = STATE_META[state] ?? STATE_META.unknown;
  return (
    <span className="inline-flex items-center gap-1.5" title={title ?? meta.label}>
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${meta.dot}`} aria-hidden />
      <span className={`text-xs ${meta.cls}`}>{meta.label}</span>
    </span>
  );
}

export function stateTextClass(state: MetricState): string {
  return (STATE_META[state] ?? STATE_META.unknown).cls;
}

/** up/down 같은 이진 상태를 아이콘으로. */
export function HealthIcon({ healthy }: { healthy: boolean }) {
  return healthy
    ? <CheckCircle2 className="w-3.5 h-3.5 text-[hsl(var(--status-healthy))]" aria-hidden />
    : <XCircle className="w-3.5 h-3.5 text-[hsl(var(--status-critical))]" aria-hidden />;
}

/** live / snapshot / offline 신선도 배지. push 모드에서 "언제 걷힌 값인지"가 중요하다. */
export function SourceBadge({ source, collectedAt }: { source: DataSource; collectedAt?: string | null }) {
  const meta = {
    live: { Icon: Radio, label: '실시간', cls: 'text-[hsl(var(--status-healthy))]' },
    snapshot: { Icon: Database, label: '스냅샷', cls: 'text-[hsl(var(--status-warning))]' },
    offline: { Icon: HelpCircle, label: '미연결', cls: 'text-muted-foreground' },
  }[source] ?? { Icon: HelpCircle, label: source, cls: 'text-muted-foreground' };

  return (
    <span className={`inline-flex items-center gap-1 text-xs ${meta.cls}`} title={collectedAt ?? undefined}>
      <meta.Icon className="w-3.5 h-3.5" aria-hidden />
      {meta.label}
      {collectedAt ? <span className="text-muted-foreground">· {relativeTime(collectedAt)}</span> : null}
    </span>
  );
}

export function relativeTime(iso: string): string {
  try {
    const diffSec = Math.max(0, Math.round((Date.now() - parseUTC(iso).getTime()) / 1000));
    if (diffSec < 60) return `${diffSec}초 전`;
    if (diffSec < 3600) return `${Math.round(diffSec / 60)}분 전`;
    if (diffSec < 86400) return `${Math.round(diffSec / 3600)}시간 전`;
    return `${Math.round(diffSec / 86400)}일 전`;
  } catch {
    return iso;
  }
}

export function formatTime(iso?: string | null): string {
  if (!iso) return '-';
  try {
    return parseUTC(iso).toLocaleString('ko-KR', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** 표시 타입에 맞춰 값을 사람이 읽는 문자열로. */
export function formatMetricValue(
  value: number | null | undefined, displayType: string, unit: string,
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  switch (displayType) {
    case 'bool':
      return value >= 1 ? 'UP (1)' : 'DOWN (0)';
    case 'bytes':
      return formatBytes(value);
    case 'duration':
      return formatDuration(value);
    case 'ratio':
      return `${round(value, 2)}%`;
    default:
      return `${round(value, 3)}${unit && unit !== 'count' ? ` ${unit}` : ''}`;
  }
}

function round(value: number, digits: number): string {
  if (Number.isInteger(value)) return String(value);
  const abs = Math.abs(value);
  // 아주 작은 비율(0.0001/s 같은 rate)은 지수 표기가 오히려 읽기 쉽다.
  if (abs > 0 && abs < 0.001) return value.toExponential(2);
  return value.toFixed(digits).replace(/\.?0+$/, '');
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)));
  return `${(bytes / 1024 ** idx).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 0)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

/** 라벨 배열을 `k=v` 한 줄로 (테이블 셀 요약용). */
export function labelsSummary(labels: LabelPair[], exclude: string[] = []): string {
  return labels
    .filter((pair) => !exclude.includes(pair.k) && pair.v)
    .map((pair) => `${pair.k}=${pair.v}`)
    .join(', ');
}

/** 확장 행에서 라벨을 2열 표로. */
export function LabelTable({ title, pairs }: { title: string; pairs: LabelPair[] }) {
  if (pairs.length === 0) return null;
  return (
    <div className="min-w-0">
      <div className="text-xs font-semibold text-muted-foreground mb-1">{title}</div>
      <table className="w-full text-xs">
        <tbody>
          {pairs.map((pair) => (
            <tr key={pair.k} className="align-top">
              <td className="pr-3 py-0.5 font-mono text-muted-foreground whitespace-nowrap">{pair.k}</td>
              <td className="py-0.5 font-mono break-all">{pair.v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 로딩/빈/오프라인 상태를 테이블 자리에 그대로 채우는 공통 행. */
export function TableMessage({ colSpan, children, tone = 'muted' }: {
  colSpan: number;
  children: React.ReactNode;
  tone?: 'muted' | 'warning';
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="py-12 text-center text-sm">
        <span className={tone === 'warning'
          ? 'text-[hsl(var(--status-warning))] inline-flex items-center gap-2'
          : 'text-muted-foreground inline-flex items-center gap-2'}>
          {tone === 'warning' ? <AlertTriangle className="w-4 h-4" aria-hidden /> : null}
          {children}
        </span>
      </td>
    </tr>
  );
}

export const TH = 'text-left py-2 px-3 font-medium text-xs text-muted-foreground whitespace-nowrap';
export const TD = 'py-2 px-3 align-middle';
export const ROW = 'border-t border-border hover:bg-muted/20 transition-colors';
