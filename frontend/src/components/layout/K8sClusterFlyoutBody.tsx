import { useCallback, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronRight, LayoutGrid, PlusCircle, Search, ServerOff } from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useCanOperate, useMyClusterAccess } from '@/hooks/useCanOperate';
import { useAuthStore } from '@/stores/authStore';
import { ClusterCheckIcon, EmptyState } from '@/components/common';
import { useClusterCheckSummaries } from '@/hooks/useOpsCheck';
import type { Cluster } from '@/types';
import { FlyoutAction } from './NavFlyout';

/** 이 개수 이상이면 목록 위에 검색창을 띄운다. */
const SEARCH_MIN = 7;

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
  // 「비정상 N개만 보기」 — 허브의 옛 클러스터 레일에 있던 필터를 옮겨 왔다(D-243).
  const [abnormalOnly, setAbnormalOnly] = useState(false);
  // 상태는 점검 탭 결과(`/ops-checks/summary`)가 원천이다 — 글자 라벨 없이 아이콘으로만 보인다.
  const { byId: checkSummary } = useClusterCheckSummaries();
  const isAbnormal = useCallback((c: Cluster) => {
    const s = checkSummary.get(c.id)?.status;
    return s === 'warning' || s === 'critical';
  }, [checkSummary]);
  const abnormalCount = useMemo(() => clusters.filter(isAbnormal).length, [clusters, isAbnormal]);
  const anyCritical = useMemo(() => clusters.some((c) => checkSummary.get(c.id)?.status === 'critical'), [clusters, checkSummary]);
  const filtering = abnormalOnly && abnormalCount > 0;
  const { clusterId: currentId, view } = parseHubPath(location.pathname);

  // 운영 수준(operationLevel)으로 묶는다. 값이 없는 클러스터는 마지막 "기타" 묶음. 묶음 안은 서버 순서(seq).
  const groups = useMemo(() => {
    const term = query.trim().toLowerCase();
    const byStatus = filtering ? clusters.filter(isAbnormal) : clusters;
    const shown = term
      ? byStatus.filter((c) => `${c.name} ${c.region ?? ''}`.toLowerCase().includes(term))
      : byStatus;
    const map = new Map<string, Cluster[]>();
    for (const c of shown) {
      const key = c.operationLevel?.trim() || '';
      map.set(key, [...(map.get(key) ?? []), c]);
    }
    return [...map.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : 0));
  }, [clusters, query, filtering, isAbnormal]);
  const grouped = groups.length > 1 || (groups.length === 1 && groups[0][0] !== '');

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

      {abnormalCount > 0 && (
        <div className="px-2 pb-1">
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={filtering}
            onClick={() => setAbnormalOnly((v) => !v)}
            className={`w-full inline-flex items-center gap-1.5 rounded-xl px-2 py-1 text-xs font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
              filtering ? 'bg-primary/15 text-primary' : 'text-foreground hover:bg-secondary'
            }`}
          >
            <AlertTriangle
              aria-hidden="true"
              className={`w-3.5 h-3.5 ${anyCritical ? 'text-status-critical' : 'text-status-warning'}`}
            />
            {filtering ? t('shell.k8sClusters.showAll', { count: clusters.length }) : t('shell.k8sClusters.abnormalOnly', { count: abnormalCount })}
          </button>
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
                const readOnly = access?.[c.id] === 'read';
                return (
                  <div key={c.id} className="flex items-center gap-0.5 mx-1">
                    <ClusterCheckIcon clusterId={c.id} summary={checkSummary.get(c.id)} onNavigate={onNavigate} role="menuitem" />
                    <Link
                      to={`/k8s/${c.id}${view ? `/${view}` : ''}`}
                      role="menuitem"
                      aria-current={active ? 'page' : undefined}
                      onClick={onNavigate}
                      className={`flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5 rounded text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
                        active ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-secondary'
                      }`}
                    >
                      <span className="flex-1 min-w-0 flex flex-col">
                        <span className={`truncate font-mono ${active ? 'font-semibold' : ''}`}>{c.name}</span>
                        {c.region && <span className="truncate text-xs text-muted-foreground">{c.region}</span>}
                      </span>
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
