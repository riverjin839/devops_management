import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, LayoutGrid, PlusCircle, Search, ServerOff } from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useCanOperate, useMyClusterAccess } from '@/hooks/useCanOperate';
import { useAuthStore } from '@/stores/authStore';
import { EmptyState } from '@/components/common';
import type { Cluster, Status } from '@/types';
import { FlyoutAction } from './NavFlyout';

/** 이 개수 이상이면 목록 위에 검색창을 띄운다. */
const SEARCH_MIN = 7;

/** 정상은 중립색 점, 비정상만 상태색(DESIGN_SYSTEM §12.12). pending 은 테두리만. */
const DOT_CLASS: Record<Status, string> = {
  healthy: 'bg-muted-foreground/60',
  warning: 'bg-status-warning',
  critical: 'bg-status-critical',
  pending: 'border-[1.5px] border-muted-foreground/60',
};

/** `/k8s/:clusterId/:view` 에서 현재 클러스터·뷰를 읽는다. 허브 밖이면 둘 다 undefined. */
function parseHubPath(pathname: string): { clusterId?: string; view?: string } {
  const m = /^\/k8s\/([^/]+)(?:\/([^/]+))?/.exec(pathname);
  return m ? { clusterId: m[1], view: m[2] } : {};
}

/**
 * 사이드바 레일 "K8s 클러스터" 아이콘 flyout 본문 — 접근 권한이 있는 클러스터 목록.
 * 목록은 `GET /clusters` 가 서버에서 `ClusterScope`(테넌트 바인딩·사용자 지정 권한)로 이미 거른 결과다.
 * 항목을 고르면 같은 허브 뷰를 유지한 채 그 클러스터로 이동한다.
 */
export function K8sClusterFlyoutBody({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { data: clusters = [], isLoading } = useClusters();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const { data: access } = useMyClusterAccess(!isAdmin);
  const { canOperate, withHint } = useCanOperate();
  const [query, setQuery] = useState('');
  const { clusterId: currentId, view } = parseHubPath(location.pathname);

  // 운영 수준(operationLevel)으로 묶는다. 값이 없는 클러스터는 마지막 "기타" 묶음. 묶음 안은 서버 순서(seq).
  const groups = useMemo(() => {
    const term = query.trim().toLowerCase();
    const shown = term
      ? clusters.filter((c) => `${c.name} ${c.region ?? ''}`.toLowerCase().includes(term))
      : clusters;
    const map = new Map<string, Cluster[]>();
    for (const c of shown) {
      const key = c.operationLevel?.trim() || '';
      map.set(key, [...(map.get(key) ?? []), c]);
    }
    return [...map.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : 0));
  }, [clusters, query]);
  const grouped = groups.length > 1 || (groups.length === 1 && groups[0][0] !== '');

  const statusLabel = (s: Status) =>
    s === 'warning' ? t('shell.k8sClusters.warning') : s === 'critical' ? t('shell.k8sClusters.critical') : null;

  return (
    <div className="pb-1">
      {clusters.length >= SEARCH_MIN && (
        <div className="px-2 pt-1 pb-1.5">
          <label className="flex items-center gap-1.5 h-8 px-2 rounded-xl border border-border bg-background text-muted-foreground focus-within:border-primary">
            <Search className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
            <input
              id="k8s-cluster-flyout-search"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('shell.k8sClusters.search')}
              aria-label={t('shell.k8sClusters.search')}
              autoComplete="off"
              className="flex-1 min-w-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-faint"
            />
          </label>
        </div>
      )}

      <div className="max-h-[360px] overflow-y-auto">
        {isLoading ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">{t('shell.k8sClusters.loading')}</p>
        ) : clusters.length === 0 ? (
          <EmptyState
            compact
            icon={ServerOff}
            title={t('shell.k8sClusters.emptyTitle')}
            description={t('shell.k8sClusters.emptyDescription')}
          />
        ) : groups.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">{t('shell.k8sClusters.noMatch', { query })}</p>
        ) : (
          groups.map(([level, items]) => (
            <div key={level || '_'}>
              {grouped && (
                <p className="px-3 pt-1.5 pb-0.5 text-xs text-muted-foreground">
                  {level || t('shell.k8sClusters.otherGroup')} · {items.length}
                </p>
              )}
              {items.map((c) => {
                const active = c.id === currentId;
                const label = statusLabel(c.status);
                const readOnly = access?.[c.id] === 'read';
                return (
                  <div key={c.id} className="flex items-center mx-1">
                    <Link
                      to={`/k8s/${c.id}${view ? `/${view}` : ''}`}
                      role="menuitem"
                      aria-current={active ? 'page' : undefined}
                      onClick={onNavigate}
                      className={`flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5 rounded text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
                        active ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-secondary'
                      }`}
                    >
                      <span aria-hidden="true" className={`w-2 h-2 rounded-full flex-shrink-0 ${DOT_CLASS[c.status] ?? DOT_CLASS.pending}`} />
                      <span className="flex-1 min-w-0 flex flex-col">
                        <span className={`truncate font-mono ${active ? 'font-semibold' : ''}`}>{c.name}</span>
                        {c.region && <span className="truncate text-xs text-muted-foreground">{c.region}</span>}
                      </span>
                      {label && (
                        <span className={`text-xs font-semibold whitespace-nowrap ${c.status === 'critical' ? 'text-status-critical' : 'text-status-warning'}`}>
                          {label}
                        </span>
                      )}
                      {readOnly && (
                        <span className="text-xs px-1.5 rounded-full border border-border text-muted-foreground whitespace-nowrap">
                          {t('shell.k8sClusters.readOnly')}
                        </span>
                      )}
                      {active && <ChevronRight className="w-3.5 h-3.5 flex-shrink-0 text-primary" aria-hidden="true" />}
                    </Link>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      <div className="mx-2 my-1 border-t border-border" />
      <div className="flex items-center mx-1">
        <Link
          to="/k8s"
          role="menuitem"
          onClick={onNavigate}
          className="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5 rounded text-[13px] text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <LayoutGrid className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
          <span className="flex-1 min-w-0">{t('shell.k8sClusters.openHub')}</span>
        </Link>
      </div>
      <FlyoutAction
        label={t('shell.k8sClusters.register')}
        Icon={PlusCircle}
        disabled={!canOperate}
        title={withHint(t('shell.k8sClusters.register'))}
        onSelect={() => { onNavigate(); navigate('/cluster-manage'); }}
      />
    </div>
  );
}
