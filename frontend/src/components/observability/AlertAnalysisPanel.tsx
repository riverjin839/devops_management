import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { observabilityApi } from '@/services/api';
import { useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import type { AlertEvent } from '@/types';

const STATUS_META: Record<string, { label: string; cls: string }> = {
  queued: { label: '분석 대기', cls: 'bg-secondary text-muted-foreground' },
  running: { label: '분석 중', cls: 'bg-status-warning/15 text-status-warning' },
  done: { label: '분석 완료', cls: 'bg-status-healthy/15 text-status-healthy' },
  failed: { label: '분석 실패', cls: 'bg-status-critical/15 text-status-critical' },
  skipped: { label: '건너뜀 (부하 제한)', cls: 'bg-muted text-muted-foreground' },
};

/**
 * 알람 인박스 행 확장에 붙는 AI 분석 패널 — 분석 전용(실행 권한 없음).
 * analyzed_by 를 그대로 노출해 어떤 백엔드/프로필이 분석했는지 투명하게 표기한다
 * (rule_based = 규칙 기반 오프라인 분석).
 */
export function AlertAnalysisPanel({ alert }: { alert: AlertEvent }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [triggering, setTriggering] = useState(false);

  const status = alert.analysisStatus ?? null;
  const { data: analysis, isFetching } = useQuery({
    queryKey: ['alert-analysis', alert.id, status],
    queryFn: async () => (await observabilityApi.getAlertAnalysis(alert.id)).data.data,
    enabled: status === 'done' || status === 'failed',
    retry: false,
  });

  const trigger = async () => {
    setTriggering(true);
    try {
      const res = await observabilityApi.triggerAlertAnalysis(alert.id);
      toast.success('AI 분석 요청됨', res.data.detail ?? '전용 큐에서 분석이 실행됩니다. 잠시 후 새로고침하세요.');
      qc.invalidateQueries({ queryKey: ['alert-inbox'] });
    } catch (e) {
      toast.error('분석 요청 실패', formatApiError(e));
    } finally {
      setTriggering(false);
    }
  };

  const meta = status ? STATUS_META[status] : null;
  const isRuleBased = (analysis?.analyzedBy ?? '').startsWith('rule_based');

  return (
    <div className="rounded-xl border border-border bg-card/50 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-primary" aria-hidden />
        <span className="text-xs font-medium">AI 분석</span>
        {meta && <span className={`px-2 py-0.5 text-xs rounded-full ${meta.cls}`}>{meta.label}</span>}
        {analysis?.analyzedBy && (
          <span
            className="px-1.5 py-0.5 text-xs rounded bg-secondary text-muted-foreground"
            title="분석을 수행한 백엔드/프로필"
          >
            {isRuleBased ? '규칙 기반 (오프라인)' : analysis.analyzedBy}
          </span>
        )}
        {typeof analysis?.confidence === 'number' && (
          <span className="text-xs text-muted-foreground">신뢰도 {(analysis.confidence * 100).toFixed(0)}%</span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void trigger()}
          disabled={triggering || status === 'queued' || status === 'running'}
          title={status ? 'AI 재분석' : 'AI 분석 실행'}
          aria-label={status ? 'AI 재분석' : 'AI 분석 실행'}
          className="flex items-center gap-1 px-2.5 py-1 rounded-xl text-xs font-medium bg-secondary border border-border hover:bg-muted disabled:opacity-50"
        >
          {triggering || status === 'queued' || status === 'running'
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <RefreshCw className="w-3.5 h-3.5" />}
          {status ? '재분석' : 'AI 분석 실행'}
        </button>
      </div>

      {isFetching && (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> 분석 결과를 불러오는 중…
        </p>
      )}

      {analysis?.status === 'failed' && analysis.error && (
        <p className="text-xs text-status-critical whitespace-pre-wrap">{analysis.error}</p>
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
        <p className="text-xs text-muted-foreground">
          아직 분석되지 않은 알람입니다. Settings → AI/LLM 의 자동 분석 범위에 매칭되면 자동 분석되며, 위 버튼으로 수동 실행할 수도 있습니다.
        </p>
      )}
    </div>
  );
}
