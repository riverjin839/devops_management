import { Link } from 'react-router-dom';
import { BookOpen, FileText, StickyNote } from 'lucide-react';
import type { RagCitation } from '@/types';

const SOURCE_META: Record<RagCitation['sourceType'], { label: string; icon: typeof BookOpen }> = {
  work_guide: { label: '작업 가이드', icon: BookOpen },
  work_item: { label: '업무 이력', icon: FileText },
  ops_note: { label: '운영 노트', icon: StickyNote },
};

/**
 * RAG 근거 인용 목록 — AI 분석/챗 응답의 출처를 클릭 가능한 사내 딥링크로 렌더.
 * AlertAnalysisPanel 과 AgentChat 이 공용으로 사용한다.
 */
export function CitationList({ citations }: { citations: RagCitation[] }) {
  if (!citations?.length) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">근거 자료</p>
      <ol className="space-y-1">
        {citations.map((c, i) => {
          const meta = SOURCE_META[c.sourceType] ?? SOURCE_META.work_guide;
          const Icon = meta.icon;
          return (
            <li key={`${c.sourceType}-${c.refId}`} className="text-xs">
              <Link
                to={c.route}
                className="inline-flex items-start gap-1.5 text-primary hover:underline"
                title={c.snippet}
              >
                <span className="shrink-0 text-muted-foreground">[{i + 1}]</span>
                <Icon className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
                <span>
                  {c.title}
                  <span className="text-muted-foreground">
                    {' '}· {meta.label} · 유사도 {(c.similarity * 100).toFixed(0)}%
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
