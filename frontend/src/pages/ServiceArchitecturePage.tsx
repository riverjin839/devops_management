import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Boxes, Download, GitBranch, Image, Loader2, Network,
  Pencil, RefreshCw, Trash2,
} from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { ClusterSidebar, useToast, EmptyState, LoadingState, PageShell, RunLogPanel } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
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
import { useRunLog, runLogged, pollIntoRunLog, type RunLogEntry, type RunLogLevel } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { architectureDocsApi } from '@/services/api';
import type { ArchDoc, ArchDocSummary, ArchManualNode, ArchViewType } from '@/types';
import { formatApiError } from '@/lib/utils';

// 플로우 뷰에서는 스토리지 노드는 숨긴다 (요청 흐름 관점 노이즈)
const FLOW_HIDDEN_KINDS = new Set(['PVC']);

// ── 실행 로그 요약 (D-136) ────────────────────────────────────────────────────
const LOG_ITEM_CAP = 200;
const LLM_DONE = new Set<ArchDoc['llmStatus']>(['ok', 'failed', 'offline']);

/** 배열 항목을 한 건당 한 줄로 — 앞 200건 + "외 N건". */
function itemLines(items: string[], level: RunLogLevel, fmt: (v: string) => string): RunLogEntry[] {
  const out: RunLogEntry[] = items.slice(0, LOG_ITEM_CAP).map((v) => [level, fmt(v)]);
  if (items.length > LOG_ITEM_CAP) out.push([level, `외 ${items.length - LOG_ITEM_CAP}건`]);
  return out;
}

/** 동기화 응답(ArchDoc) → 실행 로그 줄. */
function syncSummaryLines(d: ArchDoc, prune: boolean): RunLogEntry[] {
  const out: RunLogEntry[] = [];
  if (d.lastSyncStatus === 'failed') {
    out.push(['error', `동기화 실패 — ${d.syncError || '사유 미상'}`]);
    return out;
  }
  const g = d.autoGraph;
  const warnings = g?.warnings ?? [];
  if (d.lastSyncStatus === 'partial') {
    out.push(['warn', `부분 성공 — 경고 ${warnings.length}건${g?.truncated ? ' · 그래프 상한 초과로 잘림' : ''}`]);
  } else if (d.lastSyncStatus === 'ok') {
    out.push(['info', `동기화 완료${prune ? ' (stale 노드 정리 포함)' : ''}`]);
  } else {
    out.push(['warn', `동기화 상태 ${d.lastSyncStatus} — 아직 결과가 확정되지 않음`]);
  }
  if (g) {
    const stale = g.nodes.filter((n) => n.stale).length;
    out.push(['info', `노드 ${g.nodes.length}${stale ? `(사라진 노드 ${stale})` : ''} · 엣지 ${g.edges.length} · 실트래픽 엣지 ${d.trafficEdges.length} · 수동 노드 ${d.manualNodes.length} · 수동 엣지 ${d.manualEdges.length}`]);
  }
  out.push(...itemLines(warnings, 'warn', (w) => `경고 — ${w}`));
  if (g?.truncated) out.push(['warn', '노드 수 상한으로 그래프가 잘림 — 일부 리소스가 다이어그램에 빠졌을 수 있음']);
  const dr = d.drift;
  const added = dr?.added ?? [];
  const removed = dr?.removed ?? [];
  const changed = dr?.changed ?? [];
  if (added.length + removed.length + changed.length > 0) {
    out.push(['info', `변경 감지 — 추가 ${added.length} · 제거 ${removed.length} · 변경 ${changed.length}`]);
    out.push(...itemLines(added, 'info', (v) => `추가 — ${v}`));
    out.push(...itemLines(removed, 'info', (v) => `제거 — ${v}`));
    out.push(...itemLines(changed, 'info', (v) => `변경 — ${v}`));
  } else {
    out.push(['info', '이전 동기화 대비 변경 없음']);
  }
  return out;
}

