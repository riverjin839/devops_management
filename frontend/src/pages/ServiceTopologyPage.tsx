import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Workflow, RefreshCw, Box, Boxes, Activity, Pencil, Eye, Loader2,
  Server, Info, AlertTriangle, Layers, Grid3x3, Globe,
} from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useCanOperate } from '@/hooks/useCanOperate';
import { analyzeApi } from '@/services/api';
import {
  ClusterSidebar, ConfirmDialog, DebugLogPanel, NamespaceSingleSelect, RunLogPanel, SnapshotProgressCard, useToast,
} from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import {
  TopologyCanvas, Topology3D, NodeDetailPanel, ManualLinkDialog, AddExternalNodeDialog,
  EDGE_TYPE_LABEL,
} from '@/components/topology';
import {
  useServiceTopologyGraph, useServiceTopologyTraffic, useClusterTopologyGraph,
  useCreateTopologyLink, useDeleteTopologyLink, useCreateExternalNode, useDeleteExternalNode,
} from '@/hooks/useServiceTopology';
import type { TopoNode } from '@/types';
import { formatApiError, parseUTC } from '@/lib/utils';
import { useRunLog } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';

type ViewMode = '2d' | '3d';
type Scope = 'namespace' | 'cluster';
type ClusterMode = 'summary' | 'detail';

