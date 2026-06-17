import { useMemo, useState } from 'react';
import { Tags, Search, LayoutList, Tag, AlertTriangle, FileSpreadsheet } from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useNodeList, usePatchNodeLabels, NodeInfo } from '@/hooks/useNodeLabels';
import { NodeLabelEditorModal, NodeLabelsTable } from '@/components/node-labels';
import { matchesSearch, buildLabelEntries, filterLabelEntries } from '@/components/node-labels/nodeLabelsShared';
import { ClusterSidebar } from '@/components/common';
import { buildCsv, downloadCsv } from '@/lib/csv';
import { formatApiError } from '@/lib/utils';

function extractErrorMessage(error: unknown): string {
  return formatApiError(error, '알 수 없는 오류가 발생했습니다.');
}

export function NodeLabelsPage() {
  // useClusters() 반환값을 직접 사용 — 스토어 타이밍 이슈 방지
  const { data: clusters = [], isLoading: clustersLoading } = useClusters();

  const [selectedClusterId, setSelectedClusterId] = useState<string>('');
  const [selectedNode, setSelectedNode] = useState<NodeInfo | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'node' | 'label'>('node');

  const activeClusterId = selectedClusterId || clusters[0]?.id || '';
  const {
    data: nodes = [],
    isLoading: nodesLoading,
    isError: nodesError,
    error: nodesErrorDetail,
  } = useNodeList(activeClusterId);
  const patchNodeLabels = usePatchNodeLabels(activeClusterId);

  const activeClusterName = useMemo(
    () => clusters.find((c) => c.id === activeClusterId)?.name || '-',
    [clusters, activeClusterId],
  );

  const isLoading = clustersLoading || nodesLoading;

  // 현재 뷰/검색 결과를 CSV(엑셀)로 추출 — 화면에 보이는 행과 동일.
  const handleExportCsv = () => {
    const safeCluster = (activeClusterName || 'cluster').replace(/[^\w.-]+/g, '-');
    const today = new Date().toISOString().slice(0, 10);
    let headers: string[];
    let rows: (string | number)[][];
    if (viewMode === 'label') {
      headers = ['Label', 'Key', 'Value', 'NodeCount', 'Nodes'];
      rows = filterLabelEntries(buildLabelEntries(nodes), searchQuery).map((e) => [
        e.tag, e.key, e.value, e.nodes.length, e.nodes.join('; '),
      ]);
    } else {
      headers = ['Node', 'Role', 'Status', 'Labels'];
      rows = nodes.filter((n) => matchesSearch(n, searchQuery)).map((n) => [
        n.name, n.role, n.status,
        Object.entries(n.labels).map(([k, v]) => (v ? `${k}=${v}` : k)).join('; '),
      ]);
    }
    if (rows.length === 0) return;
    downloadCsv(`node-labels-${safeCluster}-${viewMode}-${today}.csv`, buildCsv(headers, rows));
  };

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto px-3 py-3 flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={activeClusterId || null}
          onSelect={(id) => setSelectedClusterId(id ?? '')}
          iconOnly
        />
        <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Tags className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-semibold">K8S 노드 라벨</h1>
            {activeClusterName !== '-' && (
              <span className="text-sm text-muted-foreground">
                — <span className="font-medium text-foreground">{activeClusterName}</span>
              </span>
            )}
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
              placeholder="노드명 또는 레이블 키/값 검색..."
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

          {/* Node / match count */}
          {!isLoading && nodes.length > 0 && (
            <span className="text-sm text-muted-foreground">
              {nodes.length}개 노드
            </span>
          )}

          {/* CSV(엑셀) 내보내기 — 현재 뷰/검색 결과 */}
          <button
            onClick={handleExportCsv}
            disabled={isLoading || nodes.length === 0}
            title="현재 화면 결과를 CSV(엑셀)로 추출"
            className="ml-auto flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg text-foreground transition-colors disabled:opacity-50"
          >
            <FileSpreadsheet className="w-4 h-4" />
            CSV 내보내기
          </button>
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="bg-card border border-border rounded-xl p-8 text-center text-muted-foreground">
            {clustersLoading ? 'Loading clusters...' : 'Loading nodes...'}
          </div>
        ) : !activeClusterId ? (
          <div className="bg-card border border-border rounded-xl p-8 text-center text-muted-foreground">
            클러스터를 선택하세요.
          </div>
        ) : nodesError ? (
          <div className="bg-card border border-red-500/30 rounded-xl p-8">
            <div className="flex flex-col items-center gap-3 text-center">
              <AlertTriangle className="w-8 h-8 text-red-400" />
              <div>
                <p className="font-medium text-red-400 mb-1">노드 정보를 불러올 수 없습니다</p>
                <p className="text-sm text-muted-foreground max-w-lg">
                  {extractErrorMessage(nodesErrorDetail)}
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
          patchNodeLabels.mutate({ nodeName: selectedNode.name, payload });
        }}
      />
    </div>
  );
}
