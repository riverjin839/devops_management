// frontend/src/components/batch-jobs/CreateBatchJobWizard.StepType.tsx
import { useEffect, useId } from 'react';
import type { BatchJobTypeDescriptor } from '@/services/api';
import type { Cluster } from '@/types';
import type { WizardState } from './CreateBatchJobWizard.shared';

interface StepTypeProps {
  clusters: Cluster[];
  types: BatchJobTypeDescriptor[];
  /** 부모가 clusterId 를 미리 정해 두면 select 가 readonly 로 표시된다. */
  fixedClusterId?: string;
  state: WizardState;
  onChange: (next: Partial<WizardState>) => void;
}

export function StepType({ clusters, types, fixedClusterId, state, onChange }: StepTypeProps) {
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  // 선택된 타입의 label / description 을 이름/설명에 자동 채움 (사용자가 비워둔 경우에만).
  useEffect(() => {
    const t = types.find((x) => x.jobType === state.jobType);
    if (!t) return;
    if (!state.name) onChange({ name: t.label });
    if (!state.description) onChange({ description: t.description });
    if (state.paramsJson === '{}' || !state.paramsJson) {
      onChange({ paramsJson: JSON.stringify(t.defaultParams ?? {}, null, 2) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.jobType, types]);

  const selectedType = types.find((t) => t.jobType === state.jobType);

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={f('cluster')} className="block text-sm text-muted-foreground mb-1">클러스터</label>
        <select
          id={f('cluster')}
          value={state.clusterId}
          onChange={(e) => onChange({ clusterId: e.target.value })}
          disabled={!!fixedClusterId}
          className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl disabled:bg-secondary/50 disabled:text-muted-foreground"
        >
          <option value="">선택하세요…</option>
          {clusters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}{c.region ? ` (${c.region})` : ''}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor={f('job-type')} className="block text-sm text-muted-foreground mb-1">잡 타입</label>
        <select
          id={f('job-type')}
          value={state.jobType}
          onChange={(e) => onChange({ jobType: e.target.value, name: '', description: '', paramsJson: '{}' })}
          className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl"
        >
          <option value="">선택하세요…</option>
          {types.map((t) => (
            <option key={t.jobType} value={t.jobType}>
              {t.label} ({t.jobType})
            </option>
          ))}
        </select>
        {selectedType?.description && (
          <p className="mt-1 text-xs text-muted-foreground">{selectedType.description}</p>
        )}
        {selectedType && selectedType.requiresSsh === false && (
          <p className="mt-1 inline-block text-xs px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-600 border border-sky-500/30">
            SSH 불필요 — 클러스터 kubeconfig 로 실행
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3">
        <div>
          <label htmlFor={f('name')} className="block text-sm text-muted-foreground mb-1">이름</label>
          <input
            id={f('name')}
            value={state.name}
            onChange={(e) => onChange({ name: e.target.value })}
            className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl"
            placeholder="잡 이름"
          />
        </div>
        <div>
          <label htmlFor={f('description')} className="block text-sm text-muted-foreground mb-1">설명 (선택)</label>
          <input
            id={f('description')}
            value={state.description}
            onChange={(e) => onChange({ description: e.target.value })}
            className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl"
          />
        </div>
      </div>
    </div>
  );
}
