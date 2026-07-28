import { ExternalLink } from 'lucide-react';

interface JiraIssueChipProps {
  /** 이슈 키 (예: DL-123). 비어 있으면 제목만 보여준다. */
  issueKey?: string;
  title?: string;
  /** 진행 상태 라벨 (진행 / 완료 / 지연 등). 비우면 상태 배지를 숨긴다. */
  status?: string;
  url?: string;
  className?: string;
}

function statusClass(status: string) {
  if (status === '완료') return 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30';
  if (status === '지연') return 'bg-red-500/15 text-red-500 border-red-500/30';
  if (status === '진행') return 'bg-blue-500/15 text-blue-500 border-blue-500/30';
  return 'bg-secondary text-muted-foreground border-border';
}

/**
 * Jira 이슈를 **키(링크) · 제목 · 상태** 한 덩어리로 보여주는 칩.
 *
 * 표에서 이슈를 평문으로 늘어놓으면 어느 이슈인지 눈으로 찾기 어렵다 — Confluence 에서
 * 이슈가 하나의 박스로 보이는 것과 같은 형태로 묶어 식별성을 높인다.
 */
export function JiraIssueChip({ issueKey, title, status, url, className = '' }: JiraIssueChipProps) {
  if (!issueKey && !title) return <span className="text-muted-foreground">-</span>;
  return (
    <span className={`inline-flex items-center gap-1.5 max-w-full px-1.5 py-0.5 rounded-md border border-border bg-secondary/60 ${className}`}>
      {issueKey && (
        url ? (
          <a href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-0.5 font-mono text-[11px] font-semibold text-brand-jira dark:text-blue-300 hover:underline flex-shrink-0"
            title={`${issueKey} 열기`}>
            {issueKey}<ExternalLink className="w-2.5 h-2.5" />
          </a>
        ) : (
          <span className="font-mono text-[11px] font-semibold text-muted-foreground flex-shrink-0">{issueKey}</span>
        )
      )}
      {title && <span className="truncate">{title}</span>}
      {status && (
        <span className={`flex-shrink-0 text-[10px] font-medium px-1 rounded border ${statusClass(status)}`}>
          {status}
        </span>
      )}
    </span>
  );
}
