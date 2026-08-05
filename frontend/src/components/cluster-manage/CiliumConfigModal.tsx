import { useId, useState } from 'react';
import { X, Search, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { Cluster } from '@/types';
import { clustersApi } from '@/services/api';
import { useModalA11y } from '@/components/common/useModalA11y';

interface CiliumConfigModalProps {
  cluster: Cluster;
  onClose: () => void;
}

export function CiliumConfigModal({ cluster, onClose }: CiliumConfigModalProps) {
  const [search, setSearch] = useState('');
  const titleId = useId();
  const dialogRef = useModalA11y(true, onClose);
  const { data, isLoading, error } = useQuery({
    queryKey: ['cilium-config', cluster.id],
    queryFn: () => clustersApi.getCiliumConfig(cluster.id).then(r => r.data),
    staleTime: 1000 * 60,
  });

  const rawText = data?.live ?? data?.stored ?? '';
  const lines = rawText.split('\n');
  const filteredLines = search.trim()
    ? lines.filter((l: string) => l.toLowerCase().includes(search.toLowerCase()))
    : lines;
  const displayText = filteredLines.join('\n');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="relative bg-card border border-border rounded-xl w-full max-w-4xl mx-4 shadow-2xl flex flex-col" style={{ maxHeight: '80vh' }}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div>
            <h3 id={titleId} className="text-base font-semibold">Cilium 설정 — {cluster.name}</h3>
            {data && (
              <p className="text-sm text-muted-foreground mt-0.5">
                소스: {data.source === 'live' ? '🟢 kubectl 실시간' : data.source === 'stored' ? '🟡 저장된 설정' : '⚪ 없음'}
                {data.error && <span className="text-status-warning ml-2">⚠ {data.error}</span>}
              </p>
            )}
          </div>
          <button onClick={onClose} title="닫기" aria-label="닫기" className="p-1.5 hover:bg-secondary rounded-lg text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-border flex-shrink-0">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="설정 항목 검색..."
              className="w-full pl-8 pr-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          {search && <p className="text-sm text-muted-foreground mt-1">{filteredLines.length}줄 매치</p>}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
              <span className="ml-2 text-sm text-muted-foreground">kubectl로 Cilium 설정 조회 중...</span>
            </div>
          ) : error ? (
            <p className="text-sm text-destructive py-4 text-center">조회에 실패했습니다.</p>
          ) : !rawText ? (
            <p className="text-sm text-muted-foreground py-4 text-center">Cilium 설정 정보가 없습니다.</p>
          ) : displayText ? (
            <pre className="text-sm font-mono text-foreground whitespace-pre-wrap leading-relaxed">
              {search.trim()
                ? filteredLines.map((line: string, i: number) => {
                    const idx = line.toLowerCase().indexOf(search.toLowerCase());
                    if (idx === -1) return <div key={i}>{line}</div>;
                    return (
                      <div key={i}>
                        {line.slice(0, idx)}
                        <mark className="bg-status-warning/30 text-foreground rounded px-0.5">{line.slice(idx, idx + search.length)}</mark>
                        {line.slice(idx + search.length)}
                      </div>
                    );
                  })
                : displayText}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground py-4 text-center">검색 결과 없음</p>
          )}
        </div>
      </div>
    </div>
  );
}
