import { useState } from 'react';
import { ExternalLink, ChevronDown } from 'lucide-react';
import type { WorkItem } from '@/types';
import { DocLinkChip } from './DocLinkChip';

interface ConfluenceLinkCellProps {
  item: WorkItem;
  /** 대표 링크(confluenceUrl) 저장 — 빈 문자열이면 해제. */
  onSave: (url: string) => void;
}

/**
 * "WIKI" 셀 — 목록 뷰(WorkItemTableRow)와 에픽뷰(WorkItemEpicView)가 공유하는 단일
 * 구현. 다중 링크(Jira 원격 링크에서 찾은 전체 목록)가 있으면 배지+드롭다운 옆에 대표
 * 링크(confluenceUrl) 편집용 DocLinkChip 도 함께 둔다.
 */
export function ConfluenceLinkCell({ item, onSave }: ConfluenceLinkCellProps) {
  const [linksOpen, setLinksOpen] = useState(false);
  const links = item.confluenceLinks ?? [];

  if (links.length > 1) {
    return (
      <div className="relative">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setLinksOpen((v) => !v); }}
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" />
            {links.length}
            <ChevronDown className="w-3 h-3 opacity-60" />
          </button>
          <DocLinkChip url={item.confluenceUrl} onSave={onSave} label="대표" />
        </div>
        {linksOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={(e) => { e.stopPropagation(); setLinksOpen(false); }} />
            <div className="absolute left-0 top-full mt-1 z-40 bg-card border border-border rounded-lg mac-shadow p-1 min-w-[220px] max-w-xs">
              {links.map((link, i) => (
                <a
                  key={link.url + i}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  title={link.url}
                  className="block px-2 py-1.5 rounded-md text-sm text-foreground hover:bg-secondary truncate"
                >
                  {link.title || link.url}
                </a>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  return <DocLinkChip url={item.confluenceUrl} onSave={onSave} />;
}
