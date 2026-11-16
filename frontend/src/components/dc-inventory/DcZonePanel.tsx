// DC 토폴로지 왼쪽 패널 — ① DC·구간(구획) 정의 ② 구간에 걸친 주요 K8s 클러스터 연결 ③ 선택한 개체의 관계(온톨로지).
// 구간을 누르면 캔버스가 그 구간의 랙·장비만 또렷하게 보여준다(다시 누르면 해제).
import { useState } from 'react';
import { Link2Off, Pencil, Plus, Trash2 } from 'lucide-react';
import { EmptyState } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { dcApi } from '@/services/api';
import type { DcTopology } from '@/types';
import type { EntityDraft } from './DcEntityDialog';
import { BTN, INPUT } from './shared';

const REL_LABEL: Record<string, [string, string]> = {
  contains: ['포함', '소속'],
  hosts: ['클러스터 운영', '운영 구간'],
  member_of: ['클러스터 소속', '구성 장비'],
  uplink_to: ['하위 연결', '상위 연결'],
};
const TYPE_LABEL: Record<string, string> = {
  site: 'DC', zone: '구간', rack: '랙', cluster: '클러스터', 'fa-core': 'FA 코어', 'super-spine': 'super-spine',
  spine: 'spine', leaf: 'leaf', server: '서버', mgmt: 'mgmt', patch: '패치패널',
};
const ICON_BTN = 'inline-flex items-center justify-center w-7 h-7 rounded-xl text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed';

interface Props {
  topology: DcTopology;
  clusters: { id: string; name: string }[];
  canOperate: boolean;
  hint: string | undefined;
  zoneFilter: string | null;
  onZoneFilter: (id: string | null) => void;
  selected: string | null;
  onEdit: (draft: EntityDraft) => void;
  onDelete: (target: { resource: string; id: string; label: string; note?: string }) => void;
  act: (fn: () => Promise<unknown>, done: string, failed: string) => Promise<void>;
}

