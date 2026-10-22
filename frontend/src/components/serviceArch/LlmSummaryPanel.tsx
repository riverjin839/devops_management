import { useEffect, useState } from 'react';
import { AlertTriangle, Bot, Loader2, Pencil, RefreshCw, WifiOff } from 'lucide-react';
import type { ArchDoc } from '@/types';

interface Props {
  doc: ArchDoc;
  nodeName: (id: string) => string;
  onRegenerate: () => void;
  regenerating: boolean;
  onSaveSummaryOverride: (text: string | null) => void;
  savingSummary: boolean;
  /** 재생성 실행 로그 패널(페이지가 소유 — 재생성 버튼 바로 아래에 렌더). */
  runLog?: React.ReactNode;
  /** operator + 클러스터 operate 권한. false 면 재생성·요약 수정을 사유와 함께 비활성. */
  canEdit: boolean;
  /** 비활성 사유(`useCanOperate().hint`). */
  editHint?: string;
}

/** LLM 상태 → 안내 문구. offline(미연결)·error(호출 실패, 사유 표시)·failed(노드 없음)를 구분한다(A-15). */
function llmNotice(doc: ArchDoc): { tone: 'warn' | 'error' | 'info'; text: string } | null {
  switch (doc.llmStatus) {
    case 'offline':
      return {
        tone: 'warn',
        text: `LLM 미연결${doc.llmError ? ` — ${doc.llmError}` : ''}. 자동 요약 없이도 다이어그램과 수동 편집은 정상 동작합니다.`,
      };
    case 'error':
      return { tone: 'error', text: `LLM 호출 실패 — ${doc.llmError || '사유 미상'}. 기존 요약은 그대로 둡니다.` };
    case 'failed':
      return { tone: 'info', text: '다이어그램에 노드가 없어 AI 분석을 만들 수 없습니다. 먼저 동기화하세요.' };
    case 'pending':
      return { tone: 'info', text: 'AI 분석 생성 중입니다.' };
    default:
      return null;
  }
}

/** 하단 AI 요약 패널 — 요약(사용자 수정 가능)/컴포넌트 역할/플로우 스텝. */
export function LlmSummaryPanel({
  doc, nodeName, onRegenerate, regenerating, onSaveSummaryOverride, savingSummary, runLog,
  canEdit, editHint,
}: Props) {
  const summary = doc.summaryOverride ?? doc.llmContent?.summary ?? '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(summary);
  useEffect(() => { setDraft(summary); }, [summary]);

  const notice = llmNotice(doc);
  const flowSteps = [...(doc.llmContent?.flowSteps ?? [])].sort((a, b) => a.order - b.order);
  const hintTitle = (t: string) => (canEdit ? t : (editHint ?? t));
  const hintAria = (t: string) => (canEdit || !editHint ? t : `${t} — ${editHint}`);

  return (
    <div className="border-t border-border p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Bot className="w-4 h-4 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground flex-1">
          AI 아키텍처 분석
          {doc.llmContent?.model && (
            <span className="ml-2 font-normal normal-case">({doc.llmContent.model})</span>
          )}
          {doc.summaryOverride != null && (
            <span className="ml-2 font-normal normal-case">· 사용자 수정본</span>
          )}
        </span>
        <button
          onClick={() => setEditing((v) => !v)}
          disabled={!canEdit}
          aria-label={hintAria('요약 직접 수정')} title={hintTitle('요약 직접 수정')}
          className="p-1.5 rounded-xl text-muted-foreground hover:bg-secondary disabled:opacity-50">
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onRegenerate}
          disabled={regenerating || !canEdit}
          aria-label={hintAria('AI 재생성')} title={hintTitle('AI 재생성')}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl disabled:opacity-50">
          {regenerating
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <RefreshCw className="w-3.5 h-3.5" />}
          재생성
        </button>
      </div>

      {runLog}

      {notice && (
        <div
          role={notice.tone === 'error' ? 'alert' : undefined}
          className={`flex items-start gap-2 text-xs bg-secondary/40 border border-border rounded-xl px-3 py-2 ${
            notice.tone === 'error' ? 'text-status-critical'
              : notice.tone === 'warn' ? 'text-status-warning'
                : 'text-muted-foreground'
          }`}
        >
          {notice.tone === 'warn'
            ? <WifiOff className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
            : notice.tone === 'error'
              ? <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
              : doc.llmStatus === 'pending'
                ? <Loader2 className="w-3.5 h-3.5 shrink-0 mt-px animate-spin" aria-hidden="true" />
                : <Bot className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />}
          <span className="break-words min-w-0">{notice.text}</span>
        </div>
      )}
      {doc.llmContent?.rawFallback && (
        <div className="text-xs text-muted-foreground">
          응답 JSON 파싱 실패 — 원문 요약만 표시합니다. 재생성을 시도해 보세요.
        </div>
      )}

      {editing && canEdit ? (
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
                className="px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-secondary rounded-xl disabled:opacity-50">
                AI 원문으로 되돌리기
              </button>
            )}
            <button
              onClick={() => { onSaveSummaryOverride(draft.trim() || null); setEditing(false); }}
              disabled={savingSummary}
              className="px-2.5 py-1 text-xs font-semibold bg-primary text-primary-foreground rounded-xl disabled:opacity-50">
              저장
            </button>
          </div>
        </div>
      ) : summary ? (
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{summary}</p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {canEdit
            ? '아직 생성된 요약이 없습니다. 동기화 후 재생성 버튼으로 AI 분석을 실행하거나, 연필 아이콘으로 직접 작성하세요.'
            : '아직 생성된 요약이 없습니다.'}
        </p>
      )}

      {flowSteps.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-muted-foreground mb-1.5">서비스 플로우</div>
          <ol className="space-y-1">
            {flowSteps.map((s) => (
              <li key={`${s.order}-${s.source}-${s.target}`} className="flex items-start gap-2 text-xs">
                <span className="shrink-0 min-w-[18px] h-[18px] inline-flex items-center justify-center rounded-full bg-secondary border border-border font-bold text-xs">
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
