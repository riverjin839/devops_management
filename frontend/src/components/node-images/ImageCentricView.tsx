import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Layers, Server } from 'lucide-react';
import type { NodeImagesInfo } from '@/hooks/useNodeImages';
import { formatBytes, pickPrimaryName } from './utils';
import { DoubleScrollX } from '@/components/common';

interface Props {
  nodes: NodeImagesInfo[];
  searchQuery: string;
}

interface ImageRow {
  /** 이미지의 대표 이름 (primary tag) — 같은 이미지의 별칭들은 하나의 row 로 합쳐짐 */
  primary: string;
  /** 이 이미지가 가진 모든 별칭 (여러 노드에서 다른 alias 로 노출될 수 있어 union) */
  aliases: string[];
  /** 이미지가 적재된 노드 이름들 */
  nodes: string[];
  /** 노드별로 본 size_bytes 의 최댓값 — 노드마다 0으로 보고하는 경우가 있어 최댓값으로 집계 */
  sizeBytes: number;
}

type SortKey = 'nodes' | 'size' | 'name';

/**
 * 모든 노드의 이미지를 평탄화해 "이미지 → 어떤 노드들이 가지고 있는지" 형태로 그룹핑.
 *
 * 같은 이미지를 묶는 키는 'primary name'(태그 우선, 없으면 첫 별칭). digest-only 이름은
 * 마지막 fallback. 같은 primary 의 별칭들은 union 으로 묶여 한 행에 표시된다.
 */
function aggregate(nodes: NodeImagesInfo[]): ImageRow[] {
  const map = new Map<string, ImageRow>();
  for (const node of nodes) {
    for (const img of node.images) {
      const primary = pickPrimaryName(img.names);
      const existing = map.get(primary);
      if (existing) {
        if (!existing.nodes.includes(node.node)) existing.nodes.push(node.node);
        for (const a of img.names) if (!existing.aliases.includes(a)) existing.aliases.push(a);
        if (img.sizeBytes > existing.sizeBytes) existing.sizeBytes = img.sizeBytes;
      } else {
        map.set(primary, {
          primary,
          aliases: [...img.names],
          nodes: [node.node],
          sizeBytes: img.sizeBytes,
        });
      }
    }
  }
  return Array.from(map.values());
}

export function ImageCentricView({ nodes, searchQuery }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('nodes');
  const [sortDesc, setSortDesc] = useState(true);

  const totalNodes = nodes.length;

  const rows = useMemo(() => {
    const all = aggregate(nodes);
    const q = searchQuery.trim().toLowerCase();
    const filtered = q
      ? all.filter((r) =>
          r.primary.toLowerCase().includes(q) ||
          r.aliases.some((a) => a.toLowerCase().includes(q)) ||
          r.nodes.some((n) => n.toLowerCase().includes(q)),
        )
      : all;

    const sorted = [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'nodes')      cmp = a.nodes.length - b.nodes.length;
      else if (sortKey === 'size')  cmp = a.sizeBytes - b.sizeBytes;
      else                           cmp = a.primary.localeCompare(b.primary);
      return sortDesc ? -cmp : cmp;
    });
    return sorted;
  }, [nodes, searchQuery, sortKey, sortDesc]);

  const setSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDesc((v) => !v);
    } else {
      setSortKey(key);
      setSortDesc(key !== 'name'); // 이름은 기본 오름차순, 나머진 내림차순
    }
  };

  const sortIcon = (key: SortKey) =>
    sortKey === key ? (sortDesc ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />) : null;

  if (rows.length === 0) {
    return (
      <div className="bg-card border border-border rounded-xl p-8 text-center text-muted-foreground text-sm">
        {searchQuery ? `"${searchQuery}"에 해당하는 이미지가 없습니다.` : '이미지 정보가 없습니다.'}
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-2 bg-muted/10 border-b border-border flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          전체 <span className="font-semibold text-foreground tabular-nums">{rows.length}</span>개 고유 이미지
          <span className="mx-1.5 text-muted-foreground/40">·</span>
          {totalNodes}개 노드 기준
        </p>
      </div>
      <DoubleScrollX>
        <table className="w-full text-sm">
          <thead className="bg-muted/20">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">
                <SortHeader label="Image" active={sortKey === 'name'} onClick={() => setSort('name')} icon={sortIcon('name')} />
              </th>
              <th className="text-right px-4 py-3 font-medium text-muted-foreground w-40">
                <SortHeader label="노드 수" align="right" active={sortKey === 'nodes'} onClick={() => setSort('nodes')} icon={sortIcon('nodes')} />
              </th>
              <th className="text-right px-4 py-3 font-medium text-muted-foreground w-32">
                <SortHeader label="Size" align="right" active={sortKey === 'size'} onClick={() => setSort('size')} icon={sortIcon('size')} />
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const coverage = totalNodes > 0 ? (r.nodes.length / totalNodes) * 100 : 0;
              return (
                <tr key={r.primary} className="border-t border-border hover:bg-muted/10 align-top">
                  <td className="px-4 py-3 font-mono break-all">
                    <div className="flex items-start gap-2">
                      <Layers className="w-3.5 h-3.5 mt-0.5 text-muted-foreground flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-foreground">{r.primary}</div>
                        {r.aliases.length > 1 && (
                          <details className="mt-0.5">
                            <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                              +{r.aliases.length - 1} alias
                            </summary>
                            <ul className="mt-1 ml-1 space-y-0.5 text-xs text-muted-foreground">
                              {r.aliases.filter((a) => a !== r.primary).map((a) => (
                                <li key={a} className="break-all">{a}</li>
                              ))}
                            </ul>
                          </details>
                        )}
                        {r.nodes.length > 0 && (
                          <details className="mt-1">
                            <summary className="text-xs text-muted-foreground/80 cursor-pointer hover:text-foreground inline-flex items-center gap-1">
                              <Server className="w-2.5 h-2.5" />
                              {r.nodes.length}개 노드
                            </summary>
                            <ul className="mt-1 ml-1 space-y-0.5 text-xs text-muted-foreground font-mono">
                              {r.nodes.map((n) => <li key={n} className="break-all">{n}</li>)}
                            </ul>
                          </details>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <div className="flex items-center justify-end gap-2" aria-label={`${r.nodes.length}/${totalNodes} 노드에 적재됨`}>
                      <span className="text-sm tabular-nums text-muted-foreground">
                        {r.nodes.length}/{totalNodes}
                      </span>
                      <div className="w-16 h-1.5 rounded-full bg-secondary overflow-hidden">
                        <div
                          className="h-full bg-primary"
                          style={{ width: `${coverage}%` }}
                          aria-label={`${coverage.toFixed(0)}% 노드에 적재됨`}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums align-top">{formatBytes(r.sizeBytes)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </DoubleScrollX>
    </div>
  );
}

function SortHeader({
  label, active, onClick, icon, align = 'left',
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 hover:text-foreground transition-colors ${active ? 'text-foreground' : ''} ${align === 'right' ? 'justify-end w-full' : ''}`}
    >
      <span>{label}</span>
      {icon}
    </button>
  );
}
