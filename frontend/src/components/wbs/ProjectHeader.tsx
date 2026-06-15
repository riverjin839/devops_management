import { useState } from 'react';
import { Pencil, Trash2, CalendarDays, Target, Users } from 'lucide-react';
import type { Project } from '@/types';
import { useDeleteProject } from '@/hooks/useProjects';
import { ProjectFormModal } from './ProjectFormModal';

const COLOR_MAP: Record<string, string> = {
  blue:    'from-blue-500/20 to-blue-500/5 border-blue-500/30',
  emerald: 'from-emerald-500/20 to-emerald-500/5 border-emerald-500/30',
  violet:  'from-violet-500/20 to-violet-500/5 border-violet-500/30',
  amber:   'from-amber-500/20 to-amber-500/5 border-amber-500/30',
  rose:    'from-rose-500/20 to-rose-500/5 border-rose-500/30',
  slate:   'from-slate-500/20 to-slate-500/5 border-slate-500/30',
};

const BADGE_MAP: Record<string, string> = {
  blue:    'bg-blue-500/15 text-blue-600 dark:text-blue-300',
  emerald: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
  violet:  'bg-violet-500/15 text-violet-600 dark:text-violet-300',
  amber:   'bg-amber-500/15 text-amber-600 dark:text-amber-300',
  rose:    'bg-rose-500/15 text-rose-600 dark:text-rose-300',
  slate:   'bg-slate-500/15 text-slate-600 dark:text-slate-300',
};

const DOT_MAP: Record<string, string> = {
  blue: 'bg-blue-500', emerald: 'bg-emerald-500', violet: 'bg-violet-500',
  amber: 'bg-amber-500', rose: 'bg-rose-500', slate: 'bg-slate-500',
};

interface Props {
  project: Project;
  onDeleted?: () => void;
}

export function ProjectHeader({ project, onDeleted }: Props) {
  const [editOpen, setEditOpen] = useState(false);
  const deleteMut = useDeleteProject();

  const gradient = COLOR_MAP[project.color] ?? COLOR_MAP.blue;
  const badge = BADGE_MAP[project.color] ?? BADGE_MAP.blue;
  const dot = DOT_MAP[project.color] ?? DOT_MAP.blue;

  const handleDelete = async () => {
    if (!window.confirm(`"${project.name}" 프로젝트를 삭제하시겠습니까?\n소속 업무는 미분류로 전환됩니다.`)) return;
    await deleteMut.mutateAsync(project.id);
    onDeleted?.();
  };

  const dateRange = (() => {
    if (!project.startDate && !project.endDate) return null;
    const s = project.startDate ?? '';
    const e = project.endDate ?? '';
    if (s && e) return `${s} ~ ${e}`;
    return s || e;
  })();

  return (
    <>
      <div className={`rounded-2xl border bg-gradient-to-r ${gradient} p-4`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <span className={`w-3 h-3 rounded-full flex-shrink-0 ${dot}`} />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base font-bold text-foreground leading-tight">{project.name}</h3>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${badge}`}>
                  {project.status === 'active' ? '진행중' : project.status === 'completed' ? '완료' : '중단'}
                </span>
              </div>
              {project.goal && (
                <div className="flex items-start gap-1.5 mt-1">
                  <Target className="w-3 h-3 text-muted-foreground flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-muted-foreground line-clamp-2">{project.goal}</p>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            <button onClick={() => setEditOpen(true)}
              className="p-1.5 rounded-lg text-muted-foreground hover:bg-card hover:text-foreground transition-colors"
              title="프로젝트 수정">
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button onClick={handleDelete} disabled={deleteMut.isPending}
              className="p-1.5 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-50"
              title="프로젝트 삭제">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-4 mt-3 flex-wrap text-sm text-muted-foreground">
          {dateRange && (
            <span className="flex items-center gap-1">
              <CalendarDays className="w-3 h-3" />{dateRange}
            </span>
          )}
          {project.assignees.length > 0 && (
            <span className="flex items-center gap-1">
              <Users className="w-3 h-3" />
              {project.assignees.slice(0, 4).join(' · ')}
              {project.assignees.length > 4 && ` +${project.assignees.length - 4}`}
            </span>
          )}
        </div>

        {/* 달성률 바 */}
        <div className="mt-3">
          <div className="flex items-center justify-between text-sm mb-1">
            <span className="text-muted-foreground">달성률</span>
            <span className="font-semibold tabular-nums">
              {project.achievementRate}% ({project.doneItems}/{project.totalItems})
            </span>
          </div>
          <div className="h-2 rounded-full bg-black/10 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${dot}`}
              style={{ width: `${project.achievementRate}%` }}
            />
          </div>
        </div>
      </div>

      {editOpen && <ProjectFormModal initial={project} onClose={() => setEditOpen(false)} />}
    </>
  );
}
