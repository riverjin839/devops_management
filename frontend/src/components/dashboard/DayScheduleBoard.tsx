import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronLeft, ChevronRight, RotateCcw, Plus, CalendarClock, Clock3, User, Users, X, Trash2,
} from 'lucide-react';
import {
  useWorkItems, useTimeBlocksRange, useCreateTimeBlock, useUpdateTimeBlock, useDeleteTimeBlock,
} from '@/hooks/useWorkItems';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/components/common';
import { stripHtml, cn } from '@/lib/utils';
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

const STATUS_STYLE: Record<KanbanStatus, { dot: string; bar: string; tint: string }> = {
  backlog:     { dot: 'bg-slate-400',   bar: 'bg-slate-400',   tint: 'bg-slate-500/[0.10]' },
  todo:        { dot: 'bg-blue-400',    bar: 'bg-blue-400',    tint: 'bg-blue-500/[0.12]' },
  in_progress: { dot: 'bg-amber-400',   bar: 'bg-amber-400',   tint: 'bg-amber-500/[0.14]' },
  review_test: { dot: 'bg-purple-400',  bar: 'bg-purple-400',  tint: 'bg-purple-500/[0.12]' },
  done:        { dot: 'bg-emerald-400', bar: 'bg-emerald-400', tint: 'bg-emerald-500/[0.12]' },
};

const ASSIGNEE_PALETTE = [
  'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300',
  'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
];
function assigneeColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return ASSIGNEE_PALETTE[h % ASSIGNEE_PALETTE.length];
}
function assigneeNames(w: WorkItem): string[] {
  const raw = [w.primaryAssignee, w.secondaryAssignee, w.assignee].filter(Boolean).join(',');
  const out: string[] = [];
  for (const n of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!out.includes(n)) out.push(n);
  }
  return out;
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