export function DcZonePanel({
  topology, clusters, canOperate, hint, zoneFilter, onZoneFilter, selected, onEdit, onDelete, act,
}: Props) {
  const [adding, setAdding] = useState<Record<string, string>>({});
  const names = new Map(topology.ontology.entities.map((e) => [e.id, e]));
  const relations = selected
    ? topology.ontology.relationships.filter((r) => r.source === selected || r.target === selected)
    : [];
  const selectedEntity = selected ? names.get(selected) : undefined;

  return (
    <div className="w-full lg:w-80 shrink-0 space-y-4">
      <MacCard
        title="DC · 구간"
        bodyPadding="p-0"
        actions={(
          <button type="button" className={BTN} disabled={!canOperate} title={hint ?? 'DC(사이트) 추가'}
            onClick={() => onEdit({ kind: 'site' })}>
            <Plus className="w-4 h-4" aria-hidden /> DC
          </button>
        )}
      >
        {topology.sites.length === 0 ? (
          <EmptyState compact title="DC 가 없습니다" description="DC 를 만들고 그 안에 구간(구획)을 나누세요." />
        ) : topology.sites.map((site) => {
          const zones = topology.zones.filter((z) => z.siteId === site.id);
          return (
            <div key={site.id} className="border-b border-border last:border-b-0">
              <div className="flex items-center gap-1 px-3 py-2 bg-secondary/40">
                <span className="text-sm font-semibold truncate flex-1">{site.name}</span>
                <button type="button" className={ICON_BTN} disabled={!canOperate} title={hint ?? `${site.name} 에 구간 추가`}
                  aria-label={`${site.name} 에 구간 추가`} onClick={() => onEdit({ kind: 'zone', siteId: site.id, zoneNo: zones.length + 1 })}>
                  <Plus className="w-4 h-4" aria-hidden />
                </button>
                <button type="button" className={ICON_BTN} disabled={!canOperate} title={hint ?? `${site.name} 수정`}
                  aria-label={`${site.name} 수정`} onClick={() => onEdit({ kind: 'site', id: site.id, name: site.name, description: site.description })}>
                  <Pencil className="w-3.5 h-3.5" aria-hidden />
                </button>
                <button type="button" className={ICON_BTN} disabled={!canOperate} title={hint ?? `${site.name} 삭제`}
                  aria-label={`${site.name} 삭제`}
                  onClick={() => onDelete({ resource: 'sites', id: site.id, label: site.name, note: '구간이 남아 있는 DC 는 삭제되지 않습니다.' })}>
                  <Trash2 className="w-3.5 h-3.5" aria-hidden />
                </button>
              </div>
              {zones.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">구간이 없습니다 — + 로 추가</p>}
              {zones.map((z) => {
                const on = zoneFilter === z.id;
                const linked = new Set(z.clusters.map((c) => c.clusterId));
                const candidates = clusters.filter((c) => !linked.has(c.id));
                return (
                  <div key={z.id} className={`px-3 py-2 border-t border-border ${on ? 'bg-accent' : ''}`}>
                    <div className="flex items-center gap-1">
                      <button type="button" aria-pressed={on} onClick={() => onZoneFilter(on ? null : z.id)}
                        title="이 구간만 또렷하게 보기" className="flex-1 min-w-0 text-left">
                        <span className="text-sm font-medium truncate block">
                          {z.zoneNo !== null && <span className="text-muted-foreground tabular-nums">#{z.zoneNo} </span>}
                          {z.name}
                        </span>
                        <span className="text-xs text-muted-foreground block truncate">
                          랙 {z.rackCount} · 장비 {z.deviceCount}{z.description ? ` · ${z.description}` : ''}
                        </span>
                      </button>
                      <button type="button" className={ICON_BTN} disabled={!canOperate} title={hint ?? `${z.name} 수정`}
                        aria-label={`${z.name} 수정`}
                        onClick={() => onEdit({ kind: 'zone', id: z.id, siteId: z.siteId, name: z.name, zoneNo: z.zoneNo, description: z.description })}>
                        <Pencil className="w-3.5 h-3.5" aria-hidden />
                      </button>
                      <button type="button" className={ICON_BTN} disabled={!canOperate} title={hint ?? `${z.name} 삭제`}
                        aria-label={`${z.name} 삭제`}
                        onClick={() => onDelete({ resource: 'halls', id: z.id, label: z.name, note: '랙이 남아 있는 구간은 삭제되지 않습니다.' })}>
                        <Trash2 className="w-3.5 h-3.5" aria-hidden />
                      </button>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {z.clusters.map((c) => (
                        <span key={c.linkId} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full border border-border bg-card text-xs">
                          {c.name}
                          <button type="button" disabled={!canOperate} title={hint ?? `${c.name} 연결 해제`} aria-label={`${z.name} 에서 ${c.name} 연결 해제`}
                            className="inline-flex items-center justify-center w-5 h-5 rounded-full hover:bg-secondary disabled:opacity-40"
                            onClick={() => void act(() => dcApi.remove('zone-clusters', c.linkId), `${c.name} 연결 해제`, '해제하지 못했습니다')}>
                            <Link2Off className="w-3 h-3" aria-hidden />
                          </button>
                        </span>
                      ))}
                      {z.clusters.length === 0 && <span className="text-xs text-muted-foreground">연결된 클러스터 없음</span>}
                    </div>
                    {canOperate && candidates.length > 0 && (
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <label className="sr-only" htmlFor={`zc-${z.id}`}>{z.name} 에 연결할 클러스터</label>
                        <select id={`zc-${z.id}`} className={`${INPUT} flex-1 min-w-0 py-1 text-xs`} value={adding[z.id] ?? ''}
                          onChange={(e) => setAdding((p) => ({ ...p, [z.id]: e.target.value }))}>
                          <option value="">K8s 클러스터 연결…</option>
                          {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        <button type="button" className={`${BTN} py-1 text-xs`} disabled={!adding[z.id]}
                          onClick={() => {
                            const clusterId = adding[z.id];
                            setAdding((p) => ({ ...p, [z.id]: '' }));
                            void act(() => dcApi.create('zone-clusters', { hallId: z.id, clusterId }), '클러스터를 연결했습니다', '연결하지 못했습니다');
                          }}>
                          연결
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </MacCard>

      <MacCard title="관계" description={selectedEntity ? `${TYPE_LABEL[selectedEntity.type] ?? selectedEntity.type} · ${selectedEntity.name}` : undefined}>
        {!selectedEntity ? (
          <p className="text-sm text-muted-foreground">
            캔버스에서 장비나 랙을 누르면 그 개체가 무엇에 속하고 무엇과 연결되는지 보여줍니다.
            전체 {topology.ontology.entities.length}개 개체 · {topology.ontology.relationships.length}개 관계.
          </p>
        ) : relations.length === 0 ? (
          <p className="text-sm text-muted-foreground">아직 관계가 없습니다.</p>
        ) : (
          <ul className="space-y-1 text-sm max-h-64 overflow-y-auto">
            {relations.slice(0, 60).map((r) => {
              const outgoing = r.source === selected;
              const other = names.get(outgoing ? r.target : r.source);
              const [out, inc] = REL_LABEL[r.type] ?? [r.type, r.type];
              return (
                <li key={`${r.source}-${r.type}-${r.target}`} className="flex items-baseline gap-2">
                  <span className="text-xs text-muted-foreground w-20 shrink-0">{outgoing ? out : inc}</span>
                  <span className="truncate">
                    {other?.name ?? '?'} <span className="text-xs text-muted-foreground">{TYPE_LABEL[other?.type ?? ''] ?? other?.type}</span>
                  </span>
                </li>
              );
            })}
            {relations.length > 60 && <li className="text-xs text-muted-foreground">+{relations.length - 60}개 더</li>}
          </ul>
        )}
      </MacCard>
    </div>
  );
}
