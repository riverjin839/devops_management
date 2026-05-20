import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  GitFork, Plus, Trash2, Check, X, ChevronRight,
  Pencil, Zap, Play, GitBranch, Clock, Bell,
  ZoomIn, ZoomOut, Maximize2, LayoutGrid, Link2, ExternalLink,
} from 'lucide-react';
import { workflowsApi } from '@/services/api';
import { useToast } from '@/components/common';
import { useClusters } from '@/hooks/useCluster';
import { useWorkItems } from '@/hooks/useWorkItems';
import { usePlaybooks } from '@/hooks/usePlaybook';
import { useWorkGuides } from '@/hooks/useWorkGuide';
import { useMetricCards } from '@/hooks/useMetricCards';
import type {
  WorkflowStep, WorkflowEdge,
  WorkflowStepType, WorkflowStepStatus,
  WorkflowStepUpdate, WorkflowUpdate,
} from '@/types';

// ─── constants ────────────────────────────────────────────────────────────────
const CARD_W = 260;
const CARD_H = 160;
const CANVAS_W = 3200;
const CANVAS_H = 2000;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.0;
const PORT_R = 6;
const PORT_HIT = PORT_R + 8; // drop target detection radius

// ─── step type config ─────────────────────────────────────────────────────────
type StepTypeCfg = { label: string; border: string; header: string; dot: string; icon: React.ReactNode };
const STEP_TYPE: Record<WorkflowStepType, StepTypeCfg> = {
  trigger:      { label: 'Trigger',      border: 'border-violet-500/60', header: 'bg-violet-500/10',  dot: 'bg-violet-400',  icon: <Zap       className="w-3.5 h-3.5" /> },
  action:       { label: 'Action',       border: 'border-blue-500/60',   header: 'bg-blue-500/10',    dot: 'bg-blue-400',    icon: <Play      className="w-3.5 h-3.5" /> },
  condition:    { label: 'Condition',    border: 'border-amber-500/60',  header: 'bg-amber-500/10',   dot: 'bg-amber-400',   icon: <GitBranch className="w-3.5 h-3.5" /> },
  wait:         { label: 'Wait',         border: 'border-cyan-500/60',   header: 'bg-cyan-500/10',    dot: 'bg-cyan-400',    icon: <Clock     className="w-3.5 h-3.5" /> },
  notification: { label: 'Notification', border: 'border-emerald-500/60',header: 'bg-emerald-500/10', dot: 'bg-emerald-400', icon: <Bell      className="w-3.5 h-3.5" /> },
};
const STEP_TYPE_KEYS = Object.keys(STEP_TYPE) as WorkflowStepType[];

// ─── step status config ───────────────────────────────────────────────────────
// 기획 게시판용 상태. 실행 색채 제거: pulse 애니메이션 없음, "실패" 빨간색 → "막힘" amber.
type StepStatusCfg = { label: string; cls: string; barCls: string };
const STEP_STATUS: Record<WorkflowStepStatus, StepStatusCfg> = {
  'todo':        { label: '할 일',    cls: 'bg-zinc-500/15 text-zinc-500',     barCls: 'bg-zinc-400/60' },
  'in-progress': { label: '진행 중',  cls: 'bg-blue-500/15 text-blue-600',     barCls: 'bg-blue-500' },
  'blocked':     { label: '막힘',     cls: 'bg-amber-500/15 text-amber-600',   barCls: 'bg-amber-500' },
  'done':        { label: '완료',     cls: 'bg-emerald-500/15 text-emerald-600',barCls: 'bg-emerald-500' },
  'skipped':     { label: '제외',     cls: 'bg-zinc-500/10 text-zinc-400 opacity-60', barCls: 'bg-zinc-300' },
};
const STEP_STATUS_KEYS = Object.keys(STEP_STATUS) as WorkflowStepStatus[];

/**
 * 레거시 상태값(idle/running/success/failed) 을 새 어휘로 normalise.
 * DB 마이그레이션이 돌기 전 / 외부에서 들어온 데이터에도 안전하게 동작하도록.
 */
function normalizeStatus(raw: string | null | undefined): WorkflowStepStatus {
  switch (raw) {
    case 'idle':    return 'todo';
    case 'running': return 'in-progress';
    case 'success': return 'done';
    case 'failed':  return 'blocked';
    case 'todo': case 'in-progress': case 'blocked': case 'done': case 'skipped':
      return raw;
    default: return 'todo';
  }
}

// ─── port SVG colors ──────────────────────────────────────────────────────────
const TYPE_SVG_COLOR: Record<string, { fill: string; stroke: string }> = {
  trigger:      { fill: '#a78bfa', stroke: '#7c3aed' },
  action:       { fill: '#60a5fa', stroke: '#2563eb' },
  condition:    { fill: '#fbbf24', stroke: '#d97706' },
  wait:         { fill: '#22d3ee', stroke: '#0891b2' },
  notification: { fill: '#34d399', stroke: '#059669' },
};

// ─── reference type labels ────────────────────────────────────────────────────
const REFERENCE_TYPE_LABELS: Record<string, string> = {
  cluster:     '클러스터',
  playbook:    '플레이북',
  issue:       '이슈',
  task:        '작업',
  work_guide:  '작업 가이드',
  metric_card: '메트릭 카드',
};

// ─── helpers ──────────────────────────────────────────────────────────────────
function bezierPath(sx: number, sy: number, tx: number, ty: number): string {
  const dx = Math.abs(tx - sx);
  const cx1 = sx + dx * 0.6;
  const cy1 = sy;
  const cx2 = tx - dx * 0.6;
  const cy2 = ty;
  return `M ${sx} ${sy} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${tx} ${ty}`;
}

