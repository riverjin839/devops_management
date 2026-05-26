// frontend/src/components/batch-jobs/BatchJobSlideOver.EditForm.tsx
import { useEffect, useId, useMemo, useState } from 'react';
import { Save, RotateCcw } from 'lucide-react';
import type { BatchJob, BatchJobUpdate } from '@/services/api';
import { MasterHostPicker } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import { useBatchJobTypes, useUpdateBatchJob } from '@/hooks/useBatchJobs';

interface EditFormProps {
  job: BatchJob;
  onSaved?: () => void;
}

/**
 * Inline editor for an already-registered BatchJob's mutable fields.
 *
 * Backend `PUT /batch-jobs/{id}` accepts name / description / default_host /
 * default_port / default_username / params / cron / enabled. `job_type` is
 * immutable — to switch types, delete & recreate. Saved credentials are
 * managed by the sibling SavedCreds panel; this form deliberately does NOT
 * touch them, so an operator can adjust the command (params/host/cron)
 * without re-entering credentials.
 *
 * This applies to user-created jobs AND default-registered ones such as the
 * etcdctl_defrag job — there is no special "system job" flag, so any job row
 * is freely editable here.
 */
export function EditForm({ job, onSaved }: EditFormProps) {
  const update = useUpdateBatchJob();
  const typesQ = useBatchJobTypes();
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const [name, setName] = useState(job.name);
  const [description, setDescription] = useState(job.description ?? '');
  const [host, setHost] = useState(job.defaultHost ?? '');
  const [hostSelectedName, setHostSelectedName] = useState('');
  const [hostCustom, setHostCustom] = useState(job.defaultHost ?? '');
  const [port, setPort] = useState(job.defaultPort);
  const [username, setUsername] = useState(job.defaultUsername);
  const [paramsJson, setParamsJson] = useState(JSON.stringify(job.params ?? {}, null, 2));
  const [cron, setCron] = useState(job.cron ?? '');
  const [enabled, setEnabled] = useState(job.enabled);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  // 잡이 바뀌면 폼 reset.
  useEffect(() => {
    setName(job.name);
    setDescription(job.description ?? '');
    setHost(job.defaultHost ?? '');
    setHostSelectedName('');
    setHostCustom(job.defaultHost ?? '');
    setPort(job.defaultPort);
    setUsername(job.defaultUsername);
    setParamsJson(JSON.stringify(job.params ?? {}, null, 2));
    setCron(job.cron ?? '');
    setEnabled(job.enabled);
    setError(null);
    setOkMsg(null);
  }, [job]);

  const selectedType = useMemo(
    () => (typesQ.data ?? []).find((t) => t.jobType === job.jobType),
    [typesQ.data, job.jobType],
  );

  const reset = () => {
    setName(job.name);
    setDescription(job.description ?? '');
    setHost(job.defaultHost ?? '');
    setHostSelectedName('');
    setHostCustom(job.defaultHost ?? '');
    setPort(job.defaultPort);
    setUsername(job.defaultUsername);
    setParamsJson(JSON.stringify(job.params ?? {}, null, 2));
    setCron(job.cron ?? '');
    setEnabled(job.enabled);
    setError(null);
    setOkMsg(null);
  };

  const save = async () => {
    setError(null);
    setOkMsg(null);
    if (!name.trim()) {
      setError('이름은 비워둘 수 없습니다.');
      return;
    }
    let parsedParams: Record<string, unknown> | undefined;
    if (paramsJson.trim()) {
      try {
        parsedParams = JSON.parse(paramsJson) as Record<string, unknown>;
      } catch {
        setError('params JSON 파싱 실패. 문법을 확인하세요.');
        return;
      }
    }

    const payload: BatchJobUpdate = {
      name: name.trim(),
      description: description.trim() || undefined,
      defaultHost: host.trim() || undefined,
      defaultPort: port,
      defaultUsername: username.trim() || 'root',
      params: parsedParams,
      cron: cron.trim() || undefined,
      enabled,
    };

    try {
      await update.mutateAsync({ id: job.id, data: payload });
      setOkMsg('저장 완료.');
      onSaved?.();
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  const resetParamsToDefault = () => {
    if (!selectedType) return;
    setParamsJson(JSON.stringify(selectedType.defaultParams ?? {}, null, 2));
  };

  return (
    <div className="space-y-3">
      {/* job_type 은 readonly 표시 */}
      <div className="text-[10px] text-muted-foreground">
        잡 타입: <span className="font-mono">{job.jobType}</span>
        {selectedType && <span className="ml-1 opacity-70">— {selectedType.label}</span>}
        <span className="ml-1 opacity-70">(변경 불가 — 타입 바꾸려면 삭제 후 재생성)</span>
      </div>

      {/* enabled toggle */}
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="w-3.5 h-3.5"
        />
        <span className="text-xs">
          활성화 <span className="text-muted-foreground">(꺼두면 스케줄/수동 실행 모두 차단)</span>
        </span>
      </label>

      <div>
        <label htmlFor={f('name')} className="block text-[10px] text-muted-foreground mb-1">이름</label>
        <input
          id={f('name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded-xl"
        />
      </div>

      <div>
        <label htmlFor={f('desc')} className="block text-[10px] text-muted-foreground mb-1">설명</label>
        <input
          id={f('desc')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded-xl"
        />
      </div>

      <MasterHostPicker
        clusterId={job.clusterId}
        customHost={hostCustom}
        selectedName={hostSelectedName}
        label="기본 호스트"
        compact
        onChange={({ selectedName, customHost, effectiveHost }) => {
          setHostSelectedName(selectedName);
          setHostCustom(customHost);
          setHost(effectiveHost);
        }}
      />

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={f('port')} className="block text-[10px] text-muted-foreground mb-1">기본 포트</label>
          <input
            id={f('port')}
            type="number"
            value={port}
            onChange={(e) => setPort(Number(e.target.value) || 22)}
            className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded-xl"
          />
        </div>
        <div>
          <label htmlFor={f('user')} className="block text-[10px] text-muted-foreground mb-1">기본 사용자</label>
          <input
            id={f('user')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded-xl font-mono"
          />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label htmlFor={f('params')} className="block text-[10px] text-muted-foreground">
            params (JSON) — 실행될 명령을 만드는 인자
          </label>
          {selectedType && (
            <button
              type="button"
              onClick={resetParamsToDefault}
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary"
              title="이 잡 타입의 default 파라미터로 되돌리기"
            >
              <RotateCcw className="w-3 h-3" />
              default 복원
            </button>
          )}
        </div>
        <textarea
          id={f('params')}
          value={paramsJson}
          onChange={(e) => setParamsJson(e.target.value)}
          rows={6}
          className="w-full px-2 py-1.5 text-[11px] bg-background border border-border rounded-xl font-mono"
        />
        {selectedType && Object.keys(selectedType.paramSchema ?? {}).length > 0 && (
          <details className="mt-1 text-[10px] text-muted-foreground">
            <summary className="cursor-pointer hover:text-foreground">사용 가능한 파라미터</summary>
            <ul className="mt-1 space-y-1 pl-3">
              {Object.entries(selectedType.paramSchema).map(([k, v]) => (
                <li key={k}>
                  <span className="font-mono">{k}</span>
                  <span className="opacity-60"> ({v.type})</span>
                  {typeof v.default !== 'undefined' && (
                    <span className="opacity-60"> · default: <span className="font-mono">{JSON.stringify(v.default)}</span></span>
                  )}
                  {v.help ? <span> — {String(v.help)}</span> : null}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div>
        <label htmlFor={f('cron')} className="block text-[10px] text-muted-foreground mb-1">
          cron 식 <span className="opacity-70">(비우면 수동 실행 전용)</span>
        </label>
        <input
          id={f('cron')}
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          placeholder="0 3 * * *"
          className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded-xl font-mono"
        />
      </div>

      {error && <div className="text-[11px] text-red-500">{error}</div>}
      {okMsg && <div className="text-[11px] text-emerald-600">{okMsg}</div>}

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={reset}
          disabled={update.isPending}
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs bg-secondary hover:bg-secondary/70 border border-border rounded-xl disabled:opacity-60"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          되돌리기
        </button>
        <button
          type="button"
          onClick={save}
          disabled={update.isPending}
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl mac-shadow disabled:opacity-60"
        >
          <Save className="w-3.5 h-3.5" />
          {update.isPending ? '저장 중…' : '저장'}
        </button>
      </div>
    </div>
  );
}
