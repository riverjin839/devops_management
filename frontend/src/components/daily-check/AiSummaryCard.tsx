import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sparkles, RefreshCw, AlertCircle } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { useRegenerateReview } from '@/hooks/useDeepCheck';
import type { DeepCheckReview } from '@/types';
import { parseUTC } from '@/lib/utils';

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
  const [regenerating, setRegenerating] = useState(false);
  const regenerate = useRegenerateReview();

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      await regenerate.mutateAsync(review.dailyCheckLogId);
    } finally {
      setRegenerating(false);
    }
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
    <MacCard title="AI 자동 리뷰">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Sparkles className="w-4 h-4 text-primary" />
            <span>
              {review.aiGeneratedAt
                ? parseUTC(review.aiGeneratedAt).toLocaleString('ko-KR')
                : '아직 생성되지 않음'}
            </span>
            {statusBadge && (
              <span
                className={`inline-flex items-center gap-1 ${
                  statusBadge.tone === 'red'
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-amber-600 dark:text-amber-400'
                }`}
              >
                <AlertCircle className="w-3.5 h-3.5" />
                {statusBadge.label}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={handleRegenerate}
            disabled={regenerating}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${regenerating ? 'animate-spin' : ''}`}
            />
            재생성
          </button>
        </div>

        {review.aiSummary ? (
          <div className="text-sm">
            <Md text={review.aiSummary} />
          </div>
        ) : (
          <div className="text-sm text-muted-foreground italic">
            아직 AI 리뷰가 생성되지 않았습니다. "재생성" 버튼을 눌러 수동으로 요청할 수 있습니다.
          </div>
        )}

        {review.aiRemediation && (
          <div className="rounded-xl bg-muted/50 p-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
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
