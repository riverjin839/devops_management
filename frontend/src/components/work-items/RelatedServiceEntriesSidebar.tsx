import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Library } from 'lucide-react';
import { serviceEntriesApi } from '@/services/api';
import { KIND_BY_KEY, colorBadgeClass, getServiceDef } from '@/components/services/serviceCatalog';
import { formatRelativeTime } from '@/lib/utils';

interface RelatedServiceEntriesSidebarProps {
  /** 표시 대상 서비스 슬러그. service==null 인 work_item 에서는 호출 측에서 미렌더링. */
  service: string;
}

// Design Ref: §4.3 — serviceEntriesApi.list(service) → 5건 + 더보기.
// WorkItemDetailPage 우측 sticky sidebar 로 표시.
export function RelatedServiceEntriesSidebar({ service }: RelatedServiceEntriesSidebarProps) {
  const def = getServiceDef(service);
  const q = useQuery({
    queryKey: ['service-entries', service, 'sidebar'],
    queryFn: () => serviceEntriesApi.list(service).then((r) => r.data.data),
    staleTime: 30_000,
  });

  const all = q.data ?? [];
  const top5 = all.slice(0, 5);

  // 빈 결과 + 로딩 중이 아니면 sidebar 자체를 안 그림 (AD-5)
  if (!q.isLoading && top5.length === 0) return null;

  return (
    <aside className="w-72 flex-shrink-0 sticky top-4">
      <div className="bg-card border border-border rounded-xl p-4">
        <header className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Library className="w-4 h-4 text-primary" />
            <span>관련 지식</span>
          </div>
          <Link
            to={`/services/${service}`}
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            전체 보기 <ArrowRight className="w-3 h-3" />
          </Link>
        </header>

        <div className="mb-3 text-xs text-muted-foreground">
          서비스 <span className="font-medium text-foreground">{def.label}</span> 의 카탈로그에서 발췌.
        </div>

        {q.isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 rounded bg-secondary/60 animate-pulse" />
            ))}
          </div>
        ) : (
          <ul className="space-y-2">
            {top5.map((e) => {
              const kindMeta = KIND_BY_KEY[e.kind];
              const KindIcon = kindMeta?.icon;
              return (
                <li key={e.id}>
                  <Link
                    to={`/services/${service}`}
                    className="block p-2 rounded-lg hover:bg-secondary transition-colors border border-transparent hover:border-border"
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      {KindIcon && (
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium rounded-full border ${colorBadgeClass(kindMeta.color)}`}>
                          <KindIcon className="w-3 h-3" /> {kindMeta.label}
                        </span>
                      )}
                      {e.severity && (
                        <span className={`text-xs px-1.5 py-0.5 rounded-full border ${
                          e.severity === 'critical' ? 'bg-red-500/10 text-red-500 border-red-500/30'
                          : e.severity === 'warning' ? 'bg-amber-500/10 text-amber-500 border-amber-500/30'
                          : 'bg-sky-500/10 text-sky-500 border-sky-500/30'
                        }`}>{e.severity}</span>
                      )}
                    </div>
                    <p className="text-sm font-medium text-foreground line-clamp-2 leading-snug">{e.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                      {formatRelativeTime(e.updatedAt)}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
