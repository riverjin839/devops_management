// frontend/src/components/batch-jobs/BatchJobSlideOver.tsx
import { useEffect, useRef, useState } from 'react';
import { Play, History, Trash2, X, KeyRound, Pencil } from 'lucide-react';
import type { BatchJob } from '@/services/api';
import { MacCard } from '@/components/ui/MacCard';
import { useBatchJobRuns } from '@/hooks/useBatchJobs';
import { RunForm } from './BatchJobSlideOver.RunForm';
import { RunHistory } from './BatchJobSlideOver.RunHistory';
import { SavedCreds } from './BatchJobSlideOver.SavedCreds';
import { EditForm } from './BatchJobSlideOver.EditForm';

interface BatchJobSlideOverProps {
  job: BatchJob;
  onClose: () => void;
  onDelete: (job: BatchJob) => void;
  /** 좁은 뷰포트 (< 1280px) 에서 overlay drawer 로 표시. */
  overlayMode?: boolean;
}

export function BatchJobSlideOver({ job, onClose, onDelete, overlayMode = false }: BatchJobSlideOverProps) {
  const [runFormOpen, setRunFormOpen] = useState(false);
  const [credsOpen, setCredsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const runsQ = useBatchJobRuns(job.id);

  // 잡이 바뀔 때마다 폼/이력 펼침 reset.
  useEffect(() => {
    setRunFormOpen(false);
    setCredsOpen(false);
    setEditOpen(false);
  }, [job.id]);

  // ESC 키로 닫힘. onCloseRef 패턴으로 listener 재부착 방지.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const body = (
    <MacCard
      title={job.name}
      bodyPadding="p-4"
      rootClassName={overlayMode ? '' : 'sticky top-4'}
    >
      <div className="text-xs text-muted-foreground font-mono mb-3 break-all">
        {job.jobType}
      </div>

      {/* 액션 바 */}
      <div className="flex items-center gap-1.5 mb-3 flex-wrap">
        <button
          type="button"
          onClick={() => setRunFormOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl mac-shadow"
          aria-expanded={runFormOpen}
        >
          <Play className="w-3.5 h-3.5" />
          {runFormOpen ? '실행 닫기' : '지금 실행'}
        </button>
        <button
          type="button"
          onClick={() => setEditOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm bg-secondary hover:bg-primary/10 hover:text-primary border border-border rounded-xl"
          aria-expanded={editOpen}
        >
          <Pencil className="w-3.5 h-3.5" />
          편집
        </button>
        {job.requiresSsh !== false && (
          <button
            type="button"
            onClick={() => setCredsOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm bg-secondary hover:bg-primary/10 hover:text-primary border border-border rounded-xl"
            aria-expanded={credsOpen}
          >
            <KeyRound className="w-3.5 h-3.5" />
            자격증명
            {Boolean(job.cron) && !job.hasSavedPassword && !job.hasSavedPrivateKey && (
              <span className="ml-0.5 inline-block w-1.5 h-1.5 rounded-full bg-amber-500" aria-label="자격증명 필요" />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={() => onDelete(job)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm bg-secondary hover:bg-red-500/10 hover:text-red-500 border border-border rounded-xl"
        >
          <Trash2 className="w-3.5 h-3.5" />
          삭제
        </button>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto inline-flex items-center justify-center w-7 h-7 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground"
          aria-label="닫기"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 실행 폼 — expandable */}
      {runFormOpen && (
        <div className="mb-4 pb-4 border-b border-border">
          <RunForm key={job.id} job={job} />
        </div>
      )}

      {/* 잡 메타데이터 / params / cron 편집 — expandable */}
      {editOpen && (
        <div className="mb-4 pb-4 border-b border-border">
          <EditForm key={job.id} job={job} />
        </div>
      )}

      {/* 저장된 자격증명 편집 — expandable */}
      {credsOpen && (
        <div className="mb-4 pb-4 border-b border-border">
          <SavedCreds key={job.id} job={job} />
        </div>
      )}

      {/* 최근 이력 */}
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <History className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs uppercase tracking-wider text-muted-foreground">최근 실행</span>
        </div>
        <RunHistory runs={runsQ.data ?? []} isLoading={runsQ.isLoading} />
      </div>
    </MacCard>
  );

  if (overlayMode) {
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label="패널 닫기"
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClose(); }}
      >
        <div
          className="absolute inset-y-0 right-0 w-[min(420px,90vw)] overflow-y-auto p-4"
          onClick={(e) => e.stopPropagation()}
        >
          {body}
        </div>
      </div>
    );
  }

  return <div className="w-[380px] flex-shrink-0">{body}</div>;
}