/** LLM 결과 상태 → 실행 로그 줄(재생성 응답·첫 동기화 후 폴링 공용). */
function llmResultLines(d: ArchDoc): RunLogEntry[] {
  switch (d.llmStatus) {
    case 'ok': {
      const c = d.llmContent;
      const out: RunLogEntry[] = [[
        'info',
        `AI 분석 완료 — 모델 ${c?.model || '—'} · 요약 ${(c?.summary ?? '').length}자 · 컴포넌트 역할 ${c?.components.length ?? 0} · 플로우 ${c?.flowSteps.length ?? 0}단계`,
      ]];
      if (c?.rawFallback) out.push(['warn', '응답 JSON 파싱 실패 — 원문 요약만 저장됨(재생성 권장)']);
      if (d.summaryOverride != null) out.push(['info', '사용자 수정본이 있어 화면 요약은 수정본으로 표시됨']);
      return out;
    }
    case 'offline':
      return [['error', 'AI 분석 실패 — LLM(Ollama) 오프라인 · 기존 요약 유지']];
    case 'failed':
      return [['error', 'AI 분석 실패 — 다이어그램 노드가 없어 생성할 수 없음(먼저 동기화 필요)']];
    case 'pending':
      return [['info', 'AI 분석 생성 중']];
    default:
      return [['info', 'AI 분석 대기 중(백그라운드 큐)']];
  }
}

