import { useState } from 'react';
import { Pencil, Trash2, CalendarDays, Target, Users } from 'lucide-react';
import type { Project } from '@/types';
import { useDeleteProject } from '@/hooks/useProjects';
import { ConfirmDialog, useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import { ProjectFormModal } from './ProjectFormModal';

// 프로젝트 색은 종류 구분(카테고리)이라 chart-N 토큰으로 그린다(D-120). 키는 저장값 호환을 위해 유지.

const COLOR_MAP: Record<string, string> = {
  blue:    'bg-chart-1/10 border-chart-1/30',
  emerald: 'bg-chart-2/10 border-chart-2/30',
  amber:   'bg-chart-3/10 border-chart-3/30',
  violet:  'bg-chart-4/10 border-chart-4/30',
  rose:    'bg-chart-5/10 border-chart-5/30',
  slate:   'bg-chart-8/10 border-chart-8/30',
};

const BADGE_MAP: Record<string, string> = {
  blue:    'bg-chart-1/15 text-chart-1-text',
  emerald: 'bg-chart-2/15 text-chart-2-text',
  amber:   'bg-chart-3/15 text-chart-3-text',
  violet:  'bg-chart-4/15 text-chart-4-text',
  rose:    'bg-chart-5/15 text-chart-5-text',
  slate:   'bg-chart-8/15 text-chart-8-text',
};

const DOT_MAP: Record<string, string> = {
  blue: 'bg-chart-1', emerald: 'bg-chart-2', amber: 'bg-chart-3',
  violet: 'bg-chart-4', rose: 'bg-chart-5', slate: 'bg-chart-8',
};

interface Props {
  project: Project;
  onDeleted?: () => void;
}

export function ProjectHeader({ project, onDeleted }: Props) {
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteMut = useDeleteProject();
  const toast = useToast();

  const surface = COLOR_MAP[project.color] ?? COLOR_MAP.blue;
  const badge = BADGE_MAP[project.color] ?? BADGE_MAP.blue;
  const dot = DOT_MAP[project.color] ?? DOT_MAP.blue;

  // D-159·D-161: native confirm 대신 ConfirmDialog(danger·busy), 실패는 사유와 함께 토스트(미처리 rejection 금지).
  const handleDelete = async () => {
    try {
      await deleteMut.mutateAsync(project.id);
      setConfirmDelete(false);
      toast.success('프로젝트 삭제됨', `"${project.name}" — 소속 업무 ${project.totalItems}건은 미분류로 전환됐습니다.`);
      onDeleted?.();
    } catch (err) {
      setConfirmDelete(false);
      toast.error('프로젝트 삭제 실패', formatApiError(err));
    }
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
      <div className={`rounded-md border ${surface} p-4`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <span className={`w-3 h-3 rounded-full flex-shrink-0 ${dot}`} aria-hidden />
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
            <button type="button" onClick={() => setEditOpen(true)}
              className="p-1.5 rounded-lg text-muted-foreground hover:bg-card hover:text-foreground transition-colors"
              title="프로젝트 수정" aria-label={`${project.name} 프로젝트 수정`}>
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button type="button" onClick={() => setConfirmDelete(true)} disabled={deleteMut.isPending}
              className="p-1.5 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-50"
              title="프로젝트 삭제" aria-label={`${project.name} 프로젝트 삭제`}>
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
          <div className="h-2 rounded-full bg-secondary overflow-hidden" role="progressbar"
            aria-label={`${project.name} 달성률`} aria-valuenow={project.achievementRate} aria-valuemin={0} aria-valuemax={100}>
            <div
              className={`h-full rounded-full transition-[width] ${dot}`}
              style={{ width: `${project.achievementRate}%` }}
            />
          </div>
        </div>
      </div>

      {editOpen && <ProjectFormModal initial={project} onClose={() => setEditOpen(false)} />}
      <ConfirmDialog
        open={confirmDelete}
        danger
        title={`"${project.name}" 프로젝트를 삭제할까요?`}
        description={project.totalItems > 0
          ? `소속 업무 ${project.totalItems}건은 삭제되지 않고 미분류로 전환됩니다.`
          : '소속 업무가 없습니다.'}
        confirmLabel="삭제"
        busy={deleteMut.isPending}
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