export function ServiceTopologyPage() {
  const toast = useToast();
  const { data: clusters = [] } = useClusters();
  const [clusterId, setClusterId] = useState<string>('');
  const [namespace, setNamespace] = useState<string>('default');

  // toggles
  const [view, setView] = useState<ViewMode>('2d');
  const [scope, setScope] = useState<Scope>('namespace');
  const [clusterMode, setClusterMode] = useState<ClusterMode>('summary');
  const [includePods, setIncludePods] = useState(false);
  const [includeOrphans, setIncludeOrphans] = useState(false);
  const [showTraffic, setShowTraffic] = useState(false);
  const [editMode, setEditMode] = useState(false);

  // selection / edit state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [linkSourceId, setLinkSourceId] = useState<string | null>(null);
  const [linkTargetId, setLinkTargetId] = useState<string | null>(null);
  const [extOpen, setExtOpen] = useState(false);
  // D-091 — 삭제는 복구가 안 되므로 바로 mutate 하지 않고 확인을 받는다.
  const [pendingDelete, setPendingDelete] = useState<
    { kind: 'link'; manualId: string; label: string } | { kind: 'external'; node: TopoNode } | null
  >(null);

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

  const isCluster = scope === 'cluster';
  const graphQuery = useServiceTopologyGraph(
    isCluster ? null : (clusterId || null), namespace, { includePods, includeOrphans, withMetrics: true },
  );
  const clusterQuery = useClusterTopologyGraph(
    isCluster ? (clusterId || null) : null, { mode: clusterMode, includePods, withMetrics: false },
  );
  const trafficQuery = useServiceTopologyTraffic(clusterId || null, namespace, showTraffic && !isCluster);

  // D-089 — 실트래픽 수집(켜기·새로고침)마다 요청·결과·엣지 상위 목록을 로그로 남긴다. 펼침은 "로그 보기".
  const trafficLog = useRunLog();
  const { begin: tBegin, log: tLog, end: tEnd } = trafficLog;
  const [showTrafficLog, setShowTrafficLog] = useLogPref('service-topology');
  const trafficFetching = showTraffic && !isCluster && trafficQuery.isFetching;
  const prevTrafficFetching = useRef(false);
  const trafficT0 = useRef(0);
  useEffect(() => {
    const was = prevTrafficFetching.current;
    prevTrafficFetching.current = trafficFetching;
    if (trafficFetching && !was) {
      trafficT0.current = performance.now();
      tBegin('실트래픽 수집', `${namespace} 네임스페이스 flow 수집 요청 (Hubble → conntrack 폴백)`);
      return;
    }
    if (!trafficFetching && was) {
      const ms = Math.round(performance.now() - trafficT0.current);
      if (trafficQuery.isError) {
        tLog('error', `수집 실패 · ${ms}ms — ${formatApiError(trafficQuery.error)}`);
      } else if (trafficQuery.data) {
        const d = trafficQuery.data;
        if (d.status === 'ok') {
          const dropped = d.edges.filter((e) => e.droppedCount > 0).length;
          tLog(dropped ? 'warn' : 'info',
            `수집 완료 · ${ms}ms — 소스 ${d.source ?? '-'} · 엣지 ${d.edges.length}개${dropped ? ` · drop 발생 ${dropped}개` : ''}`);
          [...d.edges].sort((a, b) => b.flowCount - a.flowCount).slice(0, 10).forEach((e) => {
            tLog(e.droppedCount > 0 ? 'warn' : 'info',
              `  ${e.source} → ${e.target}: flow ${e.flowCount}${e.droppedCount > 0 ? ` · drop ${e.droppedCount}` : ''}`);
          });
          if (d.edges.length > 10) tLog('info', `  … 외 ${d.edges.length - 10}개`);
        } else {
          tLog(d.status === 'error' ? 'error' : 'warn', `수집 ${d.status} · ${ms}ms — ${d.reason ?? '사유 없음'}`);
        }
      }
      tEnd();
    }
  }, [trafficFetching, trafficQuery.isError, trafficQuery.error, trafficQuery.data, namespace, tBegin, tLog, tEnd]);

  const activeQuery = isCluster ? clusterQuery : graphQuery;
  const clusterData = clusterQuery.data;
  const computing = isCluster && clusterData?.status === 'computing';
  const graph = isCluster ? clusterQuery.data : graphQuery.data;
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
  const { canOperate, withHint } = useCanOperate(clusterId);
  const createLink = useCreateTopologyLink(clusterId);
  const deleteLink = useDeleteTopologyLink();
  const createExt = useCreateExternalNode(clusterId);
  const deleteExt = useDeleteExternalNode();

  // D-094 — 클러스터를 바꾸면 이전 클러스터의 선택·링크 편집 상태를 버린다(이전 id 가 안내에 남고 이전 NS 로 조회되던 문제).
  const selectCluster = (id: string) => {
    if (id === clusterId) return;
    setClusterId(id);
    setNamespace('default');
    setSelectedId(null);
    setLinkSourceId(null);
    setLinkTargetId(null);
    setEditMode(false);
    setPendingDelete(null);
    trafficLog.clear();
  };

  const refreshAll = () => {
    void activeQuery.refetch();
    // 실트래픽을 켜 둔 상태면 함께 다시 모은다 — 예전엔 그래프만 새로 받아 트래픽이 stale 로 남았다(D-094).
    if (showTraffic && !isCluster) void trafficQuery.refetch();
  };

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

  const requestDeleteLink = (manualId: string) => {
    const edge = graph?.edges.find((e) => e.manualId === manualId);
    const label = edge ? `${nodeName(edge.source)} → ${nodeName(edge.target)}` : '이 수동 연계';
    setPendingDelete({ kind: 'link', manualId, label });
  };

  const requestDeleteExternal = (node: TopoNode) => {
    if (!node.externalId) return;
    setPendingDelete({ kind: 'external', node });
  };

  const confirmDelete = () => {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    if (target.kind === 'link') {
      deleteLink.mutate(target.manualId, {
        onSuccess: () => toast.success('연계 삭제됨'),
        onError: (e) => toast.error('삭제 실패', formatApiError(e)),
      });
    } else if (target.node.externalId) {
      deleteExt.mutate(target.node.externalId, {
        onSuccess: () => { toast.success('외부 노드 삭제됨'); setSelectedId(null); },
        onError: (e) => toast.error('삭제 실패', formatApiError(e)),
      });
    }
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
    <div className="app-min-h-screen bg-background">
      <main className="pr-3 py-3 flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={clusterId || null}
          onSelect={(id) => selectCluster(id ?? '')}
          iconOnly
        />

        <div className="flex-1 min-w-0">
          <DebugLogPanel pageKey="service-topology" extra={{ clusterId, scope, namespace, clusterMode, view, nodes: graph?.nodes.length ?? 0 }} />

          {/* 헤더 */}
          <div className="flex items-center gap-3 mb-2">
            <Workflow className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">서비스 토폴로지</h1>
            <span className="text-sm text-muted-foreground">pod 통신 · 자원 연계 · 사용량/한계 가시화</span>
          </div>

          {/* 툴바 */}
          <MacCard title="컨트롤" className="mb-3" bodyPadding="p-3">
            <div className="flex flex-wrap items-center gap-2">
              {/* scope: 네임스페이스 / 전체 클러스터 */}
              <div className="flex items-center rounded-lg border border-border overflow-hidden text-sm">
                <ToggleSeg active={!isCluster} onClick={() => { setScope('namespace'); setSelectedId(null); setEditMode(false); }} icon={<Layers className="w-3 h-3" />} label="네임스페이스" />
                <ToggleSeg active={isCluster} onClick={() => { setScope('cluster'); setSelectedId(null); setEditMode(false); }} icon={<Globe className="w-3 h-3" />} label="전체 클러스터" border />
              </div>

              {/* namespace 선택(NS scope) / 요약·상세(cluster scope) */}
              {!isCluster ? (
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
              ) : (
                <div className="flex items-center rounded-lg border border-border overflow-hidden text-sm">
                  <ToggleSeg active={clusterMode === 'summary'} onClick={() => { setClusterMode('summary'); setSelectedId(null); }} icon={<Boxes className="w-3 h-3" />} label="네임스페이스 요약" />
                  <ToggleSeg active={clusterMode === 'detail'} onClick={() => { setClusterMode('detail'); setSelectedId(null); }} icon={<Grid3x3 className="w-3 h-3" />} label="전체 상세" border />
                </div>
              )}

              <button onClick={refreshAll}
                className="px-2 py-1 text-sm bg-secondary hover:bg-secondary/80 border border-border rounded-lg inline-flex items-center gap-1">
                <RefreshCw className={`w-3 h-3 ${activeQuery.isFetching || (showTraffic && trafficQuery.isFetching) ? 'animate-spin' : ''}`} /> 새로고침
              </button>

              {/* 2D / 3D */}
              <div className="flex items-center rounded-lg border border-border overflow-hidden text-sm">
                <ToggleSeg active={view === '2d'} onClick={() => setView('2d')} icon={<Grid3x3 className="w-3 h-3" />} label="2D" />
                <ToggleSeg active={view === '3d'} onClick={() => setView('3d')} icon={<Boxes className="w-3 h-3" />} label="3D" border />
              </div>

              <PillToggle on={includePods} onClick={() => setIncludePods((v) => !v)} icon={<Box className="w-3 h-3" />} label="Pod 표시" />
              {!isCluster && (
                <>
                  <PillToggle on={includeOrphans} onClick={() => setIncludeOrphans((v) => !v)} icon={<Boxes className="w-3 h-3" />} label="미참조 설정" />
                  <PillToggle on={showTraffic} onClick={() => setShowTraffic((v) => !v)} icon={<Activity className="w-3 h-3" />} label="실트래픽"
                    loading={showTraffic && trafficQuery.isFetching} />
                </>
              )}

              {!isCluster && (
                <div className="ml-auto flex items-center gap-2">
                  <button onClick={() => setExtOpen(true)}
                    disabled={!canOperate}
                    title={withHint('외부 노드 추가')}
                    className="px-2 py-1 text-sm bg-secondary hover:bg-secondary/80 border border-border rounded-lg inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed">
                    <Server className="w-3 h-3" /> 외부 노드
                  </button>
                  <button onClick={() => { setEditMode((v) => !v); setLinkSourceId(null); }}
                    disabled={!canOperate}
                    title={withHint('링크 편집')}
                    className={`px-2.5 py-1 text-sm rounded-lg inline-flex items-center gap-1 border disabled:opacity-50 disabled:cursor-not-allowed ${
                      editMode ? 'bg-orange-500/15 border-orange-500/40 text-orange-600 dark:text-orange-400' : 'bg-secondary border-border hover:bg-secondary/80'
                    }`}>
                    {editMode ? <Pencil className="w-3 h-3" /> : <Eye className="w-3 h-3" />} 링크 편집
                  </button>
                </div>
              )}
            </div>

            {/* 상태/경고 라인 */}
            <div className="flex flex-wrap items-center gap-2 mt-2 text-xs">
              {graph?.generatedAt && (
                <span className="text-muted-foreground tabular-nums" title={graph.generatedAt}>
                  조회 {parseUTC(graph.generatedAt).toLocaleTimeString('ko-KR')}
                </span>
              )}
              {graph?.metricsStatus === 'offline' && (
                <span className="inline-flex items-center gap-1 text-status-warning">
                  <Info className="w-3 h-3" /> Prometheus 오프라인 — usage 미표시(requests/limits 만)
                </span>
              )}
              {graph?.truncated && (
                <span className="inline-flex items-center gap-1 text-status-warning">
                  <AlertTriangle className="w-3 h-3" /> 노드 수 상한 초과(truncated)
                </span>
              )}
              {isCluster && clusterData?.summaryRecommended && clusterMode === 'detail' && (
                <button onClick={() => { setClusterMode('summary'); setSelectedId(null); }}
                  className="inline-flex items-center gap-1 text-status-warning underline">
                  <AlertTriangle className="w-3 h-3" /> 노드가 많아 요약 보기 권장 — 전환
                </button>
              )}
              {isCluster && clusterData && (
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <Globe className="w-3 h-3" /> 네임스페이스 {clusterData.namespaceCount}개
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
                <span role="status" className="inline-flex items-center gap-1 text-orange-600 dark:text-orange-400">
                  <Pencil className="w-3 h-3" /> {linkSourceId ? `시작 노드: ${nodeName(linkSourceId)} → 대상 노드를 클릭` : '연결할 시작 노드를 클릭'}
                </span>
              )}
              {(graph?.warnings.length ?? 0) > 0 && (
                <span className="inline-flex items-center gap-1 text-muted-foreground" title={graph!.warnings.join('\n')}>
                  <AlertTriangle className="w-3 h-3" /> 경고 {graph!.warnings.length}건
                </span>
              )}
            </div>
            {showTraffic && !isCluster && (
              <div className="mt-2">
                <RunLogPanel run={trafficLog} show={showTrafficLog} onShowChange={setShowTrafficLog} maxHeight="max-h-48" />
              </div>
            )}
          </MacCard>

          {/* 캔버스 */}
          <MacCard title={`그래프 · ${graph?.nodes.length ?? 0} 노드 / ${graph?.edges.length ?? 0} 엣지`} bodyPadding="p-0">
            <div ref={canvasRef} className="relative w-full h-[calc(100vh-260px)] min-h-[420px] overflow-hidden rounded-b-2xl">
              {computing ? (
                <div className="absolute inset-0 flex items-center justify-center p-6">
                  <div className="w-full max-w-md">
                    <SnapshotProgressCard
                      processed={clusterData?.processed ?? 0}
                      total={clusterData?.total ?? null}
                      progress={clusterData?.progress ?? null}
                      label="클러스터 토폴로지 집계 중"
                      unit="Pod"
                    />
                  </div>
                </div>
              ) : activeQuery.isLoading ? (
                <div className="absolute inset-0 flex items-center justify-center text-muted-foreground gap-2">
                  <Loader2 className="w-5 h-5 animate-spin" /> 토폴로지 수집 중…
                </div>
              ) : activeQuery.isError ? (
                <div className="absolute inset-0 flex items-center justify-center text-center px-6">
                  <div>
                    <AlertTriangle className="w-7 h-7 text-status-warning mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground">{formatApiError(activeQuery.error)}</p>
                  </div>
                </div>
              ) : !graph || graph.nodes.length === 0 ? (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  {isCluster ? '표시할 리소스가 없습니다.' : '이 네임스페이스에 표시할 리소스가 없습니다.'}
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
                  onDeleteLink={requestDeleteLink}
                  onDeleteExternal={requestDeleteExternal}
                  canOperate={canOperate}
                  withHint={withHint}
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
      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title={pendingDelete?.kind === 'external' ? '외부 노드 삭제' : '수동 연계 삭제'}
        description={pendingDelete?.kind === 'external'
          ? `외부 노드 "${pendingDelete.node.name}" 를 삭제한다. 되돌릴 수 없다.`
          : `수동 연계 "${pendingDelete?.label ?? ''}" 를 삭제한다. 되돌릴 수 없다.`}
        confirmLabel="삭제"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
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
