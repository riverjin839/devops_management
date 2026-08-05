import { useId, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Rocket, Plus, Target, Pencil, Trash2, X, Loader2, CheckCircle2,
  ArrowRightLeft, CalendarDays, Users, Clock,
} from 'lucide-react';
import { ConfirmDialog, useToast, useModalA11y } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import {
  useSprints, useCreateSprint, useUpdateSprint, useDeleteSprint, useCarryOverSprint,
} from '@/hooks/useSprints';
import type { Sprint, SprintStatus, SprintCreate } from '@/types';

// ── date helpers ──────────────────────────────────────────────────────────
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysBetween(fromStr: string, toStr: string): number {
  const a = new Date(fromStr + 'T00:00:00');
  const b = new Date(toStr + 'T00:00:00');
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}
function fmtDate(s: string): string {
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d.getTime())) return s;
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

const STATUS_META: Record<SprintStatus, { label: string; cls: string }> = {
  planning:  { label: '계획',   cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30' },
  active:    { label: '진행중', cls: 'bg-blue-500/10 text-blue-500 border-blue-500/30' },
  completed: { label: '완료',   cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30' },
};

// ── create / edit modal ────────────────────────────────────────────────────
interface FormState { name: string; goal: string; jiraNo: string; confluenceLink: string; startDate: string; endDate: string; status: SprintStatus; }

function SprintModal({
  initial, onClose, onSubmit, busy,
}: {
  initial?: Sprint;
  onClose: () => void;
  onSubmit: (data: SprintCreate) => void;
  busy: boolean;
}) {
  const dialogRef = useModalA11y(true, onClose);
  const titleId = useId();
  const start = initial?.startDate ?? todayStr();
  const [form, setForm] = useState<FormState>({
    name: initial?.name ?? `스프린트 ${(() => { const d = new Date(); return `${d.getMonth() + 1}/${d.getDate()}`; })()}`,
    goal: initial?.goal ?? '',
    jiraNo: initial?.jiraNo ?? '',
    confluenceLink: initial?.confluenceLink ?? '',
    startDate: start,
    endDate: initial?.endDate ?? addDaysStr(start, 13),
    status: initial?.status ?? 'active',
  });
  const invalidRange = daysBetween(form.startDate, form.endDate) < 0;
  const canSubmit = form.name.trim().length > 0 && !invalidRange && !busy;

  // 기간 프리셋 — 1~4주 빠른 설정. (종료일 포함이므로 N주 = 시작일 + 7N-1 일)
  const durationDays = daysBetween(form.startDate, form.endDate) + 1;
  const activeWeeks = durationDays > 0 && durationDays % 7 === 0 ? durationDays / 7 : null;
  const setWeeks = (n: number) => setForm((f) => ({ ...f, endDate: addDaysStr(f.startDate, n * 7 - 1) }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="bg-card border border-border rounded-2xl w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 id={titleId} className="font-bold flex items-center gap-2"><Rocket className="w-4 h-4 text-primary" />{initial ? '스프린트 수정' : '새 스프린트'}</h2>
          <button onClick={onClose} aria-label="닫기" className="p-1 rounded-lg hover:bg-secondary text-muted-foreground"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label htmlFor="sprint-name" className="block text-sm font-medium text-muted-foreground mb-1">이름</label>
            <input
              id="sprint-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50"
              placeholder="스프린트 이름"
            />
          </div>
          <div>
            <label htmlFor="sprint-goal" className="block text-sm font-medium text-muted-foreground mb-1">목표 (선택)</label>
            <textarea
              id="sprint-goal"
              value={form.goal}
              onChange={(e) => setForm((f) => ({ ...f, goal: e.target.value }))}
              rows={2}
              className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50 resize-none"
              placeholder="이번 반복에서 이루려는 것"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="sprint-jira-no" className="block text-sm font-medium text-muted-foreground mb-1">JIRA NO (선택)</label>
              <input
                id="sprint-jira-no"
                value={form.jiraNo}
                onChange={(e) => setForm((f) => ({ ...f, jiraNo: e.target.value }))}
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50 font-mono"
                placeholder="예) PROJ-123"
              />
            </div>
            <div>
              <label htmlFor="sprint-confluence" className="block text-sm font-medium text-muted-foreground mb-1">Confluence 링크 (선택)</label>
              <input
                id="sprint-confluence"
                value={form.confluenceLink}
                onChange={(e) => setForm((f) => ({ ...f, confluenceLink: e.target.value }))}
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50"
                placeholder="https://..."
              />
            </div>
          </div>
          <div>
            <span className="block text-sm font-medium text-muted-foreground mb-1">기간</span>
            <div className="flex items-center gap-1.5">
              {[1, 2, 3, 4].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setWeeks(n)}
                  className={`px-2.5 py-1 text-sm rounded-lg border transition-colors ${activeWeeks === n ? 'bg-primary/10 text-primary border-primary/30' : 'bg-secondary border-border text-muted-foreground hover:text-foreground'}`}
                >
                  {n}주
                </button>
              ))}
              <span className="text-xs text-muted-foreground ml-1">
                {activeWeeks ? `${activeWeeks}주` : `${durationDays > 0 ? durationDays : 0}일`} · 종료일 직접 지정 가능
              </span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="sprint-start" className="block text-sm font-medium text-muted-foreground mb-1">시작일</label>
              <input
                id="sprint-start"
                type="date"
                value={form.startDate}
                onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50 font-mono"
              />
            </div>
            <div>
              <label htmlFor="sprint-end" className="block text-sm font-medium text-muted-foreground mb-1">종료일</label>
              <input
                id="sprint-end"
                type="date"
                value={form.endDate}
                onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
                className={`w-full px-3 py-2 text-sm bg-secondary border rounded-lg focus:outline-none font-mono ${invalidRange ? 'border-red-500/60' : 'border-border focus:border-primary/50'}`}
              />
            </div>
          </div>
          {invalidRange && <p className="text-sm text-red-500">종료일은 시작일 이후여야 합니다.</p>}
          <div className="flex items-center gap-2">
            {(['planning', 'active', 'completed'] as SprintStatus[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setForm((f) => ({ ...f, status: s }))}
                className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${form.status === s ? STATUS_META[s].cls : 'bg-secondary border-border text-muted-foreground hover:text-foreground'}`}
              >
                {STATUS_META[s].label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg bg-secondary hover:bg-secondary/80 border border-border">취소</button>
          <button
            onClick={() => onSubmit({ name: form.name.trim(), goal: form.goal.trim() || undefined, jiraNo: form.jiraNo.trim() || undefined, confluenceLink: form.confluenceLink.trim() || undefined, startDate: form.startDate, endDate: form.endDate, status: form.status })}
            disabled={!canSubmit}
            className="px-4 py-2 text-sm rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            {initial ? '저장' : '생성'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── carry-over modal ────────────────────────────────────────────────────────
function CarryOverModal({
  source, targets, onClose, onConfirm, busy,
}: {
  source: Sprint;
  targets: Sprint[];
  onClose: () => void;
  onConfirm: (toId: string) => void;
  busy: boolean;
}) {
  const dialogRef = useModalA11y(true, onClose);
  const titleId = useId();
  const [toId, setToId] = useState(targets[0]?.id ?? '');
  const remaining = source.totalItems - source.doneItems;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="bg-card border border-border rounded-2xl w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 id={titleId} className="font-bold flex items-center gap-2"><ArrowRightLeft className="w-4 h-4 text-primary" />미완료 이월</h2>
          <button onClick={onClose} aria-label="닫기" className="p-1 rounded-lg hover:bg-secondary text-muted-foreground"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{source.name}</span> 의 미완료 항목
            <span className="mx-1 px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 text-sm font-semibold">{remaining}건</span>
            을 다른 스프린트로 옮깁니다.
          </p>
          {targets.length === 0 ? (
            <p className="text-sm text-red-500">이월할 대상 스프린트가 없습니다. 먼저 새 스프린트를 만들어 주세요.</p>
          ) : (
            <div>
              <label htmlFor="carryover-target" className="block text-sm font-medium text-muted-foreground mb-1">이월 대상</label>
              <select
                id="carryover-target"
                value={toId}
                onChange={(e) => setToId(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50"
              >
                {targets.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({fmtDate(s.startDate)} ~ {fmtDate(s.endDate)})</option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg bg-secondary hover:bg-secondary/80 border border-border">취소</button>
          <button
            onClick={() => onConfirm(toId)}
            disabled={!toId || busy || remaining === 0}
            className="px-4 py-2 text-sm rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRightLeft className="w-4 h-4" />}이월
          </button>
        </div>
      </div>
    </div>
  );
}

// ── sprint card ──────────────────────────────────────────────────────────────
function SprintCard({
  sprint, onEdit, onDelete, onCarryOver, onComplete, onOpenBoard,
}: {
  sprint: Sprint;
  onEdit: (s: Sprint) => void;
  onDelete: (s: Sprint) => void;
  onCarryOver: (s: Sprint) => void;
  onComplete: (s: Sprint) => void;
  onOpenBoard: (s: Sprint) => void;
}) {
  const pct = sprint.achievementRate;
  const remaining = sprint.totalItems - sprint.doneItems;
  const left = daysBetween(todayStr(), sprint.endDate);
  const meta = STATUS_META[sprint.status];
  return (
    <div className="bg-card border border-border rounded-2xl p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={`text-xs px-1.5 py-0.5 rounded border ${meta.cls}`}>{meta.label}</span>
            <h3 className="font-bold truncate">{sprint.name}</h3>
          </div>
          <p className="text-sm text-muted-foreground inline-flex items-center gap-1">
            <CalendarDays className="w-3 h-3" />{fmtDate(sprint.startDate)} ~ {fmtDate(sprint.endDate)}
            {sprint.status !== 'completed' && (
              left < 0 ? <span className="ml-1 text-red-500 font-medium">종료일 경과</span>
              : left === 0 ? <span className="ml-1 text-amber-500 font-medium">오늘 마감</span>
              : <span className="ml-1 text-primary font-medium">D-{left}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={() => onEdit(sprint)} title="수정" aria-label="수정" className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground"><Pencil className="w-3.5 h-3.5" /></button>
          <button onClick={() => onDelete(sprint)} title="삭제" aria-label="삭제" className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      {sprint.goal && (
        <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
          <Target className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-primary/70" />{sprint.goal}
        </p>
      )}

      <div>
        <div className="flex items-center justify-between text-sm mb-1">
          <span className="text-muted-foreground">진행률</span>
          <span className="font-semibold text-primary">{pct}%</span>
        </div>
        <div className="h-2 rounded-full bg-secondary overflow-hidden">
          <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
        <span className="text-emerald-600">완료 {sprint.doneItems}</span>
        <span>전체 {sprint.totalItems}</span>
        {remaining > 0 && <span className="text-amber-600">미완료 {remaining}</span>}
        {sprint.totalEffortHours > 0 && <span className="inline-flex items-center gap-0.5"><Clock className="w-3 h-3" />{sprint.totalEffortHours}h</span>}
        {sprint.assignees.length > 0 && <span className="inline-flex items-center gap-0.5"><Users className="w-3 h-3" />{sprint.assignees.length}명</span>}
      </div>

      <div className="flex items-center gap-2 pt-1 border-t border-border/60">
        <button onClick={() => onOpenBoard(sprint)} className="text-sm px-2.5 py-1.5 rounded-lg bg-secondary hover:bg-secondary/80 border border-border text-muted-foreground hover:text-foreground transition-colors">
          게시판에서 보기
        </button>
        {sprint.status !== 'completed' && (
          <>
            {remaining > 0 && (
              <button onClick={() => onCarryOver(sprint)} className="text-sm px-2.5 py-1.5 rounded-lg bg-secondary hover:bg-secondary/80 border border-border text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1">
                <ArrowRightLeft className="w-3 h-3" />이월
              </button>
            )}
            <button onClick={() => onComplete(sprint)} className="ml-auto text-sm px-2.5 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 transition-colors inline-flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" />종료
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────
export function SprintsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { data, isLoading } = useSprints();
  const sprints = useMemo(() => data?.data ?? [], [data]);

  const createSprint = useCreateSprint();
  const updateSprint = useUpdateSprint();
  const deleteSprint = useDeleteSprint();
  const carryOver = useCarryOverSprint();

  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; sprint: Sprint } | null>(null);
  const [carryOverFor, setCarryOverFor] = useState<Sprint | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Sprint | null>(null);

  const active = sprints.filter((s) => s.status === 'active');
  const planning = sprints.filter((s) => s.status === 'planning');
  const completed = sprints.filter((s) => s.status === 'completed');

  const handleCreate = (payload: SprintCreate) => {
    createSprint.mutate(payload, {
      onSuccess: () => { setModal(null); toast.success('스프린트 생성됨', payload.name); },
      onError: (err) => toast.error('생성 실패', formatApiError(err, '스프린트를 만들 수 없습니다.')),
    });
  };
  const handleEdit = (payload: SprintCreate) => {
    if (modal?.mode !== 'edit') return;
    updateSprint.mutate({ id: modal.sprint.id, data: payload }, {
      onSuccess: () => { setModal(null); toast.success('스프린트 수정됨', payload.name); },
      onError: (err) => toast.error('수정 실패', formatApiError(err, '스프린트를 수정할 수 없습니다.')),
    });
  };
  const handleComplete = (s: Sprint) => {
    updateSprint.mutate({ id: s.id, data: { status: 'completed' } }, {
      onSuccess: () => toast.success('스프린트 종료', `${s.name} 를 완료 처리했습니다.`),
      onError: (err) => toast.error('종료 실패', formatApiError(err, '스프린트를 종료할 수 없습니다.')),
    });
  };
  const handleCarryOver = (toId: string) => {
    if (!carryOverFor) return;
    carryOver.mutate({ id: carryOverFor.id, to: toId }, {
      onSuccess: () => { setCarryOverFor(null); toast.success('이월 완료', '미완료 항목을 옮겼습니다.'); },
      onError: (err) => toast.error('이월 실패', formatApiError(err, '항목을 이월할 수 없습니다.')),
    });
  };
  const doDelete = () => {
    if (!confirmDelete) return;
    const s = confirmDelete;
    setConfirmDelete(null);
    deleteSprint.mutate(s.id, {
      onSuccess: () => toast.success('스프린트 삭제됨', `${s.name} (업무 연결만 해제, 업무는 유지)`),
      onError: (err) => toast.error('삭제 실패', formatApiError(err, '스프린트를 삭제할 수 없습니다.')),
    });
  };
  const openBoard = (s: Sprint) => navigate(`/tasks-mgmt?sprint=${s.id}`);

  // 이월 대상 — 자기 자신 제외, 완료 아닌 스프린트.
  const carryTargets = carryOverFor ? sprints.filter((s) => s.id !== carryOverFor.id && s.status !== 'completed') : [];

  const renderGroup = (title: string, list: Sprint[]) =>
    list.length > 0 && (
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground px-1">{title} <span className="text-sm">{list.length}</span></h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {list.map((s) => (
            <SprintCard
              key={s.id}
              sprint={s}
              onEdit={(sp) => setModal({ mode: 'edit', sprint: sp })}
              onDelete={setConfirmDelete}
              onCarryOver={setCarryOverFor}
              onComplete={handleComplete}
              onOpenBoard={openBoard}
            />
          ))}
        </div>
      </div>
    );

  return (
    <div className="app-min-h-screen bg-background">
      <main className="max-w-[1400px] mx-auto px-4 lg:px-6 py-5 space-y-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Rocket className="w-5 h-5 text-primary" />
            <div>
              <h1 className="text-xl font-bold">스프린트</h1>
              <p className="text-sm text-muted-foreground">반복(iteration) 단위로 업무를 계획·추적합니다.</p>
            </div>
          </div>
          <button
            onClick={() => setModal({ mode: 'create' })}
            className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors inline-flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" />새 스프린트
          </button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
        ) : sprints.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4 text-muted-foreground">
            <Rocket className="w-12 h-12 opacity-30 text-primary" />
            <div className="text-center">
              <p className="text-base font-medium text-foreground">아직 스프린트가 없습니다</p>
              <p className="text-sm mt-1 opacity-70">1~4주 등 원하는 기간의 반복으로 팀의 업무를 묶어 추적해보세요.</p>
            </div>
            <button
              onClick={() => setModal({ mode: 'create' })}
              className="px-4 py-2 text-sm bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg inline-flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />첫 스프린트 만들기
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            {renderGroup('진행중', active)}
            {renderGroup('예정', planning)}
            {renderGroup('완료', completed)}
          </div>
        )}
      </main>

      {modal?.mode === 'create' && (
        <SprintModal onClose={() => setModal(null)} onSubmit={handleCreate} busy={createSprint.isPending} />
      )}
      {modal?.mode === 'edit' && (
        <SprintModal initial={modal.sprint} onClose={() => setModal(null)} onSubmit={handleEdit} busy={updateSprint.isPending} />
      )}
      {carryOverFor && (
        <CarryOverModal
          source={carryOverFor}
          targets={carryTargets}
          onClose={() => setCarryOverFor(null)}
          onConfirm={handleCarryOver}
          busy={carryOver.isPending}
        />
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="스프린트 삭제"
        description={confirmDelete ? `"${confirmDelete.name}" 스프린트를 삭제할까요? 연결된 업무는 삭제되지 않고 스프린트 배정만 해제됩니다.` : ''}
        confirmLabel="삭제"
        cancelLabel="취소"
        danger
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
