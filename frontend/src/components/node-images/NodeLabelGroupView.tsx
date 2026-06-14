import { useMemo, useState } from 'react';
import { Layers, Tag } from 'lucide-react';
import type { NodeImagesInfo } from '@/hooks/useNodeImages';
import { formatBytes } from './utils';

interface Props {
  nodes: NodeImagesInfo[];
  searchQuery: string;
}

/**
 * 모든 노드에서 등장하는 라벨 키 후보를 추려서, 그룹핑에 의미 있는 것들만 추천한다.
 * - 모든 노드가 동일 값을 갖는 키(=차별화 안됨) 는 제외
 * - 모든 노드에서 값이 전부 달라 그룹이 1노드씩 쪼개지는 키도 제외
 * - 흔한 시스템 라벨(beta.kubernetes.io/* 등) 은 제외해 노이즈 줄임
 */
function suggestLabelKeys(nodes: NodeImagesInfo[]): string[] {
  if (nodes.length === 0) return [];
  const keyValues = new Map<string, Set<string>>();
  for (const n of nodes) {
    for (const [k, v] of Object.entries(n.labels ?? {})) {
      if (!keyValues.has(k)) keyValues.set(k, new Set());
      keyValues.get(k)!.add(v);
    }
  }
  const denyPrefix = ['beta.kubernetes.io/', 'kubernetes.io/hostname', 'kubernetes.io/os', 'kubernetes.io/arch'];
  const out: string[] = [];
  for (const [key, vals] of keyValues.entries()) {
    if (denyPrefix.some((p) => key === p || key.startsWith(p))) continue;
    if (vals.size <= 1) continue; // 모든 노드 동일 → 그룹핑 의미 없음
    if (vals.size === nodes.length) continue; // 노드별 고유 → 의미 없음
    out.push(key);
  }
  // role 관련 라벨 / topology 관련을 우선 노출
  const priority = (k: string) =>
    k.startsWith('node-role.kubernetes.io/') ? 0 :
    k.startsWith('topology.kubernetes.io/')  ? 1 :
    k === 'kubernetes.io/role'               ? 2 : 5;
  out.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
  return out;
}

function nodeMatches(node: NodeImagesInfo, q: string): boolean {
  if (!q.trim()) return true;
  const lower = q.toLowerCase();
  if (node.node.toLowerCase().includes(lower)) return true;
  return node.images.some((img) => img.names.some((n) => n.toLowerCase().includes(lower)));
}

export function NodeLabelGroupView({ nodes, searchQuery }: Props) {
  const candidateKeys = useMemo(() => suggestLabelKeys(nodes), [nodes]);
  const [groupKey, setGroupKey] = useState<string>(() => candidateKeys[0] ?? 'role');

  const filtered = useMemo(() => nodes.filter((n) => nodeMatches(n, searchQuery)), [nodes, searchQuery]);

  // 그룹핑 — groupKey === 'role' 이면 NodeImagesInfo.role, 아니면 labels[groupKey]
  const groups = useMemo(() => {
    const map = new Map<string, NodeImagesInfo[]>();
    for (const n of filtered) {
      const value = groupKey === 'role'
        ? n.role
        : (n.labels?.[groupKey] ?? '(미지정)');
      if (!map.has(value)) map.set(value, []);
      map.get(value)!.push(n);
    }
    const arr = Array.from(map.entries()).map(([value, nodes]) => ({
      value,
      nodes,
      totalImages: nodes.reduce((s, n) => s + n.imageCount, 0),
      totalSize: nodes.reduce((s, n) => s + n.totalSizeBytes, 0),
    }));
    arr.sort((a, b) => b.nodes.length - a.nodes.length || a.value.localeCompare(b.value));
    return arr;
  }, [filtered, groupKey]);

  if (filtered.length === 0) {
    return (
      <div className="bg-card border border-border rounded-xl p-8 text-center text-muted-foreground text-sm">
        {searchQuery ? `"${searchQuery}"에 해당하는 노드/이미지가 없습니다.` : '노드 이미지 정보가 없습니다.'}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 그룹 키 선택 */}
      <div className="flex items-center gap-2 flex-wrap">
        <Tag className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        <span className="text-sm text-muted-foreground">그룹 기준:</span>
        <button
          type="button"
          onClick={() => setGroupKey('role')}
          className={`px-2 py-1 text-xs font-medium rounded-md border transition-colors ${
            groupKey === 'role'
              ? 'bg-primary/10 text-primary border-primary/30'
              : 'bg-secondary/40 text-muted-foreground border-border hover:bg-secondary'
          }`}
        >
          role
        </button>
        {candidateKeys.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setGroupKey(k)}
            className={`px-2 py-1 text-xs font-mono rounded-md border transition-colors ${
              groupKey === k
                ? 'bg-primary/10 text-primary border-primary/30'
                : 'bg-secondary/40 text-muted-foreground border-border hover:bg-secondary'
            }`}
            title={k}
          >
            {k}
          </button>
        ))}
        {candidateKeys.length === 0 && (
          <span className="text-xs text-muted-foreground/60">
            노드 라벨이 모두 같거나 노드별로 모두 달라 그룹화 가능한 라벨이 없습니다.
          </span>
        )}
      </div>

      {/* 그룹 카드 그리드 */}
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
        {groups.map((g) => (
          <div key={g.value} className="bg-card border border-border rounded-xl overflow-hidden flex flex-col">
            {/* 카드 헤더 */}
            <div className="px-4 py-3 bg-muted/20 border-b border-border">
              <div className="flex items-baseline justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-xs font-mono text-muted-foreground/70 uppercase tracking-wider truncate">
                    {groupKey}
                  </span>
                  <span className="text-sm font-semibold text-foreground font-mono truncate" title={g.value}>
                    {g.value}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0">
                  {g.nodes.length}개 노드
                </span>
              </div>
              <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Layers className="w-3 h-3" />
                  <span className="tabular-nums font-medium text-foreground">{g.totalImages.toLocaleString()}</span>
                  <span>이미지</span>
                </span>
                <span className="text-muted-foreground/40">·</span>
                <span className="tabular-nums">{formatBytes(g.totalSize)}</span>
              </div>
            </div>

            {/* 노드 목록 */}
            <ul className="flex-1 divide-y divide-border/60">
              {g.nodes.map((n) => (
                <li key={n.node} className="px-4 py-2.5 flex items-center justify-between gap-2 hover:bg-muted/10">
                  <div className="min-w-0">
                    <p className="text-sm font-mono text-foreground truncate" title={n.node}>{n.node}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className={`text-[9.5px] px-1.5 py-0.5 rounded ${
                        n.role === 'control-plane' ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground'
                      }`}>{n.role}</span>
                      <span className={`text-[9.5px] px-1.5 py-0.5 rounded ${
                        n.status === 'ready' ? 'bg-green-500/15 text-green-600 dark:text-green-400' :
                        n.status === 'not-ready' ? 'bg-red-500/15 text-red-600 dark:text-red-400' :
                        'bg-muted text-muted-foreground'
                      }`}>{n.status}</span>
                    </div>
                  </div>
                  <div className="flex flex-col items-end flex-shrink-0">
                    <span className="text-sm font-semibold tabular-nums text-foreground">
                      {n.imageCount.toLocaleString()}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatBytes(n.totalSizeBytes)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
