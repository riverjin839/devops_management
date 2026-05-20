import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, StickyNote, Pin } from 'lucide-react';
import { opsNotesApi } from '@/services/api';
import { formatRelativeTime } from '@/lib/utils';

interface RelatedOpsNotesPanelProps {
  /** 표시 대상 서비스 슬러그. backend ops_note.service 필터 사용. */
  service: string;
}

// Design Ref: §4.2 — opsNotesApi.getAll(service) → 5건 + 더보기
export function RelatedOpsNotesPanel({ service }: RelatedOpsNotesPanelProps) {
  const q = useQuery({
    queryKey: ['ops-notes', service],
    queryFn: () => opsNotesApi.getAll(service).then((r) => r.data),
    staleTime: 30_000,
  });

  const all = q.data?.data ?? [];
  const top5 = all.slice(0, 5);

  return (
    <section className="bg-card border border-border rounded-xl p-4 mt-4">
      <header className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <StickyNote className="w-4 h-4 text-amber-500" />
          <span>관련 운영 노트</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground tabular-nums">
            {all.length}
          </span>
        </div>
        {all.length > 5 && (
          <Link
            to="/ops-notes"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            전체 보기 <ArrowRight className="w-3 h-3" />
          </Link>
        )}
      </header>

      {q.isLoading ? (
        <div className="space-y-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-9 rounded bg-secondary/60 animate-pulse" />
          ))}
        </div>
      ) : top5.length === 0 ? (
        <p className="px-2 py-3 text-xs text-muted-foreground italic">
          이 서비스에 등록된 운영 노트가 없습니다.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {top5.map((n) => (
            <li key={n.id}>
              <Link
                to={`/ops-notes/${n.id}`}
                className="flex items-center gap-2 px-2 py-2 hover:bg-secondary rounded transition-colors min-w-0"
              >
                {n.pinned ? (
                  <Pin className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                ) : (
                  <StickyNote className="w-3.5 h-3.5 text-amber-500/70 flex-shrink-0" />
                )}
                <span className="flex-1 min-w-0 truncate text-sm text-foreground">{n.title}</span>
                <span className="flex-shrink-0 text-[10px] text-muted-foreground tabular-nums">
                  {formatRelativeTime(n.updatedAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
