// frontend/src/components/batch-jobs/CreateBatchJobWizard.StepHost.tsx
import { useId } from 'react';
import type { BatchJobTypeDescriptor } from '@/services/api';
import { MasterHostPicker } from '@/components/common';
import type { WizardState } from './CreateBatchJobWizard.shared';

interface StepHostProps {
  types: BatchJobTypeDescriptor[];
  state: WizardState;
  onChange: (next: Partial<WizardState>) => void;
}

export function StepHost({ types, state, onChange }: StepHostProps) {
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;
  const selectedType = types.find((t) => t.jobType === state.jobType);
  return (
    <div className="space-y-4">
      <MasterHostPicker
        clusterId={state.clusterId}
        customHost={state.hostCustom}
        selectedName={state.hostSelectedName}
        label="기본 호스트 (master 노드 후보)"
        onChange={({ selectedName, customHost, effectiveHost }) =>
          onChange({
            hostSelectedName: selectedName,
            hostCustom: customHost,
            defaultHost: effectiveHost,
          })
        }
      />

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={f('port')} className="block text-xs text-muted-foreground mb-1">포트</label>
          <input
            id={f('port')}
            type="number"
            value={state.defaultPort}
            onChange={(e) => onChange({ defaultPort: Number(e.target.value) || 22 })}
            className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl"
          />
        </div>
        <div>
          <label htmlFor={f('username')} className="block text-xs text-muted-foreground mb-1">기본 사용자</label>
          <input
            id={f('username')}
            value={state.defaultUsername}
            onChange={(e) => onChange({ defaultUsername: e.target.value })}
            className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl font-mono"
          />
        </div>
      </div>

      <div>
        <label htmlFor={f('params')} className="block text-xs text-muted-foreground mb-1">params (JSON)</label>
        <textarea
          id={f('params')}
          value={state.paramsJson}
          onChange={(e) => onChange({ paramsJson: e.target.value })}
          rows={6}
          className="w-full px-3 py-2 text-xs bg-background border border-border rounded-xl font-mono"
        />
        {selectedType && Object.keys(selectedType.paramSchema).length > 0 && (
          <details className="mt-2 text-[11px] text-muted-foreground">
            <summary className="cursor-pointer">사용 가능한 파라미터</summary>
            <ul className="mt-1 space-y-1 pl-3">
              {Object.entries(selectedType.paramSchema).map(([k, v]) => (
                <li key={k}>
                  <span className="font-mono">{k}</span>
                  <span className="opacity-60"> ({v.type})</span>
                  {v.help && <span> — {v.help}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
