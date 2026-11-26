import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, LayoutGrid, Search, ServerOff } from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useMyClusterAccess } from '@/hooks/useCanOperate';
import { useAuthStore } from '@/stores/authStore';
import { ClusterCheckIcon, EmptyState } from '@/components/common';
import { useClusterCheckSummaries } from '@/hooks/useOpsCheck';
import {
  levelColor, levelLabel, levelSectionClasses, levelSectionStyle, levelShortLabel, useOperationLevels,
} from '@/hooks/useOperationLevels';
import type { Cluster } from '@/types';
import { useClusterSwitchGuardStore } from '@/stores/clusterSwitchGuardStore';

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
 * 운영등급별 섹션(색·약칭·순서는 Settings 운영레벨이 원천 — UI-First)으로 묶고, 글꼴은 본문 스택을 그대로 쓴다.
 */
export function K8sClusterFlyoutBody({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation();
  const location = useLocation();
  const { data: clusters = [], isLoading } = useClusters();
  const { data: levels } = useOperationLevels();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const { data: access } = useMyClusterAccess(!isAdmin);
  const [query, setQuery] = useState('');
  // 열린 터미널 세션이 있는 화면의 전환 가드(D-244) — 다른 클러스터로 갈 때만 묻는다.
  const switchGuard = useClusterSwitchGuardStore((s) => s.guard);
  // 상태는 점검 탭 결과(`/ops-checks/summary`)가 원천이다 — 글자 라벨 없이 아이콘으로만 보인다.
  // (예전 「비정상 N개만 보기」 필터는 걷어냈다 — 상태는 행마다 아이콘으로 보인다.)
  const { byId: checkSummary } = useClusterCheckSummaries();
  const { clusterId: currentId, view } = parseHubPath(location.pathname);

  // 운영 수준(operationLevel)으로 묶는다. 묶음 순서는 Settings 운영레벨 목록 순서, 목록에 없는 값은 그 뒤
  // (처음 나온 순서), 값이 없는 클러스터는 마지막 "기타" 묶음. 묶음 안은 서버 순서(seq) — 상태로 재배치하지 않는다.
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
    const rank = new Map((levels ?? []).map((l, i) => [l.value, i]));
    const order = (k: string) => (k === '' ? Number.MAX_SAFE_INTEGER : rank.get(k) ?? Number.MAX_SAFE_INTEGER - 1);
    return [...map.entries()].sort(([a], [b]) => order(a) - order(b));
  }, [clusters, query, levels]);
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
              className="flex-1 min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-faint"
            />
          </label>
        </div>
      )}

      <div className="max-h-[480px] overflow-y-auto">
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
          <div className="flex flex-col gap-2 px-2 py-1">
            {groups.map(([level, items]) => {
              const cls = levelSectionClasses(level ? levelColor(levels, level) : 'muted');
              const custom = level ? levelSectionStyle(levels, level) : undefined;
              const fullName = level ? levelLabel(levels, level) : t('shell.k8sClusters.otherGroup');
              return (
                <section
                  key={level || '_'}
                  aria-label={fullName}
                  style={custom?.section}
                  className={`rounded-md border overflow-hidden ${grouped ? cls.section : 'border-transparent'}`}
                >
                  {grouped && (
                    <p
                      title={fullName}
                      style={custom?.header}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border-b ${cls.header}`}
                    >
                      <span className="font-bold truncate">{level ? levelShortLabel(levels, level) : fullName}</span>
                      <span className="tabular-nums">{items.length}</span>
                    </p>
                  )}
                  {items.map((c, i) => {
                    const active = c.id === currentId;
                    const readOnly = access?.[c.id] === 'read';
                    const meta = [
                      c.region,
                      c.k8sVersion ? `v${c.k8sVersion.replace(/^v/, '')}` : '',
                      c.nodeCount != null ? t('shell.k8sClusters.nodes', { count: c.nodeCount }) : '',
                    ].filter(Boolean).join(' · ');
                    return (
                      <div
                        key={c.id}
                        className={`flex items-center gap-1 pl-1.5 ${i > 0 ? `border-t ${cls.divider}` : ''} ${active ? 'bg-primary/10' : ''}`}
                      >
                        <ClusterCheckIcon clusterId={c.id} summary={checkSummary.get(c.id)} onNavigate={onNavigate} role="menuitem" />
                        <Link
                          // 허브 안에서 옮길 때는 뷰 쿼리(?service= 등)도 유지한다 — 허브의 클러스터 선택기와 같은 동작.
                          to={`/k8s/${c.id}${view ? `/${view}` : ''}${currentId ? location.search : ''}`}
                          role="menuitem"
                          aria-current={active ? 'page' : undefined}
                          onClick={(e) => {
                            if (!active && switchGuard?.({ clusterId: c.id, path: `/k8s/${c.id}${view ? `/${view}` : ''}` })) e.preventDefault();
                            onNavigate();
                          }}
                          className={`flex-1 min-w-0 flex items-center gap-2 pl-1 pr-2.5 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50 ${
                            active ? 'text-primary' : 'text-foreground hover:bg-secondary/60'
                          }`}
                        >
                          <span className="flex-1 min-w-0 flex flex-col">
                            <span className="truncate text-sm font-semibold leading-5">{c.name}</span>
                            {meta && <span className="truncate text-xs leading-4 text-muted-foreground">{meta}</span>}
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
                </section>
              );
            })}
          </div>
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
    </div>
  );
}
