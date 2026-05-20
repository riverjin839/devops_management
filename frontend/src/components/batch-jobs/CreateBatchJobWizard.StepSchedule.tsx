// frontend/src/components/batch-jobs/CreateBatchJobWizard.StepSchedule.tsx
import { useId } from 'react';
import type { WizardState } from './CreateBatchJobWizard.shared';

interface StepScheduleProps {
  state: WizardState;
  onChange: (next: Partial<WizardState>) => void;
}

export function StepSchedule({ state, onChange }: StepScheduleProps) {
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;
  const needsCreds = !!state.cron.trim();
  const hasCreds = !!state.savedPassword || !!state.savedPrivateKey;
  const credsMissing = needsCreds && !hasCreds;

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={f('cron')} className="block text-xs text-muted-foreground mb-1">cron 식 (선택)</label>
        <input
          id={f('cron')}
          value={state.cron}
          onChange={(e) => onChange({ cron: e.target.value })}
          placeholder="0 3 * * *"
          className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl font-mono"
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          cron 을 비워두면 수동 실행 전용 잡이 됩니다.
        </p>
      </div>

      <div className="border border-border rounded-xl px-3 py-3 bg-secondary/30">
        <div className="text-xs font-medium mb-1">
          저장된 자격증명
          <span className="text-muted-foreground"> (cron 사용 시 필수, 수동 실행에는 불필요)</span>
        </div>
        <p className="text-[11px] text-muted-foreground mb-3">
          서버의 SECRET_KEY 로 암호화되어 저장됩니다.
        </p>

        <div className="space-y-2">
          <div>
            <label htmlFor={f('saved-password')} className="block text-xs text-muted-foreground mb-1">저장 비밀번호</label>
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
            <label htmlFor={f('saved-private-key')} className="block text-xs text-muted-foreground mb-1">저장 개인키 (PEM)</label>
            <textarea
              id={f('saved-private-key')}
              value={state.savedPrivateKey}
              onChange={(e) => onChange({ savedPrivateKey: e.target.value })}
              rows={3}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              className="w-full px-3 py-2 text-[11px] bg-background border border-border rounded-xl font-mono"
            />
          </div>
        </div>

        {credsMissing && (
          <div className="mt-2 text-[11px] text-amber-600 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2">
            ⚠ cron 이 설정되어 있지만 저장된 자격증명이 없어 스케줄 실행이 동작하지 않습니다.
            지금 입력하지 않으면 등록 후 잡 패널에서 추가할 수 있습니다.
          </div>
        )}
      </div>
    </div>
  );
}