function syncStatusMeta(status: string): { color: string; label: string } {
  switch (status) {
    case 'ok': return { color: 'bg-muted-foreground/40', label: '최신' };
    case 'partial': return { color: 'bg-status-warning', label: '부분 성공' };
    case 'failed': return { color: 'bg-status-critical', label: '실패' };
    default: return { color: 'bg-status-unknown', label: '미생성' };
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
  const qc = useQueryClient();

  // 실행 로그 — 동기화·정리 동기화·AI 재생성이 공유한다. 패널은 마지막 실행 버튼 근처에 둔다.
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('arch-doc-sync');
  const [logSlot, setLogSlot] = useState<'sync' | 'llm'>('sync');
  const pollAbort = useRef<AbortController | null>(null);
  const pollDone = useRef<Promise<unknown> | null>(null);
  useEffect(() => () => pollAbort.current?.abort(), []);

  /** 이전 실행의 LLM 진행 추적을 멈추고 끝날 때까지 기다린다(로그가 섞이지 않게). */
  const stopPoll = async () => {
    pollAbort.current?.abort();
    if (pollDone.current) await pollDone.current;
    pollAbort.current = null;
    pollDone.current = null;
  };

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

  const moduleLabel = () => {
    if (!selectedModule) return serviceId ?? '';
    return `${selectedModule.serviceName}${selectedModule.namespace ? ` (${selectedModule.namespace})` : ''}`;
  };

  const runSync = async (prune = false) => {
    const sid = serviceId;
    if (!sid) return;
    await stopPoll();
    setLogSlot('sync');
    const r = await runLogged(runLog, {
      title: prune ? '정리 동기화' : '동기화',
      first: `${moduleLabel()} — ${prune ? '정리 동기화(참조되지 않는 stale 노드 제거)' : 'K8s 리소스 수집·현행화'} 요청`,
      fn: () => syncMut.mutateAsync({ prune }),
      summarize: (d) => syncSummaryLines(d, prune),
      keepOpen: true,
    });
    if (!r.ok) {
      if (!r.aborted) toast.error(formatApiError(r.error));
      return;
    }
    const d = r.data;
    if (d.lastSyncStatus === 'failed') toast.error(d.syncError || '동기화에 실패했습니다.');
    else if (d.lastSyncStatus === 'partial') toast.warning(`${prune ? '정리 동기화' : '현행화'} 부분 성공 — 경고 ${d.autoGraph?.warnings.length ?? 0}건`, '실행 로그에서 경고를 확인하세요.');
    else toast.success(prune ? '정리 동기화 완료' : '현행화 완료');

    // 첫 동기화 성공 시 백엔드가 LLM 생성을 Celery 로 걸어 둔다 — 문서를 재조회해 llmStatus 변화를 이어 쓴다.
    const llmQueued = (d.lastSyncStatus === 'ok' || d.lastSyncStatus === 'partial') && d.llmStatus === 'none';
    if (!llmQueued && d.llmStatus !== 'pending') {
      r.run.end();
      return;
    }
    r.run.log('info', 'AI 아키텍처 분석이 백그라운드로 요청됨 — 완료까지 진행 추적');
    const ctrl = new AbortController();
    pollAbort.current = ctrl;
    const p = pollIntoRunLog<ArchDoc>(r.run, {
      fetch: () => architectureDocsApi.get(sid).then((res) => res.data),
      describe: (snap, prev) => (prev && prev.llmStatus === snap.llmStatus ? [] : llmResultLines(snap)),
      isDone: (snap) => LLM_DONE.has(snap.llmStatus),
      intervalMs: 3000,
      timeoutMs: 180_000,
      signal: ctrl.signal,
    }).then((last) => {
      if (last && LLM_DONE.has(last.llmStatus)) {
        qc.invalidateQueries({ queryKey: ['arch-doc', sid] });
        qc.invalidateQueries({ queryKey: ['arch-docs'] });
      }
    });
    pollDone.current = p;
    await p;
  };

  const runRegenerate = async () => {
    if (!serviceId) return;
    if (syncMut.isPending) {
      toast.info('동기화가 끝난 뒤 재생성하세요.');
      return;
    }
    await stopPoll();
    setLogSlot('llm');
    const r = await runLogged(runLog, {
      title: 'AI 재생성',
      first: `${moduleLabel()} — AI 아키텍처 분석 재생성 요청(LLM 응답까지 최대 180초)`,
      fn: () => llmMut.mutateAsync(),
      summarize: llmResultLines,
    });
    if (!r.ok) {
      if (!r.aborted) toast.error(formatApiError(r.error));
      return;
    }
    const d = r.data;
    if (d.llmStatus === 'offline') toast.error('LLM(Ollama) 이 오프라인입니다.');
    else if (d.llmStatus === 'failed') toast.error('AI 분석 실패 — 먼저 동기화해 다이어그램을 생성하세요.');
    else if (d.llmStatus === 'ok') toast.success('AI 분석 갱신됨');
  };

  const logPanel = (
    <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
  );
  const hasLog = runLog.running || runLog.lines.length > 0;

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
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" className="flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={clusterId || null}
          onSelect={(id) => setClusterId(id ?? '')}
          iconOnly
        />

        <div className="flex-1 min-w-0 space-y-3">
        <PageHeader
          icon={Network}
          title="서비스 아키텍처"
          description="클러스터의 서비스 모듈별 K8s 리소스를 수집해 아키텍처·서비스 플로우 다이어그램으로 현행화합니다."
        />
        <div className="flex gap-3 items-start">
          {/* 모듈 목록 */}
          <MacCard title="서비스 모듈" rootClassName="w-60 shrink-0 sticky top-4" bodyPadding="p-2">
            {docsQuery.isLoading ? (
              <LoadingState compact />
            ) : modules.length === 0 ? (
              <EmptyState
                compact
                icon={Boxes}
                title="등록된 서비스 모듈이 없습니다."
                description="설정 → PEP/APP 서비스에서 모듈(namespace 포함)을 등록하세요."
              />
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
                            <span className="text-[11px] font-bold text-status-warning" title="드리프트 감지">
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
          <MacCard
            title={selectedModule?.serviceName ?? '다이어그램'}
            rootClassName="flex-1 min-w-0"
            bodyPadding="p-0"
            titleExtra={
              <span className="flex items-center gap-2 text-[11px] text-muted-foreground min-w-0">
                {doc?.lastSyncedAt && (
                  <span>현행화: {new Date(doc.lastSyncedAt).toLocaleString('ko-KR')}</span>
                )}
                {driftTotal > 0 && (
                  <span className="inline-flex items-center gap-1 text-status-warning font-semibold"
                    title={`추가 ${drift?.added?.length ?? 0} · 제거 ${drift?.removed?.length ?? 0} · 변경 ${drift?.changed?.length ?? 0}`}>
                    <AlertTriangle className="w-3.5 h-3.5" /> 변경 {driftTotal}건
                  </span>
                )}
                {doc?.lastSyncStatus === 'failed' && (
                  <span className="text-status-critical truncate" title={doc.syncError ?? ''}>
                    동기화 실패: {doc.syncError}
                  </span>
                )}
              </span>
            }
            actions={<>
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
              <button
                onClick={() => setEditMode((v) => { if (v) setLinkSourceId(null); return !v; })}
                disabled={!doc}
                aria-label="편집 모드" title="편집 모드 — 노드 두 개를 차례로 클릭해 연결"
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-xl border ${
                  editMode ? 'border-primary/40 text-primary bg-primary/10' : 'border-border bg-card hover:bg-secondary'
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
                onClick={() => { void runSync(true); }}
                disabled={!serviceId || syncMut.isPending || llmMut.isPending}
                aria-label="정리 동기화" title="정리 동기화 — 참조되지 않는 stale 노드를 제거하며 현행화"
                className="p-1.5 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => { void runSync(false); }}
                disabled={!serviceId || syncMut.isPending || llmMut.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl disabled:opacity-50"
              >
                {syncMut.isPending
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <RefreshCw className="w-3.5 h-3.5" />}
                동기화
              </button>
            </>}
          >
            {hasLog && logSlot === 'sync' && (
              <div className="px-4 py-3 border-b border-border">{logPanel}</div>
            )}

            {editMode && (
              <div className="px-4 py-1.5 text-xs text-primary bg-secondary/40 border-b border-border">
                편집 모드: {linkSourceId
                  ? `${nodeName(linkSourceId)} → 연결할 대상 노드를 클릭하세요`
                  : '연결 시작 노드를 클릭하세요'}
              </div>
            )}

            {/* 캔버스 + 우측 패널 */}
            <div className="flex" style={{ height: '58vh' }}>
              <div className="flex-1 min-w-0 relative">
                {!serviceId ? (
                  <EmptyState title="서비스 모듈을 선택하세요" description="왼쪽 목록에서 모듈을 고르면 아키텍처 다이어그램이 표시됩니다." className="h-full" />
                ) : docQuery.isLoading ? (
                  <div className="h-full flex items-center justify-center">
                    <LoadingState />
                  </div>
                ) : !doc?.autoGraph ? (
                  <EmptyState
                    title={doc?.lastSyncStatus === 'failed' ? '동기화에 실패했습니다.' : '아직 생성된 다이어그램이 없습니다.'}
                    description={doc?.lastSyncStatus === 'failed'
                      ? (doc.syncError || '동기화 로그를 확인하세요.')
                      : '「동기화」를 눌러 K8s 리소스를 자동 수집하세요.'}
                    className="h-full"
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
                  <div className="absolute bottom-2 left-2 right-2 text-[11px] text-status-warning bg-card border border-border rounded-md px-2 py-1 truncate"
                    title={warnings.join('\n')}>
                    <AlertTriangle className="inline w-3 h-3 mr-1 -mt-0.5" aria-hidden="true" />{warnings[0]}{warnings.length > 1 ? ` 외 ${warnings.length - 1}건` : ''}
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
                      onSuccess: () => { setSelectedId(null); toast.success('수동 노드 삭제됨'); },
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
                onRegenerate={() => { void runRegenerate(); }}
                runLog={hasLog && logSlot === 'llm' ? logPanel : null}
                savingSummary={patchMut.isPending}
                onSaveSummaryOverride={(text) => patchMut.mutate({ summaryOverride: text }, {
                  onError: (e) => toast.error(formatApiError(e)),
                })}
              />
            )}
          </MacCard>
        </div>
        </div>
      </PageShell>

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
                toast.success('저장됨');
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
                  toast.success('연결 추가됨');
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

