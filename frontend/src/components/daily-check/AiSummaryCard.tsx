import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sparkles, RefreshCw, AlertCircle } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { RunLogPanel } from '@/components/common';
import { useRegenerateReview } from '@/hooks/useDeepCheck';
import { useRunLog, runLogged, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import type { DeepCheckReview } from '@/types';
import { parseUTC } from '@/lib/utils';

/** Markdown 목록 항목 수(조치 권고가 몇 건인지 대략 세기 — 목록이 아니면 0). */
function countListItems(md: string): number {
  return md.split('\n').filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(l)).length;
}

/** 재생성 응답 → 실행 로그 줄. offline/error 는 error 줄로 남긴다. */
function reviewLines(r: DeepCheckReview): RunLogEntry[] {
  const summaryLen = (r.aiSummary ?? '').length;
  const remediation = r.aiRemediation ?? '';
  const items = countListItems(remediation);
  const detail = `요약 ${summaryLen}자 · 조치 권고 ${remediation ? (items ? `${items}건` : `${remediation.length}자`) : '없음'} · 심층 점검 결과 ${r.deepResults.length}건 · 종합 상태 ${r.overallStatus}`;
  switch (r.aiStatus) {
    case 'offline':
      return [['error', 'AI 리뷰 실패 — Ollama 오프라인 · fallback 메시지로 대체'], ['info', detail]];
    case 'error':
      return [['error', 'AI 리뷰 실패 — 응답 처리 오류(모델/프롬프트 확인)'], ['info', detail]];
    case 'ok':
      return [['info', `AI 리뷰 생성 완료 — ${detail}`]];
    default:
      return [['warn', `AI 상태 ${r.aiStatus ?? '미상'} — ${detail}`]];
  }
}

// Ollama 응답을 Markdown 으로 렌더 — react-markdown 이 기본적으로 HTML 을 escape 하므로
// XSS 위험 없음. remark-gfm 으로 GitHub 스타일 (table/strike/task list) 까지 지원.
function Md({ text }: { text: string }) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none leading-relaxed
                    [&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5
                    [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5
                    [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:overflow-x-auto
                    [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_h1]:font-semibold
                    [&_table]:text-sm [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1
                    [&_th]:border [&_td]:border [&_th]:border-border [&_td]:border-border">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

interface Props {
  review: DeepCheckReview;
}

export function AiSummaryCard({ review }: Props) {
  const regenerate = useRegenerateReview();
  const regenerating = regenerate.isPending;
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('ai-summary-regenerate');

  // 실패는 runLogged 가 error 줄로 남긴다(예전엔 catch 가 없어 unhandled rejection 으로 조용히 실패).
  const handleRegenerate = async () => {
    await runLogged(runLog, {
      title: 'AI 리뷰 재생성',
      first: `점검 로그 ${review.dailyCheckLogId.slice(0, 8)} — AI 리뷰 재생성 요청(LLM 응답 대기)`,
      fn: () => regenerate.mutateAsync(review.dailyCheckLogId).then((res) => res.data),
      summarize: reviewLines,
    });
  };

  // ai_status: 'ok' | 'offline' | 'error' — 운영자가 원인을 구분할 수 있도록 3-way 분기.
  // 'offline' = Ollama 미가용 (인프라 문제), 'error' = 호출은 됐으나 응답 처리 실패 (모델/프롬프트 문제)
  const statusBadge = (() => {
    if (review.aiStatus === 'offline') {
      return { label: 'Ollama 오프라인 — fallback 메시지', tone: 'amber' as const };
    }
    if (review.aiStatus === 'error') {
      return { label: 'AI 응답 처리 실패 — 재생성 시도', tone: 'red' as const };
    }
    return null;
  })();

  return (
    <MacCard
      title="AI 자동 리뷰"
      icon={Sparkles}
      description={
        review.aiGeneratedAt
          ? `생성 ${parseUTC(review.aiGeneratedAt).toLocaleString('ko-KR')}`
          : '아직 생성되지 않음'
      }
      titleExtra={
        statusBadge && (
          <span
            className={`inline-flex items-center gap-1 text-xs ${
              statusBadge.tone === 'red' ? 'text-status-critical' : 'text-status-warning'
            }`}
          >
            <AlertCircle className="w-3.5 h-3.5" />
            {statusBadge.label}
          </span>
        )
      }
      actions={
        <button
          type="button"
          onClick={handleRegenerate}
          disabled={regenerating}
          className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${regenerating ? 'animate-spin' : ''}`} />
          재생성
        </button>
      }
    >
      <div className="space-y-4">
        <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
        {review.aiSummary ? (
          <div className="text-sm">
            <Md text={review.aiSummary} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            AI 리뷰가 아직 생성되지 않았습니다. 헤더의 「재생성」으로 수동 요청할 수 있습니다.
          </p>
        )}

        {review.aiRemediation && (
          <div className="rounded-xl bg-muted/50 p-3">
            <div className="text-xs font-semibold text-muted-foreground mb-2">
              조치 권고
            </div>
            <div className="text-sm">
              <Md text={review.aiRemediation} />
            </div>
          </div>
        )}
      </div>
    </MacCard>
  );
}