function computeAutoLayout(
  steps: WorkflowStep[],
  edges: WorkflowEdge[],
): Record<string, { x: number; y: number }> {
  const adj: Record<string, string[]> = {};
  const inDeg: Record<string, number> = {};
  steps.forEach((s) => { adj[s.id] = []; inDeg[s.id] = 0; });
  edges.forEach((e) => {
    adj[e.sourceStepId]?.push(e.targetStepId);
    if (e.targetStepId in inDeg) inDeg[e.targetStepId]++;
  });
  const queue = steps.map((s) => s.id).filter((id) => inDeg[id] === 0);
  const depth: Record<string, number> = {};
  queue.forEach((id) => { depth[id] = 0; });
  const visited = new Set(queue);
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    for (const next of adj[cur]) {
      if (!visited.has(next)) { visited.add(next); queue.push(next); }
      depth[next] = Math.max(depth[next] ?? 0, (depth[cur] ?? 0) + 1);
    }
  }
  const byDepth: Record<number, string[]> = {};
  steps.forEach((s) => {
    const d = depth[s.id] ?? 0;
    (byDepth[d] = byDepth[d] ?? []).push(s.id);
  });
  const out: Record<string, { x: number; y: number }> = {};
  Object.entries(byDepth).forEach(([colStr, ids]) => {
    const col = Number(colStr);
    ids.forEach((id, row) => {
      out[id] = { x: 80 + col * (CARD_W + 90), y: 80 + row * (CARD_H + 60) };
    });
  });
  return out;
}