type ScheduleScope = 'me' | 'all';
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
  const todayStr = dateKey(new Date());
  const [viewDate, setViewDate] = useState(todayStr);
  const isToday = viewDate === todayStr;

  const [quickAdd, setQuickAdd] = useState<{ time: string; assignee?: string } | null>(null);
  const [addMenu, setAddMenu] = useState<{ minute: number; y: number } | null>(null);

  const currentUser = useAuthStore((s) => s.user);
  const myName = (currentUser?.displayName?.trim() || currentUser?.username || '').trim();

  const scopeKey = `k8s:dayScheduleScope:${currentUser?.username ?? 'guest'}`;
  const [scope, setScope] = useState<ScheduleScope>(() => {
    try { return localStorage.getItem(scopeKey) === 'all' ? 'all' : 'me'; } catch { return 'me'; }
  });
  useEffect(() => {
    try { setScope(localStorage.getItem(scopeKey) === 'all' ? 'all' : 'me'); } catch { /* noop */ }
  }, [scopeKey]);
  const changeScope = (next: ScheduleScope) => {
    setScope(next);
    try { localStorage.setItem(scopeKey, next); } catch { /* noop */ }
  };
  const meOnly = scope === 'me';

  const { data: workItemsData, isLoading } = useWorkItems();
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
      if (meOnly && (!myName || !assigneeNames(w).includes(myName))) continue;
      if (w.kanbanStatus === 'done') continue;
      const startD = parseLocal(w.startedAt);
      if (!startD) continue;
      const startKey = dateKey(startD);
      const closedD = parseLocal(w.closedAt);
      let endKey = closedD ? dateKey(closedD) : todayKey;
      if (endKey < startKey) endKey = startKey;
      const hasBlockToday = dayBlocks.some((b) => b.workItemId === w.id && b.blockDate === viewDate);
      if (hasBlockToday || (viewDate >= startKey && viewDate <= endKey)) out.push(w);
    }
    return out;
  }, [allItems, selectedClusterId, meOnly, myName, dayBlocks, viewDate]);

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

  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const totalCount = sessions.length + allDay.length;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* header */}
      <div className="flex-none flex items-center gap-1.5 mb-2">
        <button onClick={() => setViewDate((d) => addDays(d, -1))}
          className="w-6 h-6 rounded-lg flex items-center justify-center hover:bg-secondary text-muted-foreground hover:text-foreground" title="이전 날">
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        <div className="flex items-center gap-1.5 px-1">
          <CalendarClock className="w-3.5 h-3.5 text-primary flex-shrink-0" />
          <span className="text-xs font-semibold tabular-nums">
            {isToday ? `오늘 · ${fmtLabel(viewDate)}` : fmtLabel(viewDate)}
          </span>
        </div>
        <button onClick={() => setViewDate((d) => addDays(d, 1))}
          className="w-6 h-6 rounded-lg flex items-center justify-center hover:bg-secondary text-muted-foreground hover:text-foreground" title="다음 날">
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
        {!isToday && (
          <button onClick={() => setViewDate(todayStr)}
            className="w-6 h-6 rounded-lg flex items-center justify-center hover:bg-secondary text-muted-foreground hover:text-primary" title="오늘로 돌아가기">
            <RotateCcw className="w-3 h-3" />
          </button>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{totalCount}건</span>
        <button
          onClick={() => setQuickAdd({ time: isToday ? `${String(Math.min(new Date().getHours(), 23)).padStart(2, '0')}:00` : '09:00', assignee: meOnly ? (myName || undefined) : undefined })}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-primary/30 bg-primary/10 text-primary text-[11px] font-semibold hover:bg-primary/20"
          title="업무 등록">
          <Plus className="w-3 h-3" /> 등록
        </button>
      </div>

      {/* scope toggle */}
      <div className="flex-none flex items-center gap-2 pb-2 mb-1">
        <div className="flex items-center rounded-lg border border-border overflow-hidden text-[11px]">
          <button onClick={() => changeScope('me')} aria-pressed={meOnly}
            className={cn('flex items-center gap-1 px-2 py-1', meOnly ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground')}>
            <User className="w-3 h-3" /> 나만
          </button>
          <button onClick={() => changeScope('all')} aria-pressed={!meOnly}
            className={cn('flex items-center gap-1 px-2 py-1 border-l border-border', !meOnly ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground')}>
            <Users className="w-3 h-3" /> 전체
          </button>
        </div>
        <span className="text-[10px] text-muted-foreground">박스 가운데 드래그=이동 · 위/아래 끝 드래그=시간 조절</span>
      </div>

      {/* body */}
      <div className="flex-1 min-h-0 overflow-y-auto pr-1 -mr-1">
        {isLoading ? (
          <div className="space-y-2 pt-1">
            {[...Array(6)].map((_, i) => <div key={i} className="h-12 rounded-xl bg-secondary/40 animate-pulse" />)}
          </div>
        ) : (
          <>
            {/* 캘린더 그리드 */}
            <div className="flex">
              {/* 시간 거터 */}
              <div className="flex-none w-10 relative" style={{ height: gridHeight }}>
                {hours.map((h) => (
                  <div key={h} className="absolute right-1 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground"
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
                    onNewTask={() => { setQuickAdd({ time: fmtMin(addMenu.minute), assignee: meOnly ? (myName || undefined) : undefined }); setAddMenu(null); }}
                    onClose={() => setAddMenu(null)}
                  />
                )}
              </div>
            </div>

            {/* 시간 미지정 (하단) */}
            {allDay.length > 0 && (
              <div className="mt-2 rounded-xl border border-border/60 bg-secondary/20 p-2">
                <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                  <Clock3 className="w-3 h-3" /> 시간 미지정 · {allDay.length}
                </div>
                <div className="space-y-1">
                  {allDay.map((w) => <UnscheduledCard key={w.id} item={w} onOpen={openItem} />)}
                </div>
              </div>
            )}

            {totalCount === 0 && (
              <div className="rounded-xl border border-dashed border-border/60 py-10 mt-2 text-center text-sm text-muted-foreground">
                {meOnly && !myName
                  ? '로그인 후 나의 일정을 볼 수 있습니다. "전체" 로 모든 일정을 볼 수 있어요.'
                  : `${isToday ? '오늘' : '해당 날짜'} ${meOnly ? '나의 ' : ''}일정이 없습니다.`}
                <div>
                  <button onClick={() => setQuickAdd({ time: '09:00', assignee: meOnly ? (myName || undefined) : undefined })}
                    className="mt-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] bg-primary/10 text-primary hover:bg-primary/20">
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
  const TypeIcon = WORK_ITEM_TYPE_CONFIG[item.type]?.Icon;
  const names = assigneeNames(item);
  const primary = names[0] ?? '미지정';
  const label = item.title?.trim() || stripHtml(item.content) || item.category;
  const compact = height < 38;

  return (
    <div
      className={cn('absolute rounded-lg border border-border/70 overflow-hidden group hover:shadow-sm hover:border-primary/40 transition-colors', sv.tint)}
      style={{ top, height, left: `calc(${leftPct}% + 2px)`, width: `calc(${widthPct}% - 4px)` }}
    >
      {/* 상단 리사이즈 핸들 */}
      <div onMouseDown={onTopDown} className="absolute top-0 left-0 right-0 h-2 cursor-ns-resize z-10 group-hover:bg-primary/20" title="시작 시각 조절" />
      {/* 본문(이동) */}
      <div onMouseDown={onMoveDown} className="h-full pl-1.5 pr-1 py-0.5 cursor-grab active:cursor-grabbing flex flex-col">
        <span className={cn('absolute left-0 top-0 bottom-0 w-1 rounded-l', sv.bar)} />
        <div className="flex items-center gap-1 min-w-0">
          {TypeIcon && !compact && <TypeIcon className="w-3 h-3 flex-shrink-0 text-muted-foreground" />}
          <span className="text-[11px] font-medium truncate text-foreground">{label}</span>
          {onDelete && (
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="ml-auto opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 flex-shrink-0"
              title="이 시간 블록 삭제">
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
      {/* 하단 리사이즈 핸들 */}
      <div onMouseDown={onBottomDown} className="absolute bottom-0 left-0 right-0 h-2 cursor-ns-resize z-10 group-hover:bg-primary/20" title="종료 시각 조절" />
    </div>
  );
}

// ── 미지정 카드 (하단) ──────────────────────────────────────────────────────────
function UnscheduledCard({ item, onOpen }: { item: WorkItem; onOpen: (id: string) => void }) {
  const status = item.kanbanStatus ?? 'todo';
  const sv = STATUS_STYLE[status] ?? STATUS_STYLE.todo;
  const names = assigneeNames(item);
  const label = item.title?.trim() || stripHtml(item.content) || item.category;
  return (
    <button type="button" onClick={() => onOpen(item.id)} title={label}
      className={cn('w-full flex items-center gap-2 rounded-lg border border-border/60 pl-0 pr-2 py-1.5 text-left hover:border-primary/40', sv.tint)}>
      <span className={cn('flex-none w-1 self-stretch rounded-full', sv.bar)} />
      <div className="min-w-0 flex-1">
        <span className="text-xs truncate text-foreground font-medium block">{label}</span>
        <span className="text-[10px] text-muted-foreground truncate block">{names.join(', ')}{item.clusterName ? ` · ${item.clusterName}` : ''}</span>
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
          <span className="text-[11px] font-semibold tabular-nums">{fmtMin(minute)} 에 추가</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-3 h-3" /></button>
        </div>
        {candidates.length > 0 && (
          <>
            <div className="px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">기존 업무에 시간 추가</div>
            <div className="max-h-40 overflow-y-auto">
              {candidates.map((it) => (
                <button key={it.id} onClick={() => onPickItem(it)}
                  className="w-full text-left px-1.5 py-1 rounded-lg hover:bg-secondary text-[11px] truncate">
                  {it.title?.trim() || stripHtml(it.content) || it.category}
                </button>
              ))}
            </div>
            <div className="border-t border-border/60 my-1" />
          </>
        )}
        <button onClick={onNewTask}
          className="w-full text-left px-1.5 py-1 rounded-lg hover:bg-secondary text-[11px] text-primary font-medium inline-flex items-center gap-1">
          <Plus className="w-3 h-3" /> 새 업무 등록
        </button>
      </div>
    </>
  );
}
