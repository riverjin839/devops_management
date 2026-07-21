import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Layers, Send } from 'lucide-react';
import type { NodeImagesInfo } from '@/hooks/useNodeImages';
import { formatBytes, pickPrimaryName } from './utils';

interface Props {
  nodes: NodeImagesInfo[];
  searchQuery: string;
  /** 이미지 배포(다른 노드로 prepull) 트리거 — 있으면 각 이미지 행에 배포 버튼 노출 */
  onDistribute?: (image: string) => void;
}

function nodeMatches(node: NodeImagesInfo, q: string): boolean {
  if (!q.trim()) return true;
  const lower = q.toLowerCase();
  if (node.node.toLowerCase().includes(lower)) return true;
  return node.images.some((img) => img.names.some((n) => n.toLowerCase().includes(lower)));
}

function filterImages(node: NodeImagesInfo, q: string): NodeImagesInfo['images'] {
  if (!q.trim()) return node.images;
  const lower = q.toLowerCase();
  if (node.node.toLowerCase().includes(lower)) return node.images;
  return node.images.filter((img) => img.names.some((n) => n.toLowerCase().includes(lower)));
}

export function NodeImagesTable({ nodes, searchQuery, onDistribute }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const filtered = useMemo(
    () => nodes.filter((n) => nodeMatches(n, searchQuery)),
    [nodes, searchQuery],
  );

  if (filtered.length === 0) {
    return (
      <div className="bg-card border border-border rounded-xl p-8 text-center text-muted-foreground text-sm">
        {searchQuery ? `"${searchQuery}"에 해당하는 노드/이미지가 없습니다.` : '노드 이미지 정보가 없습니다.'}
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/20">
          <tr>
            <th className="text-left px-4 py-3 font-medium text-muted-foreground w-8">
              <span className="sr-only">펼치기</span>
            </th>
            <th className="text-left px-4 py-3 font-medium text-muted-foreground w-64">Node</th>
            <th className="text-left px-4 py-3 font-medium text-muted-foreground w-32">Role</th>
            <th className="text-left px-4 py-3 font-medium text-muted-foreground w-24">Status</th>
            <th className="text-right px-4 py-3 font-medium text-muted-foreground w-24">Images</th>
            <th className="text-right px-4 py-3 font-medium text-muted-foreground w-32">Total Size</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((node) => {
            const isOpen = expanded[node.node] ?? false;
            const visibleImages = filterImages(node, searchQuery);
            return (
              <RowGroup
                key={node.node}
                node={node}
                isOpen={isOpen}
                visibleImages={visibleImages}
                onToggle={() =>
                  setExpanded((prev) => ({ ...prev, [node.node]: !isOpen }))
                }
                onDistribute={onDistribute}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RowGroup({
  node,
  isOpen,
  visibleImages,
  onToggle,
  onDistribute,
}: {
  node: NodeImagesInfo;
  isOpen: boolean;
  visibleImages: NodeImagesInfo['images'];
  onToggle: () => void;
  onDistribute?: (image: string) => void;
}) {
  return (
    <>
      <tr
        className="border-t border-border hover:bg-muted/10 cursor-pointer"
        onClick={onToggle}
      >
        <td className="px-4 py-3 align-middle">
          {isOpen ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          )}
        </td>
        <td className="px-4 py-3 align-middle font-mono text-sm">{node.node}</td>
        <td className="px-4 py-3 align-middle">
          <RoleBadge role={node.role} />
        </td>
        <td className="px-4 py-3 align-middle">
          <StatusBadge status={node.status} />
        </td>
        <td className="px-4 py-3 align-middle text-right tabular-nums">
          <span className="font-semibold text-foreground">{node.imageCount.toLocaleString()}</span>
        </td>
        <td className="px-4 py-3 align-middle text-right tabular-nums">
          {formatBytes(node.totalSizeBytes)}
        </td>
      </tr>
      {isOpen && (
        <tr className="bg-muted/5">
          <td colSpan={6} className="px-0 py-0">
            <ImageList images={visibleImages} onDistribute={onDistribute} />
          </td>
        </tr>
      )}
    </>
  );
}

function ImageList({ images, onDistribute }: { images: NodeImagesInfo['images']; onDistribute?: (image: string) => void }) {
  if (images.length === 0) {
    return (
      <div className="px-12 py-4 text-sm text-muted-foreground">검색 조건에 맞는 이미지가 없습니다.</div>
    );
  }
  return (
    <div className="px-12 py-3">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground">
            <th className="text-left py-1.5 font-medium">Image</th>
            <th className="text-right py-1.5 font-medium w-32">Size</th>
            {onDistribute && <th className="text-right py-1.5 font-medium w-24">배포</th>}
          </tr>
        </thead>
        <tbody>
          {images.map((img, idx) => {
            const primary = pickPrimaryName(img.names);
            return (
              <tr key={idx} className="border-t border-border/50">
                <td className="py-1.5 pr-4 font-mono break-all">
                  <div className="flex items-start gap-2">
                    <Layers className="w-3 h-3 mt-0.5 text-muted-foreground flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-foreground">{primary}</div>
                      {img.names.length > 1 && (
                        <details className="mt-0.5">
                          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                            +{img.names.length - 1} alias
                          </summary>
                          <ul className="mt-1 ml-1 space-y-0.5 text-xs text-muted-foreground">
                            {img.names
                              .filter((n) => n !== primary)
                              .map((n) => (
                                <li key={n} className="break-all">
                                  {n}
                                </li>
                              ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  </div>
                </td>
                <td className="py-1.5 text-right tabular-nums">{formatBytes(img.sizeBytes)}</td>
                {onDistribute && (
                  <td className="py-1.5 text-right">
                    <button
                      type="button"
                      onClick={() => onDistribute(primary)}
                      title={`${primary} 를 다른 노드로 배포`}
                      aria-label={`${primary} 를 다른 노드로 배포`}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-md bg-secondary hover:bg-primary/10 hover:text-primary text-muted-foreground transition-colors"
                    >
                      <Send className="w-3 h-3" /> 배포
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  const isControl = role === 'control-plane';
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium ${
        isControl
          ? 'bg-primary/10 text-primary'
          : 'bg-secondary text-foreground'
      }`}
    >
      {role}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'ready'
      ? 'bg-green-500/15 text-green-600 dark:text-green-400'
      : status === 'not-ready'
      ? 'bg-red-500/15 text-red-600 dark:text-red-400'
      : 'bg-muted text-muted-foreground';
  return (
    <span className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}
