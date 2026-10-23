/* eslint-disable react-refresh/only-export-components */
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, CheckCircle2, ChevronRight, CloudOff, HelpCircle, Database, Radio, XCircle,
} from 'lucide-react';
import { EmptyState, ErrorState, LoadingState } from '@/components/common';
import type { DataSource, LabelPair, MetricState, ObservabilitySourceError } from '@/types';
import { formatApiError, parseUTC } from '@/lib/utils';

/** 지표 상태 → 색/아이콘. 정상은 무채색, 경고·심각만 상태 토큰(DESIGN_SYSTEM §12.12-3). */
const STATE_META: Record<MetricState, { cls: string; dot: string; label: string }> = {
  ok: {
    cls: 'text-muted-foreground',
    dot: 'bg-muted-foreground/40',
    label: '정상',
  },
  warning: {
    cls: 'text-status-warning',
    dot: 'bg-status-warning',
    label: '경고',
  },
  critical: {
    cls: 'text-status-critical',
    dot: 'bg-status-critical',
    label: '심각',
  },
  unknown: {
    cls: 'text-muted-foreground',
    dot: 'bg-muted-foreground/50',
    label: '알 수 없음',
  },
};

/** `label` 을 주면 상태 이름 대신 그 문구를 쓴다 — 실패 행의 점과 값 칸 라벨을 맞출 때(D-191). */
export function StateDot({ state, title, label }: { state: MetricState; title?: string; label?: string }) {
  const meta = STATE_META[state] ?? STATE_META.unknown;
  const text = label ?? meta.label;
  return (
    <span className="inline-flex items-center gap-1.5" title={title ?? text}>
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${meta.dot}`} aria-hidden />
      <span className={`text-xs ${meta.cls}`}>{text}</span>
    </span>
  );
}

export function stateTextClass(state: MetricState): string {
  return (STATE_META[state] ?? STATE_META.unknown).cls;
}

/** up/down 같은 이진 상태를 아이콘으로. */
export function HealthIcon({ healthy }: { healthy: boolean }) {
  return healthy
    ? <CheckCircle2 className="w-3.5 h-3.5 text-muted-foreground" aria-hidden />
    : <XCircle className="w-3.5 h-3.5 text-status-critical" aria-hidden />;
}

/** 상대 시간 표기를 주기적으로 다시 그리기 위한 tick(D-183 ③ — 배지가 "n초 전"에 멈추지 않게). */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

/**
 * 신선도 배지 — **현재 뷰 쿼리**의 결과만 받는다(D-183 ④).
 * - `failed`: 갱신(폴링) 실패 — "실시간" 대신 "갱신 실패 · 마지막 성공 n분 전".
 * - `stale`: push 스냅샷이 오래됨 기준을 넘김 — 이때만 경고색(정상 스냅샷은 무채색).
 */
export function SourceBadge({ source, collectedAt, stale = false, failed = false, lastSuccessAt }: {
  source?: DataSource | null;
  collectedAt?: string | null;
  stale?: boolean;
  failed?: boolean;
  /** 마지막 성공 시각(ms, TanStack `dataUpdatedAt`). 0/undefined = 성공한 적 없음. */
  lastSuccessAt?: number;
}) {
  useNow();
  if (failed) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-status-warning" role="status">
        <AlertTriangle className="w-3.5 h-3.5" aria-hidden />
        {lastSuccessAt ? '갱신 실패' : '조회 실패'}
        {lastSuccessAt ? (
          <span className="text-muted-foreground">· 마지막 성공 {relativeFromMs(lastSuccessAt)}</span>
        ) : null}
      </span>
    );
  }
  if (!source) return null;
  const meta = {
    live: { Icon: Radio, label: '실시간', cls: 'text-muted-foreground' },
    partial: { Icon: AlertTriangle, label: '일부 실패', cls: 'text-status-warning' },
    snapshot: stale
      ? { Icon: Database, label: '오래된 스냅샷', cls: 'text-status-warning' }
      : { Icon: Database, label: '스냅샷', cls: 'text-muted-foreground' },
    offline: { Icon: HelpCircle, label: '미연결', cls: 'text-muted-foreground' },
  }[source] ?? { Icon: HelpCircle, label: source, cls: 'text-muted-foreground' };

  return (
    <span className={`inline-flex items-center gap-1 text-xs ${meta.cls}`} title={collectedAt ? formatTime(collectedAt) : undefined}>
      <meta.Icon className="w-3.5 h-3.5" aria-hidden />
      {meta.label}
      {collectedAt ? <span className="text-muted-foreground">· {relativeTime(collectedAt)}</span> : null}
    </span>
  );
}

const SOURCE_NAME: Record<string, string> = {
  prometheus: 'Prometheus',
  alertmanager: 'Alertmanager',
  push: '수집기(push)',
};

/**
 * 뷰 상단 안내 줄 — 소스별 실패(`errors[]`), 오래된 스냅샷, 갱신 실패, 서버 안내(`detail`)(D-183).
 * 표 자체는 그대로 그리고, 결과가 불완전·오래됐다는 사실만 위에서 알린다.
 */
export function ObservabilityNotice({
  errors, detail, stale, snapshotAgeSec, collectedAt, staleMinutes, refetchError,
}: {
  errors?: ObservabilitySourceError[] | null;
  detail?: string | null;
  stale?: boolean;
  snapshotAgeSec?: number | null;
  collectedAt?: string | null;
  staleMinutes?: number | null;
  /** 폴링 실패(이전 데이터를 보여주는 중) — 사유 표시용. */
  refetchError?: unknown;
}) {
  const lines: Array<{ key: string; text: string }> = [];
  if (refetchError) {
    lines.push({
      key: 'refetch',
      text: `갱신 실패 — 아래는 마지막으로 성공한 조회 결과입니다. ${formatApiError(refetchError)}`,
    });
  }
  for (const [idx, err] of (errors ?? []).entries()) {
    lines.push({
      key: `err-${idx}`,
      text: `${SOURCE_NAME[err.source] ?? err.source} 조회 실패 — ${err.message}`,
    });
  }
  if (stale) {
    const age = snapshotAgeSec != null
      ? formatAge(snapshotAgeSec)
      : (collectedAt ? relativeTime(collectedAt) : null);
    lines.push({
      key: 'stale',
      text: `오래된 스냅샷${age ? ` (${age})` : ''} — 클러스터 안 수집기(push)가 멈췄을 수 있습니다. 현재 상태와 다를 수 있습니다`
        + `${staleMinutes ? ` (오래됨 기준 ${staleMinutes}분)` : ''}.`,
    });
  }
  // errors[] 와 같은 문구면 중복으로 보이지 않게 뺀다.
  if (detail && !(errors ?? []).some((e) => detail.includes(e.message))) {
    lines.push({ key: 'detail', text: detail });
  }
  if (lines.length === 0) return null;
  return (
    <div role="status" className="px-4 py-2 border-b border-border space-y-1">
      {lines.map((line) => (
        <p key={line.key} className="flex items-start gap-1.5 text-xs text-status-warning">
          <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" aria-hidden />
          <span className="break-words">{line.text}</span>
        </p>
      ))}
    </div>
  );
}

/**
 * 표 자리의 로딩·조회 실패·미연결·빈 상태(D-183·D-188). 그릴 행이 있으면 null.
 * 분기 순서: 로딩 → 실패(데이터 없음) → 미연결(offline) → 빈 배열.
 */
export function tableStatus({
  colSpan, isLoading, error, onRetry, offline, clusterId, isEmpty, emptyTitle, emptyDescription, errorTitle,
}: {
  colSpan: number;
  isLoading: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** 서버가 `source="offline"` 을 준 경우 그 사유(`detail`). undefined = 온라인. */
  offline?: string | null | undefined;
  clusterId?: string | null;
  isEmpty: boolean;
  emptyTitle: string;
  emptyDescription?: string;
  /** 조회 실패 제목(예: "알람 규칙을 불러오지 못했습니다"). */
  errorTitle: string;
}): ReactNode {
  let body: ReactNode = null;
  if (isLoading) {
    body = <LoadingState compact />;
  } else if (error) {
    body = (
      <ErrorState
        compact
        error={error}
        title={errorTitle}
        onRetry={onRetry}
      />
    );
  } else if (offline !== undefined) {
    body = <OfflineState detail={offline} clusterId={clusterId} />;
  } else if (isEmpty) {
    body = <EmptyState compact title={emptyTitle} description={emptyDescription} />;
  }
  if (body === null) return null;
  return (
    <tr>
      <td colSpan={colSpan}>{body}</td>
    </tr>
  );
}

/** 표 4종 공통 상태 props(D-183). */
export interface TableStateProps {
  isLoading: boolean;
  /** 데이터 없이 조회가 실패한 경우만 넘긴다(이전 데이터가 있으면 표 + 안내 줄). */
  error?: unknown;
  onRetry?: () => void;
  /** 서버 `source="offline"` 사유. undefined = 연결됨. */
  offline?: string | null;
  clusterId?: string | null;
  /** 소스 일부 실패·오래된 스냅샷·갱신 실패 — 빈 결과를 "없음"으로 단정하지 않는다. */
  incomplete?: boolean;
  /** 검색·필터로 비었을 때의 문구. */
  emptyMessage?: string;
}

export const INCOMPLETE_HINT = '일부 소스 조회 실패나 오래된 값 때문에 목록이 불완전할 수 있습니다 — 위 안내를 확인하세요.';

/** 관측 스택 미연결 — 서버 사유 + 다음 행동(클러스터 정보 수정). */
export function OfflineState({ detail, clusterId }: { detail?: string | null; clusterId?: string | null }) {
  return (
    <EmptyState
      compact
      icon={CloudOff}
      title="관측 스택에 연결할 수 없습니다"
      description={detail
        || 'Prometheus 에 연결하지 못했습니다. 클러스터 정보 수정에서 관측 연동 사용과 Prometheus·Alertmanager 주소를 확인하세요.'}
    >
      {clusterId ? (
        <Link
          to={`/cluster-manage/${clusterId}/edit`}
          className="mt-3 inline-flex items-center px-3 py-1.5 rounded-xl text-sm bg-secondary text-foreground border border-border hover:bg-secondary/80 transition-colors"
        >
          클러스터 정보 수정
        </Link>
      ) : null}
    </EmptyState>
  );
}

/** 행 펼침 버튼 — 키보드(Enter/Space)로 상세를 열 수 있게 이름 셀을 버튼으로(D-189, D-111 방식). */
export function ExpandButton({ open, controls, onToggle, children, className = '' }: {
  open: boolean;
  controls: string;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className={`inline-flex items-center gap-1 max-w-full text-left rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${className}`}
    >
      <ChevronRight
        className={`w-3.5 h-3.5 flex-shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
        aria-hidden
      />
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

// ── 원문 상태값 → 한국어 라벨(D-191). 원문은 각 셀 title 로 남긴다. ──────────────
export const RULE_STATE_LABEL: Record<string, string> = {
  firing: '발화',
  pending: '대기',
  inactive: '비활성',
  recording: '기록 규칙',
};
export const RULE_HEALTH_LABEL: Record<string, string> = {
  ok: '정상',
  err: '오류',
  error: '오류',
  unknown: '알 수 없음',
};
export const TARGET_HEALTH_LABEL: Record<string, string> = {
  up: '정상',
  down: '중단',
  unknown: '알 수 없음',
};
export const SEVERITY_LABEL: Record<string, string> = {
  critical: '심각',
  warning: '경고',
  info: '정보',
  none: '없음',
};
export const ALERT_STATE_LABEL: Record<string, string> = {
  firing: '발화',
  pending: '대기',
  active: '발화',
  suppressed: '억제',
};
export const ORIGIN_LABEL: Record<string, string> = {
  prometheus: 'Prometheus',
  alertmanager: 'Alertmanager',
};

export function relativeFromMs(ms: number): string {
  return formatAge(Math.max(0, Math.round((Date.now() - ms) / 1000)));
}

function formatAge(diffSec: number): string {
  if (diffSec < 60) return `${diffSec}초 전`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}분 전`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}시간 전`;
  return `${Math.round(diffSec / 86400)}일 전`;
}

export function relativeTime(iso: string): string {
  try {
    return formatAge(Math.max(0, Math.round((Date.now() - parseUTC(iso).getTime()) / 1000)));
  } catch {
    return iso;
  }
}

export function formatTime(iso?: string | null): string {
  if (!iso) return '—';
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
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  switch (displayType) {
    case 'bool':
      return value >= 1 ? '가동 (1)' : '중단 (0)';
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

export const TH = 'text-left py-2 px-3 font-medium text-xs text-muted-foreground whitespace-nowrap';
export const TD = 'py-2 px-3 align-middle';
export const ROW = 'border-t border-border hover:bg-muted/20 transition-colors';
