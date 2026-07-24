import { useEffect, useState } from 'react';
import { Bot, Loader2, Pencil, RefreshCw, WifiOff } from 'lucide-react';
import type { ArchDoc } from '@/types';

interface Props {
  doc: ArchDoc;
  nodeName: (id: string) => string;
  onRegenerate: () => void;
  regenerating: boolean;
  onSaveSummaryOverride: (text: string | null) => void;
  savingSummary: boolean;
}

/** 하단 AI 요약 패널 — 요약(사용자 수정 가능)/컴포넌트 역할/플로우 스텝. */
export function LlmSummaryPanel({
  doc, nodeName, onRegenerate, regenerating, onSaveSummaryOverride, savingSummary,
}: Props) {
  const summary = doc.summaryOverride ?? doc.llmContent?.summary ?? '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(summary);
  useEffect(() => { setDraft(summary); }, [summary]);

  const offline = doc.llmStatus === 'offline';
  const flowSteps = [...(doc.llmContent?.flowSteps ?? [])].sort((a, b) => a.order - b.order);

  return (
    <div className="border-t border-border p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Bot className="w-4 h-4 text-muted-foreground" />
        <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground flex-1">
          AI 아키텍처 분석
          {doc.llmContent?.model && (
            <span className="ml-2 font-normal normal-case">({doc.llmContent.model})</span>
          )}
          {doc.summaryOverride != null && (
            <span className="ml-2 font-normal normal-case text-amber-500">· 사용자 수정본</span>
          )}
        </span>
        <button
          onClick={() => setEditing((v) => !v)}
          aria-label="요약 직접 수정" title="요약 직접 수정"
          className="p-1.5 rounded-lg text-muted-foreground hover:bg-secondary">
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onRegenerate}
          disabled={regenerating}
          aria-label="AI 재생성" title="AI 재생성"
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl disabled:opacity-50">
          {regenerating
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <RefreshCw className="w-3.5 h-3.5" />}
          재생성
        </button>
      </div>

      {offline && (
        <div className="flex items-center gap-2 text-xs text-amber-500 bg-secondary/40 border border-border rounded-xl px-3 py-2">
          <WifiOff className="w-3.5 h-3.5 shrink-0" />
          LLM(Ollama) 미연결 — 자동 요약 없이도 다이어그램/수동 편집은 정상 동작합니다.
        </div>
      )}
      {doc.llmContent?.rawFallback && (
        <div className="text-[11px] text-muted-foreground">
          응답 JSON 파싱 실패 — 원문 요약만 표시합니다. 재생성을 시도해 보세요.
        </div>
      )}

      {editing ? (
        <div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            aria-label="아키텍처 요약 수정"
            className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm resize-none"
          />
          <div className="flex justify-end gap-2 mt-1.5">
            {doc.summaryOverride != null && (
              <button
                onClick={() => { onSaveSummaryOverride(null); setEditing(false); }}
                disabled={savingSummary}
                className="px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-secondary rounded-lg disabled:opacity-50">
                AI 원문으로 되돌리기
              </button>
            )}
            <button
              onClick={() => { onSaveSummaryOverride(draft.trim() || null); setEditing(false); }}
              disabled={savingSummary}
              className="px-2.5 py-1 text-xs font-semibold bg-primary text-primary-foreground rounded-lg disabled:opacity-50">
              저장
            </button>
          </div>
        </div>
      ) : summary ? (
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{summary}</p>
      ) : (
        <p className="text-sm text-muted-foreground">
          아직 생성된 요약이 없습니다. 동기화 후 재생성 버튼으로 AI 분석을 실행하거나, 연필 아이콘으로 직접 작성하세요.
        </p>
      )}

      {flowSteps.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-muted-foreground mb-1.5">서비스 플로우</div>
          <ol className="space-y-1">
            {flowSteps.map((s) => (
              <li key={`${s.order}-${s.source}-${s.target}`} className="flex items-start gap-2 text-xs">
                <span className="shrink-0 w-4.5 h-4.5 min-w-[18px] inline-flex items-center justify-center rounded-full bg-secondary border border-border font-bold text-[10px]">
                  {s.order}
                </span>
                <span className="text-muted-foreground">
                  <span className="text-foreground font-medium">{nodeName(s.source)}</span>
                  {' → '}
                  <span className="text-foreground font-medium">{nodeName(s.target)}</span>
                  {s.description ? ` — ${s.description}` : ''}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
