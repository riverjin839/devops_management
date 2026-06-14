import { useMemo } from 'react';
import { Pencil } from 'lucide-react';
import { NodeInfo } from '@/hooks/useNodeLabels';

interface Props {
  nodes: NodeInfo[];
  onEdit: (node: NodeInfo) => void;
  searchQuery: string;
  viewMode: 'node' | 'label';
}

// ── 검색 필터 ─────────────────────────────────────────────
function matchesSearch(node: NodeInfo, query: string): boolean {
  if (!query.trim()) return true;
  const q = query.toLowerCase();
  if (node.name.toLowerCase().includes(q)) return true;
  return Object.entries(node.labels).some(
    ([k, v]) => k.toLowerCase().includes(q) || v.toLowerCase().includes(q),
  );
}

// ── 노드 기준 뷰 ──────────────────────────────────────────
function NodeView({
  nodes,
  onEdit,
  searchQuery,
}: {
  nodes: NodeInfo[];
  onEdit: (node: NodeInfo) => void;
  searchQuery: string;
}) {
  const filtered = useMemo(
    () => nodes.filter((n) => matchesSearch(n, searchQuery)),
    [nodes, searchQuery],
  );

  if (filtered.length === 0) {
    return (
      <div className="bg-card border border-border rounded-xl p-8 text-center text-muted-foreground text-sm">
        {searchQuery ? `"${searchQuery}"에 해당하는 노드가 없습니다.` : '노드 정보가 없습니다.'}
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/20">
          <tr>
            <th className="text-left px-4 py-3 font-medium text-muted-foreground w-48">Node</th>
            <th className="text-left px-4 py-3 font-medium text-muted-foreground w-32">Role</th>
            <th className="text-left px-4 py-3 font-medium text-muted-foreground w-24">Status</th>
            <th className="text-left px-4 py-3 font-medium text-muted-foreground">Labels</th>
            <th className="text-left px-4 py-3 font-medium text-muted-foreground w-20">Action</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((node) => {
            const labelEntries = Object.entries(node.labels);
            return (
              <tr key={node.name} className="border-t border-border align-top hover:bg-muted/10 transition-colors">
                <td className="px-4 py-3 font-mono text-sm font-medium">{node.name}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 text-sm rounded-full font-medium ${
                    node.role === 'control-plane'
                      ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                      : 'bg-secondary text-muted-foreground border border-border'
                  }`}>
                    {node.role}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 text-sm rounded-full font-medium ${
                    node.status === 'ready'
                      ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                      : 'bg-red-500/10 text-red-400 border border-red-500/20'
                  }`}>
                    {node.status}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1 max-w-3xl">
                    {labelEntries.slice(0, 15).map(([k, v]) => {
                      const tag = v ? `${k}=${v}` : k;
                      const isHighlighted =
                        searchQuery &&
                        (k.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          v.toLowerCase().includes(searchQuery.toLowerCase()));
                      return (
                        <span
                          key={k}
                          className={`px-2 py-0.5 text-sm rounded border font-mono ${
                            isHighlighted
                              ? 'bg-yellow-500/15 border-yellow-500/40 text-yellow-300'
                              : 'bg-secondary border-border text-muted-foreground'
                          }`}
                        >
                          {tag}
                        </span>
                      );
                    })}
                    {labelEntries.length > 15 && (
                      <span className="px-2 py-0.5 text-sm text-muted-foreground">
                        +{labelEntries.length - 15} more
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => onEdit(node)}
                    className="px-2 py-1 rounded bg-primary/10 text-primary border border-primary/20 inline-flex items-center gap-1 text-sm hover:bg-primary/20 transition-colors"
                  >
                    <Pencil className="w-3 h-3" /> Edit
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── 레이블 기준 뷰 ────────────────────────────────────────
interface LabelEntry {
  key: string;
  value: string;
  tag: string;
  nodes: string[];
}

function LabelView({
  nodes,
  searchQuery,
}: {
  nodes: NodeInfo[];
  searchQuery: string;
}) {
  const labelMap = useMemo<LabelEntry[]>(() => {
    const map = new Map<string, { nodes: string[]; value: string }>();
    for (const node of nodes) {
      for (const [k, v] of Object.entries(node.labels)) {
        const tag = v ? `${k}=${v}` : k;
        const entry = map.get(tag);
        if (entry) {
          entry.nodes.push(node.name);
        } else {
          map.set(tag, { nodes: [node.name], value: v });
        }
      }
    }
    return Array.from(map.entries())
      .map(([tag, { nodes: ns, value }]) => ({
        key: tag.split('=')[0],
        value,
        tag,
        nodes: ns,
      }))
      .sort((a, b) => {
        // system labels last, then sort by key
        const aSystem = a.key.includes('kubernetes.io') || a.key.includes('k8s.io');
        const bSystem = b.key.includes('kubernetes.io') || b.key.includes('k8s.io');
        if (aSystem !== bSystem) return aSystem ? 1 : -1;
        return a.tag.localeCompare(b.tag);
      });
  }, [nodes]);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return labelMap;
    const q = searchQuery.toLowerCase();
    return labelMap.filter(
      (entry) =>
        entry.tag.toLowerCase().includes(q) ||
        entry.nodes.some((n) => n.toLowerCase().includes(q)),
    );
  }, [labelMap, searchQuery]);

  if (filtered.length === 0) {
    return (
      <div className="bg-card border border-border rounded-xl p-8 text-center text-muted-foreground text-sm">
        {searchQuery ? `"${searchQuery}"에 해당하는 레이블이 없습니다.` : '레이블 정보가 없습니다.'}
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/20">
          <tr>
            <th className="text-left px-4 py-3 font-medium text-muted-foreground w-12">#</th>
            <th className="text-left px-4 py-3 font-medium text-muted-foreground">Label (key=value)</th>
            <th className="text-left px-4 py-3 font-medium text-muted-foreground w-16">Nodes</th>
            <th className="text-left px-4 py-3 font-medium text-muted-foreground">적용된 노드</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((entry, idx) => {
            const isHighlighted =
              searchQuery && entry.tag.toLowerCase().includes(searchQuery.toLowerCase());
            const isSystem =
              entry.key.includes('kubernetes.io') || entry.key.includes('k8s.io');
            return (
              <tr key={entry.tag} className="border-t border-border align-middle hover:bg-muted/10 transition-colors">
                <td className="px-4 py-3 text-sm text-muted-foreground">{idx + 1}</td>
                <td className="px-4 py-3">
                  <span
                    className={`px-2 py-0.5 text-sm rounded border font-mono ${
                      isHighlighted
                        ? 'bg-yellow-500/15 border-yellow-500/40 text-yellow-300'
                        : isSystem
                        ? 'bg-secondary border-border text-muted-foreground'
                        : 'bg-primary/10 border-primary/20 text-primary'
                    }`}
                  >
                    {entry.tag}
                  </span>
                </td>
                <td className="px-4 py-3 text-center">
                  <span className="px-2 py-0.5 text-sm rounded-full bg-secondary text-muted-foreground font-medium">
                    {entry.nodes.length}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {entry.nodes.map((nodeName) => (
                      <span
                        key={nodeName}
                        className={`px-2 py-0.5 text-sm rounded border font-mono ${
                          searchQuery && nodeName.toLowerCase().includes(searchQuery.toLowerCase())
                            ? 'bg-yellow-500/15 border-yellow-500/40 text-yellow-300'
                            : 'bg-secondary border-border text-foreground'
                        }`}
                      >
                        {nodeName}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────
export function NodeLabelsTable({ nodes, onEdit, searchQuery, viewMode }: Props) {
  if (viewMode === 'label') {
    return <LabelView nodes={nodes} searchQuery={searchQuery} />;
  }
  return <NodeView nodes={nodes} onEdit={onEdit} searchQuery={searchQuery} />;
}
