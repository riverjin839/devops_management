import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronLeft, ChevronRight, RotateCcw, Plus, CalendarClock, Clock3, User, Users, X, Trash2, AlertTriangle,
  ClipboardList,
} from 'lucide-react';
import {
  useHomeWorkItems, useTimeBlocksRange, useCreateTimeBlock, useUpdateTimeBlock, useDeleteTimeBlock,
} from '@/hooks/useWorkItems';
import { useAssignees } from '@/hooks/useAssignees';
import { useToday } from '@/hooks/useToday';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/components/common';
import { Button } from '@/components/ui/button';
import { stripHtml, cn, assigneeNames } from '@/lib/utils';
import { WORK_ITEM_TYPE_CONFIG } from '@/components/work-items/workItemKanbanUtils';
import { QuickAddTaskModal } from './QuickAddTaskModal';
import type { WorkItem, KanbanStatus, WorkItemTimeBlock } from '@/types';

interface DayScheduleBoardProps {
  selectedClusterId: string | null;
}

// ── date / time helpers ───────────────────────────────────────────────────────
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(dateStr: string, delta: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  return dateKey(d);
}
function fmtLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const week = ['일', '월', '화', '수', '목', '금', '토'];
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} (${week[d.getDay()]})`;
}
/** ISO 문자열에 실제 시각 성분(T HH:mm)이 있는지 — 없으면 "시간 미지정". */
function hasClock(iso?: string | null): boolean {
  return !!iso && /T\d{2}:\d{2}/.test(iso);
}
function parseLocal(iso?: string | null): Date | null {
  if (!iso) return null;
  const norm = iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z';
  const d = new Date(norm);
  return Number.isNaN(d.getTime()) ? null : d;
}
function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function snap15(min: number): number {
  return Math.round(min / 15) * 15;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// D-011: 상태색은 semantic status 토큰 경유. done=완료(healthy), in_progress=warning,
// todo=info, backlog=unknown(중립), review_test 는 의미색이 없는 구분 상태라 chart 토큰 사용.
const STATUS_STYLE: Record<KanbanStatus, { dot: string; bar: string; tint: string }> = {
  backlog:     { dot: 'bg-status-unknown', bar: 'bg-status-unknown', tint: 'bg-status-unknown/10' },
  todo:        { dot: 'bg-status-info',    bar: 'bg-status-info',    tint: 'bg-status-info/10' },
  in_progress: { dot: 'bg-status-warning', bar: 'bg-status-warning', tint: 'bg-status-warning/10' },
  review_test: { dot: 'bg-chart-4',        bar: 'bg-chart-4',        tint: 'bg-chart-4/10' },
  done:        { dot: 'bg-status-healthy', bar: 'bg-status-healthy', tint: 'bg-status-healthy/10' },
};

// 담당자 구분용 categorical 색 — 의미(성공/실패)가 아닌 '사람 구분'이므로 chart-N 토큰(D-005).
const ASSIGNEE_PALETTE = [
  'bg-chart-1/20 text-chart-1',
  'bg-chart-2/20 text-chart-2',
  'bg-chart-3/20 text-chart-3',
  'bg-chart-4/20 text-chart-4',
  'bg-chart-5/20 text-chart-5',
  'bg-chart-6/20 text-chart-6',
  'bg-chart-7/20 text-chart-7',
];
function assigneeColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return ASSIGNEE_PALETTE[h % ASSIGNEE_PALETTE.length];
}
// ── grid geometry ───────────────────────────────────────────────────────────
const HOUR_PX = 56;
const PX_PER_MIN = HOUR_PX / 60;
const MIN_DURATION = 15;
const DEFAULT_DURATION = 60;

/** 하루에 표시할 세션(= 시간 블록 or 시작일 암묵 세션). */
interface Session {
  key: string;          // block:<id> | implicit:<itemId>
  item: WorkItem;
  startMin: number;
  endMin: number;
  block?: WorkItemTimeBlock;  // 있으면 블록 기반, 없으면 implicit
}

/** 겹치는 세션을 열(column)로 분할 — left/width 계산용. */
function computeColumns(sessions: Session[]): Map<string, { col: number; cols: number }> {
  const out = new Map<string, { col: number; cols: number }>();
  const sorted = [...sessions].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  let cluster: Session[] = [];
  let clusterEnd = -1;

  const flush = () => {
    if (!cluster.length) return;
    const colEnd: number[] = []; // 각 열의 마지막 endMin
    const assigned: Record<string, number> = {};
    for (const s of cluster) {
      let col = colEnd.findIndex((e) => e <= s.startMin);
      if (col === -1) { col = colEnd.length; colEnd.push(s.endMin); }
      else colEnd[col] = s.endMin;
      assigned[s.key] = col;
    }
    const cols = colEnd.length;
    for (const s of cluster) out.set(s.key, { col: assigned[s.key], cols });
    cluster = [];
    clusterEnd = -1;
  };

  for (const s of sorted) {
    if (cluster.length && s.startMin >= clusterEnd) flush();
    cluster.push(s);
    clusterEnd = Math.max(clusterEnd, s.endMin);
  }
  flush();
  return out;
}

type ScheduleScope = 'individual' | 'all';
interface ScheduleScopeState { scope: ScheduleScope; selectedName: string }
type DragMode = 'move' | 'top' | 'bottom';
interface DragState {
  key: string;
  mode: DragMode;
  startY: number;
  origStart: number;
  origEnd: number;
  curStart: number;
  curEnd: number;
  moved: boolean;
}

export function DayScheduleBoard({ selectedClusterId }: DayScheduleBoardProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const todayStr = useToday();  // 자정 넘기면 자동 갱신
  const [viewDate, setViewDate] = useState(todayStr);
  const isToday = viewDate === todayStr;

  // 현재 시각 인디케이터(빨간 now 라인) — 30초마다 갱신해 상시 화면에서도 실제 시각을 따라간다.
  const [nowMin, setNowMin] = useState(() => new Date().getHours() * 60 + new Date().getMinutes());
  useEffect(() => {
    const id = window.setInterval(() => {
      setNowMin(new Date().getHours() * 60 + new Date().getMinutes());
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);

  const [quickAdd, setQuickAdd] = useState<{ time: string; assignee?: string } | null>(null);
  const [addMenu, setAddMenu] = useState<{ minute: number; y: number } | null>(null);

  const currentUser = useAuthStore((s) => s.user);
  const myName = (currentUser?.displayName?.trim() || currentUser?.username || '').trim();

  // 담당자 순환 전환용 전체 목록(가나다순) — 화살표로 "나만" 자리를 다른 사람으로 바꿀 때 사용.
  const { data: assigneesData } = useAssignees();
  const namesList = useMemo(() => {
    const names = (assigneesData ?? []).map((a) => a.name).filter(Boolean);
    return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b, 'ko'));
  }, [assigneesData]);

  const scopeKey = `k8s:dayScheduleScope:${currentUser?.username ?? 'guest'}`;
  // 구버전 값('me'/'all' 문자열) → 신버전({scope,selectedName}) 마이그레이션.
  const readScopeState = useCallback((): ScheduleScopeState => {
    try {
      const raw = localStorage.getItem(scopeKey);
      if (raw === 'all') return { scope: 'all', selectedName: myName };
      if (raw === 'me' || !raw) return { scope: 'individual', selectedName: myName };
      const parsed = JSON.parse(raw) as Partial<ScheduleScopeState>;
      if (parsed && (parsed.scope === 'all' || parsed.scope === 'individual')) {
        return { scope: parsed.scope, selectedName: parsed.selectedName || myName };
      }
    } catch { /* noop */ }
    return { scope: 'individual', selectedName: myName };
  }, [scopeKey, myName]);

  const [scope, setScope] = useState<ScheduleScope>(() => readScopeState().scope);
  const [selectedName, setSelectedName] = useState<string>(() => readScopeState().selectedName);
  useEffect(() => {
    const s = readScopeState();
    setScope(s.scope);
    setSelectedName(s.selectedName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  const persistScope = (next: ScheduleScopeState) => {
    try { localStorage.setItem(scopeKey, JSON.stringify(next)); } catch { /* noop */ }
  };
  const changeScope = (next: ScheduleScope) => {
    setScope(next);
    persistScope({ scope: next, selectedName });
  };
  /** 화살표 순환 — namesList 안에서 selectedName 을 ±1 이동, 개별 모드로 전환. */
  const cycleSelectedName = (dir: 1 | -1) => {
    if (namesList.length === 0) return;
    const curIdx = namesList.indexOf(selectedName);
    // 현재 선택이 목록에 없으면(-1) 첫 이동은 dir 방향의 끝(다음=첫번째 / 이전=마지막)으로 —
    // base 0 에서 계산하면 '다음' 이 index 0 을 건너뛰던 문제 회피.
    const nextIdx = curIdx < 0
      ? (dir === 1 ? 0 : namesList.length - 1)
      : (curIdx + dir + namesList.length) % namesList.length;
    const next = namesList[nextIdx];
    setSelectedName(next);
    setScope('individual');
    persistScope({ scope: 'individual', selectedName: next });
  };
  const meOnly = scope === 'individual';

  const { data: workItemsData, isLoading, isError, refetch } = useHomeWorkItems();
  const { data: dayBlocks = [] } = useTimeBlocksRange(viewDate, viewDate);
  const createBlock = useCreateTimeBlock();
  const updateBlock = useUpdateTimeBlock();
  const deleteBlock = useDeleteTimeBlock();

  const allItems = useMemo(() => workItemsData?.data ?? [], [workItemsData]);

  // 이 날에 걸치는 (필터 통과) 업무 — 미지정/세션 분류의 모집단.
  const spanItems = useMemo<WorkItem[]>(() => {
    const todayKey = dateKey(new Date());
    const out: WorkItem[] = [];
    for (const w of allItems) {
      if (selectedClusterId && w.clusterId !== selectedClusterId) continue;
      if (meOnly && (!selectedName || !assigneeNames(w).includes(selectedName))) continue;
      // 완료 항목도 남긴다(흐리게 — 하루 회고용). 단 span 은 완료일까지만(레거시 완료일
      // 미상이면 시작일 하루만) 잡아 과거 날짜에 무한정 끌리지 않게 한다.
      const isDone = w.kanbanStatus === 'done';
      const startD = parseLocal(w.startedAt);
      if (!startD) continue;
      const startKey = dateKey(startD);
      const closedD = parseLocal(w.closedAt);
      let endKey = closedD ? dateKey(closedD) : (isDone ? startKey : todayKey);
      if (endKey < startKey) endKey = startKey;
      const hasBlockToday = dayBlocks.some((b) => b.workItemId === w.id && b.blockDate === viewDate);
      if (hasBlockToday || (viewDate >= startKey && viewDate <= endKey)) out.push(w);
    }
    return out;
  }, [allItems, selectedClusterId, meOnly, selectedName, dayBlocks, viewDate]);

  const itemById = useMemo(() => {
    const m = new Map<string, WorkItem>();
    for (const w of spanItems) m.set(w.id, w);
    return m;
  }, [spanItems]);

  // 세션(그리드) / 미지정(하단) 분리.
  const { sessions, allDay } = useMemo(() => {
    const todayKey = dateKey(new Date());
    const ses: Session[] = [];
    const unscheduled: WorkItem[] = [];
    const blocksToday = dayBlocks.filter((b) => b.blockDate === viewDate && itemById.has(b.workItemId));
    const blocksByItem = new Map<string, WorkItemTimeBlock[]>();
    for (const b of blocksToday) {
      const arr = blocksByItem.get(b.workItemId);
      if (arr) arr.push(b); else blocksByItem.set(b.workItemId, [b]);
    }
    for (const w of spanItems) {
      const ib = blocksByItem.get(w.id);
      if (ib && ib.length) {
        for (const b of ib) {
          ses.push({ key: `block:${b.id}`, item: w, startMin: b.startMinute, endMin: b.endMinute, block: b });
        }
        continue;
      }
      const startD = parseLocal(w.startedAt);
      if (!startD) continue;
      const startKey = dateKey(startD);
      if (viewDate === startKey && hasClock(w.startedAt)) {
        const sMin = startD.getHours() * 60 + startD.getMinutes();
        ses.push({ key: `implicit:${w.id}`, item: w, startMin: sMin, endMin: Math.min(1440, sMin + DEFAULT_DURATION) });
      } else {
        // 시작일이 아니거나 시각 미지정 → 진행 중/미지정 (하단)
        const closedD = parseLocal(w.closedAt);
        let endKey = closedD ? dateKey(closedD) : todayKey;
        if (endKey < startKey) endKey = startKey;
        if (viewDate >= startKey && viewDate <= endKey) unscheduled.push(w);
      }
    }
    return { sessions: ses, allDay: unscheduled };
  }, [spanItems, dayBlocks, viewDate, itemById]);

  // 드래그 미리보기 override (key → {startMin,endMin})
  const [preview, setPreview] = useState<Record<string, { startMin: number; endMin: number }>>({});
  const drag = useRef<DragState | null>(null);

  const effSessions = useMemo(
    () => sessions.map((s) => preview[s.key] ? { ...s, ...preview[s.key] } : s),
    [sessions, preview],
  );

  // 표시 시간 범위.
  const { startHour, endHour } = useMemo(() => {
    let lo = 8;
    let hi = 19;
    for (const s of effSessions) {
      lo = Math.min(lo, Math.floor(s.startMin / 60));
      hi = Math.max(hi, Math.ceil(s.endMin / 60));
    }
    return { startHour: clamp(lo, 0, 23), endHour: clamp(hi, 1, 24) };
  }, [effSessions]);
  const hours = useMemo(
    () => Array.from({ length: endHour - startHour + 1 }, (_, i) => startHour + i),
    [startHour, endHour],
  );
  const gridHeight = (endHour - startHour) * HOUR_PX;
  const yOf = useCallback((min: number) => (min - startHour * 60) * PX_PER_MIN, [startHour]);

  const columns = useMemo(() => computeColumns(effSessions), [effSessions]);

  const laneRef = useRef<HTMLDivElement>(null);
  const openItem = (id: string) => navigate(`/tasks-mgmt/${id}`);

  // ── 드래그 (이동 / 리사이즈) ────────────────────────────────────────────────
  const beginDrag = (e: React.MouseEvent, s: Session, mode: DragMode) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { key: s.key, mode, startY: e.clientY, origStart: s.startMin, origEnd: s.endMin, curStart: s.startMin, curEnd: s.endMin, moved: false };
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const deltaMin = snap15((e.clientY - d.startY) / PX_PER_MIN);
      if (Math.abs(e.clientY - d.startY) > 3) d.moved = true;
      let startMin = d.origStart;
      let endMin = d.origEnd;
      if (d.mode === 'move') {
        const dur = d.origEnd - d.origStart;
        startMin = clamp(d.origStart + deltaMin, 0, 1440 - dur);
        endMin = startMin + dur;
      } else if (d.mode === 'top') {
        startMin = clamp(d.origStart + deltaMin, 0, d.origEnd - MIN_DURATION);
      } else {
        endMin = clamp(d.origEnd + deltaMin, d.origStart + MIN_DURATION, 1440);
      }
      d.curStart = startMin;
      d.curEnd = endMin;
      setPreview((p) => ({ ...p, [d.key]: { startMin, endMin } }));
    };
    const onUp = () => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      const sess = sessions.find((s) => s.key === d.key);
      // 이동량이 거의 없으면 클릭으로 간주 → 상세 열기
      if (!d.moved) {
        setPreview((p) => { const n = { ...p }; delete n[d.key]; return n; });
        if (sess) openItem(sess.item.id);
        return;
      }
      if (!sess) {
        setPreview((p) => { const n = { ...p }; delete n[d.key]; return n; });
        return;
      }
      const startMin = snap15(d.curStart);
      const endMin = Math.max(startMin + MIN_DURATION, snap15(d.curEnd));
      const clearPv = () => setPreview((p) => { const n = { ...p }; delete n[d.key]; return n; });
      if (sess.block) {
        updateBlock.mutate(
          { blockId: sess.block.id, data: { startMinute: startMin, endMinute: endMin } },
          { onSuccess: () => { clearPv(); }, onError: (err) => { clearPv(); toast.error('시간 변경 실패', String(err)); } },
        );
      } else {
        // implicit → 블록으로 승격(생성)
        createBlock.mutate(
          { itemId: sess.item.id, data: { blockDate: viewDate, startMinute: startMin, endMinute: endMin } },
          { onSuccess: () => { clearPv(); }, onError: (err) => { clearPv(); toast.error('블록 생성 실패', String(err)); } },
        );
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [sessions, viewDate, updateBlock, createBlock, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  // 빈 영역 클릭 → 블록 추가 메뉴(기존 업무) 또는 새 업무.
  const onLaneClick = (e: React.MouseEvent) => {
    if (drag.current) return;
    if (e.target !== laneRef.current) return; // 세션 위 클릭은 무시
    const rect = laneRef.current!.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const minute = snap15(clamp(startHour * 60 + y / PX_PER_MIN, 0, 1440 - MIN_DURATION));
    setAddMenu({ minute, y });
  };

  const addBlockTo = (item: WorkItem, minute: number) => {
    const endMin = Math.min(1440, minute + DEFAULT_DURATION);
    createBlock.mutate(
      { itemId: item.id, data: { blockDate: viewDate, startMinute: minute, endMinute: endMin } },
      {
        onSuccess: () => { setAddMenu(null); toast.success('시간 블록 추가', `${item.title || '업무'} · ${fmtMin(minute)}–${fmtMin(endMin)}`); },
        onError: (err) => toast.error('블록 추가 실패', String(err)),
      },
    );
  };

  const removeBlock = (block: WorkItemTimeBlock) => {
    deleteBlock.mutate(block.id, {
      onSuccess: () => toast.success('시간 블록 삭제'),
      onError: (err) => toast.error('삭제 실패', String(err)),
    });
  };

  const totalCount = sessions.length + allDay.length;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* header */}
      <div className="flex-none flex items-center gap-1.5 mb-2">
        <button onClick={() => setViewDate((d) => addDays(d, -1))}
          className="w-6 h-6 rounded-lg flex items-center justify-center hover:bg-secondary text-muted-foreground hover:text-foreground" title="이전 날" aria-label="이전 날">
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        <div className="flex items-center gap-1.5 px-1">
          <CalendarClock className="w-3.5 h-3.5 text-primary flex-shrink-0" />
          <span className="text-sm font-semibold tabular-nums">
            {isToday ? `오늘 · ${fmtLabel(viewDate)}` : fmtLabel(viewDate)}
          </span>
        </div>
        <button onClick={() => setViewDate((d) => addDays(d, 1))}
          className="w-6 h-6 rounded-lg flex items-center justify-center hover:bg-secondary text-muted-foreground hover:text-foreground" title="다음 날" aria-label="다음 날">
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
        {!isToday && (
          <button onClick={() => setViewDate(todayStr)}
            className="w-6 h-6 rounded-lg flex items-center justify-center hover:bg-secondary text-muted-foreground hover:text-primary" title="오늘로 돌아가기" aria-label="오늘로 돌아가기">
            <RotateCcw className="w-3 h-3" />
          </button>
        )}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{totalCount}건</span>
        <button
          type="button"
          onClick={() => navigate('/tasks-mgmt')}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-border bg-secondary text-muted-foreground text-xs font-semibold hover:text-foreground hover:bg-secondary/80"
          title="업무 관리로 이동">
          <ClipboardList className="w-3 h-3" /> 업무 관리
        </button>
        <button
          onClick={() => setQuickAdd({ time: isToday ? `${String(Math.min(new Date().getHours(), 23)).padStart(2, '0')}:00` : '09:00', assignee: meOnly ? (selectedName || undefined) : undefined })}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-primary/30 bg-primary/10 text-primary text-xs font-semibold hover:bg-primary/20"
          title="업무 등록">
          <Plus className="w-3 h-3" /> 업무 등록
        </button>
      </div>

      {/* scope toggle — 개별 담당자는 화살표로 순환 전환(기본값=로그인 유저), "전체"는 별도 버튼 */}
      <div className="flex-none flex items-center gap-2 pb-2 mb-1">
        <div className="flex items-center rounded-lg border border-border overflow-hidden text-xs">
          <button
            onClick={() => cycleSelectedName(-1)}
            disabled={namesList.length === 0}
            title="이전 담당자"
            aria-label="이전 담당자"
            className="flex items-center justify-center w-6 py-1 border-r border-border hover:bg-secondary text-muted-foreground disabled:opacity-40 disabled:cursor-not-allowed">
            <ChevronLeft className="w-3 h-3" />
          </button>
          <button
            onClick={() => changeScope('individual')}
            aria-pressed={meOnly}
            title={myName && selectedName === myName ? '나만' : `${selectedName || '담당자'} 일정만 보기`}
            className={cn('flex items-center gap-1 px-2 py-1 max-w-[120px]', meOnly ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground')}>
            <User className="w-3 h-3 flex-shrink-0" /> <span className="truncate">{selectedName || '나만'}</span>
          </button>
          <button
            onClick={() => cycleSelectedName(1)}
            disabled={namesList.length === 0}
            title="다음 담당자"
            aria-label="다음 담당자"
            className="flex items-center justify-center w-6 py-1 border-l border-border hover:bg-secondary text-muted-foreground disabled:opacity-40 disabled:cursor-not-allowed">
            <ChevronRight className="w-3 h-3" />
          </button>
          <button onClick={() => changeScope('all')} aria-pressed={!meOnly}
            className={cn('flex items-center gap-1 px-2 py-1 border-l border-border', !meOnly ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground')}>
            <Users className="w-3 h-3" /> 전체
          </button>
        </div>
        <span className="text-xs text-muted-foreground">박스 가운데 드래그=이동 · 위/아래 끝 드래그=시간 조절</span>
      </div>

      {/* body */}
      <div className="flex-1 min-h-0 overflow-y-auto pr-1 -mr-1">
        {isLoading ? (
          <div className="space-y-2 pt-1">
            {[...Array(6)].map((_, i) => <div key={i} className="h-12 rounded-xl bg-secondary/40 animate-pulse" />)}
          </div>
        ) : isError ? (
          <div className="rounded-xl border border-status-critical/40 bg-status-critical/5 py-10 mt-2 text-center text-sm text-status-critical">
            <AlertTriangle className="w-6 h-6 mx-auto mb-2 opacity-80" />
            일정을 불러오지 못했습니다.
            <div>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>
                <RotateCcw className="w-3 h-3" /> 다시 시도
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* 캘린더 그리드 */}
            <div className="flex">
              {/* 시간 거터 */}
              <div className="flex-none w-10 relative" style={{ height: gridHeight }}>
                {hours.map((h) => (
                  <div key={h} className="absolute right-1 -translate-y-1/2 text-xs tabular-nums text-muted-foreground"
                    style={{ top: yOf(h * 60) }}>
                    {String(h).padStart(2, '0')}:00
                  </div>
                ))}
              </div>
              {/* 레인 */}
              <div ref={laneRef} onClick={onLaneClick}
                className="relative flex-1 border-l border-border/60 cursor-copy"
                style={{ height: gridHeight }}>
                {/* 시간 그리드 라인 */}
                {hours.map((h) => (
                  <div key={h} className="absolute left-0 right-0 border-t border-border/40 pointer-events-none"
                    style={{ top: yOf(h * 60) }} />
                ))}
                {/* now 라인 */}
                {isToday && nowMin >= startHour * 60 && nowMin <= endHour * 60 && (
                  <div className="absolute left-0 right-0 flex items-center pointer-events-none z-20" style={{ top: yOf(nowMin) }}>
                    <span className="w-1.5 h-1.5 rounded-full bg-primary -ml-[3px]" />
                    <span className="flex-1 h-px bg-primary/40" />
                  </div>
                )}
                {/* 세션 박스 */}
                {effSessions.map((s) => {
                  const colInfo = columns.get(s.key) ?? { col: 0, cols: 1 };
                  const top = yOf(s.startMin);
                  const height = Math.max(MIN_DURATION * PX_PER_MIN, yOf(s.endMin) - top);
                  const widthPct = 100 / colInfo.cols;
                  const leftPct = colInfo.col * widthPct;
                  return (
                    <SessionBox
                      key={s.key}
                      session={s}
                      top={top}
                      height={height}
                      leftPct={leftPct}
                      widthPct={widthPct}
                      onMoveDown={(e) => beginDrag(e, s, 'move')}
                      onTopDown={(e) => beginDrag(e, s, 'top')}
                      onBottomDown={(e) => beginDrag(e, s, 'bottom')}
                      onDelete={s.block ? () => removeBlock(s.block!) : undefined}
                    />
                  );
                })}

                {/* 빈 영역 추가 메뉴 */}
                {addMenu && (
                  <AddBlockMenu
                    minute={addMenu.minute}
                    y={addMenu.y}
                    candidates={spanItems}
                    onPickItem={(it) => addBlockTo(it, addMenu.minute)}
                    onNewTask={() => { setQuickAdd({ time: fmtMin(addMenu.minute), assignee: meOnly ? (selectedName || undefined) : undefined }); setAddMenu(null); }}
                    onClose={() => setAddMenu(null)}
                  />
                )}
              </div>
            </div>

            {/* 시간 미지정 (하단) */}
            {allDay.length > 0 && (
              <div className="mt-2 rounded-xl border border-border/60 bg-secondary/20 p-2">
                <div className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                  <Clock3 className="w-3 h-3" /> 시간 미지정 · {allDay.length}
                </div>
                <div className="space-y-1">
                  {allDay.map((w) => <UnscheduledCard key={w.id} item={w} onOpen={openItem} />)}
                </div>
              </div>
            )}

            {totalCount === 0 && (
              <div className="rounded-xl border border-dashed border-border/60 py-10 mt-2 text-center text-sm text-muted-foreground">
                {meOnly && !selectedName
                  ? '로그인 후 나의 일정을 볼 수 있습니다. "전체" 로 모든 일정을 볼 수 있어요.'
                  : `${isToday ? '오늘' : '해당 날짜'} ${meOnly ? `${selectedName === myName ? '나의' : `${selectedName}의`} ` : ''}일정이 없습니다.`}
                <div>
                  <button onClick={() => setQuickAdd({ time: '09:00', assignee: meOnly ? (selectedName || undefined) : undefined })}
                    className="mt-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs bg-primary/10 text-primary hover:bg-primary/20">
                    <Plus className="w-3 h-3" /> 업무 등록
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <QuickAddTaskModal
        open={!!quickAdd}
        defaultDate={viewDate}
        defaultTime={quickAdd?.time}
        defaultAssignee={quickAdd?.assignee}
        defaultClusterId={selectedClusterId}
        onClose={() => setQuickAdd(null)}
      />
    </div>
  );
}

// ── session box (이동 + 엣지 리사이즈) ──────────────────────────────────────────
function SessionBox({
  session, top, height, leftPct, widthPct, onMoveDown, onTopDown, onBottomDown, onDelete,
}: {
  session: Session;
  top: number; height: number; leftPct: number; widthPct: number;
  onMoveDown: (e: React.MouseEvent) => void;
  onTopDown: (e: React.MouseEvent) => void;
  onBottomDown: (e: React.MouseEvent) => void;
  onDelete?: () => void;
}) {
  const { item } = session;
  const status = item.kanbanStatus ?? 'todo';
  const sv = STATUS_STYLE[status] ?? STATUS_STYLE.todo;
  const isDone = status === 'done';
  const TypeIcon = WORK_ITEM_TYPE_CONFIG[item.type]?.Icon;
  const names = assigneeNames(item);
  const primary = names[0] ?? '미지정';
  const label = item.title?.trim() || stripHtml(item.content) || item.category;
  const compact = height < 38;

  return (
    <div
      className={cn('absolute rounded-lg border border-border/70 overflow-hidden group hover:shadow-sm hover:border-primary/25 transition-colors', sv.tint, isDone && 'opacity-60')}
      style={{ top, height, left: `calc(${leftPct}% + 2px)`, width: `calc(${widthPct}% - 4px)` }}
    >
      {/* 상단 리사이즈 핸들 — 히트영역은 넓게(h-2), 표시는 얇은 그립 라인만 */}
      <div onMouseDown={onTopDown} className="absolute top-0 left-0 right-0 h-2 cursor-ns-resize z-10 flex items-start justify-center" title="시작 시각 조절">
        <span className="mt-[1px] h-0.5 w-6 rounded-full bg-primary/0 group-hover:bg-primary/45 transition-colors" />
      </div>
      {/* 본문(이동) */}
      <div onMouseDown={onMoveDown} className="h-full pl-1.5 pr-1 py-0.5 cursor-grab active:cursor-grabbing flex flex-col">
        <span className={cn('absolute left-0 top-0 bottom-0 w-1 rounded-l', sv.bar)} />
        <div className="flex items-center gap-1 min-w-0">
          {TypeIcon && !compact && <TypeIcon className="w-3 h-3 flex-shrink-0 text-muted-foreground" />}
          <span className={cn('text-xs font-medium truncate', isDone ? 'text-muted-foreground line-through' : 'text-foreground')}>{label}</span>
          {onDelete && (
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="ml-auto opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-status-critical flex-shrink-0"
              title="이 시간 블록 삭제" aria-label="이 시간 블록 삭제">
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
        {!compact && (
          <div className="flex items-center gap-1.5 mt-0.5 text-[9.5px] text-muted-foreground min-w-0">
            <span className={cn('w-3.5 h-3.5 rounded-full flex items-center justify-center text-[7px] font-bold flex-shrink-0', assigneeColor(primary))}>
              {primary.slice(0, 2).toUpperCase()}
            </span>
            <span className="tabular-nums">{fmtMin(session.startMin)}–{fmtMin(session.endMin)}</span>
            {item.clusterName && <span className="truncate hidden md:inline">· {item.clusterName}</span>}
          </div>
        )}
      </div>
      {/* 하단 리사이즈 핸들 — 히트영역은 넓게(h-2), 표시는 얇은 그립 라인만 */}
      <div onMouseDown={onBottomDown} className="absolute bottom-0 left-0 right-0 h-2 cursor-ns-resize z-10 flex items-end justify-center" title="종료 시각 조절">
        <span className="mb-[1px] h-0.5 w-6 rounded-full bg-primary/0 group-hover:bg-primary/45 transition-colors" />
      </div>
    </div>
  );
}

// ── 미지정 카드 (하단) ──────────────────────────────────────────────────────────
function UnscheduledCard({ item, onOpen }: { item: WorkItem; onOpen: (id: string) => void }) {
  const status = item.kanbanStatus ?? 'todo';
  const sv = STATUS_STYLE[status] ?? STATUS_STYLE.todo;
  const isDone = status === 'done';
  const names = assigneeNames(item);
  const label = item.title?.trim() || stripHtml(item.content) || item.category;
  return (
    <button type="button" onClick={() => onOpen(item.id)} title={label} aria-label={label}
      className={cn('w-full flex items-center gap-2 rounded-lg border border-border/60 pl-0 pr-2 py-1.5 text-left hover:border-primary/40', sv.tint, isDone && 'opacity-60')}>
      <span className={cn('flex-none w-1 self-stretch rounded-full', sv.bar)} />
      <div className="min-w-0 flex-1">
        <span className={cn('text-sm truncate font-medium block', isDone ? 'text-muted-foreground line-through' : 'text-foreground')}>{label}</span>
        <span className="text-xs text-muted-foreground truncate block">{names.join(', ')}{item.clusterName ? ` · ${item.clusterName}` : ''}</span>
      </div>
      <span className={cn('w-1.5 h-1.5 rounded-full flex-none', sv.dot)} />
    </button>
  );
}

// ── 빈 영역 추가 메뉴 ────────────────────────────────────────────────────────────
function AddBlockMenu({
  minute, y, candidates, onPickItem, onNewTask, onClose,
}: {
  minute: number; y: number; candidates: WorkItem[];
  onPickItem: (item: WorkItem) => void; onNewTask: () => void; onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute left-2 right-2 z-40 bg-card border border-border rounded-xl mac-shadow p-1.5"
        style={{ top: Math.max(0, y) }}>
        <div className="flex items-center justify-between px-1.5 py-1">
          <span className="text-xs font-semibold tabular-nums">{fmtMin(minute)} 에 추가</span>
          <button onClick={onClose} aria-label="닫기" className="text-muted-foreground hover:text-foreground"><X className="w-3 h-3" /></button>
        </div>
        {candidates.length > 0 && (
          <>
            <div className="px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">기존 업무에 시간 추가</div>
            <div className="max-h-40 overflow-y-auto">
              {candidates.map((it) => (
                <button key={it.id} onClick={() => onPickItem(it)}
                  className="w-full text-left px-1.5 py-1 rounded-lg hover:bg-secondary text-xs truncate">
                  {it.title?.trim() || stripHtml(it.content) || it.category}
                </button>
              ))}
            </div>
            <div className="border-t border-border/60 my-1" />
          </>
        )}
        <button onClick={onNewTask}
          className="w-full text-left px-1.5 py-1 rounded-lg hover:bg-secondary text-xs text-primary font-medium inline-flex items-center gap-1">
          <Plus className="w-3 h-3" /> 새 업무 등록
        </button>
      </div>
    </>
  );
}
