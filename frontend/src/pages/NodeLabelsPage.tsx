import { useMemo, useState } from 'react';
import { Tags, Search, LayoutList, Tag, AlertTriangle, RefreshCw, Pause, Play } from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useClustersNodes, usePatchNodeLabels, NodeRow } from '@/hooks/useNodeLabels';
import { NodeLabelEditorModal, NodeLabelsTable } from '@/components/node-labels';
import { ClusterSidebar } from '@/components/common';
import { formatApiError } from '@/lib/utils';

function extractErrorMessage(error: unknown): string {
  return formatApiError(error, '알 수 없는 오류가 발생했습니다.');
}

export function NodeLabelsPage() {
  const { data: clusters = [], isLoading: clustersLoading } = useClusters();

  // null = 전체 클러스터 취합(기본). 특정 클러스터 선택 시 해당 cluster.id.
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<NodeRow | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'node' | 'label'>('node');
  const [autoRefresh, setAutoRefresh] = useState(true);

  // 취합 대상 클러스터 — 전체면 모든 클러스터, 아니면 선택된 하나. (useQueries 안정화를 위해 memo)
  const targetClusters = useMemo(
    () =>
      (selectedClusterId ? clusters.filter((c) => c.id === selectedClusterId) : clusters).map((c) => ({
        id: c.id,
        name: c.name,
      })),
    [clusters, selectedClusterId],
  );

  const { nodes, isLoading: nodesLoading, isFetching, isError, errors, refetch } = useClustersNodes(
    targetClusters,
    { autoRefresh },
  );
  const patchNodeLabels = usePatchNodeLabels();

  const showCluster = targetClusters.length > 1;

  const headerLabel = useMemo(() => {
    if (selectedClusterId) return clusters.find((c) => c.id === selectedClusterId)?.name || '-';
    return `전체 클러스터 (${clusters.length})`;
  }, [clusters, selectedClusterId]);

  const isLoading = clustersLoading || nodesLoading;

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto px-3 py-3 flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={selectedClusterId}
          onSelect={(id) => setSelectedClusterId(id)}
          allowAll
          allLabel="전체 클러스터"
          iconOnly
        />
        <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Tags className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-semibold">Node Labels</h1>
            <span className="text-sm text-muted-foreground">
              — <span className="font-medium text-foreground">{headerLabel}</span>
            </span>
          </div>
        </div>

        {/* Toolbar: search + view mode */}
        <div className="flex items-center gap-3 mb-4">
          {/* Search box */}
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="클러스터 / 노드명 / 레이블 키·값 검색..."
              className="w-full pl-9 pr-3 py-2 bg-card border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          {/* View mode toggle */}
          <div className="flex items-center gap-1 bg-secondary rounded-lg p-1">
            <button
              onClick={() => setViewMode('node')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewMode === 'node'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <LayoutList className="w-3.5 h-3.5" />
              노드 기준
            </button>
            <button
              onClick={() => setViewMode('label')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewMode === 'label'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Tag className="w-3.5 h-3.5" />
              레이블 기준
            </button>
          </div>

          {/* Node count */}
          {nodes.length > 0 && (
            <span className="text-sm text-muted-foreground">
              {nodes.length}개 노드
            </span>
          )}

          {/* 새로고침 제어 — 수동 새로고침 + 자동 on/off */}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              title="지금 새로고침"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
              새로고침
            </button>
            <button
              onClick={() => setAutoRefresh((v) => !v)}
              title={autoRefresh ? '자동 새로고침 끄기' : '자동 새로고침 켜기 (60초)'}
              aria-pressed={autoRefresh}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm rounded-lg border transition-colors ${
                autoRefresh
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-border bg-card text-muted-foreground hover:text-foreground'
              }`}
            >
              {autoRefresh ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              {autoRefresh ? '자동 60초' : '자동 꺼짐'}
            </button>
          </div>
        </div>

        {/* 일부 클러스터 조회 실패 시 — 나머지는 그대로 표시하되 경고 노출 */}
        {errors.length > 0 && nodes.length > 0 && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-500">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>
              {errors.length}개 클러스터 노드 조회 실패 (kubeconfig/엔드포인트 확인):{' '}
              {errors.map((e) => e.cluster?.name).filter(Boolean).join(', ')}
            </span>
          </div>
        )}

        {/* Table */}
        {isLoading ? (
          <div className="bg-card border border-border rounded-xl p-8 text-center text-muted-foreground">
            {clustersLoading ? 'Loading clusters...' : 'Loading nodes...'}
          </div>
        ) : clusters.length === 0 ? (
          <div className="bg-card border border-border rounded-xl p-8 text-center text-muted-foreground">
            등록된 클러스터가 없습니다.
          </div>
        ) : isError ? (
          <div className="bg-card border border-red-500/30 rounded-xl p-8">
            <div className="flex flex-col items-center gap-3 text-center">
              <AlertTriangle className="w-8 h-8 text-red-400" />
              <div>
                <p className="font-medium text-red-400 mb-1">노드 정보를 불러올 수 없습니다</p>
                <p className="text-sm text-muted-foreground max-w-lg">
                  {extractErrorMessage(errors[0]?.error)}
                </p>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                클러스터의 kubeconfig 경로와 API Endpoint 설정을 확인하세요.
              </p>
            </div>
          </div>
        ) : (
          <NodeLabelsTable
            nodes={nodes}
            onEdit={setSelectedNode}
            searchQuery={searchQuery}
            viewMode={viewMode}
            showCluster={showCluster}
          />
        )}
        </div>
      </main>

      <NodeLabelEditorModal
        node={selectedNode}
        isOpen={!!selectedNode}
        onClose={() => setSelectedNode(null)}
        onApply={(payload) => {
          if (!selectedNode) return;
          patchNodeLabels.mutate({
            clusterId: selectedNode.clusterId,
            nodeName: selectedNode.name,
            payload,
          });
        }}
      />
    </div>
  );
}
