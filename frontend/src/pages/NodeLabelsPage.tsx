import { useMemo, useRef, useState } from 'react';
import { Tags, Search, LayoutList, Tag, AlertTriangle, FileSpreadsheet, RefreshCw, Pause, Play } from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useClustersNodes, usePatchNodeLabels, NodeRow } from '@/hooks/useNodeLabels';
import { NodeLabelEditorModal, NodeLabelsTable, type NodeEditAccess, type NodeLabelPatch } from '@/components/node-labels';
import { matchesSearch, buildLabelEntries, filterLabelEntries } from '@/components/node-labels/nodeLabelsShared';
import { ClusterSidebar, ExportMenu, EmptyState, ErrorState, LoadingState, PageShell, RunLogPanel, useToast } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { CLUSTER_OPERATE_REQUIRED_HINT, useCanOperate, useMyClusterAccess } from '@/hooks/useCanOperate';
import { useRunLog, runLogged, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { buildCsv, downloadCsv } from '@/lib/csv';
import { formatApiError } from '@/lib/utils';

export function NodeLabelsPage() {
  const {
    data: clusters = [],
    isLoading: clustersLoading,
    isError: clustersError,
    error: clustersErrorObj,
    refetch: refetchClusters,
  } = useClusters();
  const toast = useToast();

  // undefined = 아직 미선택(→ 첫 클러스터로 폴백, 기본은 "클러스터별" 단일 뷰).
  // null = 사용자가 명시적으로 "전체 클러스터" 선택. string = 특정 cluster.id.
  const [selectedClusterId, setSelectedClusterId] = useState<string | null | undefined>(undefined);
  const [selectedNode, setSelectedNode] = useState<NodeRow | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'node' | 'label'>('node');
  const [autoRefresh, setAutoRefresh] = useState(true);

  // 실제 선택 — 미선택(undefined)이면 첫 클러스터로 폴백(기본 단일 뷰). null 이면 전체.
  const effectiveSelection: string | null =
    selectedClusterId === undefined ? (clusters[0]?.id ?? null) : selectedClusterId;

  // 취합 대상 클러스터 — 전체(null)면 모든 클러스터, 아니면 선택된 하나. (useQueries 안정화를 위해 memo)
  const targetClusters = useMemo(
    () =>
      (effectiveSelection ? clusters.filter((c) => c.id === effectiveSelection) : clusters).map((c) => ({
        id: c.id,
        name: c.name,
      })),
    [clusters, effectiveSelection],
  );

  const { nodes, isLoading: nodesLoading, isFetching, isError, errors, refetch } = useClustersNodes(
    targetClusters,
    { autoRefresh },
  );
  const patchNodeLabels = usePatchNodeLabels();

  // 권한(§12.9) — 역할은 공통, 테넌트 바인딩은 노드 행의 클러스터마다 다르므로 행 단위로 판정한다.
  const roleAccess = useCanOperate();
  const clusterAccess = useMyClusterAccess(roleAccess.canOperate && roleAccess.role !== 'admin');
  const canEdit: NodeEditAccess = (node) => {
    if (!roleAccess.canOperate) return { ok: false, hint: roleAccess.hint };
    const level = clusterAccess.data?.[node.clusterId];
    if (level !== undefined && level !== 'operate') return { ok: false, hint: CLUSTER_OPERATE_REQUIRED_HINT };
    return { ok: true };
  };
  const editAccess = selectedNode ? canEdit(selectedNode) : { ok: true };

  // 라벨 적용(K8s 쓰기) 실행 로그 — §12.9.1. 펼침 여부는 사용자가 "로그 보기" 로 정한다.
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('node-labels');

  const applyLabels = async (node: NodeRow, payload: NodeLabelPatch): Promise<boolean> => {
    const changes: RunLogEntry[] = [
      ...Object.entries(payload.add).map(([k, v]): RunLogEntry => ['info', `+ ${v ? `${k}=${v}` : k}`]),
      ...payload.remove.map((k): RunLogEntry => ['info', `- ${k}`]),
    ];
    const res = await runLogged(runLog, {
      title: '노드 라벨 변경',
      first: `${node.clusterName} / ${node.name} — 추가 ${Object.keys(payload.add).length} · 삭제 ${payload.remove.length}`,
      fn: async (run) => {
        for (const [level, msg] of changes) run.log(level, msg);
        const { data } = await patchNodeLabels.mutateAsync({
          clusterId: node.clusterId,
          nodeName: node.name,
          payload,
        });
        return data as { data?: { labels?: Record<string, string> } };
      },
      summarize: (data) => {
        const labels = data?.data?.labels ?? {};
        const missing = Object.keys(payload.add).filter((k) => !(k in labels));
        const left = payload.remove.filter((k) => k in labels);
        const out: RunLogEntry[] = [['info', `적용 완료 · 최종 라벨 ${Object.keys(labels).length}개`]];
        if (missing.length) out.push(['warn', `응답에 없는 추가 키: ${missing.join(', ')}`]);
        if (left.length) out.push(['warn', `응답에 남은 삭제 키: ${left.join(', ')}`]);
        return out;
      },
    });
    if (res.ok) {
      toast.success('노드 라벨 변경됨', `${node.name} — 추가 ${Object.keys(payload.add).length} · 삭제 ${payload.remove.length}`);
      return true;
    }
    if (!res.aborted) toast.error('노드 라벨 변경 실패', formatApiError(res.error));
    return false;
  };

  const showCluster = targetClusters.length > 1;

  const headerLabel = useMemo(() => {
    if (effectiveSelection) return clusters.find((c) => c.id === effectiveSelection)?.name || '—';
    return `전체 클러스터 (${clusters.length})`;
  }, [clusters, effectiveSelection]);

  const isLoading = clustersLoading || nodesLoading;
  const contentRef = useRef<HTMLDivElement>(null);
  const safeName = (headerLabel || 'cluster').replace(/[^\w.-]+/g, '-');

  // 현재 뷰/검색 결과를 CSV(엑셀)로 추출 — 화면에 보이는 행과 동일.
  const handleExportCsv = () => {
    const safeCluster = (headerLabel || 'cluster').replace(/[^\w.-]+/g, '-');
    const today = new Date().toISOString().slice(0, 10);
    let headers: string[];
    let rows: (string | number)[][];
    if (viewMode === 'label') {
      headers = ['Label', 'Key', 'Value', 'NodeCount', 'Nodes'];
      rows = filterLabelEntries(buildLabelEntries(nodes), searchQuery).map((e) => [
        e.tag, e.key, e.value, e.nodes.length,
        e.nodes.map((n) => (showCluster ? `${n.clusterName}/${n.name}` : n.name)).join('; '),
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
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" className="flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={effectiveSelection}
          onSelect={(id) => setSelectedClusterId(id)}
          allowAll
          allLabel="전체 클러스터"
          iconOnly
        />
        <div ref={contentRef} className="flex-1 min-w-0">
        {/* Header */}
        <PageHeader
          className="mb-6"
          icon={Tags}
          title="K8s 노드 라벨"
          titleExtra={
            <span className="text-sm text-muted-foreground">
              — <span className="font-medium text-foreground">{headerLabel}</span>
            </span>
          }
        />

        {/* Toolbar: search + view mode */}
        <div className="flex items-center gap-3 mb-4">
          {/* Search box */}
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="클러스터 / 노드명 / 라벨 키·값 검색…"
              aria-label="클러스터·노드명·라벨 키·값 검색"
              className="w-full pl-9 pr-3 py-2 bg-card border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          {/* View mode toggle */}
          <div className="flex items-center gap-1 bg-secondary rounded-lg p-1">
            <button
              type="button"
              onClick={() => setViewMode('node')}
              aria-pressed={viewMode === 'node'}
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
              type="button"
              onClick={() => setViewMode('label')}
              aria-pressed={viewMode === 'label'}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewMode === 'label'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Tag className="w-3.5 h-3.5" />
              라벨 기준
            </button>
          </div>

          {/* Node count */}
          {nodes.length > 0 && (
            <span className="text-sm text-muted-foreground">
              {nodes.length}개 노드
            </span>
          )}

          {/* 우측 컨트롤 — 내보내기 + CSV + 새로고침(수동/자동) */}
          <div className="ml-auto flex items-center gap-1.5" data-export-ignore>
            <ExportMenu targetRef={contentRef} filenameBase={`node-labels-${safeName}`} disabled={isLoading || nodes.length === 0} />
            {/* CSV(엑셀) 내보내기 — 현재 뷰/검색 결과 */}
            <button
              onClick={handleExportCsv}
              disabled={isLoading || nodes.length === 0}
              title="현재 화면 결과를 CSV(엑셀)로 추출"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              CSV 내보내기
            </button>
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
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-status-warning/30 bg-status-warning/5 px-3 py-2 text-sm text-status-warning">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>
              {errors.length}개 클러스터 노드 조회 실패 (kubeconfig/엔드포인트 확인):{' '}
              {errors.map((e) => e.cluster?.name).filter(Boolean).join(', ')}
            </span>
          </div>
        )}

        {/* 라벨 적용 실행 로그 */}
        <div className="mb-3 empty:hidden">
          <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
        </div>

        {/* Table — 분기 순서: 로딩 → 클러스터 목록 실패 → 클러스터 없음 → 노드 조회 실패 → 표 */}
        {isLoading ? (
          <LoadingState />
        ) : clustersError ? (
          <ErrorState error={clustersErrorObj} title="클러스터 목록을 불러오지 못했습니다" onRetry={() => { void refetchClusters(); }} />
        ) : clusters.length === 0 ? (
          <EmptyState title="등록된 클러스터가 없습니다." description="클러스터 관리에서 클러스터를 등록하면 노드 라벨을 조회할 수 있습니다." />
        ) : isError ? (
          <ErrorState
            error={errors[0]?.error}
            title="노드 정보를 불러오지 못했습니다 — 클러스터의 kubeconfig·API 엔드포인트를 확인하세요"
            onRetry={refetch}
          />
        ) : (
          <NodeLabelsTable
            nodes={nodes}
            onEdit={setSelectedNode}
            canEdit={canEdit}
            searchQuery={searchQuery}
            viewMode={viewMode}
            showCluster={showCluster}
          />
        )}
        </div>
      </PageShell>

      <NodeLabelEditorModal
        node={selectedNode}
        isOpen={!!selectedNode}
        onClose={() => setSelectedNode(null)}
        canApply={editAccess.ok}
        applyHint={editAccess.hint}
        onApply={(payload) => (selectedNode ? applyLabels(selectedNode, payload) : Promise.resolve(false))}
      />
    </div>
  );
}
