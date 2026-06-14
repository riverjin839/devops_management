import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Inbox } from 'lucide-react';
import { workItemsApi } from '@/services/api';
import { WORK_ITEM_TYPE_CONFIG } from '@/components/work-items';
import type { WorkItem } from '@/types';
import { formatRelativeTime, stripHtml } from '@/lib/utils';

interface RelatedWorkItemsPanelProps {
  /** 표시 대상 서비스 슬러그. 같은 service 인 work_item 만 추출. */
  service: string;
}

// Design Ref: §4.1 — service 일치 work_item 5건 + 더보기
export function RelatedWorkItemsPanel({ service }: RelatedWorkItemsPanelProps) {
  const q = useQuery({
    queryKey: ['items'],
    queryFn: () => workItemsApi.getAll().then((r) => r.data),
    staleTime: 30_000,
  });

  const matched: WorkItem[] = useMemo(() => {
    const all = q.data?.data ?? [];
    return all.filter((w) => w.service === service);
  }, [q.data, service]);

  const top5 = matched.slice(0, 5);

  return (
    <section className="bg-card border border-border rounded-xl p-4 mt-4">
      <header className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Inbox className="w-4 h-4 text-primary" />
          <span>관련 업무</span>
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground tabular-nums">
            {matched.length}
          </span>
        </div>
        {matched.length > 5 && (
          <Link
            to="/tasks-mgmt"
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
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
        <p className="px-2 py-3 text-sm text-muted-foreground italic">
          이 서비스에 등록된 업무가 없습니다.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {top5.map((w) => {
            const typeCfg = WORK_ITEM_TYPE_CONFIG[w.type];
            const TypeIcon = typeCfg.Icon;
            const title = stripHtml(w.content).split('\n')[0] || w.category;
            return (
              <li key={w.id}>
                <Link
                  to={`/tasks-mgmt/${w.id}`}
                  className="flex items-center gap-2 px-2 py-2 hover:bg-secondary rounded transition-colors min-w-0"
                >
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium rounded ${typeCfg.cls} flex-shrink-0`}>
                    <TypeIcon className="w-3 h-3" /> {typeCfg.label}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-sm text-foreground">{title}</span>
                  <span className="flex-shrink-0 text-xs text-muted-foreground tabular-nums">
                    {formatRelativeTime(w.updatedAt)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
