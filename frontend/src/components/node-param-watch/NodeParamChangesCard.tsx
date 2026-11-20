// OS 파라미터 변경 이력 — 에이전트 감지분과 SSH 수집 비교(OS 파라미터 변경 점검)분을 한 표로.
// "변경 구간" = 마지막으로 같은 값이 확인된 시각 ~ 바뀐 값을 처음 본 시각 — 실제 변경은 이 사이에 일어났다.
import { useMemo, useState } from 'react';
import { History, Search } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { EmptyState } from '@/components/common';
import { formatDateTime } from '@/lib/utils';
import type { NodeParamChange } from '@/types';

const TH = 'text-left px-3 py-2 text-xs font-medium text-muted-foreground';
const TD = 'px-3 py-2 align-top';
const TYPE_LABEL: Record<NodeParamChange['changeType'], string> = { changed: '변경', added: '생김', removed: '사라짐' };

export function NodeParamChangesCard({ changes, initialQuery = '' }: { changes: NodeParamChange[]; initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return changes;
    return changes.filter((c) => c.node.toLowerCase().includes(q) || c.param.toLowerCase().includes(q));
  }, [changes, query]);

  return (
    <MacCard
      title="변경 이력"
      titleExtra={<span className="text-xs text-muted-foreground">최근 {changes.length}건</span>}
      description="값이 실제로 바뀐 시각은 '변경 구간' 안에 있다"
      actions={(
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="노드·파라미터 검색"
            aria-label="노드·파라미터 검색"
            className="pl-8 pr-2.5 py-1 text-sm rounded-xl border border-border bg-card focus:outline-none focus:ring-1 focus:ring-primary" />
        </div>
      )}
      bodyPadding="p-0"
    >
      {filtered.length === 0 ? (
        <EmptyState icon={History} compact title={changes.length ? '조건에 맞는 변경이 없습니다' : '아직 감지된 변경이 없습니다'} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={TH}>감지 시각</th>
                <th className={TH}>노드</th>
                <th className={TH}>파라미터</th>
                <th className={TH}>이전 → 새 값</th>
                <th className={TH}>변경 구간</th>
                <th className={TH}>출처</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0">
                  <td className={`${TD} text-xs whitespace-nowrap`}>{c.detectedAt ? formatDateTime(c.detectedAt) : '—'}</td>
                  <td className={`${TD} text-xs`}>{c.node}</td>
                  <td className={`${TD} font-mono text-xs`}>{c.param}</td>
                  <td className={`${TD} font-mono text-xs`}>
                    <span className="text-muted-foreground">{c.oldValue ?? '없음'}</span>
                    {' → '}
                    <span className="text-foreground font-semibold">{c.newValue ?? '없음'}</span>
                    {c.changeType !== 'changed' && <span className="ml-1.5 font-sans text-muted-foreground">({TYPE_LABEL[c.changeType]})</span>}
                  </td>
                  <td className={`${TD} text-xs text-muted-foreground whitespace-nowrap`}>
                    {c.lastUnchangedAt ? `${formatDateTime(c.lastUnchangedAt)} 이후` : '—'}
                  </td>
                  <td className={`${TD} text-xs text-muted-foreground`}>{c.source === 'agent' ? '에이전트' : 'SSH 수집'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </MacCard>
  );
}
