// frontend/src/components/batch-jobs/CreateBatchJobWizard.StepType.tsx
import { useEffect, useId } from 'react';
import type { BatchJobTypeDescriptor } from '@/services/api';
import type { Cluster } from '@/types';
import { useScripts, useScriptVersions } from '@/hooks/useScripts';
import type { WizardState } from './CreateBatchJobWizard.shared';

interface StepTypeProps {
  clusters: Cluster[];
  types: BatchJobTypeDescriptor[];
  /** 부모가 clusterId 를 미리 정해 두면 select 가 readonly 로 표시된다. */
  fixedClusterId?: string;
  state: WizardState;
  onChange: (next: Partial<WizardState>) => void;
}

// "script" 는 스크립트 라이브러리 연동을 위한 내부 job_type 이라 시스템 타입
// 드롭다운에는 노출하지 않는다 — 이 컴포넌트가 executionMode='script' 일 때
// 자동으로 이 값을 세팅한다.
const SCRIPT_JOB_TYPE = 'script';
// Python 실행은 아직 Batch Job 을 지원하지 않는다(Phase 2 — K8s Job 실행기 예정).
const SUPPORTED_SCRIPT_KINDS = new Set(['shell', 'ansible_playbook']);

export function StepType({ clusters, types, fixedClusterId, state, onChange }: StepTypeProps) {
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const systemTypes = types.filter((t) => t.jobType !== SCRIPT_JOB_TYPE);
  const { data: allScripts = [] } = useScripts();
  const scripts = allScripts.filter((s) => SUPPORTED_SCRIPT_KINDS.has(s.kind));
  const { data: versions = [] } = useScriptVersions(state.executionMode === 'script' ? state.scriptId : undefined);

  // 선택된 시스템 타입의 label / description 을 이름/설명에 자동 채움 (비워둔 경우에만).
  useEffect(() => {
    if (state.executionMode !== 'system') return;
    const t = types.find((x) => x.jobType === state.jobType);
    if (!t) return;
    if (!state.name) onChange({ name: t.label });
    if (!state.description) onChange({ description: t.description });
    if (state.paramsJson === '{}' || !state.paramsJson) {
      onChange({ paramsJson: JSON.stringify(t.defaultParams ?? {}, null, 2) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.jobType, state.executionMode, types]);

  // 선택된 스크립트의 이름/설명을 자동 채움 (비워둔 경우에만) — 시스템 타입과 동일한 UX.
  useEffect(() => {
    if (state.executionMode !== 'script') return;
    const s = scripts.find((x) => x.id === state.scriptId);
    if (!s) return;
    if (!state.name) onChange({ name: s.name });
    if (!state.description && s.description) onChange({ description: s.description });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.scriptId, state.executionMode]);

  const selectedType = types.find((t) => t.jobType === state.jobType);
  const selectedScript = scripts.find((s) => s.id === state.scriptId);

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
        <span className="block text-sm text-muted-foreground mb-1">실행 방식</span>
        <div className="inline-flex rounded-xl border border-border overflow-hidden">
          <button
            type="button"
            onClick={() => onChange({
              executionMode: 'system', jobType: '', scriptId: '', scriptVersionId: '',
              name: '', description: '', paramsJson: '{}',
            })}
            className={`px-3 py-1.5 text-sm ${state.executionMode === 'system' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-secondary'}`}
          >
            시스템 제공
          </button>
          <button
            type="button"
            onClick={() => onChange({
              executionMode: 'script', jobType: SCRIPT_JOB_TYPE, name: '', description: '', paramsJson: '{}',
            })}
            className={`px-3 py-1.5 text-sm border-l border-border ${state.executionMode === 'script' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-secondary'}`}
          >
            스크립트 선택
          </button>
        </div>
      </div>

      {state.executionMode === 'system' ? (
        <div>
          <label htmlFor={f('job-type')} className="block text-sm text-muted-foreground mb-1">잡 타입</label>
          <select
            id={f('job-type')}
            value={state.jobType}
            onChange={(e) => onChange({ jobType: e.target.value, name: '', description: '', paramsJson: '{}' })}
            className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl"
          >
            <option value="">선택하세요…</option>
            {systemTypes.map((t) => (
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
      ) : (
        <div className="space-y-3">
          <div>
            <label htmlFor={f('script')} className="block text-sm text-muted-foreground mb-1">스크립트</label>
            <select
              id={f('script')}
              value={state.scriptId}
              onChange={(e) => onChange({ scriptId: e.target.value, scriptVersionId: '', name: '', description: '' })}
              className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl"
            >
              <option value="">선택하세요…</option>
              {scripts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.kind === 'shell' ? 'Shell' : 'Ansible'})
                </option>
              ))}
            </select>
            {scripts.length === 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                Shell/Ansible 스크립트가 없습니다 — 먼저 스크립트 라이브러리(/scripts)에서 만들어주세요.
              </p>
            )}
            {selectedScript?.description && (
              <p className="mt-1 text-xs text-muted-foreground">{selectedScript.description}</p>
            )}
          </div>
          {state.scriptId && (
            <div>
              <label htmlFor={f('script-version')} className="block text-sm text-muted-foreground mb-1">버전 고정</label>
              <select
                id={f('script-version')}
                value={state.scriptVersionId}
                onChange={(e) => onChange({ scriptVersionId: e.target.value })}
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl"
              >
                <option value="">항상 최신 버전</option>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.version}{v.changelog ? ` — ${v.changelog}` : ''}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                항상 최신을 선택하면 스크립트가 수정될 때 다음 실행부터 자동 반영됩니다.
                특정 버전에 고정하면 스크립트가 갱신돼도 이 잡은 계속 그 버전을 실행합니다.
              </p>
            </div>
          )}
        </div>
      )}

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
