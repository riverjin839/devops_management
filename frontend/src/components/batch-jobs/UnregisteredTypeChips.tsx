// frontend/src/components/batch-jobs/UnregisteredTypeChips.tsx
import { Plus } from 'lucide-react';
import type { BatchJob, BatchJobTypeDescriptor } from '@/services/api';

interface UnregisteredTypeChipsProps {
  /** 단일 클러스터 모드의 그 클러스터에 등록된 잡들. */
  clusterJobs: BatchJob[];
  /** 전체 잡 타입 정의. */
  allTypes: BatchJobTypeDescriptor[];
  /** 칩 클릭 → wizard 가 jobType prefilled 로 열림. */
  onPick: (jobType: string) => void;
}

export function UnregisteredTypeChips({ clusterJobs, allTypes, onPick }: UnregisteredTypeChipsProps) {
  const registered = new Set(clusterJobs.map((j) => j.jobType));
  const missing = allTypes.filter((t) => !registered.has(t.jobType));

  if (missing.length === 0) return null;

  return (
    <div className="pt-3 border-t border-dashed border-border">
      <div className="text-[10px] text-muted-foreground mb-2 uppercase tracking-wider">
        미등록 잡 타입
      </div>
      <div className="flex flex-wrap gap-2">
        {missing.map((t) => (
          <button
            key={t.jobType}
            type="button"
            onClick={() => onPick(t.jobType)}
            title={t.description}
            className="inline-flex items-center gap-1 px-3 py-1 rounded-full border border-dashed border-border bg-card hover:bg-secondary hover:border-primary/40 text-xs text-muted-foreground hover:text-primary transition-colors"
          >
            <Plus className="w-3 h-3" />
            {t.label}
            <span className="text-[10px] opacity-60 font-mono">{t.jobType}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
