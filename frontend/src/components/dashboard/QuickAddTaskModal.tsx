import { useEffect, useId, useState } from 'react';
import {
  CalendarDays, X, Loader2, AlertTriangle, Server, Users, Tag,
  CheckCircle2, ChevronRight,
} from 'lucide-react';
import { useCreateWorkItem } from '@/hooks/useWorkItems';
import { useClusters } from '@/hooks/useCluster';
import { useAssignees } from '@/hooks/useAssignees';
import { useToast } from '@/components/common';
import type { KanbanStatus, WorkItemType } from '@/types';
import { WORK_ITEM_TYPE_CONFIG, WORK_ITEM_TYPE_ORDER } from '@/components/work-items/workItemKanbanUtils';
import { formatApiError } from '@/lib/utils';

interface QuickAddTaskModalProps {
  open: boolean;
  /** YYYY-MM-DD — 클릭한 달력 날짜 (필수). */
  defaultDate: string;
  /** 클러스터 사이드바에서 선택된 클러스터 — 미리 채움 (선택). */
  defaultClusterId?: string | null;
  onClose: () => void;
  /** 등록 후 caller 가 추가로 처리할 후크 (선택). 기본은 useCreateWorkItem 가 캐시 무효화. */
  onCreated?: () => void;
}

const PRIORITY_OPTIONS: { value: 'high' | 'medium' | 'low'; label: string; dot: string }[] = [
  { value: 'high',   label: '높음', dot: 'bg-red-500' },
  { value: 'medium', label: '보통', dot: 'bg-amber-500' },
  { value: 'low',    label: '낮음', dot: 'bg-emerald-500' },
];

const STATUS_OPTIONS: { value: KanbanStatus; label: string }[] = [
  { value: 'backlog',     label: '백로그' },
  { value: 'todo',        label: '할일' },
  { value: 'in_progress', label: '진행 중' },
  { value: 'review_test', label: '검토' },
  { value: 'done',        label: '완료' },
];

const PRESET_CATEGORIES = ['일반 업무', '점검', '배포', '구성 변경', '회의', '기타'];

function buildScheduledAtIso(date: string, time: string): string {
  // KST → UTC 보존을 위해 datetime-local 같은 의미로 처리:
  // Date(`${date}T${time}:00`) 는 브라우저 로컬 타임존 기준이므로,
  // toISOString() 으로 UTC 직렬화하여 백엔드 DateTime 컬럼에 저장.
  const d = new Date(`${date}T${time}:00`);
  return d.toISOString();
}

