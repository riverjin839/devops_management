import { useMemo, useRef, useState } from 'react';
import { Boxes, Search, LayoutList, LayoutGrid, Layers } from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useK8sHub } from '@/lib/k8sHub';
import { useNodeImageList } from '@/hooks/useNodeImages';
import { NodeImagesTable, NodeLabelGroupView, ImageCentricView, NodeImagesCsvExportMenu, ImageDistributeDialog } from '@/components/node-images';
import { ClusterSidebar, SnapshotProgressCard, ExportMenu, SelectClusterEmptyState, LoadingState, ErrorState, PageShell } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { StatTile, StatTileRow } from '@/components/common/StatTile';

type ViewMode = 'node-table' | 'label-group' | 'image-centric';

const TABS: { id: ViewMode; label: string; icon: typeof LayoutList; tip: string }[] = [
  { id: 'node-table',    label: '노드별 표',       icon: LayoutList,  tip: '노드 단위 표 — 펼치면 그 노드의 이미지 목록' },
  { id: 'label-group',   label: '라벨 그룹', icon: LayoutGrid,  tip: '노드를 라벨/role 기준으로 묶어 카드로 표시' },
  { id: 'image-centric', label: '이미지별',         icon: Layers,      tip: '이미지 기준 집계 — 어떤 이미지가 어느 노드에 적재됐는지' },
];

export function NodeImagesPage() {
  const {
    data: clusters = [],
    isLoading: clustersLoading,
    isError: clustersError,
    error: clustersErrorObj,
    refetch: refetchClusters,
  } = useClusters();

  const [selectedClusterId, setSelectedClusterId] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [view, setView] = useState<ViewMode>('node-table');
  // 이미지 배포 다이얼로그 — 선택한 이미지를 배포되지 않은 다른 노드로 prepull
  const [distributeImage, setDistributeImage] = useState<string | null>(null);

  // K8s 클러스터 허브(D-240) 안에서는 허브가 고른 클러스터가 우선.
  const hub = useK8sHub();
  const activeClusterId = hub ? hub.clusterId : (selectedClusterId || clusters[0]?.id || '');
  const {
    data: result,
    isLoading: nodesLoading,
    isError: nodesError,
    error: nodesErrorDetail,
    refetch: refetchNodes,
  } = useNodeImageList(activeClusterId);
  const nodes = useMemo(() => result?.nodes ?? [], [result]);
  // 백그라운드 집계 중이고 아직 보여줄 데이터가 없으면 진행률 화면을 띄운다.
  const computing = result?.status === 'computing' && nodes.length === 0;

  const activeClusterName = useMemo(
    () => clusters.find((c) => c.id === activeClusterId)?.name || '—',
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
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" className="flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={activeClusterId || null}
          onSelect={(id) => setSelectedClusterId(id ?? '')}
          iconOnly
        />
        <div ref={contentRef} className="flex-1 min-w-0">
          <PageHeader
            className="mb-6"
            icon={Boxes}
            title="K8s 노드 이미지"
            titleExtra={activeClusterId ? (
              <span className="text-sm text-muted-foreground">
                — <span className="font-medium text-foreground">{activeClusterName}</span>
              </span>
            ) : undefined}
          />

          {/* 통계 요약 카드 — image_count 가 안 보이던 문제 해결 + 한눈에 파악 */}
          {!isLoading && nodes.length > 0 && (
            <StatTileRow className="mb-4">
              <StatTile label="노드" value={nodes.length.toLocaleString()} hint="개" />
              <div title="모든 노드의 이미지 수 합 — 같은 이미지가 N개 노드에 있으면 N으로 카운트" className="min-w-0">
                <StatTile label="총 이미지 슬롯" value={totals.totalImages.toLocaleString()} hint="개" />
              </div>
              <div title="대표 이미지 이름 기준으로 중복 제거" className="min-w-0">
                <StatTile label="고유 이미지" value={totals.uniqueImages.toLocaleString()} hint="개" />
              </div>
              <StatTile label="총 용량" value={formatTotalSize(totals.totalSize)} />
            </StatTileRow>
          )}

          {/* 검색 + 탭 */}
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <div className="relative flex-1 max-w-md min-w-[240px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="노드명 또는 이미지명 검색…"
                aria-label="노드명·이미지명 검색"
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
                    aria-pressed={active}
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
            <LoadingState />
          ) : clustersError ? (
            <ErrorState error={clustersErrorObj} title="클러스터 목록을 불러오지 못했습니다" onRetry={() => { void refetchClusters(); }} />
          ) : computing ? (
            <SnapshotProgressCard
              processed={result?.processed ?? 0}
              total={result?.total ?? null}
              progress={result?.progress ?? null}
              label="노드 이미지 수집 중"
              unit="노드"
            />
          ) : !activeClusterId ? (
            <SelectClusterEmptyState />
          ) : nodesError ? (
            <ErrorState
              error={nodesErrorDetail}
              title="노드 이미지 정보를 불러오지 못했습니다 — 클러스터의 kubeconfig·API 엔드포인트를 확인하세요"
              onRetry={() => { void refetchNodes(); }}
            />
          ) : view === 'node-table' ? (
            <NodeImagesTable nodes={nodes} searchQuery={searchQuery} onDistribute={setDistributeImage} />
          ) : view === 'label-group' ? (
            <NodeLabelGroupView nodes={nodes} searchQuery={searchQuery} />
          ) : (
            <ImageCentricView nodes={nodes} searchQuery={searchQuery} onDistribute={setDistributeImage} />
          )}
        </div>
      </PageShell>

      {distributeImage && activeClusterId && (
        <ImageDistributeDialog
          open={!!distributeImage}
          onClose={() => setDistributeImage(null)}
          image={distributeImage}
          sourceClusterId={activeClusterId}
          clusters={clusters.map((c) => ({ id: c.id, name: c.name }))}
        />
      )}
    </div>
  );
}

function formatTotalSize(n: number): string {
  if (!n || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
