// frontend/src/components/batch-jobs/CreateBatchJobWizard.StepSchedule.tsx
import { useId } from 'react';
import type { WizardState } from './CreateBatchJobWizard.shared';

interface StepScheduleProps {
  state: WizardState;
  onChange: (next: Partial<WizardState>) => void;
  /** false = non-SSH(클러스터 스코프) 타입 — 자격증명 입력을 숨긴다. */
  requiresSsh?: boolean;
}

export function StepSchedule({ state, onChange, requiresSsh = true }: StepScheduleProps) {
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;
  const hasCron = !!state.cron.trim();
  const hasCreds = !!state.savedPassword || !!state.savedPrivateKey;
  const credsMissing = requiresSsh && hasCron && !hasCreds;
  const hostMissing = requiresSsh && hasCron && !state.defaultHost.trim();

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={f('cron')} className="block text-sm text-muted-foreground mb-1">cron 식 (선택)</label>
        <input
          id={f('cron')}
          value={state.cron}
          onChange={(e) => onChange({ cron: e.target.value })}
          placeholder="0 3 * * *"
          className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl font-mono"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          cron 을 비워두면 수동 실행 전용 잡이 됩니다.
        </p>
      </div>

      {!requiresSsh && (
        <div className="text-sm text-muted-foreground bg-secondary/30 border border-border rounded-xl px-3 py-2.5">
          이 잡 타입은 SSH 자격증명이 필요 없습니다 — 스케줄 실행도 클러스터
          kubeconfig 로 동작합니다. cron 만 지정하면 됩니다.
        </div>
      )}

      {requiresSsh && (
      <div className="border border-border rounded-xl px-3 py-3 bg-secondary/30">
        <div className="text-sm font-medium mb-1">
          저장된 자격증명
          <span className="text-muted-foreground"> (cron 사용 시 필수, 수동 실행에는 불필요)</span>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          서버의 SECRET_KEY 로 암호화되어 저장됩니다.
        </p>

        <div className="space-y-2">
          <div>
            <label htmlFor={f('saved-password')} className="block text-sm text-muted-foreground mb-1">저장 비밀번호</label>
            <input
              id={f('saved-password')}
              type="password"
              autoComplete="new-password"
              value={state.savedPassword}
              onChange={(e) => onChange({ savedPassword: e.target.value })}
              className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl"
            />
          </div>
          <div>
            <label htmlFor={f('saved-private-key')} className="block text-sm text-muted-foreground mb-1">저장 개인키 (PEM)</label>
            <textarea
              id={f('saved-private-key')}
              value={state.savedPrivateKey}
              onChange={(e) => onChange({ savedPrivateKey: e.target.value })}
              rows={3}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              className="w-full px-3 py-2 text-xs bg-background border border-border rounded-xl font-mono"
            />
          </div>
        </div>

        {credsMissing && (
          <div className="mt-2 text-xs text-amber-600 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2">
            ⚠ cron 을 사용하려면 비밀번호 또는 개인키 중 하나를 지금 입력해야
            등록할 수 있습니다. 자격증명 없이 등록하려면 cron 을 비워 수동 실행
            전용으로 만드세요.
          </div>
        )}
        {hostMissing && (
          <div className="mt-2 text-xs text-amber-600 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2">
            ⚠ cron 을 사용하려면 기본 호스트도 필요합니다 — 이전 단계에서
            호스트를 지정하세요.
          </div>
        )}
      </div>
      )}
    </div>
  );
}
