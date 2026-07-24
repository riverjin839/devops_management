import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Boxes, Download, GitBranch, Image, Loader2, Network,
  Pencil, RefreshCw, Trash2,
} from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { ClusterSidebar, useToast } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import {
  ArchDocCanvas, ManualNodeDialog, ManualEdgeDialog, NodeDetailPanel, LlmSummaryPanel,
  exportSvgDiagram,
  type ArchCanvasNode, type ArchCanvasEdge,
} from '@/components/serviceArch';
import {
  useArchDoc, useArchDocs, useSyncArchDoc, useRegenerateLlm, usePatchArchDoc,
  useUpdateArchLayout, useCreateManualNode, useUpdateManualNode, useDeleteManualNode,
  useCreateManualEdge, useDeleteManualEdge,
} from '@/hooks/useArchDoc';
import type { ArchDocSummary, ArchManualNode, ArchViewType } from '@/types';
import { formatApiError } from '@/lib/utils';

// 플로우 뷰에서는 스토리지 노드는 숨긴다 (요청 흐름 관점 노이즈)
const FLOW_HIDDEN_KINDS = new Set(['PVC']);

function syncStatusMeta(status: string): { color: string; label: string } {
  switch (status) {
    case 'ok': return { color: 'bg-emerald-500', label: '최신' };
    case 'partial': return { color: 'bg-amber-500', label: '부분 성공' };
    case 'failed': return { color: 'bg-red-500', label: '실패' };
    default: return { color: 'bg-slate-400', label: '미생성' };
  }
}

