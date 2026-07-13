import { useMemo, useRef, useState } from 'react';
import { Boxes, Search, AlertTriangle, LayoutList, LayoutGrid, Layers } from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useNodeImageList } from '@/hooks/useNodeImages';
import { NodeImagesTable, NodeLabelGroupView, ImageCentricView, NodeImagesCsvExportMenu } from '@/components/node-images';
import { ClusterSidebar, SnapshotProgressCard, ExportMenu } from '@/components/common';
import { formatApiError } from '@/lib/utils';

function extractErrorMessage(error: unknown): string {
  return formatApiError(error, '알 수 없는 오류가 발생했습니다.');
}

type ViewMode = 'node-table' | 'label-group' | 'image-centric';

const TABS: { id: ViewMode; label: string; icon: typeof LayoutList; tip: string }[] = [
  { id: 'node-table',    label: '노드별 (Table)',  icon: LayoutList,  tip: '노드 단위 표 — 펼치면 그 노드의 이미지 목록' },
  { id: 'label-group',   label: '라벨 그룹 (Card)', icon: LayoutGrid,  tip: '노드를 라벨/role 기준으로 묶어 카드로 표시' },
  { id: 'image-centric', label: '이미지별',         icon: Layers,      tip: '이미지 기준 집계 — 어떤 이미지가 어느 노드에 적재됐는지' },
];

export function NodeImagesPage() {
  const { data: clusters = [], isLoading: clustersLoading } = useClusters();

  const [selectedClusterId, setSelectedClusterId] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [view, setView] = useState<ViewMode>('node-table');

  const activeClusterId = selectedClusterId || clusters[0]?.id || '';
  const {
    data: result,
    isLoading: nodesLoading,
    isError: nodesError,
    error: nodesErrorDetail,
  } = useNodeImageList(activeClusterId);
  const nodes = useMemo(() => result?.nodes ?? [], [result]);
  // 백그라운드 집계 중이고 아직 보여줄 데이터가 없으면 진행률 화면을 띄운다.
  const computing = result?.status === 'computing' && nodes.length === 0;

  const activeClusterName = useMemo(
    () => clusters.find((c) => c.id === activeClusterId)?.name || '-',
    [clusters, activeClusterId],
  );

  const totals = useMemo(() => {
    const totalImages = nodes.reduce((acc, n) => acc + n.imageCount, 0);
    const totalSize = nodes.reduce((acc, n) => acc + n.totalSizeBytes, 0);
    // 고유 이미지 수 (전체 클러스터 기준 — primary name 으로 dedup)
    const uniq = new Set<string>();
    for (const n of nodes) {
      for (const img of n.images) {
        const tagged = img.names.find((nm) => !nm.includes('@sha256:'));
        uniq.add(tagged ?? img.names[0] ?? '');
      }
    }
    return { totalImages, totalSize, uniqueImages: uniq.size };
  }, [nodes]);

  const isLoading = clustersLoading || nodesLoading;
  const contentRef = useRef<HTMLDivElement>(null);
  const safeName = (activeClusterName || 'cluster').replace(/[^\w.-]+/g, '-');

  return (
    <div className="min-h-screen bg-background">
      <main className="pr-3 py-3 flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={activeClusterId || null}
          onSelect={(id) => setSelectedClusterId(id ?? '')}
          iconOnly
        />
        <div ref={contentRef} className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <Boxes className="w-5 h-5 text-primary" />
              <h1 className="text-xl font-semibold">K8S 노드 이미지</h1>
              {activeClusterName !== '-' && (
                <span className="text-sm text-muted-foreground">
                  — <span className="font-medium text-foreground">{activeClusterName}</span>
                </span>
              )}
            </div>
          </div>

          {/* 통계 요약 카드 — image_count 가 안 보이던 문제 해결 + 한눈에 파악 */}
          {!isLoading && nodes.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <SummaryTile label="노드" value={nodes.length.toLocaleString()} unit="개" />
              <SummaryTile label="총 이미지 슬롯" value={totals.totalImages.toLocaleString()} unit="개"
                tip="모든 노드의 이미지 수 합 — 같은 이미지가 N개 노드에 있으면 N으로 카운트" />
              <SummaryTile label="고유 이미지" value={totals.uniqueImages.toLocaleString()} unit="개"
                tip="primary name 기준 dedup" />
              <SummaryTile label="총 용량" value={formatTotalSize(totals.totalSize)} unit="" />
            </div>
          )}

          {/* 검색 + 탭 */}
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <div className="relative flex-1 max-w-md min-w-[240px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="노드명 또는 이미지명 검색..."
                className="w-full pl-9 pr-3 py-2 bg-card border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>

            <div className="flex bg-card border border-border rounded-lg p-0.5">
              {TABS.map((t) => {
                const Icon = t.icon;
                const active = view === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setView(t.id)}
                    title={t.tip}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                      active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {t.label}
                  </button>
                );
              })}
            </div>

            <div className="ml-auto flex items-center gap-2" data-export-ignore>
              <NodeImagesCsvExportMenu clusterId={activeClusterId} disabled={isLoading || nodes.length === 0} />
              <ExportMenu targetRef={contentRef} filenameBase={`node-images-${safeName}`} disabled={isLoading || nodes.length === 0} />
            </div>
          </div>

          {isLoading ? (
            <div className="bg-card border border-border rounded-xl p-8 text-center text-muted-foreground">
              {clustersLoading ? 'Loading clusters...' : 'Loading node images...'}
            </div>
          ) : computing ? (
            <SnapshotProgressCard
              processed={result?.processed ?? 0}
              total={result?.total ?? null}
              progress={result?.progress ?? null}
              label="노드 이미지 수집 중"
              unit="노드"
            />
          ) : !activeClusterId ? (
            <div className="bg-card border border-border rounded-xl p-8 text-center text-muted-foreground">
              클러스터를 선택하세요.
            </div>
          ) : nodesError ? (
            <div className="bg-card border border-red-500/30 rounded-xl p-8">
              <div className="flex flex-col items-center gap-3 text-center">
                <AlertTriangle className="w-8 h-8 text-red-400" />
                <div>
                  <p className="font-medium text-red-400 mb-1">노드 이미지 정보를 불러올 수 없습니다</p>
                  <p className="text-sm text-muted-foreground max-w-lg">
                    {extractErrorMessage(nodesErrorDetail)}
                  </p>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  클러스터의 kubeconfig 경로와 API Endpoint 설정을 확인하세요.
                </p>
              </div>
            </div>
          ) : view === 'node-table' ? (
            <NodeImagesTable nodes={nodes} searchQuery={searchQuery} />
          ) : view === 'label-group' ? (
            <NodeLabelGroupView nodes={nodes} searchQuery={searchQuery} />
          ) : (
            <ImageCentricView nodes={nodes} searchQuery={searchQuery} />
          )}
        </div>
      </main>
    </div>
  );
}

function SummaryTile({ label, value, unit, tip }: { label: string; value: string; unit: string; tip?: string }) {
  return (
    <div
      className="bg-card border border-border rounded-lg px-3 py-2.5"
      title={tip}
    >
      <p className="text-xs uppercase tracking-wider text-muted-foreground/80">{label}</p>
      <p className="mt-0.5 flex items-baseline gap-1">
        <span className="text-lg font-bold tabular-nums text-foreground">{value}</span>
        {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
      </p>
    </div>
  );
}

function formatTotalSize(n: number): string {
  if (!n || n <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
