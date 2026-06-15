import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Workflow, RefreshCw, Box, Boxes, Activity, Pencil, Eye, Loader2,
  Server, Info, AlertTriangle, Layers, Grid3x3,
} from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { analyzeApi } from '@/services/api';
import { ClusterSidebar, DebugLogPanel, NamespaceSingleSelect, useToast } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import {
  TopologyCanvas, Topology3D, NodeDetailPanel, ManualLinkDialog, AddExternalNodeDialog,
  EDGE_TYPE_LABEL,
} from '@/components/topology';
import {
  useServiceTopologyGraph, useServiceTopologyTraffic,
  useCreateTopologyLink, useDeleteTopologyLink, useCreateExternalNode, useDeleteExternalNode,
} from '@/hooks/useServiceTopology';
import type { TopoNode } from '@/types';
import { formatApiError } from '@/lib/utils';

type ViewMode = '2d' | '3d';

export function ServiceTopologyPage() {
  const toast = useToast();
  const { data: clusters = [] } = useClusters();
  const [clusterId, setClusterId] = useState<string>('');
  const [namespace, setNamespace] = useState<string>('default');

  // toggles
  const [view, setView] = useState<ViewMode>('2d');
  const [includePods, setIncludePods] = useState(false);
  const [includeOrphans, setIncludeOrphans] = useState(false);
  const [showTraffic, setShowTraffic] = useState(false);
  const [editMode, setEditMode] = useState(false);

  // selection / edit state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [linkSourceId, setLinkSourceId] = useState<string | null>(null);
  const [linkTargetId, setLinkTargetId] = useState<string | null>(null);
  const [extOpen, setExtOpen] = useState(false);

  const canvasRef = useRef<HTMLDivElement>(null);
  const [dim, setDim] = useState({ w: 800, h: 600 });

  useEffect(() => {
    if (!clusterId && clusters.length > 0) setClusterId(clusters[0].id);
  }, [clusters, clusterId]);

  useEffect(() => {
    const ro = new ResizeObserver(() => {
      if (canvasRef.current) setDim({ w: canvasRef.current.clientWidth, h: canvasRef.current.clientHeight });
    });
    if (canvasRef.current) ro.observe(canvasRef.current);
    return () => ro.disconnect();
  }, []);

  // namespaces
  const nsQuery = useQuery({
    queryKey: ['topoNamespaces', clusterId],
    queryFn: async () => (await analyzeApi.listNamespaces(clusterId)).data,
    enabled: !!clusterId,
    staleTime: 1000 * 60,
  });
  const namespaces = useMemo(() => (nsQuery.data?.namespaces ?? []).map((n) => n.name), [nsQuery.data]);
  useEffect(() => {
    if (namespaces.length && !namespaces.includes(namespace)) {
      setNamespace(namespaces.includes('default') ? 'default' : namespaces[0]);
    }
  }, [namespaces]); // eslint-disable-line react-hooks/exhaustive-deps

  const graphQuery = useServiceTopologyGraph(clusterId || null, namespace, { includePods, includeOrphans, withMetrics: true });
  const trafficQuery = useServiceTopologyTraffic(clusterId || null, namespace, showTraffic);

  const graph = graphQuery.data;
  const nodeById = useMemo(() => {
    const m = new Map<string, TopoNode>();
    for (const n of graph?.nodes ?? []) m.set(n.id, n);
    return m;
  }, [graph]);
  const nodeName = (id: string) => {
    const n = nodeById.get(id);
    return n ? n.name : id;
  };

  // mutations
  const createLink = useCreateTopologyLink(clusterId);
  const deleteLink = useDeleteTopologyLink();
  const createExt = useCreateExternalNode(clusterId);
  const deleteExt = useDeleteExternalNode();

  const handleSelect = (id: string | null) => {
    if (!editMode) { setSelectedId(id); return; }
    if (id == null) return;
    if (!linkSourceId) { setLinkSourceId(id); return; }
    if (id === linkSourceId) { setLinkSourceId(null); return; }
    setLinkTargetId(id);
  };

  const parseKindName = (n: TopoNode): { kind: string; name: string } => ({
    kind: n.kind === 'External' ? 'External' : n.kind,
    name: n.name,
  });

  const submitLink = (data: { linkType: string; label?: string; note?: string }) => {
    const s = linkSourceId && nodeById.get(linkSourceId);
    const t = linkTargetId && nodeById.get(linkTargetId);
    if (!s || !t) return;
    const sk = parseKindName(s); const tk = parseKindName(t);
    createLink.mutate(
      { namespace, sourceKind: sk.kind, sourceName: sk.name, targetKind: tk.kind, targetName: tk.name, ...data },
      {
        onSuccess: () => { toast.success('수동 연계 추가됨'); setLinkSourceId(null); setLinkTargetId(null); },
        onError: (e) => toast.error('연계 추가 실패', formatApiError(e)),
      },
    );
  };

  const handleDeleteLink = (manualId: string) => {
    deleteLink.mutate(manualId, {
      onSuccess: () => toast.success('연계 삭제됨'),
      onError: (e) => toast.error('삭제 실패', formatApiError(e)),
    });
  };

  const handleDeleteExternal = (node: TopoNode) => {
    if (!node.externalId) return;
    deleteExt.mutate(node.externalId, {
      onSuccess: () => { toast.success('외부 노드 삭제됨'); setSelectedId(null); },
      onError: (e) => toast.error('삭제 실패', formatApiError(e)),
    });
  };

  const submitExternal = (data: { name: string; nodeType: string; note?: string }) => {
    createExt.mutate(
      { namespace, ...data },
      {
        onSuccess: () => { toast.success('외부 노드 추가됨'); setExtOpen(false); },
        onError: (e) => toast.error('추가 실패', formatApiError(e)),
      },
    );
  };

  const selectedNode = selectedId ? nodeById.get(selectedId) : null;
  const trafficEdges = trafficQuery.data?.status === 'ok' ? trafficQuery.data.edges : [];

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto px-4 py-3 flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={clusterId || null}
          onSelect={(id) => setClusterId(id ?? '')}
          iconOnly
        />

        <div className="flex-1 min-w-0">
          <DebugLogPanel pageKey="service-topology" extra={{ clusterId, namespace, view, nodes: graph?.nodes.length ?? 0 }} />

          {/* 헤더 */}
          <div className="flex items-center gap-3 mb-2">
            <Workflow className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">서비스 토폴로지</h1>
            <span className="text-sm text-muted-foreground">pod 통신 · 자원 연계 · 사용량/한계 가시화</span>
          </div>

          {/* 툴바 */}
          <MacCard title="컨트롤" className="mb-3" bodyPadding="p-3">
            <div className="flex flex-wrap items-center gap-2">
              {/* namespace */}
              <div className="flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-muted-foreground" />
                <div className="min-w-[180px]">
                  <NamespaceSingleSelect
                    clusterId={clusterId}
                    value={namespace}
                    onChange={(ns) => { setNamespace(ns); setSelectedId(null); }}
                    clearable={false}
                  />
                </div>
              </div>

              <button onClick={() => graphQuery.refetch()}
                className="px-2 py-1 text-sm bg-secondary hover:bg-secondary/80 border border-border rounded-lg inline-flex items-center gap-1">
                <RefreshCw className={`w-3 h-3 ${graphQuery.isFetching ? 'animate-spin' : ''}`} /> 새로고침
              </button>

              {/* 2D / 3D */}
              <div className="flex items-center rounded-lg border border-border overflow-hidden text-sm">
                <ToggleSeg active={view === '2d'} onClick={() => setView('2d')} icon={<Grid3x3 className="w-3 h-3" />} label="2D" />
                <ToggleSeg active={view === '3d'} onClick={() => setView('3d')} icon={<Boxes className="w-3 h-3" />} label="3D" border />
              </div>

              <PillToggle on={includePods} onClick={() => setIncludePods((v) => !v)} icon={<Box className="w-3 h-3" />} label="Pod 표시" />
              <PillToggle on={includeOrphans} onClick={() => setIncludeOrphans((v) => !v)} icon={<Boxes className="w-3 h-3" />} label="미참조 설정" />
              <PillToggle on={showTraffic} onClick={() => setShowTraffic((v) => !v)} icon={<Activity className="w-3 h-3" />} label="실트래픽"
                loading={showTraffic && trafficQuery.isFetching} />

              <div className="ml-auto flex items-center gap-2">
                <button onClick={() => setExtOpen(true)}
                  className="px-2 py-1 text-sm bg-secondary hover:bg-secondary/80 border border-border rounded-lg inline-flex items-center gap-1">
                  <Server className="w-3 h-3" /> 외부 노드
                </button>
                <button onClick={() => { setEditMode((v) => !v); setLinkSourceId(null); }}
                  className={`px-2.5 py-1 text-sm rounded-lg inline-flex items-center gap-1 border ${
                    editMode ? 'bg-orange-500/15 border-orange-500/40 text-orange-600 dark:text-orange-400' : 'bg-secondary border-border hover:bg-secondary/80'
                  }`}>
                  {editMode ? <Pencil className="w-3 h-3" /> : <Eye className="w-3 h-3" />} 링크 편집
                </button>
              </div>
            </div>

            {/* 상태/경고 라인 */}
            <div className="flex flex-wrap items-center gap-2 mt-2 text-xs">
              {graph?.metricsStatus === 'offline' && (
                <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <Info className="w-3 h-3" /> Prometheus 오프라인 — usage 미표시(requests/limits 만)
                </span>
              )}
              {graph?.truncated && (
                <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="w-3 h-3" /> 노드 수 상한 초과(truncated)
                </span>
              )}
              {showTraffic && trafficQuery.data && trafficQuery.data.status !== 'ok' && (
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <Activity className="w-3 h-3" /> 트래픽 {trafficQuery.data.status} — {trafficQuery.data.reason}
                </span>
              )}
              {showTraffic && trafficQuery.data?.status === 'ok' && (
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <Activity className="w-3 h-3" /> 트래픽 소스: {trafficQuery.data.source} · {trafficEdges.length} 엣지
                </span>
              )}
              {editMode && (
                <span className="inline-flex items-center gap-1 text-orange-600 dark:text-orange-400">
                  <Pencil className="w-3 h-3" /> {linkSourceId ? `시작 노드: ${nodeName(linkSourceId)} → 대상 노드를 클릭` : '연결할 시작 노드를 클릭'}
                </span>
              )}
              {(graph?.warnings.length ?? 0) > 0 && (
                <span className="inline-flex items-center gap-1 text-muted-foreground" title={graph!.warnings.join('\n')}>
                  <AlertTriangle className="w-3 h-3" /> 경고 {graph!.warnings.length}건
                </span>
              )}
            </div>
          </MacCard>

          {/* 캔버스 */}
          <MacCard title={`그래프 · ${graph?.nodes.length ?? 0} 노드 / ${graph?.edges.length ?? 0} 엣지`} bodyPadding="p-0">
            <div ref={canvasRef} className="relative w-full h-[calc(100vh-260px)] min-h-[420px] overflow-hidden rounded-b-2xl">
              {graphQuery.isLoading ? (
                <div className="absolute inset-0 flex items-center justify-center text-muted-foreground gap-2">
                  <Loader2 className="w-5 h-5 animate-spin" /> 토폴로지 수집 중…
                </div>
              ) : graphQuery.isError ? (
                <div className="absolute inset-0 flex items-center justify-center text-center px-6">
                  <div>
                    <AlertTriangle className="w-7 h-7 text-amber-500 mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground">{formatApiError(graphQuery.error)}</p>
                  </div>
                </div>
              ) : !graph || graph.nodes.length === 0 ? (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  이 네임스페이스에 표시할 리소스가 없습니다.
                </div>
              ) : view === '2d' ? (
                <TopologyCanvas
                  graph={graph}
                  trafficEdges={trafficEdges}
                  showTraffic={showTraffic}
                  selectedId={selectedId}
                  onSelectNode={handleSelect}
                  editMode={editMode}
                  linkSourceId={linkSourceId}
                />
              ) : (
                <Topology3D
                  graph={graph}
                  trafficEdges={trafficEdges}
                  showTraffic={showTraffic}
                  width={dim.w}
                  height={dim.h}
                  onSelectNode={handleSelect}
                />
              )}

              {/* 범례 */}
              <Legend />

              {/* 상세 패널 */}
              {selectedNode && !editMode && (
                <NodeDetailPanel
                  node={selectedNode}
                  edges={graph?.edges ?? []}
                  nodeName={nodeName}
                  onClose={() => setSelectedId(null)}
                  onDeleteLink={handleDeleteLink}
                  onDeleteExternal={handleDeleteExternal}
                />
              )}
            </div>
          </MacCard>
        </div>
      </main>

      {/* 다이얼로그 */}
      {linkTargetId && linkSourceId && nodeById.get(linkSourceId) && nodeById.get(linkTargetId) && (
        <ManualLinkDialog
          source={nodeById.get(linkSourceId)!}
          target={nodeById.get(linkTargetId)!}
          pending={createLink.isPending}
          onSubmit={submitLink}
          onClose={() => setLinkTargetId(null)}
        />
      )}
      {extOpen && (
        <AddExternalNodeDialog pending={createExt.isPending} onSubmit={submitExternal} onClose={() => setExtOpen(false)} />
      )}
    </div>
  );
}