export function ServiceArchitecturePage() {
  const toast = useToast();
  const { data: clusters = [] } = useClusters();
  const [clusterId, setClusterId] = useState<string>('');
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [view, setView] = useState<ArchViewType>('architecture');
  const [editMode, setEditMode] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [linkSourceId, setLinkSourceId] = useState<string | null>(null);
  const [linkTargetId, setLinkTargetId] = useState<string | null>(null);
  const [nodeDialogOpen, setNodeDialogOpen] = useState(false);
  const [editingManualNode, setEditingManualNode] = useState<ArchManualNode | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!clusterId && clusters.length > 0) setClusterId(clusters[0].id);
  }, [clusters, clusterId]);

  const docsQuery = useArchDocs(clusterId || null);
  const modules: ArchDocSummary[] = useMemo(() => docsQuery.data ?? [], [docsQuery.data]);
  useEffect(() => {
    // 클러스터 변경/목록 로드 시 첫 모듈 자동 선택
    if (modules.length && (!serviceId || !modules.some((m) => m.serviceId === serviceId))) {
      setServiceId(modules[0].serviceId);
    }
    if (!modules.length) setServiceId(null);
  }, [modules, serviceId]);

  const docQuery = useArchDoc(serviceId);
  const doc = docQuery.data;
  const selectedModule = modules.find((m) => m.serviceId === serviceId);

  // mutations
  const syncMut = useSyncArchDoc(serviceId);
  const llmMut = useRegenerateLlm(serviceId);
  const patchMut = usePatchArchDoc(serviceId);
  const layoutMut = useUpdateArchLayout(serviceId);
  const createNode = useCreateManualNode(serviceId);
  const updateNode = useUpdateManualNode(serviceId);
  const deleteNode = useDeleteManualNode(serviceId);
  const createEdge = useCreateManualEdge(serviceId);
  const deleteEdge = useDeleteManualEdge(serviceId);

  // 선택/편집 상태는 모듈·뷰 전환 시 초기화
  useEffect(() => {
    setSelectedId(null);
    setLinkSourceId(null);
    setLinkTargetId(null);
    setEditMode(false);
  }, [serviceId]);

  // ── 뷰별 노드/엣지 병합 ─────────────────────────────────────────────────────
  const { nodes, edges } = useMemo((): { nodes: ArchCanvasNode[]; edges: ArchCanvasEdge[] } => {
    if (!doc) return { nodes: [], edges: [] };
    const autoNodes = doc.autoGraph?.nodes ?? [];
    const isFlow = view === 'flow';

    const outNodes: ArchCanvasNode[] = [];
    for (const n of autoNodes) {
      if (isFlow && FLOW_HIDDEN_KINDS.has(n.kind)) continue;
      outNodes.push({
        id: n.id, kind: n.kind, name: n.name, status: n.status,
        stale: n.stale, detail: n.detail, annotated: !!doc.annotations[n.id],
      });
    }
    for (const mn of doc.manualNodes) {
      outNodes.push({
        id: mn.nodeId, kind: mn.kind, name: mn.label, status: 'healthy',
        manual: true, manualPk: mn.id, detail: mn.description,
        annotated: !!doc.annotations[mn.nodeId],
      });
    }
    const nodeIds = new Set(outNodes.map((n) => n.id));

    const outEdges: ArchCanvasEdge[] = [];
    // LLM 플로우 스텝 → "src|tgt" 순번 맵 (flow 뷰 뱃지)
    const stepMap = new Map<string, number>();
    if (isFlow) {
      for (const s of doc.llmContent?.flowSteps ?? []) {
        if (s.source && s.target) stepMap.set(`${s.source}|${s.target}`, s.order);
      }
    }

    if (!isFlow) {
      for (const e of doc.autoGraph?.edges ?? []) {
        if (nodeIds.has(e.source) && nodeIds.has(e.target)) {
          outEdges.push({ id: e.id, source: e.source, target: e.target, type: e.type, label: e.label });
        }
      }
    } else {
      // 플로우 뷰: 실트래픽 엣지
      for (const [i, t] of (doc.trafficEdges ?? []).entries()) {
        if (!nodeIds.has(t.source) || !nodeIds.has(t.target)) continue;
        outEdges.push({
          id: `traffic-${i}`, source: t.source, target: t.target, type: 'traffic',
          flowCount: t.flowCount, dropped: t.droppedCount > 0,
          step: stepMap.get(`${t.source}|${t.target}`),
        });
        stepMap.delete(`${t.source}|${t.target}`);
      }
    }

    // 수동 엣지 (뷰 필터) — 끊긴 끝점은 ghost 노드로
    for (const me of doc.manualEdges) {
      if (me.view !== 'both' && me.view !== view) continue;
      for (const endpoint of [me.sourceId, me.targetId]) {
        if (!nodeIds.has(endpoint)) {
          const name = endpoint.startsWith('manual:')
            ? '삭제된 수동 노드'
            : endpoint.split('/').pop() || endpoint;
          outNodes.push({
            id: endpoint, kind: 'External', name, status: 'warning', stale: true,
          });
          nodeIds.add(endpoint);
        }
      }
      const key = `${me.sourceId}|${me.targetId}`;
      outEdges.push({
        id: `manual-${me.id}`, source: me.sourceId, target: me.targetId,
        type: 'manual', label: me.label || me.edgeType, manualPk: me.id,
        step: isFlow ? stepMap.get(key) : undefined,
      });
      if (isFlow) stepMap.delete(key);
    }

    // 남은 LLM 플로우 스텝 — 대응 엣지가 없으면 합성 플로우 엣지로 표시
    if (isFlow) {
      for (const [key, order] of stepMap) {
        const [src, tgt] = key.split('|');
        if (nodeIds.has(src) && nodeIds.has(tgt)) {
          outEdges.push({
            id: `step-${key}`, source: src, target: tgt, type: 'manual', step: order,
          });
        }
      }
    }

    return { nodes: outNodes, edges: outEdges };
  }, [doc, view]);

  const nodeById = useMemo(() => {
    const m = new Map<string, ArchCanvasNode>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);
  const nodeName = (id: string) => nodeById.get(id)?.name ?? id;
  const selectedNode = selectedId ? nodeById.get(selectedId) : null;

  // ── handlers ────────────────────────────────────────────────────────────────
  const handleSelect = (id: string | null) => {
    if (!editMode) { setSelectedId(id); return; }
    if (id == null) return;
    if (!linkSourceId) { setLinkSourceId(id); return; }
    if (id === linkSourceId) { setLinkSourceId(null); return; }
    setLinkTargetId(id);
  };

  const runSync = (prune = false) => {
    syncMut.mutate({ prune }, {
      onSuccess: (d) => {
        if (d.lastSyncStatus === 'failed') {
          toast.error(d.syncError || '동기화에 실패했습니다.');
        } else {
          toast.success(prune ? '정리 동기화 완료' : '현행화 완료');
        }
      },
      onError: (e) => toast.error(formatApiError(e)),
    });
  };

  const saveAnnotation = (nodeId: string, text: string | null) => {
    patchMut.mutate({ annotations: [{ id: nodeId, text }] }, {
      onError: (e) => toast.error(formatApiError(e)),
    });
  };

  const drift = doc?.drift;
  const driftTotal = drift
    ? (drift.added?.length ?? 0) + (drift.removed?.length ?? 0) + (drift.changed?.length ?? 0)
    : 0;
  const warnings = doc?.autoGraph?.warnings ?? [];

  return (
    <div className="min-h-screen bg-background">
      <main className="py-3 pr-3 flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={clusterId || null}
          onSelect={(id) => setClusterId(id ?? '')}
          iconOnly
        />

        <div className="flex-1 min-w-0 flex gap-3 items-start">
          {/* 모듈 목록 */}
          <MacCard title="서비스 모듈" rootClassName="w-60 shrink-0 sticky top-4" bodyPadding="p-2">
            {docsQuery.isLoading ? (
              <div className="flex justify-center py-6"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
            ) : modules.length === 0 ? (
              <p className="text-xs text-muted-foreground px-2 py-4">
                이 클러스터에 등록된 서비스 모듈이 없습니다. Settings → PEP/APP 서비스에서 모듈(namespace 포함)을 등록하세요.
              </p>
            ) : (
              <ul className="space-y-1">
                {modules.map((m) => {
                  const meta = syncStatusMeta(m.lastSyncStatus);
                  const mDrift = m.driftCounts
                    ? Object.values(m.driftCounts).reduce((a, b) => a + b, 0)
                    : 0;
                  return (
                    <li key={m.serviceId}>
                      <button
                        onClick={() => setServiceId(m.serviceId)}
                        className={`w-full text-left px-2.5 py-2 rounded-xl border transition-colors ${
                          m.serviceId === serviceId
                            ? 'border-primary bg-secondary/60'
                            : 'border-transparent hover:bg-secondary/40'
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className={`w-2 h-2 rounded-full shrink-0 ${meta.color}`} title={meta.label} />
                          <span className="text-sm font-medium truncate flex-1">{m.serviceName}</span>
                          {mDrift > 0 && (
                            <span className="text-[10px] font-bold text-amber-500" title="드리프트 감지">
                              Δ{mDrift}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-muted-foreground truncate pl-3.5">
                          {m.serviceType}{m.namespace ? ` · ${m.namespace}` : ''}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </MacCard>

          {/* 본문 */}
          <MacCard title="서비스 아키텍처" rootClassName="flex-1 min-w-0" bodyPadding="p-0">
            {/* 헤더 툴바 */}
            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-border">
              <div className="flex items-center rounded-xl border border-border overflow-hidden">
                {([
                  { key: 'architecture', label: '아키텍처', icon: Network },
                  { key: 'flow', label: '서비스 플로우', icon: GitBranch },
                ] as const).map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setView(t.key)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium ${
                      view === t.key ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-secondary'
                    }`}
                  >
                    <t.icon className="w-3.5 h-3.5" />{t.label}
                  </button>
                ))}
              </div>

              <div className="flex-1 min-w-0 flex items-center gap-2 text-[11px] text-muted-foreground">
                {doc?.lastSyncedAt && (
                  <span>현행화: {new Date(doc.lastSyncedAt).toLocaleString('ko-KR')}</span>
                )}
                {driftTotal > 0 && (
                  <span className="inline-flex items-center gap-1 text-amber-500 font-semibold"
                    title={`추가 ${drift?.added?.length ?? 0} · 제거 ${drift?.removed?.length ?? 0} · 변경 ${drift?.changed?.length ?? 0}`}>
                    <AlertTriangle className="w-3.5 h-3.5" /> 변경 {driftTotal}건
                  </span>
                )}
                {doc?.lastSyncStatus === 'failed' && (
                  <span className="text-red-500 truncate" title={doc.syncError ?? ''}>
                    동기화 실패: {doc.syncError}
                  </span>
                )}
              </div>

              <button
                onClick={() => setEditMode((v) => { if (v) setLinkSourceId(null); return !v; })}
                disabled={!doc}
                aria-label="편집 모드" title="편집 모드 — 노드 두 개를 차례로 클릭해 연결"
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-xl border ${
                  editMode ? 'border-orange-500 text-orange-500 bg-secondary/60' : 'border-border bg-card hover:bg-secondary'
                } disabled:opacity-50`}
              >
                <Pencil className="w-3.5 h-3.5" />{editMode ? '편집 중' : '편집'}
              </button>
              <button
                onClick={() => setNodeDialogOpen(true)}
                disabled={!doc}
                aria-label="수동 노드 추가" title="수동 노드 추가"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-card hover:bg-secondary border border-border rounded-xl disabled:opacity-50"
              >
                <Boxes className="w-3.5 h-3.5" />노드 추가
              </button>
              <button
                onClick={() => svgRef.current && exportSvgDiagram(svgRef.current, `arch-${selectedModule?.serviceName ?? 'diagram'}-${view}`, 'png')}
                disabled={!doc?.autoGraph}
                aria-label="PNG 내보내기" title="PNG 내보내기"
                className="p-1.5 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-50"
              >
                <Image className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => svgRef.current && exportSvgDiagram(svgRef.current, `arch-${selectedModule?.serviceName ?? 'diagram'}-${view}`, 'svg')}
                disabled={!doc?.autoGraph}
                aria-label="SVG 내보내기" title="SVG 내보내기"
                className="p-1.5 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-50"
              >
                <Download className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => runSync(true)}
                disabled={!serviceId || syncMut.isPending}
                aria-label="정리 동기화" title="정리 동기화 — 참조되지 않는 stale 노드를 제거하며 현행화"
                className="p-1.5 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => runSync(false)}
                disabled={!serviceId || syncMut.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl disabled:opacity-50"
              >
                {syncMut.isPending
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <RefreshCw className="w-3.5 h-3.5" />}
                동기화
              </button>
            </div>

            {editMode && (
              <div className="px-4 py-1.5 text-[11px] text-orange-500 bg-secondary/40 border-b border-border">
                편집 모드: {linkSourceId
                  ? `${nodeName(linkSourceId)} → 연결할 대상 노드를 클릭하세요`
                  : '연결 시작 노드를 클릭하세요'}
              </div>
            )}

            {/* 캔버스 + 우측 패널 */}
            <div className="flex" style={{ height: '58vh' }}>
              <div className="flex-1 min-w-0 relative">
                {!serviceId ? (
                  <EmptyState text="좌측에서 서비스 모듈을 선택하세요." />
                ) : docQuery.isLoading ? (
                  <div className="h-full flex items-center justify-center">
                    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                  </div>
                ) : !doc?.autoGraph ? (
                  <EmptyState
                    text={doc?.lastSyncStatus === 'failed'
                      ? (doc.syncError || '동기화에 실패했습니다.')
                      : '아직 생성된 다이어그램이 없습니다. [동기화] 를 눌러 K8s 리소스를 자동 수집하세요.'}
                  />
                ) : (
                  <ArchDocCanvas
                    ref={svgRef}
                    nodes={nodes}
                    edges={edges}
                    positions={doc.layout[view] ?? {}}
                    onNodeMoved={(id, x, y) => layoutMut.queuePosition(view, id, x, y)}
                    resetKey={`${serviceId}:${view}`}
                    selectedId={selectedId}
                    onSelectNode={handleSelect}
                    editMode={editMode}
                    linkSourceId={linkSourceId}
                  />
                )}
                {warnings.length > 0 && (
                  <div className="absolute bottom-2 left-2 right-2 text-[10px] text-amber-500 bg-card/80 border border-border rounded-lg px-2 py-1 truncate"
                    title={warnings.join('\n')}>
                    ⚠ {warnings[0]}{warnings.length > 1 ? ` 외 ${warnings.length - 1}건` : ''}
                  </div>
                )}
              </div>

              {selectedNode && doc && !editMode && (
                <NodeDetailPanel
                  node={selectedNode}
                  doc={doc}
                  onClose={() => setSelectedId(null)}
                  onSaveAnnotation={saveAnnotation}
                  savingAnnotation={patchMut.isPending}
                  onEditManualNode={(pk) => {
                    const mn = doc.manualNodes.find((x) => x.id === pk);
                    if (mn) { setEditingManualNode(mn); setNodeDialogOpen(true); }
                  }}
                  onDeleteManualNode={(pk) => {
                    deleteNode.mutate(pk, {
                      onSuccess: () => { setSelectedId(null); toast.success('수동 노드를 삭제했습니다.'); },
                      onError: (e) => toast.error(formatApiError(e)),
                    });
                  }}
                  onDeleteManualEdge={(pk) => {
                    deleteEdge.mutate(pk, {
                      onError: (e) => toast.error(formatApiError(e)),
                    });
                  }}
                />
              )}
            </div>

            {/* AI 요약 */}
            {doc && (
              <LlmSummaryPanel
                doc={doc}
                nodeName={nodeName}
                regenerating={llmMut.isPending}
                onRegenerate={() => llmMut.mutate(undefined, {
                  onSuccess: (d) => {
                    if (d.llmStatus === 'offline') toast.error('LLM(Ollama) 이 오프라인입니다.');
                    else toast.success('AI 분석을 갱신했습니다.');
                  },
                  onError: (e) => toast.error(formatApiError(e)),
                })}
                savingSummary={patchMut.isPending}
                onSaveSummaryOverride={(text) => patchMut.mutate({ summaryOverride: text }, {
                  onError: (e) => toast.error(formatApiError(e)),
                })}
              />
            )}
          </MacCard>
        </div>
      </main>

      {/* dialogs */}
      {nodeDialogOpen && (
        <ManualNodeDialog
          editing={editingManualNode}
          pending={createNode.isPending || updateNode.isPending}
          onClose={() => { setNodeDialogOpen(false); setEditingManualNode(null); }}
          onSubmit={(data) => {
            const done = {
              onSuccess: () => {
                setNodeDialogOpen(false);
                setEditingManualNode(null);
                toast.success('저장했습니다.');
              },
              onError: (e: unknown) => toast.error(formatApiError(e)),
            };
            if (editingManualNode) updateNode.mutate({ nodePk: editingManualNode.id, data }, done);
            else createNode.mutate(data, done);
          }}
        />
      )}
      {linkSourceId && linkTargetId && (
        <ManualEdgeDialog
          sourceName={nodeName(linkSourceId)}
          targetName={nodeName(linkTargetId)}
          pending={createEdge.isPending}
          onClose={() => { setLinkSourceId(null); setLinkTargetId(null); }}
          onSubmit={(data) => {
            createEdge.mutate(
              { sourceId: linkSourceId, targetId: linkTargetId, ...data },
              {
                onSuccess: () => {
                  setLinkSourceId(null);
                  setLinkTargetId(null);
                  toast.success('연결을 추가했습니다.');
                },
                onError: (e) => toast.error(formatApiError(e)),
              },
            );
          }}
        />
      )}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="h-full flex items-center justify-center px-8">
      <p className="text-sm text-muted-foreground text-center max-w-md">{text}</p>
    </div>
  );
}