// ─── component ────────────────────────────────────────────────────────────────
export function WorkflowBoardPage() {
  // drag state for cards
  const [localPos, setLocalPos] = useState<Record<string, { x: number; y: number }>>({});
  const [dragging, setDragging] = useState<{
    stepId: string; startX: number; startY: number; origX: number; origY: number;
  } | null>(null);

  // selection
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // pending edge drag (port drag-to-connect)
  const [pendingEdge, setPendingEdge] = useState<{
    sourceStepId: string;
    fromX: number; fromY: number;
    toX: number;   toY: number;
  } | null>(null);

  // workflow name editing
  const [editingWfId, setEditingWfId] = useState<string | null>(null);
  const [wfEditTitle, setWfEditTitle] = useState('');
  const [editingHeaderTitle, setEditingHeaderTitle] = useState(false);
  const [headerTitleDraft, setHeaderTitleDraft] = useState('');

  // workflow create
  const [showCreateWf, setShowCreateWf] = useState(false);
  const [newWfTitle, setNewWfTitle] = useState('');
  const [newWfConfluence, setNewWfConfluence] = useState('');
  const [editingHeaderConfluence, setEditingHeaderConfluence] = useState(false);
  const [headerConfluenceDraft, setHeaderConfluenceDraft] = useState('');

  // step editing
  const [editingStep, setEditingStep] = useState<string | null>(null);
  const [stepTitle, setStepTitle] = useState('');
  const [stepDesc, setStepDesc] = useState('');
  const [stepRefType, setStepRefType] = useState('');
  const [stepRefId, setStepRefId] = useState('');

  // dropdowns
  const [typeMenuStep, setTypeMenuStep] = useState<string | null>(null);
  const [statusMenuStep, setStatusMenuStep] = useState<string | null>(null);

  // zoom
  const [zoom, setZoom] = useState(1.0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── data ─────────────────────────────────────────────────────────────────────
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({
    queryKey: ['workflows'],
    queryFn: () => workflowsApi.getAll().then((r) => r.data),
    staleTime: 1000 * 10,
  });
  const workflows = data?.data ?? [];
  const selectedWf = workflows.find((w) => w.id === selectedId) ?? null;

  // 선택된 워크플로우의 상태별 카운트 (헤더 진행률 시각화용)
  const statusCounts = useMemo(() => {
    const init: Record<WorkflowStepStatus, number> = {
      'todo': 0, 'in-progress': 0, 'blocked': 0, 'done': 0, 'skipped': 0,
    };
    if (!selectedWf) return init;
    for (const s of selectedWf.steps) {
      // completed=true 인 단계는 status 와 무관하게 'done' 으로 카운트 (체크박스 단축)
      const eff = s.completed ? 'done' : normalizeStatus(s.status);
      init[eff] = (init[eff] ?? 0) + 1;
    }
    return init;
  }, [selectedWf]);

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['workflows'] }),
    [queryClient],
  );

  // ── canvas coordinate helper ──────────────────────────────────────────────────
  const canvasCoords = useCallback((clientX: number, clientY: number) => {
    const el = scrollRef.current;
    if (!el) return { x: clientX, y: clientY };
    const rect = el.getBoundingClientRect();
    return {
      x: (clientX - rect.left + el.scrollLeft) / zoom,
      y: (clientY - rect.top  + el.scrollTop)  / zoom,
    };
  }, [zoom]);

  // ── mutations ─────────────────────────────────────────────────────────────────
  const createWorkflow = useMutation({
    mutationFn: ({ title, confluenceUrl }: { title: string; confluenceUrl?: string }) =>
      workflowsApi.create({ title, confluenceUrl }),
    onSuccess: (res) => {
      invalidate();
      setSelectedId(res.data.id);
      setShowCreateWf(false);
      setNewWfTitle('');
      setNewWfConfluence('');
    },
  });

  const updateWorkflow = useMutation({
    mutationFn: ({ id, d }: { id: string; d: WorkflowUpdate }) => workflowsApi.update(id, d),
    onSuccess: () => { invalidate(); setEditingWfId(null); setEditingHeaderTitle(false); },
  });

  const deleteWorkflow = useMutation({
    mutationFn: (id: string) => workflowsApi.delete(id),
    onSuccess: (_, id) => { invalidate(); if (selectedId === id) setSelectedId(null); },
  });

  const addStep = useMutation({
    mutationFn: ({ wfId, count }: { wfId: string; count: number }) =>
      workflowsApi.createStep(wfId, {
        title: `단계 ${count + 1}`,
        posX: 80 + (count % 4) * (CARD_W + 80),
        posY: 80 + Math.floor(count / 4) * (CARD_H + 60),
        orderIndex: count,
      }),
    onSuccess: invalidate,
  });

  const updateStep = useMutation({
    mutationFn: ({ wfId, stepId, stepData }: { wfId: string; stepId: string; stepData: WorkflowStepUpdate }) =>
      workflowsApi.updateStep(wfId, stepId, stepData),
    onSuccess: invalidate,
  });

  const deleteStep = useMutation({
    mutationFn: ({ wfId, stepId }: { wfId: string; stepId: string }) =>
      workflowsApi.deleteStep(wfId, stepId),
    onSuccess: () => { invalidate(); setEditingStep(null); },
  });

  const createEdge = useMutation({
    mutationFn: ({ wfId, sourceStepId, targetStepId }: { wfId: string; sourceStepId: string; targetStepId: string }) =>
      workflowsApi.createEdge(wfId, { sourceStepId, targetStepId }),
    onSuccess: invalidate,
  });

  const deleteEdge = useMutation({
    mutationFn: ({ wfId, edgeId }: { wfId: string; edgeId: string }) =>
      workflowsApi.deleteEdge(wfId, edgeId),
    onSuccess: invalidate,
  });

  // ── zoom: ctrl+wheel ──────────────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((prev) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prev - e.deltaY * 0.002)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ── Escape cancels pending edge ───────────────────────────────────────────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setPendingEdge(null); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);

  // ── dropdown close on outside click ──────────────────────────────────────────
  useEffect(() => {
    const h = () => { setTypeMenuStep(null); setStatusMenuStep(null); };
    document.addEventListener('click', h);
    return () => document.removeEventListener('click', h);
  }, []);

  // ── helpers ───────────────────────────────────────────────────────────────────
  const getPos = (step: WorkflowStep) => localPos[step.id] ?? { x: step.posX, y: step.posY };

  const handleAutoLayout = async () => {
    if (!selectedWf) return;
    const positions = computeAutoLayout(selectedWf.steps, selectedWf.edges);
    // 1. 로컬 위치 즉시 반영 — 사용자가 변화를 바로 보게.
    setLocalPos((prev) => ({ ...prev, ...positions }));
    // 2. 백엔드는 Promise.all 로 병렬 호출하고, invalidate 는 마지막에 한 번만.
    //    각 mutation 을 따로 .mutate 하면 invalidate 가 N번 → N번 refetch 라 비효율.
    const targets = selectedWf.steps
      .map((s) => ({ s, p: positions[s.id] }))
      .filter((t) => t.p);
    try {
      await Promise.all(
        targets.map(({ s, p }) =>
          workflowsApi.updateStep(selectedWf.id, s.id, { posX: p.x, posY: p.y }),
        ),
      );
      invalidate();
      toast.success('자동 배치 완료', `${targets.length}개 단계 위치 갱신`);
    } catch (e) {
      toast.error('자동 배치 실패', e instanceof Error ? e.message : String(e));
    }
  };

  const handleCardPointerDown = (e: React.PointerEvent<HTMLDivElement>, step: WorkflowStep) => {
    if (pendingEdge) return;
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const pos = getPos(step);
    setDragging({ stepId: step.id, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y });
  };

  const handleCardPointerMove = (e: React.PointerEvent<HTMLDivElement>, step: WorkflowStep) => {
    if (!dragging || dragging.stepId !== step.id) return;
    const dx = (e.clientX - dragging.startX) / zoom;
    const dy = (e.clientY - dragging.startY) / zoom;
    setLocalPos((prev) => ({
      ...prev,
      [step.id]: { x: Math.max(0, dragging.origX + dx), y: Math.max(0, dragging.origY + dy) },
    }));
  };

  const handleCardPointerUp = (step: WorkflowStep) => {
    if (!dragging || dragging.stepId !== step.id) return;
    const pos = localPos[step.id];
    if (pos && selectedWf) {
      updateStep.mutate({ wfId: selectedWf.id, stepId: step.id, stepData: { posX: pos.x, posY: pos.y } });
    }
    setDragging(null);
  };

  // ── port drag handlers ────────────────────────────────────────────────────────
  const handlePortPointerDown = (e: React.PointerEvent<HTMLDivElement>, step: WorkflowStep) => {
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = canvasCoords(e.clientX, e.clientY);
    const pos = getPos(step);
    setPendingEdge({
      sourceStepId: step.id,
      fromX: pos.x + CARD_W,
      fromY: pos.y + CARD_H / 2,
      toX: x,
      toY: y,
    });
  };

  const handlePortPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pendingEdge) return;
    const { x, y } = canvasCoords(e.clientX, e.clientY);
    setPendingEdge((prev) => prev ? { ...prev, toX: x, toY: y } : null);
  };

  const handlePortPointerUp = (e: React.PointerEvent<HTMLDivElement>, step: WorkflowStep) => {
    if (!pendingEdge || pendingEdge.sourceStepId !== step.id) return;
    const { x, y } = canvasCoords(e.clientX, e.clientY);
    const target = selectedWf?.steps.find((s) => {
      if (s.id === step.id) return false;
      const sp = getPos(s);
      return Math.hypot(x - sp.x, y - (sp.y + CARD_H / 2)) <= PORT_HIT;
    });
    if (target && selectedWf) {
      createEdge.mutate({ wfId: selectedWf.id, sourceStepId: step.id, targetStepId: target.id });
    }
    setPendingEdge(null);
  };

  const startEditStep = (step: WorkflowStep) => {
    if (pendingEdge) return;
    setEditingStep(step.id);
    setStepTitle(step.title);
    setStepDesc(step.description ?? '');
    setStepRefType(step.referenceType ?? '');
    setStepRefId(step.referenceId ?? '');
  };

  const saveEditStep = () => {
    if (!editingStep || !selectedWf) return;
    updateStep.mutate({
      wfId: selectedWf.id,
      stepId: editingStep,
      stepData: {
        title: stepTitle.trim() || '단계',
        description: stepDesc || undefined,
        referenceType: stepRefType || undefined,
        referenceId: stepRefType && stepRefId.trim() ? stepRefId.trim() : undefined,
      },
    });
    setEditingStep(null);
  };

  // ── render ────────────────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex overflow-hidden bg-background">
      {/* ── Left sidebar ── */}
      <aside className="w-64 flex-shrink-0 border-r border-border flex flex-col bg-card">
        <div className="flex items-center justify-between px-4 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <GitFork className="w-4 h-4 text-primary" />
            <span className="font-semibold text-sm">워크플로우</span>
          </div>
          <button
            onClick={() => setShowCreateWf(true)}
            className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        {showCreateWf && (
          <div className="px-3 py-3 border-b border-border bg-secondary/30 space-y-2">
            <input
              type="text"
              value={newWfTitle}
              onChange={(e) => setNewWfTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newWfTitle.trim()) {
                  createWorkflow.mutate({
                    title: newWfTitle.trim(),
                    confluenceUrl: newWfConfluence.trim() || undefined,
                  });
                }
                if (e.key === 'Escape') { setShowCreateWf(false); setNewWfTitle(''); setNewWfConfluence(''); }
              }}
              placeholder="워크플로우 이름"
              className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded focus:outline-none focus:border-primary"
              autoFocus
            />
            <input
              type="url"
              value={newWfConfluence}
              onChange={(e) => setNewWfConfluence(e.target.value)}
              placeholder="Confluence URL (선택)"
              className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded focus:outline-none focus:border-primary"
            />
            <div className="flex gap-2">
              <button
                onClick={() => newWfTitle.trim() && createWorkflow.mutate({
                  title: newWfTitle.trim(),
                  confluenceUrl: newWfConfluence.trim() || undefined,
                })}
                disabled={!newWfTitle.trim()}
                className="flex-1 px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
              >
                생성
              </button>
              <button
                onClick={() => { setShowCreateWf(false); setNewWfTitle(''); setNewWfConfluence(''); }}
                className="flex-1 px-2 py-1 text-xs bg-secondary text-foreground rounded hover:bg-secondary/80"
              >
                취소
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto py-2">
          {workflows.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center mt-10 px-4 leading-relaxed">
              워크플로우가 없습니다.
              <br />
              <button onClick={() => setShowCreateWf(true)} className="mt-2 text-primary hover:underline">
                + 새로 만들기
              </button>
            </p>
          ) : (
            workflows.map((wf) => {
              const doneCount = wf.steps.filter((s) => s.completed).length;
              const total = wf.steps.length;
              const isSelected = selectedId === wf.id;
              const isRenamingThis = editingWfId === wf.id;

              return (
                <div key={wf.id} className={`group relative ${isSelected ? 'bg-primary/10' : 'hover:bg-secondary'}`}>
                  {isRenamingThis ? (
                    <div className="px-3 py-2 flex items-center gap-1.5">
                      <input
                        value={wfEditTitle}
                        onChange={(e) => setWfEditTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && wfEditTitle.trim())
                            updateWorkflow.mutate({ id: wf.id, d: { title: wfEditTitle.trim() } });
                          if (e.key === 'Escape') setEditingWfId(null);
                        }}
                        className="flex-1 min-w-0 px-2 py-1 text-sm bg-background border border-primary rounded focus:outline-none"
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                      />
                      <button
                        onClick={() => wfEditTitle.trim() && updateWorkflow.mutate({ id: wf.id, d: { title: wfEditTitle.trim() } })}
                        className="p-1 rounded text-emerald-400 hover:bg-emerald-500/10"
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => setEditingWfId(null)} className="p-1 rounded text-muted-foreground hover:bg-secondary">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div
                      className="flex items-center gap-2 px-3 py-2.5 cursor-pointer"
                      onClick={() => setSelectedId(wf.id)}
                    >
                      <ChevronRight
                        className={`w-3 h-3 flex-shrink-0 transition-transform ${isSelected ? 'rotate-90 text-primary' : 'text-muted-foreground'}`}
                      />
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium truncate ${isSelected ? 'text-primary' : ''}`}>{wf.title}</p>
                        <p className="text-xs text-muted-foreground">{total}단계 · {doneCount}/{total} 완료</p>
                        {total > 0 && (
                          <div className="mt-1 h-1 bg-secondary rounded-full overflow-hidden">
                            <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${(doneCount / total) * 100}%` }} />
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditingWfId(wf.id); setWfEditTitle(wf.title); }}
                          className="p-1 rounded hover:bg-blue-500/20 hover:text-blue-400 text-muted-foreground"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`"${wf.title}" 워크플로우를 삭제할까요?`)) deleteWorkflow.mutate(wf.id);
                          }}
                          className="p-1 rounded hover:bg-red-500/20 hover:text-red-400 text-muted-foreground"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* ── Main canvas ── */}
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {!selectedWf ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <GitFork className="w-16 h-16 mx-auto mb-4 text-muted-foreground/20" />
              <p className="text-muted-foreground mb-2">왼쪽에서 워크플로우를 선택하거나 새로 만드세요</p>
              <button onClick={() => setShowCreateWf(true)} className="text-sm text-primary hover:underline">
                + 새 워크플로우 만들기
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* ── Toolbar ── */}
            <div className="flex items-center justify-between px-5 py-2.5 border-b border-border bg-card flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                {editingHeaderTitle ? (
                  <>
                    <input
                      value={headerTitleDraft}
                      onChange={(e) => setHeaderTitleDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && headerTitleDraft.trim())
                          updateWorkflow.mutate({ id: selectedWf.id, d: { title: headerTitleDraft.trim() } });
                        if (e.key === 'Escape') setEditingHeaderTitle(false);
                      }}
                      className="text-base font-semibold bg-background border border-primary rounded px-2 py-0.5 focus:outline-none min-w-0 w-56"
                      autoFocus
                    />
                    <button
                      onClick={() => headerTitleDraft.trim() && updateWorkflow.mutate({ id: selectedWf.id, d: { title: headerTitleDraft.trim() } })}
                      className="p-1 rounded text-emerald-400 hover:bg-emerald-500/10"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setEditingHeaderTitle(false)} className="p-1 rounded text-muted-foreground hover:bg-secondary">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </>
                ) : (
                  <button
                    className="flex items-center gap-1.5 group/title min-w-0"
                    onClick={() => { setHeaderTitleDraft(selectedWf.title); setEditingHeaderTitle(true); }}
                  >
                    <h2 className="text-base font-semibold truncate group-hover/title:text-primary transition-colors">
                      {selectedWf.title}
                    </h2>
                    <Pencil className="w-3 h-3 text-muted-foreground/40 group-hover/title:text-primary transition-colors flex-shrink-0" />
                  </button>
                )}

                {/* Confluence 링크 — 설정되어 있으면 열기 + ✏ 로 인라인 편집, 없으면 + Confluence */}
                {editingHeaderConfluence ? (
                  <div className="flex items-center gap-1">
                    <input
                      type="url"
                      value={headerConfluenceDraft}
                      onChange={(e) => setHeaderConfluenceDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          updateWorkflow.mutate({
                            id: selectedWf.id,
                            d: { confluenceUrl: headerConfluenceDraft.trim() || undefined },
                          });
                          setEditingHeaderConfluence(false);
                        }
                        if (e.key === 'Escape') setEditingHeaderConfluence(false);
                      }}
                      placeholder="Confluence URL"
                      className="text-[11px] bg-background border border-primary rounded px-2 py-0.5 focus:outline-none w-64"
                      autoFocus
                    />
                    <button
                      onClick={() => {
                        updateWorkflow.mutate({
                          id: selectedWf.id,
                          d: { confluenceUrl: headerConfluenceDraft.trim() || undefined },
                        });
                        setEditingHeaderConfluence(false);
                      }}
                      className="p-1 rounded text-emerald-400 hover:bg-emerald-500/10"
                    >
                      <Check className="w-3 h-3" />
                    </button>
                    <button onClick={() => setEditingHeaderConfluence(false)} className="p-1 rounded text-muted-foreground hover:bg-secondary">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ) : selectedWf.confluenceUrl ? (
                  <div className="inline-flex items-center gap-0.5">
                    <a
                      href={selectedWf.confluenceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                      title={selectedWf.confluenceUrl}
                    >
                      <ExternalLink className="w-3 h-3" /> Confluence
                    </a>
                    <button
                      onClick={() => { setHeaderConfluenceDraft(selectedWf.confluenceUrl ?? ''); setEditingHeaderConfluence(true); }}
                      className="p-0.5 rounded text-muted-foreground/50 hover:text-primary hover:bg-secondary"
                      title="Confluence 링크 수정"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setHeaderConfluenceDraft(''); setEditingHeaderConfluence(true); }}
                    className="text-[11px] px-1.5 py-0.5 rounded-full border border-dashed border-border text-muted-foreground/70 hover:text-primary hover:border-primary/40 transition-colors inline-flex items-center gap-1"
                  >
                    <Link2 className="w-3 h-3" /> Confluence
                  </button>
                )}
                {/* 진행률 바 + 상태별 카운트 — 기획 게시판이라 진행 추적이 핵심 */}
                <div className="flex items-center gap-2 min-w-0">
                  <div className="flex h-1.5 w-32 rounded-full overflow-hidden bg-secondary/60">
                    {(STEP_STATUS_KEYS as WorkflowStepStatus[]).map((st) => {
                      const n = statusCounts[st];
                      const total = selectedWf.steps.length || 1;
                      if (n === 0) return null;
                      return (
                        <div
                          key={st}
                          className={`h-full ${STEP_STATUS[st].barCls}`}
                          style={{ width: `${(n / total) * 100}%` }}
                          title={`${STEP_STATUS[st].label}: ${n}`}
                        />
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] whitespace-nowrap">
                    <span className="text-muted-foreground">{selectedWf.steps.length}단계</span>
                    {(STEP_STATUS_KEYS as WorkflowStepStatus[]).filter((st) => statusCounts[st] > 0).map((st) => (
                      <span key={st} className={`px-1.5 py-0.5 rounded ${STEP_STATUS[st].cls}`}>
                        {STEP_STATUS[st].label} {statusCounts[st]}
                      </span>
                    ))}
                    <span className="text-muted-foreground/60">· 연결 {selectedWf.edges.length}</span>
                  </div>
                </div>
                {pendingEdge && (
                  <span className="text-xs px-2.5 py-1 bg-primary/10 text-primary border border-primary/30 rounded-full animate-pulse">
                    연결할 대상 포트에 드롭하세요 · Esc 취소
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5 flex-shrink-0">
                {/* zoom */}
                <div className="flex items-center gap-0.5 border border-border rounded-lg overflow-hidden">
                  <button onClick={() => setZoom((z) => Math.max(ZOOM_MIN, +(z - 0.1).toFixed(2)))}
                    className="px-2 py-1.5 hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
                    <ZoomOut className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => setZoom(1)}
                    className="px-2 py-1.5 text-xs hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors min-w-[42px]">
                    {Math.round(zoom * 100)}%
                  </button>
                  <button onClick={() => setZoom((z) => Math.min(ZOOM_MAX, +(z + 0.1).toFixed(2)))}
                    className="px-2 py-1.5 hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
                    <ZoomIn className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => setZoom(1)}
                    className="px-2 py-1.5 hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors border-l border-border">
                    <Maximize2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <button onClick={handleAutoLayout}
                  className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-border bg-background hover:bg-secondary text-foreground flex items-center gap-1.5 transition-colors">
                  <LayoutGrid className="w-3.5 h-3.5" />
                  자동 배치
                </button>
                <button
                  onClick={() => addStep.mutate({ wfId: selectedWf.id, count: selectedWf.steps.length })}
                  className="px-2.5 py-1.5 text-xs font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors flex items-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" />
                  단계 추가
                </button>
              </div>
            </div>

            {/* ── Canvas ── */}
            <div
              ref={scrollRef}
              className="flex-1 overflow-auto"
              style={{
                backgroundImage: 'radial-gradient(circle, hsl(var(--border)) 1px, transparent 1px)',
                backgroundSize: '24px 24px',
                cursor: pendingEdge ? 'crosshair' : 'default',
              }}
              onClick={() => { setTypeMenuStep(null); setStatusMenuStep(null); }}
            >
              <div style={{ width: CANVAS_W * zoom, height: CANVAS_H * zoom, position: 'relative' }}>
                <div
                  style={{
                    width: CANVAS_W, height: CANVAS_H,
                    transform: `scale(${zoom})`, transformOrigin: 'top left',
                    position: 'absolute', top: 0, left: 0,
                  }}
                >
                  {/* ── SVG layer: ports + edges + pending edge ── */}
                  <svg
                    className="absolute inset-0"
                    width={CANVAS_W}
                    height={CANVAS_H}
                    style={{ overflow: 'visible', pointerEvents: 'none' }}
                  >
                    <defs>
                      <marker id="wf-arrow" markerWidth="10" markerHeight="8" refX="8" refY="4" orient="auto">
                        <polygon points="0 0, 8 4, 0 8" fill="hsl(var(--muted-foreground))" opacity="0.75" />
                      </marker>
                      <marker id="wf-arrow-pending" markerWidth="10" markerHeight="8" refX="8" refY="4" orient="auto">
                        <polygon points="0 0, 8 4, 0 8" fill="hsl(var(--primary))" />
                      </marker>
                    </defs>

                    {/* 1. Port circles (behind edges) */}
                    {selectedWf.steps.map((step) => {
                      const pos = getPos(step);
                      const cy = pos.y + CARD_H / 2;
                      const tc = TYPE_SVG_COLOR[step.stepType] ?? TYPE_SVG_COLOR.action;
                      const hasOut = selectedWf.edges.some((e) => e.sourceStepId === step.id);
                      const hasIn  = selectedWf.edges.some((e) => e.targetStepId === step.id);
                      // highlight target port when pending edge is near it
                      const isHoverTarget = pendingEdge && pendingEdge.sourceStepId !== step.id &&
                        Math.hypot(pendingEdge.toX - pos.x, pendingEdge.toY - cy) <= PORT_HIT;
                      return (
                        <g key={`port-${step.id}`} style={{ pointerEvents: 'none' }}>
                          {/* left port — incoming */}
                          <circle
                            cx={pos.x} cy={cy} r={isHoverTarget ? PORT_R + 3 : PORT_R}
                            fill={isHoverTarget ? 'hsl(var(--primary))' : hasIn ? tc.fill : 'hsl(var(--card))'}
                            stroke={isHoverTarget ? 'hsl(var(--primary))' : hasIn ? tc.stroke : 'hsl(var(--border))'}
                            strokeWidth={isHoverTarget ? 2.5 : 2}
                            style={{ transition: 'r 0.1s, fill 0.1s' }}
                          />
                          {/* right port — outgoing */}
                          <circle
                            cx={pos.x + CARD_W} cy={cy} r={PORT_R}
                            fill={hasOut ? tc.fill : 'hsl(var(--card))'}
                            stroke={hasOut ? tc.stroke : 'hsl(var(--border))'}
                            strokeWidth={2}
                          />
                        </g>
                      );
                    })}

                    {/* 2. Existing edges (on top of port circles) — hover 시 중간에 X 버튼으로 안전하게 삭제 */}
                    {selectedWf.edges.map((edge) => {
                      const src = selectedWf.steps.find((s) => s.id === edge.sourceStepId);
                      const tgt = selectedWf.steps.find((s) => s.id === edge.targetStepId);
                      if (!src || !tgt) return null;
                      const sp = getPos(src);
                      const tp = getPos(tgt);
                      const sx = sp.x + CARD_W;
                      const sy = sp.y + CARD_H / 2;
                      const tx = tp.x;
                      const ty = tp.y + CARD_H / 2;
                      const mx = (sx + tx) / 2;
                      const my = (sy + ty) / 2;
                      const d = bezierPath(sx, sy, tx, ty);
                      return (
                        <g key={edge.id} className="group/edge" style={{ pointerEvents: 'all' }}>
                          {/* 넓은 hover 영역 (투명) */}
                          <path d={d} stroke="transparent" strokeWidth={16} fill="none" />
                          {/* 실제 라인 */}
                          <path
                            d={d}
                            stroke="hsl(var(--muted-foreground))"
                            strokeOpacity={0.55}
                            strokeWidth={1.8}
                            fill="none"
                            markerEnd="url(#wf-arrow)"
                            className="group-hover/edge:stroke-rose-400 group-hover/edge:stroke-[2.4px] transition-colors"
                            style={{ pointerEvents: 'none' }}
                          />
                          {/* hover 시에만 보이는 중간 X 버튼 — 클릭 한 번 더 필요해 실수 방지 */}
                          <g
                            className="opacity-0 group-hover/edge:opacity-100 transition-opacity"
                            style={{ cursor: 'pointer' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteEdge.mutate({ wfId: selectedWf.id, edgeId: edge.id });
                            }}
                          >
                            <circle cx={mx} cy={my} r={9} fill="hsl(var(--card))" stroke="hsl(var(--rose-400, 251 113 133))" strokeWidth={1.6} className="stroke-rose-400" />
                            <line x1={mx - 3.5} y1={my - 3.5} x2={mx + 3.5} y2={my + 3.5} stroke="currentColor" className="text-rose-500" strokeWidth={1.8} strokeLinecap="round" />
                            <line x1={mx + 3.5} y1={my - 3.5} x2={mx - 3.5} y2={my + 3.5} stroke="currentColor" className="text-rose-500" strokeWidth={1.8} strokeLinecap="round" />
                          </g>
                        </g>
                      );
                    })}

                    {/* 3. Pending edge preview */}
                    {pendingEdge && (
                      <path
                        d={bezierPath(pendingEdge.fromX, pendingEdge.fromY, pendingEdge.toX, pendingEdge.toY)}
                        stroke="hsl(var(--primary))"
                        strokeWidth={2}
                        strokeOpacity={0.8}
                        strokeDasharray="7 4"
                        fill="none"
                        markerEnd="url(#wf-arrow-pending)"
                        style={{ pointerEvents: 'none' }}
                      />
                    )}
                  </svg>

                  {/* ── Step cards ── */}
                  {selectedWf.steps.map((step) => {
                    const pos = getPos(step);
                    const isDraggingThis = dragging?.stepId === step.id;
                    const isEditing = editingStep === step.id;
                    const typeCfg = STEP_TYPE[step.stepType as WorkflowStepType] ?? STEP_TYPE.action;
                    const stepStatus = normalizeStatus(step.status);
                    const statusCfg = STEP_STATUS[stepStatus] ?? STEP_STATUS['todo'];
                    const isSourceOfPending = pendingEdge?.sourceStepId === step.id;

                    return (
                      <div
                        key={step.id}
                        style={{
                          position: 'absolute', left: pos.x, top: pos.y, width: CARD_W,
                          zIndex: isDraggingThis ? 20 : isEditing ? 15 : 1,
                        }}
                        className={`rounded-xl border-2 shadow-sm select-none bg-card transition-shadow ${typeCfg.border} ${
                          step.completed ? 'opacity-70' : ''
                        } ${isSourceOfPending ? 'ring-2 ring-primary/60 shadow-lg' : ''} ${
                          isDraggingThis ? 'shadow-xl opacity-90' : ''
                        }`}
                        onPointerDown={(e) => handleCardPointerDown(e, step)}
                        onPointerMove={(e) => handleCardPointerMove(e, step)}
                        onPointerUp={() => handleCardPointerUp(step)}
                      >
                        {/* Header */}
                        <div className={`flex items-center justify-between px-3 py-2 rounded-t-[10px] border-b border-border ${typeCfg.header} cursor-grab active:cursor-grabbing`}>
                          <div className="flex items-center gap-1.5" data-no-drag>
                            {/* type selector */}
                            <div className="relative" onClick={(e) => e.stopPropagation()}>
                              <button
                                onClick={() => { setTypeMenuStep(typeMenuStep === step.id ? null : step.id); setStatusMenuStep(null); }}
                                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${typeCfg.header} hover:brightness-110`}
                              >
                                <span className={`w-1.5 h-1.5 rounded-full ${typeCfg.dot} flex-shrink-0`} />
                                {typeCfg.icon}
                                <span className="text-foreground/70">{typeCfg.label}</span>
                              </button>
                              {typeMenuStep === step.id && (
                                <div className="absolute top-full left-0 mt-1 bg-card border border-border rounded-lg shadow-xl z-50 py-1 min-w-[150px]">
                                  {STEP_TYPE_KEYS.map((t) => (
                                    <button key={t}
                                      onClick={() => { if (selectedWf) updateStep.mutate({ wfId: selectedWf.id, stepId: step.id, stepData: { stepType: t } }); setTypeMenuStep(null); }}
                                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-secondary transition-colors ${step.stepType === t ? 'text-primary' : 'text-foreground'}`}
                                    >
                                      <span className={`w-1.5 h-1.5 rounded-full ${STEP_TYPE[t].dot}`} />
                                      {STEP_TYPE[t].icon}
                                      {STEP_TYPE[t].label}
                                      {step.stepType === t && <Check className="w-3 h-3 ml-auto" />}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                            {/* status selector */}
                            <div className="relative" onClick={(e) => e.stopPropagation()}>
                              <button
                                onClick={() => { setStatusMenuStep(statusMenuStep === step.id ? null : step.id); setTypeMenuStep(null); }}
                                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${statusCfg.cls}`}
                              >
                                {statusCfg.label}
                              </button>
                              {statusMenuStep === step.id && (
                                <div className="absolute top-full left-0 mt-1 bg-card border border-border rounded-lg shadow-xl z-50 py-1 min-w-[120px]">
                                  {STEP_STATUS_KEYS.map((st) => (
                                    <button key={st}
                                      onClick={() => { if (selectedWf) updateStep.mutate({ wfId: selectedWf.id, stepId: step.id, stepData: { status: st } }); setStatusMenuStep(null); }}
                                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-secondary transition-colors ${stepStatus === st ? 'font-semibold' : ''}`}
                                    >
                                      <span className={`px-1.5 py-0.5 rounded text-xs ${STEP_STATUS[st].cls}`}>{STEP_STATUS[st].label}</span>
                                      {stepStatus === st && <Check className="w-3 h-3 ml-auto text-primary" />}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1" data-no-drag>
                            <span className="text-xs text-muted-foreground/60 font-mono">#{selectedWf.steps.indexOf(step) + 1}</span>
                            <button
                              onClick={(e) => { e.stopPropagation(); if (confirm('이 단계를 삭제할까요?')) deleteStep.mutate({ wfId: selectedWf.id, stepId: step.id }); }}
                              className="p-0.5 rounded text-muted-foreground/30 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>

                        {/* Body */}
                        <div className="px-3 py-2.5" data-no-drag>
                          <div className="flex items-start gap-2 mb-1.5">
                            <button
                              onClick={(e) => { e.stopPropagation(); if (selectedWf) updateStep.mutate({ wfId: selectedWf.id, stepId: step.id, stepData: { completed: !step.completed } }); }}
                              className={`flex-shrink-0 w-[18px] h-[18px] rounded border-2 flex items-center justify-center transition-colors mt-0.5 ${step.completed ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-border hover:border-emerald-400'}`}
                            >
                              {step.completed && <Check className="w-2.5 h-2.5" />}
                            </button>
                            {isEditing ? (
                              <input
                                type="text"
                                value={stepTitle}
                                onChange={(e) => setStepTitle(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') saveEditStep(); if (e.key === 'Escape') setEditingStep(null); }}
                                onClick={(e) => e.stopPropagation()}
                                className="flex-1 text-sm font-medium bg-background border border-primary rounded px-1.5 py-0.5 focus:outline-none"
                                autoFocus
                              />
                            ) : (
                              <span
                                className={`flex-1 text-sm font-medium leading-tight cursor-text hover:text-primary ${step.completed ? 'line-through text-muted-foreground' : ''}`}
                                onClick={(e) => { e.stopPropagation(); startEditStep(step); }}
                              >
                                {step.title}
                              </span>
                            )}
                          </div>

                          {isEditing ? (
                            <div>
                              <textarea
                                value={stepDesc}
                                onChange={(e) => setStepDesc(e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => { if (e.key === 'Escape') setEditingStep(null); }}
                                placeholder="상세 내용 입력..."
                                rows={2}
                                className="w-full text-xs bg-background border border-border rounded px-2 py-1 focus:outline-none focus:border-primary resize-none"
                              />
                              {/* 연계 항목 선택 — 타입 선택 시 해당 카테고리의 실제 항목 목록을 드롭다운으로 노출 */}
                              <div className="mt-1.5 space-y-1" onClick={(e) => e.stopPropagation()}>
                                <select
                                  value={stepRefType}
                                  onChange={(e) => { setStepRefType(e.target.value); setStepRefId(''); }}
                                  className="w-full text-[11px] bg-background border border-border rounded px-2 py-1 focus:outline-none focus:border-primary text-muted-foreground"
                                >
                                  <option value="">— 연계 항목 없음 —</option>
                                  {Object.entries(REFERENCE_TYPE_LABELS).map(([k, v]) => (
                                    <option key={k} value={k}>{v}</option>
                                  ))}
                                </select>
                                {stepRefType && (
                                  <ReferenceSelect
                                    type={stepRefType}
                                    value={stepRefId}
                                    onChange={setStepRefId}
                                  />
                                )}
                              </div>
                              <div className="flex gap-1 mt-1.5">
                                <button onClick={(e) => { e.stopPropagation(); saveEditStep(); }}
                                  className="flex-1 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors">
                                  저장
                                </button>
                                <button onClick={(e) => { e.stopPropagation(); setEditingStep(null); }}
                                  className="px-2 py-1 text-xs bg-secondary rounded hover:bg-secondary/80 transition-colors">
                                  <X className="w-3 h-3" />
                                </button>
                              </div>
                            </div>
                          ) : step.description ? (
                            <p
                              className="text-xs text-muted-foreground leading-relaxed line-clamp-2 cursor-text hover:text-foreground/80"
                              onClick={(e) => { e.stopPropagation(); startEditStep(step); }}
                            >
                              {step.description}
                            </p>
                          ) : (
                            <p className="text-xs text-muted-foreground/30 italic cursor-text"
                              onClick={(e) => { e.stopPropagation(); startEditStep(step); }}>
                              내용 입력...
                            </p>
                          )}
                          {/* 연계 항목 배지 (편집 모드 아닐 때) */}
                          {!isEditing && step.referenceType && (
                            <div className="mt-1.5 pt-1.5 border-t border-border/50 flex items-center gap-1">
                              <Link2 className="w-2.5 h-2.5 text-primary/60 flex-shrink-0" />
                              <span className="text-[10px] text-primary/70 font-medium">
                                {REFERENCE_TYPE_LABELS[step.referenceType] ?? step.referenceType}
                              </span>
                            </div>
                          )}
                        </div>

                        {/* Right port drag handle */}
                        <div
                          data-no-drag
                          style={{
                            position: 'absolute', right: -8, top: '50%',
                            transform: 'translateY(-50%)',
                            width: 16, height: 24,
                            cursor: 'crosshair', zIndex: 10,
                          }}
                          onPointerDown={(e) => handlePortPointerDown(e, step)}
                          onPointerMove={(e) => handlePortPointerMove(e)}
                          onPointerUp={(e) => handlePortPointerUp(e, step)}
                        />
                      </div>
                    );
                  })}

                  {selectedWf.steps.length === 0 && (
                    <div className="absolute inset-0 flex items-center justify-center" style={{ pointerEvents: 'none' }}>
                      <p className="text-muted-foreground/30 text-sm">"단계 추가" 버튼으로 워크플로우를 구성하세요</p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="absolute bottom-4 right-4 text-xs text-muted-foreground/40 pointer-events-none">
              Ctrl + 스크롤로 줌 · 우측 포트 드래그로 연결
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// ─── Reference 항목 드롭다운 ───────────────────────────────────────────────────
// type 별로 적합한 hook 을 호출해 실제 항목 목록을 보여준다. 사용자가 UUID 를
// 직접 외워서 입력하지 않아도 되게 함.
interface ReferenceSelectProps {
  type: string;
  value: string;
  onChange: (id: string) => void;
}

function ReferenceSelect({ type, value, onChange }: ReferenceSelectProps) {
  const { data: clusters } = useClusters();
  const { data: workItemsData } = useWorkItems();
  const { data: playbooksData } = usePlaybooks();
  const { data: workGuidesData } = useWorkGuides();
  const { data: metricCardsData } = useMetricCards();

  // 각 hook 의 반환 형태가 제각각이라 분기로 정규화한다.
  // - useClusters / usePlaybooks / useMetricCards 는 배열 자체를 돌려줌
  // - useWorkItems / useWorkGuides 는 { data: [...] } 형태. WorkItem 은 type 으로 issue/task 구분.
  const options = useMemo<{ id: string; label: string }[]>(() => {
    const allWorkItems = workItemsData?.data ?? [];
    switch (type) {
      case 'cluster':
        return (clusters ?? []).map((c) => ({ id: c.id, label: c.name }));
      case 'issue':
        return allWorkItems.filter((w) => w.type === 'issue').map((i) => ({ id: i.id, label: i.content }));
      case 'task':
        return allWorkItems.filter((w) => w.type === 'task').map((t) => ({ id: t.id, label: t.content }));
      case 'playbook':
        return (playbooksData ?? []).map((p) => ({ id: p.id, label: p.name }));
      case 'work_guide':
        return (workGuidesData?.data ?? []).map((w) => ({ id: w.id, label: w.title }));
      case 'metric_card':
        return (metricCardsData ?? []).map((m) => ({ id: m.id, label: m.title }));
      default:
        return [];
    }
  }, [type, clusters, workItemsData, playbooksData, workGuidesData, metricCardsData]);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full text-[11px] bg-background border border-border rounded px-2 py-1 focus:outline-none focus:border-primary"
    >
      <option value="">— 항목 선택 —</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>{o.label}</option>
      ))}
      {/* 현재 ID 가 목록에 없으면(삭제됐거나 아직 로드 안 됨) 그대로 보여줘 잃지 않도록 */}
      {value && !options.some((o) => o.id === value) && (
        <option value={value}>(존재 확인 안됨) {value}</option>
      )}
    </select>
  );
}
