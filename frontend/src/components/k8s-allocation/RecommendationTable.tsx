// request 축소 추천 목록 — 다중 선택 → 적용(드라이런 기본) / 무시. 오퍼레이터 관리 워크로드는 적용 불가 배지.
import { memo, useMemo, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Check, Info, X } from 'lucide-react';
import { EmptyState, Skeleton } from '@/components/common';
import { useCanOperate } from '@/hooks/useCanOperate';
import type { EffRecommendation } from '@/types';
import { fmtN } from './format';
import { SearchInput, StatTooltip } from './primitives';

const VIRTUALIZE_AT = 60;
const GRID = 'grid grid-cols-[28px_minmax(140px,1.3fr)_minmax(160px,1.6fr)_70px_120px_120px_90px_minmax(120px,1fr)_70px] gap-2 items-center px-3';

function Row({ r, selected, onToggle, onDismiss, canOperate, hint }: {
  r: EffRecommendation; selected: boolean; onToggle: (id: string) => void; onDismiss: (id: string) => void;
  canOperate: boolean; hint: string | undefined;
}) {
  const blocked = r.recommendOnly;
  const target = `${r.namespace}/${r.name} ${r.container} ${r.resource === 'cpu' ? 'CPU' : 'MEM'}`;
  return (
    <div className={`${GRID} py-1.5 text-sm border-b border-border/60 ${selected ? 'bg-primary/5' : 'hover:bg-muted/10'}`}>
      <input type="checkbox" checked={selected} disabled={blocked} onChange={() => onToggle(r.id)}
        aria-label={`${target} 선택`} title={blocked ? '오퍼레이터가 관리하는 워크로드라 선택할 수 없습니다' : undefined}
        className="accent-primary" />
      <div className="min-w-0">
        <div className="truncate text-xs text-muted-foreground">{r.namespace}</div>
        <div className="truncate"><span className="text-xs text-muted-foreground mr-1">{r.kind}</span>{r.name}</div>
      </div>
      <div className="min-w-0">
        <div className="truncate font-mono text-xs">{r.container}</div>
        <div className="flex items-center gap-1 flex-wrap">
          {blocked && (
            <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full border bg-secondary text-muted-foreground border-border"
              title={r.hint ?? ''}>
              <Info className="w-3 h-3" aria-hidden="true" /> 오퍼레이터 관리 — CR로 조정
            </span>
          )}
          {r.targetLim != null && <span className="text-xs text-muted-foreground">limit 동반</span>}
        </div>
      </div>
      <div className="text-xs">{r.resource === 'cpu' ? 'CPU' : 'MEM'}</div>
      <div className="tabular-nums text-right">
        <span className="text-muted-foreground line-through mr-1">{r.currentReqDisplay}</span>
        <span className="font-medium text-foreground">{r.targetReqDisplay}</span>
      </div>
      <div className="tabular-nums text-right text-xs text-muted-foreground">
        p{r.reason?.percentile ?? 95} {r.p95Use == null ? '—' : r.resource === 'cpu' ? `${r.p95Use}m` : `${Math.round(r.p95Use / 1024 ** 2)}Mi`}
        <div>{r.usageSource} · 샘플 {r.samples}개</div>
      </div>
      <div className="tabular-nums text-right font-medium">{r.savingsDisplay}<div className="text-xs text-muted-foreground font-normal">× Pod {r.podCount}개</div></div>
      <div className="text-xs text-muted-foreground truncate" title={JSON.stringify(r.reason)}>
        여유율 {r.reason?.headroomPct ?? '—'}% · 임계 ×{r.reason?.thresholdRatio ?? '—'} · {r.windowDays}일
      </div>
      <div className="flex justify-end">
        <button type="button" onClick={() => onDismiss(r.id)} disabled={!canOperate}
          title={hint ?? '이 추천 무시'} aria-label={hint ? `${target} 추천 무시 — ${hint}` : `${target} 추천 무시`}
          className="p-1 rounded-xl text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50">
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
const MemoRow = memo(Row);

export function RecommendationTable({
  clusterId, items, isLoading, isError, computedAt, selected, onToggle, onSelectAll, onDismiss, onDismissSelected, onApply,
}: {
  clusterId: string;
  items: EffRecommendation[]; isLoading: boolean; isError: boolean; computedAt: string | null;
  selected: Set<string>; onToggle: (id: string) => void; onSelectAll: (ids: string[]) => void;
  onDismiss: (id: string) => void; onDismissSelected: () => void; onApply: () => void;
}) {
  const { canOperate, hint, withHint, ariaWithHint } = useCanOperate(clusterId);
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? items.filter((r) => `${r.namespace}/${r.name}/${r.container}`.toLowerCase().includes(s)) : items;
  }, [items, q]);
  const applicableIds = useMemo(() => filtered.filter((r) => !r.recommendOnly).map((r) => r.id), [filtered]);
  const allSelected = applicableIds.length > 0 && applicableIds.every((id) => selected.has(id));
  const header = (
    <div className={`${GRID} py-2 text-xs text-muted-foreground bg-muted/20 border-b border-border`}>
      <input type="checkbox" checked={allSelected} onChange={() => onSelectAll(allSelected ? [] : applicableIds)}
        aria-label="적용 가능한 추천 전체 선택" className="accent-primary" />
      <div>NS / 워크로드</div><div>컨테이너</div><div>자원</div>
      <div className="text-right">현재 → 목표(Pod당)</div><div className="text-right">관측(p95)</div>
      <div className="text-right">절감</div><div>근거</div><div />
    </div>
  );

  const rowProps = { onToggle, onDismiss, canOperate, hint };
  let body: React.ReactNode;
  if (isLoading && !items.length) body = <div className="p-3"><Skeleton className="h-32 w-full" /></div>;
  else if (isError && !items.length) body = <div className="p-3"><EmptyState title="추천 목록을 불러오지 못했습니다" description="잠시 후 다시 시도하거나, 위의 '추천 재생성'으로 다시 계산하세요." /></div>;
  else if (!items.length) body = <div className="p-3"><EmptyState title="추천 없음" description="수집이 쌓이면(기본 24시간 이상) 조건에 맞는 request 축소 추천이 여기 표시됩니다. 데이터 부족·시스템 NS·opt-out 은 제외됩니다." /></div>;
  else if (!filtered.length) body = <div className="p-3"><EmptyState title="검색 결과 없음" description={`'${q}' 와 일치하는 추천이 없습니다.`} action={{ label: '검색 지우기', onClick: () => setQ(''), variant: 'secondary' }} /></div>;
  else if (filtered.length > VIRTUALIZE_AT) body = (
    <Virtuoso style={{ height: '48vh' }} data={filtered} computeItemKey={(_i, r) => r.id}
      itemContent={(_i, r) => <MemoRow r={r} selected={selected.has(r.id)} {...rowProps} />} />
  );
  else body = <div>{filtered.map((r) => <MemoRow key={r.id} r={r} selected={selected.has(r.id)} {...rowProps} />)}</div>;

  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-wrap">
        <SearchInput value={q} onChange={setQ} placeholder="NS/워크로드/컨테이너 찾기" width="w-56" />
        <span className="text-xs text-muted-foreground">
          {fmtN(filtered.length)}건{computedAt ? ` · 계산 ${new Date(computedAt.endsWith('Z') ? computedAt : computedAt + 'Z').toLocaleString()}` : ''}
        </span>
        <StatTooltip>
          <p className="font-semibold text-foreground">추천 규칙</p>
          <p>목표 = max(p95 × (1 + 여유율), 하한). 현재 request 가 목표 × 임계비율보다 크고 절감이 최소값 이상일 때만 추천합니다.</p>
          <p className="text-muted-foreground mt-1">오퍼레이터(CR)가 관리하는 워크로드는 직접 패치하면 되돌려지므로 추천만 표시합니다.</p>
        </StatTooltip>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={onDismissSelected} disabled={selected.size === 0 || !canOperate}
            title={withHint('선택한 추천을 모두 무시')} aria-label={ariaWithHint(`선택 무시 ${selected.size}건`)}
            className="text-sm inline-flex items-center gap-1 px-3 py-1 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-50">
            <X className="w-3.5 h-3.5" aria-hidden="true" /> 선택 무시
          </button>
          <button type="button" onClick={onApply} disabled={selected.size === 0 || !canOperate}
            title={withHint('선택한 추천을 적용(드라이런 기본)')} aria-label={ariaWithHint(`선택 적용 ${selected.size}건`)}
            className="text-sm inline-flex items-center gap-1 px-3 py-1 rounded-xl bg-primary text-primary-foreground disabled:opacity-50">
            <Check className="w-3.5 h-3.5" aria-hidden="true" /> 선택 적용 ({selected.size})
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[980px]">
          {header}
          <div className="min-h-32">{body}</div>
        </div>
      </div>
    </div>
  );
}
