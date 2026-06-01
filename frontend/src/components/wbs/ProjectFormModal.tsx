import { useEffect, useId, useState } from 'react';
import { X, Loader2, FolderOpen } from 'lucide-react';
import type { Project, ProjectCreate } from '@/types';
import { useCreateProject, useUpdateProject } from '@/hooks/useProjects';
import { formatApiError } from '@/lib/utils';

const COLOR_OPTIONS = [
  { value: 'blue',   label: '파랑',  cls: 'bg-blue-500' },
  { value: 'emerald', label: '초록', cls: 'bg-emerald-500' },
  { value: 'violet', label: '보라',  cls: 'bg-violet-500' },
  { value: 'amber',  label: '노랑',  cls: 'bg-amber-500' },
  { value: 'rose',   label: '빨강',  cls: 'bg-rose-500' },
  { value: 'slate',  label: '회색',  cls: 'bg-slate-500' },
];

interface Props {
  initial?: Project;
  onClose: () => void;
}

export function ProjectFormModal({ initial, onClose }: Props) {
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;
  const isEdit = !!initial;

  const createMut = useCreateProject();
  const updateMut = useUpdateProject();

  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [goal, setGoal] = useState(initial?.goal ?? '');
  const [color, setColor] = useState(initial?.color ?? 'blue');
  const [startDate, setStartDate] = useState(initial?.startDate ?? '');
  const [endDate, setEndDate] = useState(initial?.endDate ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isPending = createMut.isPending || updateMut.isPending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    const payload: ProjectCreate = {
      name: name.trim(),
      description: description.trim() || undefined,
      goal: goal.trim() || undefined,
      color,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    };
    try {
      if (isEdit && initial) {
        await updateMut.mutateAsync({ id: initial.id, data: payload });
      } else {
        await createMut.mutateAsync(payload);
      }
      onClose();
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  const inputCls = 'w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40';
  const labelCls = 'block text-xs font-medium text-muted-foreground mb-1';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !isPending && onClose()} />
      <form
        onSubmit={handleSubmit}
        className="relative bg-card border border-border rounded-2xl mac-shadow w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <FolderOpen className="w-5 h-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold">{isEdit ? '프로젝트 수정' : '새 프로젝트'}</h2>
          </div>
          <button type="button" onClick={onClose} disabled={isPending}
            className="p-1.5 rounded-lg text-muted-foreground hover:bg-secondary disabled:opacity-50">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pb-5 space-y-3.5">
          <div>
            <label htmlFor={f('name')} className={labelCls}>프로젝트 이름 *</label>
            <input id={f('name')} type="text" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="예) Q3 인프라 고도화" className={inputCls} required autoFocus />
          </div>

          <div>
            <label htmlFor={f('goal')} className={labelCls}>목표</label>
            <textarea id={f('goal')} value={goal} onChange={(e) => setGoal(e.target.value)}
              placeholder="프로젝트 달성 목표를 입력하세요"
              className={`${inputCls} resize-none`} rows={2} />
          </div>

          <div>
            <label htmlFor={f('desc')} className={labelCls}>설명</label>
            <textarea id={f('desc')} value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="프로젝트 상세 설명 (선택)"
              className={`${inputCls} resize-none`} rows={2} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={f('start')} className={labelCls}>시작일</label>
              <input id={f('start')} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label htmlFor={f('end')} className={labelCls}>종료일</label>
              <input id={f('end')} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={inputCls} />
            </div>
          </div>

          <div>
            <p className={labelCls}>색상</p>
            <div className="flex items-center gap-2 flex-wrap">
              {COLOR_OPTIONS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setColor(c.value)}
                  className={`w-7 h-7 rounded-full ${c.cls} transition-all ${
                    color === c.value ? 'ring-2 ring-offset-2 ring-primary scale-110' : 'opacity-60 hover:opacity-100'
                  }`}
                  title={c.label}
                  aria-label={c.label}
                />
              ))}
            </div>
          </div>

          {error && (
            <p className="text-xs text-destructive bg-destructive/10 rounded-xl px-3 py-2">{error}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-muted/30">
          <button type="button" onClick={onClose} disabled={isPending}
            className="px-3.5 py-1.5 text-xs font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl disabled:opacity-50">
            취소
          </button>
          <button type="submit" disabled={!name.trim() || isPending}
            className="px-3.5 py-1.5 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl disabled:opacity-50 inline-flex items-center gap-1.5 mac-shadow">
            {isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            {isEdit ? '저장' : '만들기'}
          </button>
        </div>
      </form>
    </div>
  );
}
