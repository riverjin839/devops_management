import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useToast } from '@/components/common/Toast';
import { CitationList } from '@/components/common/CitationList';
import { RunLogPanel } from '@/components/common/RunLogPanel';
import { formatApiError } from '@/lib/utils';
import { degradedHeadline } from '@/lib/analysisDegraded';
import { useRunLog, runLogged, pollIntoRunLog, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import type { AlertIncidentAnalysis } from '@/types';

const TERMINAL = new Set(['done', 'failed', 'skipped']);

/** 분석 결과가 아직 없으면 404 — 폴링 중엔 "아직 없음"(null)으로 본다. */
function isNotFound(e: unknown): boolean {
  return (e as { response?: { status?: number } } | null)?.response?.status === 404;
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  queued: { label: '분석 대기', cls: 'bg-secondary text-muted-foreground' },
  running: { label: '분석 중', cls: 'bg-status-warning/15 text-status-warning' },
  done: { label: '분석 완료', cls: 'bg-secondary text-muted-foreground' },
  failed: { label: '분석 실패', cls: 'bg-status-critical/15 text-status-critical' },
  skipped: { label: '건너뜀 (부하 제한)', cls: 'bg-muted text-muted-foreground' },
};

interface IncidentAnalysisPanelProps {
  subjectId: string;
  analysisStatus: string | null | undefined;
  queryKeyPrefix: string;
  fetchAnalysis: (id: string) => Promise<AlertIncidentAnalysis>;
  triggerAnalysis: (id: string) => Promise<{ status: string; detail?: string }>;
  /** 트리거 성공 후 무효화할 목록 쿼리 키 (예: ['alert-inbox'] / ['k8s-events']) */
  invalidateKeys: unknown[];
  emptyHint: string;
  /** 분석 트리거 권한(D-105) — 서버가 operator + 클러스터 operate 를 요구한다. 기본 true. */
  canOperate?: boolean;
  /** `canOperate` 가 false 일 때 버튼 title/aria-label 에 붙일 사유(`useCanOperate().hint`). */
  hint?: string | null;
}

/**
 * 분석기가 결과를 내지 못해 대체 결과를 돌려줬는지(D-115). 서버가 레코드마다 `degraded` 를 저장하므로
 * 그 판정을 그대로 쓴다. `degraded` 가 null 인 것은 이 컬럼이 생기기 전 레코드뿐이다 — 그때만
 * 예전 local_llm 이 LLM 연결 실패 시 confidence 0 의 안내문을 done 으로 남기던 패턴으로 보조 판정한다.
 */
function isDegraded(a: AlertIncidentAnalysis): boolean {
  if (typeof a.degraded === 'boolean') return a.degraded;
  return a.status === 'done' && a.confidence === 0;
}

/**
 * AI 분석 패널 (분석 전용 — 실행 권한 없음) — 알람 인박스 / K8s 이벤트 양쪽에서
 * 공용으로 쓰는 일반화 컴포넌트. analyzed_by 를 그대로 노출해 어떤 백엔드/프로필이
 * 분석했는지 투명하게 표기한다(rule_based = 규칙 기반 오프라인 분석).
 */
export function IncidentAnalysisPanel({
  subjectId, analysisStatus, queryKeyPrefix, fetchAnalysis, triggerAnalysis, invalidateKeys, emptyHint,
  canOperate = true, hint = null,
}: IncidentAnalysisPanelProps) {
  const toast = useToast();
  const qc = useQueryClient();
  const [triggering, setTriggering] = useState(false);
  // 실행 로그(D-089/D-135) — 큐잉 요청 → 분석 레코드 폴링(상태 변화 줄) → 완료/실패. 펼침 여부는 사용자가 정한다.
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('incident-analysis-panel');
  const pollAbort = useRef<AbortController | null>(null);
  useEffect(() => () => pollAbort.current?.abort(), []);

  const status = analysisStatus ?? null;
  const { data: analysis, isFetching, isError: loadFailed, error: loadError } = useQuery({
    queryKey: [queryKeyPrefix, subjectId, status],
    queryFn: () => fetchAnalysis(subjectId),
    enabled: status === 'done' || status === 'failed',
    retry: false,
  });

  const refreshViews = () => {
    invalidateKeys.forEach((key) => qc.invalidateQueries({ queryKey: key as never }));
    qc.invalidateQueries({ queryKey: [queryKeyPrefix, subjectId] });
  };

  const fetchLatest = async (): Promise<AlertIncidentAnalysis | null> => {
    try {
      return await fetchAnalysis(subjectId);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  };

  const trigger = async () => {
    if (!canOperate) return;
    pollAbort.current?.abort();
    setTriggering(true);
    // 재분석이면 이전 결과 레코드가 남아 있다 — 그걸 기준선으로 잡아 "새 레코드의 완료"만 완료로 본다.
    // 기준선 조회가 실패하면(404 외) 이전 레코드를 구분할 수 없다 — 그때는 요청 시각 이후에 생긴 레코드만 새 것으로 본다.
    const triggeredAt = Date.now();
    let baselineUnknown = false;
    const baseline = await fetchLatest().catch(() => { baselineUnknown = true; return null; });
    const baselineActive = !!baseline && !TERMINAL.has(baseline.status);
    const r = await runLogged(runLog, {
      title: 'AI 분석',
      first: `AI 분석 요청 — 전용 llm 큐로 보냄${status ? ` (현재 상태: ${STATUS_META[status]?.label ?? status})` : ''}`,
      fn: () => triggerAnalysis(subjectId),
      summarize: (res): RunLogEntry[] => [['info', `큐잉됨 · 상태 ${res.status}${res.detail ? ` — ${res.detail}` : ''}`]],
      keepOpen: true,
    });
    setTriggering(false);
    if (!r.ok) {
      if (!r.aborted) toast.error('분석 요청 실패', formatApiError(r.error));
      return;
    }
    toast.success('AI 분석 요청됨', r.data.detail ?? '전용 큐에서 분석이 실행됩니다. 진행 상황은 실행 로그에 표시됩니다.');
    refreshViews();
    const ctrl = new AbortController();
    pollAbort.current = ctrl;
    const isNew = (a: AlertIncidentAnalysis) => {
      if (baselineUnknown) return Date.parse(a.createdAt) >= triggeredAt - 5_000;  // 서버·브라우저 시계 차 여유
      return !baseline || a.id !== baseline.id || baselineActive;
    };
    await pollIntoRunLog<AlertIncidentAnalysis | null>(r.run, {
      fetch: fetchLatest,
      describe: (snap, prev) => {
        if (!snap || !isNew(snap)) return [];
        if (prev && prev.id === snap.id && prev.status === snap.status) return [];
        refreshViews();
        const label = STATUS_META[snap.status]?.label ?? snap.status;
        if (snap.status === 'done') {
          const out: RunLogEntry[] = [['info', `${label}${snap.durationMs != null ? ` · ${snap.durationMs}ms` : ''} · 분석기 ${snap.analyzedBy ?? '—'}`]];
          out.push(['info', `심각도 ${snap.severity ?? '—'}${typeof snap.confidence === 'number' ? ` · 신뢰도 ${(snap.confidence * 100).toFixed(0)}%` : ''} · 조치 가이드 ${snap.suggestedActions.length}건`]);
          return out;
        }
        if (snap.status === 'failed') return [['error', `${label} — ${snap.error ?? '사유 미상'}`]];
        if (snap.status === 'skipped') return [['warn', label]];
        return [['info', label]];
      },
      isDone: (snap) => !!snap && isNew(snap) && TERMINAL.has(snap.status),
      intervalMs: 3000,
      timeoutMs: 180_000,
      signal: ctrl.signal,
    });
    if (pollAbort.current === ctrl) pollAbort.current = null;
    refreshViews();
  };

  const meta = status ? STATUS_META[status] : null;
  const isRuleBased = (analysis?.analyzedBy ?? '').startsWith('rule_based');
  const degraded = analysis ? isDegraded(analysis) : false;
  const busy = triggering || runLog.running || status === 'queued' || status === 'running';
  const actionLabel = status ? 'AI 재분석' : 'AI 분석 실행';
  const deniedHint = !canOperate ? (hint || '분석 실행 권한이 없습니다') : null;

  // D-116 — 이 패널은 알람·이벤트 목록 MacCard 의 펼침 행 안에 놓인다. 카드 안 카드가 되지 않게 비카드 면을 쓴다.
  return (
    <div className="rounded-md bg-secondary/40 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-primary" aria-hidden />
        <span className="text-xs font-medium">AI 분석</span>
        {meta && <span className={`px-2 py-0.5 text-xs rounded-full ${meta.cls}`}>{meta.label}</span>}
        {analysis?.analyzedBy && (
          <span
            className="px-1.5 py-0.5 text-xs rounded-md bg-secondary text-muted-foreground"
            title="분석을 수행한 백엔드/프로필"
          >
            {isRuleBased
              ? (analysis.analyzedBy.startsWith('rule_based:fallback') ? '규칙 기반 (LLM 대체)' : '규칙 기반 (오프라인)')
              : analysis.analyzedBy}
          </span>
        )}
        {typeof analysis?.confidence === 'number' && (
          <span className="text-xs text-muted-foreground">신뢰도 {(analysis.confidence * 100).toFixed(0)}%</span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void trigger()}
          disabled={!canOperate || busy}
          title={deniedHint ?? actionLabel}
          aria-label={deniedHint ? `${actionLabel} — ${deniedHint}` : actionLabel}
          className="flex items-center gap-1 px-2.5 py-1 rounded-xl text-xs font-medium bg-secondary border border-border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
            : <RefreshCw className="w-3.5 h-3.5" aria-hidden />}
          {status ? '재분석' : 'AI 분석 실행'}
        </button>
      </div>

      <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-40" />

      <div role="status" aria-live="polite" className="space-y-2">
      {isFetching && (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> 분석 결과를 불러오는 중…
        </p>
      )}

      {/* 결과 조회 자체가 실패(404 외) — 상태 pill 만 남고 본문이 비어 정상처럼 보이지 않게 사유를 남긴다. */}
      {loadFailed && !isFetching && !isNotFound(loadError) && (
        <p className="text-xs text-status-critical">분석 결과를 불러오지 못했습니다 — {formatApiError(loadError)}</p>
      )}

      {analysis?.status === 'failed' && (
        <p className="text-xs text-status-critical whitespace-pre-wrap">
          분석 실패 — {analysis.error || '사유가 기록되지 않았습니다. 분석기(LLM) 연결 상태를 확인하세요.'}
        </p>
      )}

      {analysis?.status === 'done' && degraded && (
        <p className="flex items-start gap-1 text-xs text-status-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {degradedHeadline(null)}. 아래 내용은 자동 안내문이며 원인 분석이 아닙니다 —
            설정 → AI/LLM 에서 연결 상태를 확인하세요.
          </span>
        </p>
      )}

      {analysis?.status === 'done' && (
        <div className="space-y-2 text-sm">
          {analysis.rootCause && (
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">원인 분석</p>
              <p className="whitespace-pre-wrap">{analysis.rootCause}</p>
            </div>
          )}
          {analysis.suggestedActions.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">조치 가이드 (직접 실행되지 않음 — 사람이 수행)</p>
              <ul className="list-disc list-inside space-y-0.5">
                {analysis.suggestedActions.map((a, i) => (
                  <li key={i} className="whitespace-pre-wrap">{a}</li>
                ))}
              </ul>
            </div>
          )}
          {analysis.citations.length > 0 && (
            <CitationList citations={analysis.citations} />
          )}
          {analysis.relatedRunbooks.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {analysis.relatedRunbooks.map((r, i) => (
                <span key={i} className="px-2 py-0.5 text-xs rounded-full bg-secondary text-muted-foreground">{r}</span>
              ))}
            </div>
          )}
          {analysis.durationMs != null && (
            <p className="text-xs text-muted-foreground">소요 {analysis.durationMs.toLocaleString()}ms</p>
          )}
        </div>
      )}

      {!status && (
        <p className="text-xs text-muted-foreground">{emptyHint}</p>
      )}
      </div>
    </div>
  );
}