function formatDateLabel(date: string): string {
  const d = new Date(date + 'T00:00:00');
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${days[d.getDay()]})`;
}

/**
 * 메인 화면 달력에서 날짜 클릭 시 띄우는 빠른 업무 등록 모달.
 *
 * 백엔드의 `work_items` 테이블을 그대로 사용한다 — `startedAt` 가 일정의 시점,
 * `type` 으로 작업/이슈/회의/교육/기타 를 구분한다. 자세한 옵션(서비스 태그,
 * 모듈, effortHours 등)은 업무 관리 게시판의 정식 폼에서 추가/수정.
 */
export function QuickAddTaskModal({
  open, defaultDate, defaultClusterId, onClose, onCreated,
}: QuickAddTaskModalProps) {
  const toast = useToast();
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const { data: clusters = [] } = useClusters();
  const { data: assignees = [] } = useAssignees();
  const createMut = useCreateWorkItem();

  const [selectedType, setSelectedType] = useState<WorkItemType | null>(null);
  const [content, setTaskContent] = useState('');
  const [assignee, setAssignee] = useState('');
  const [category, setTaskCategory] = useState(PRESET_CATEGORIES[0]);
  const [priority, setPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [kanbanStatus, setKanbanStatus] = useState<KanbanStatus>('todo');
  const [time, setTime] = useState('09:00');
  const [clusterId, setClusterId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // 모달 열릴 때마다 입력값 초기화. defaultDate / defaultClusterId 만 전파.
  useEffect(() => {
    if (!open) return;
    setSelectedType(null);
    setTaskContent('');
    setTaskCategory(PRESET_CATEGORIES[0]);
    setPriority('medium');
    setKanbanStatus('todo');
    setTime('09:00');
    setClusterId(defaultClusterId ?? '');
    setError(null);
    // 첫 담당자가 있으면 기본 채움 (사용자 편의)
    setAssignee((prev) => prev || (assignees[0]?.name ?? ''));
  }, [open, defaultClusterId, assignees]);

  if (!open) return null;

  const canSubmit = selectedType !== null
    && content.trim().length > 0
    && assignee.trim().length > 0
    && !createMut.isPending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !selectedType) return;
    setError(null);
    try {
      const cluster = clusters.find((c) => c.id === clusterId);
      await createMut.mutateAsync({
        type: selectedType,
        assignee: assignee.trim(),
        primaryAssignee: assignee.trim(),
        category: category.trim() || '일반 업무',
        content: content.trim(),
        startedAt: buildScheduledAtIso(defaultDate, time),
        priority,
        kanbanStatus,
        clusterId: cluster?.id,
        clusterName: cluster?.name,
      });
      const typeLabel = WORK_ITEM_TYPE_CONFIG[selectedType].label;
      toast.success(`${typeLabel} 등록 완료`, `${formatDateLabel(defaultDate)} · ${time}`);
      onCreated?.();
      onClose();
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !createMut.isPending && onClose()} />
      <form
        onSubmit={handleSubmit}
        className="relative bg-card border border-border rounded-2xl mac-shadow w-full max-w-md mx-4 max-h-[92vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <CalendarDays className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold leading-tight">업무 등록</h2>
            <p className="text-[11px] text-muted-foreground">{formatDateLabel(defaultDate)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={createMut.isPending}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50 transition-colors"
            aria-label="닫기"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pb-5 space-y-3.5">
          {/* 업무 유형 picker — 작업/이슈/회의/교육/기타. 기본값 없음. */}
          <fieldset>
            <legend className="text-xs font-medium text-muted-foreground mb-1.5 block">
              유형 <span className="text-red-500">*</span>
            </legend>
            <div className="flex items-stretch gap-1.5">
              {WORK_ITEM_TYPE_ORDER.map((key) => {
                const cfg = WORK_ITEM_TYPE_CONFIG[key];
                const active = selectedType === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSelectedType(key)}
                    aria-pressed={active}
                    className={`flex-1 flex flex-col items-center justify-center gap-1 px-2 py-2 rounded-xl border text-[11px] font-medium transition-colors ${
                      active
                        ? `${cfg.cls} border-current ring-2 ring-primary/30`
                        : 'bg-secondary border-border text-muted-foreground hover:text-foreground hover:bg-secondary/80'
                    }`}
                  >
                    <cfg.Icon className="w-4 h-4" />
                    {cfg.label}
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/* 제목 */}
          <div>
            <label htmlFor={f('content')} className="text-xs font-medium text-muted-foreground mb-1 block">
              내용 *
            </label>
            <input
              id={f('content')}
              type="text"
              value={content}
              onChange={(e) => setTaskContent(e.target.value)}
              placeholder="예) 노드 NIC 점검, master1 kubelet 재기동…"
              autoFocus
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              required
            />
          </div>

          {/* 시간 + 우선순위 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={f('time')} className="text-xs font-medium text-muted-foreground mb-1 block">시간</label>
              <input
                id={f('time')}
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">우선순위</p>
              <div className="flex items-center gap-1 bg-secondary/60 rounded-xl p-0.5">
                {PRIORITY_OPTIONS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => setPriority(p.value)}
                    className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs rounded-lg transition-colors ${
                      priority === p.value
                        ? 'bg-card text-foreground shadow-sm font-semibold'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full ${p.dot}`} />
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 담당자 + 상태 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={f('assignee')} className="text-xs font-medium text-muted-foreground mb-1 block flex items-center gap-1">
                <Users className="w-3 h-3" /> 담당자 *
              </label>
              <input
                id={f('assignee')}
                list={f('assignee-list')}
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                placeholder="이름"
                className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                required
              />
              <datalist id={f('assignee-list')}>
                {assignees.map((a) => (
                  <option key={a.name} value={a.name} />
                ))}
              </datalist>
            </div>
            <div>
              <label htmlFor={f('status')} className="text-xs font-medium text-muted-foreground mb-1 block">상태</label>
              <select
                id={f('status')}
                value={kanbanStatus}
                onChange={(e) => setKanbanStatus(e.target.value as KanbanStatus)}
                className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* 카테고리 + 클러스터 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={f('cat')} className="text-xs font-medium text-muted-foreground mb-1 block flex items-center gap-1">
                <Tag className="w-3 h-3" /> 분류
              </label>
              <input
                id={f('cat')}
                list={f('cat-list')}
                value={category}
                onChange={(e) => setTaskCategory(e.target.value)}
                placeholder="예) 점검, 배포…"
                className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              <datalist id={f('cat-list')}>
                {PRESET_CATEGORIES.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
            <div>
              <label htmlFor={f('cluster')} className="text-xs font-medium text-muted-foreground mb-1 block flex items-center gap-1">
                <Server className="w-3 h-3" /> 클러스터
              </label>
              <select
                id={f('cluster')}
                value={clusterId}
                onChange={(e) => setClusterId(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                <option value="">선택 안 함</option>
                {clusters.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          </div>

          {error && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span className="break-all">{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border bg-muted/30">
          <p className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
            상세 항목은 업무 관리 게시판에서 추가 편집
            <ChevronRight className="w-3 h-3" />
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={createMut.isPending}
              className="px-3.5 py-1.5 text-xs font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors disabled:opacity-50"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-3.5 py-1.5 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors disabled:opacity-50 inline-flex items-center gap-1.5 mac-shadow"
            >
              {createMut.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5" />
              )}
              {createMut.isPending ? '등록 중…' : '업무 등록'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
