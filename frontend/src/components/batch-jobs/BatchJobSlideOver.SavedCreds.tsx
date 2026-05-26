// frontend/src/components/batch-jobs/BatchJobSlideOver.SavedCreds.tsx
import { useId, useState } from 'react';
import { KeyRound, ShieldCheck, ShieldAlert, Save, Trash2 } from 'lucide-react';
import type { BatchJob } from '@/services/api';
import { formatApiError } from '@/lib/utils';
import { useUpdateBatchJob } from '@/hooks/useBatchJobs';

interface SavedCredsProps {
  job: BatchJob;
}

/**
 * Inline editor for a BatchJob's saved credentials (password / private key).
 *
 * Scheduled (cron) runs use these saved creds — when both are missing the
 * dispatcher silently skips the job (see `run_batch_job_dispatcher` in
 * `backend/app/celery_app.py`). This panel lets operators add or rotate them
 * on an already-registered job without deleting and re-creating it.
 */
export function SavedCreds({ job }: SavedCredsProps) {
  const update = useUpdateBatchJob();
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const hasAnyCreds = job.hasSavedPassword || job.hasSavedPrivateKey;
  const cronRequiresCreds = Boolean(job.cron) && !hasAnyCreds;

  const save = async () => {
    setError(null);
    setOkMsg(null);
    if (!password && !privateKey) {
      setError('비밀번호 또는 개인키 중 하나는 입력해주세요.');
      return;
    }
    try {
      await update.mutateAsync({
        id: job.id,
        data: {
          savedPassword: password || undefined,
          savedPrivateKey: privateKey || undefined,
        },
      });
      setPassword('');
      setPrivateKey('');
      setOkMsg('자격증명 저장 완료.');
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  const clear = async (which: 'password' | 'privateKey') => {
    setError(null);
    setOkMsg(null);
    try {
      await update.mutateAsync({
        id: job.id,
        data:
          which === 'password'
            ? { clearSavedPassword: true }
            : { clearSavedPrivateKey: true },
      });
      setOkMsg(which === 'password' ? '저장된 비밀번호 삭제.' : '저장된 개인키 삭제.');
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  return (
    <div className="space-y-3">
      {/* 현재 상태 */}
      <div className="flex items-center gap-2 text-[11px]">
        <CredBadge label="비밀번호" present={job.hasSavedPassword} />
        <CredBadge label="개인키" present={job.hasSavedPrivateKey} />
      </div>

      {cronRequiresCreds && (
        <div className="flex items-start gap-1.5 text-[11px] text-amber-600 bg-amber-500/10 border border-amber-500/30 rounded-xl px-2.5 py-2">
          <ShieldAlert className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>
            cron <span className="font-mono">{job.cron}</span> 가 설정됐지만 저장된 자격증명이
            없어 스케줄 실행이 skip 됩니다. 아래에서 입력 후 저장하세요.
          </span>
        </div>
      )}

      {/* 비밀번호 */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label htmlFor={f('pw')} className="block text-[10px] text-muted-foreground">
            새 비밀번호
          </label>
          {job.hasSavedPassword && (
            <button
              type="button"
              onClick={() => clear('password')}
              disabled={update.isPending}
              className="inline-flex items-center gap-1 text-[10px] text-red-500 hover:underline disabled:opacity-60"
            >
              <Trash2 className="w-3 h-3" />
              저장된 비밀번호 삭제
            </button>
          )}
        </div>
        <input
          id={f('pw')}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={job.hasSavedPassword ? '비워두면 기존 비밀번호 유지' : ''}
          className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded-xl"
        />
      </div>

      {/* 개인키 */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label htmlFor={f('pem')} className="block text-[10px] text-muted-foreground">
            새 개인키 (PEM)
          </label>
          {job.hasSavedPrivateKey && (
            <button
              type="button"
              onClick={() => clear('privateKey')}
              disabled={update.isPending}
              className="inline-flex items-center gap-1 text-[10px] text-red-500 hover:underline disabled:opacity-60"
            >
              <Trash2 className="w-3 h-3" />
              저장된 개인키 삭제
            </button>
          )}
        </div>
        <textarea
          id={f('pem')}
          value={privateKey}
          onChange={(e) => setPrivateKey(e.target.value)}
          rows={3}
          placeholder={
            job.hasSavedPrivateKey
              ? '비워두면 기존 개인키 유지'
              : '-----BEGIN OPENSSH PRIVATE KEY-----'
          }
          className="w-full px-2 py-1.5 text-[11px] bg-background border border-border rounded-xl font-mono"
        />
      </div>

      {error && <div className="text-[11px] text-red-500">{error}</div>}
      {okMsg && <div className="text-[11px] text-emerald-600">{okMsg}</div>}

      <button
        type="button"
        onClick={save}
        disabled={update.isPending || (!password && !privateKey)}
        className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl mac-shadow disabled:opacity-60"
      >
        <Save className="w-3.5 h-3.5" />
        {update.isPending ? '저장 중…' : '자격증명 저장'}
      </button>
    </div>
  );
}

function CredBadge({ label, present }: { label: string; present: boolean }) {
  if (present) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 border border-emerald-500/30">
        <ShieldCheck className="w-3 h-3" />
        {label} 저장됨
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border">
      <KeyRound className="w-3 h-3" />
      {label} 없음
    </span>
  );
}