function ToggleSeg({ active, onClick, icon, label, border }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string; border?: boolean;
}) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-1 px-2 py-1 transition-colors ${border ? 'border-l border-border' : ''} ${
        active ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground'
      }`}>
      {icon} {label}
    </button>
  );
}

function PillToggle({ on, onClick, icon, label, loading }: {
  on: boolean; onClick: () => void; icon: React.ReactNode; label: string; loading?: boolean;
}) {
  return (
    <button onClick={onClick}
      className={`px-2.5 py-1 text-sm rounded-lg inline-flex items-center gap-1 border transition-colors ${
        on ? 'bg-primary/10 border-primary/40 text-primary' : 'bg-secondary border-border text-muted-foreground hover:bg-secondary/80'
      }`}>
      {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : icon} {label}
    </button>
  );
}

function Legend() {
  const items: { type: string }[] = [
    { type: 'routes' }, { type: 'exposes' }, { type: 'uses_config' },
    { type: 'uses_secret' }, { type: 'mounts_pvc' }, { type: 'manual' }, { type: 'traffic' },
  ];
  return (
    <div className="absolute bottom-3 left-3 bg-card/90 backdrop-blur border border-border rounded-xl px-3 py-2 z-10 max-w-[60%]">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {items.map((it) => (
          <span key={it.type} className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <EdgeSwatch type={it.type} /> {EDGE_TYPE_LABEL[it.type]}
          </span>
        ))}
      </div>
    </div>
  );
}

function EdgeSwatch({ type }: { type: string }) {
  // topologyShared.edgeStyle 와 일관된 색
  const color: Record<string, string> = {
    routes: '#0ea5e9', exposes: '#8b5cf6', uses_config: '#6366f1',
    uses_secret: '#ec4899', mounts_pvc: '#06b6d4', manual: '#f97316', traffic: '#f59e0b',
  };
  return <span className="inline-block w-3 h-0.5 rounded-full" style={{ background: color[type] ?? '#94a3b8' }} />;
}
