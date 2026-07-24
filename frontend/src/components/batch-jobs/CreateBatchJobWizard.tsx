// frontend/src/components/batch-jobs/CreateBatchJobWizard.tsx
import { useEffect, useRef, useState } from 'react';
import type { BatchJob } from '@/services/api';
import { useClusters } from '@/hooks/useCluster';
import { useBatchJobTypes, useCreateBatchJob } from '@/hooks/useBatchJobs';
import { formatApiError } from '@/lib/utils';
import {
  EMPTY_WIZARD,
  cronRequiresCredentials,
  isStepTypeValid,
  isStepHostValid,
  isStepScheduleValid,
  type WizardState,
} from './CreateBatchJobWizard.shared';
import { StepType } from './CreateBatchJobWizard.StepType';
import { StepHost } from './CreateBatchJobWizard.StepHost';
import { StepSchedule } from './CreateBatchJobWizard.StepSchedule';

interface CreateBatchJobWizardProps {
  open: boolean;
  /** 호출자가 미리 정해둔 cluster — wizard 가 step 1 에서 select 를 readonly 로 표시. */
  defaultClusterId?: string;
  /** 호출자가 미리 정해둔 jobType. */
  defaultJobType?: string;
  onClose: () => void;
  /** 등록 성공 시 새 잡을 인자로 전달 — 부모에서 자동 선택. */
  onCreated: (job: BatchJob) => void;
}

const STEP_LABELS = ['잡 종류', '호스트 / 파라미터', '스케줄 / 자격증명'];

export function CreateBatchJobWizard({
  open, defaultClusterId, defaultJobType, onClose, onCreated,
}: CreateBatchJobWizardProps) {
  const { data: clusters = [] } = useClusters();
  const typesQ = useBatchJobTypes();
  const create = useCreateBatchJob();

  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [state, setState] = useState<WizardState>(EMPTY_WIZARD);
  const [error, setError] = useState<string | null>(null);

  // open 될 때마다 초기화 + prefilled 값 적용.
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setError(null);
    setState({
      ...EMPTY_WIZARD,
      clusterId: defaultClusterId ?? '',
      jobType: defaultJobType ?? '',
    });
  }, [open, defaultClusterId, defaultJobType]);

  // ESC 로 닫기.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  if (!open) return null;

  const types = typesQ.data ?? [];
  const selectedType = types.find((t) => t.jobType === state.jobType);
  // non-SSH(클러스터 스코프) 타입은 host/자격증명 없이 kubeconfig 로 실행된다.
  const isSshType = selectedType ? selectedType.requiresSsh !== false : true;

  const update = (next: Partial<WizardState>) => setState((s) => ({ ...s, ...next }));

  const goNext = () => {
    setError(null);
    if (step === 0 && !isStepTypeValid(state)) {
      setError('클러스터, 잡 타입, 이름은 필수입니다.');
      return;
    }
    if (step === 1 && !isStepHostValid(state)) {
      setError('params JSON 파싱에 실패했습니다.');
      return;
    }
    if (step < 2) setStep((s) => ((s + 1) as 0 | 1 | 2));
  };

  const goBack = () => {
    setError(null);
    if (step > 0) setStep((s) => ((s - 1) as 0 | 1 | 2));
  };

  const submit = async () => {
    setError(null);
    if (!isStepTypeValid(state) || !isStepHostValid(state) || !isStepScheduleValid()) {
      setError('필수 입력이 누락되었습니다.');
      return;
    }
    let params: Record<string, unknown> = {};
    try {
      params = state.paramsJson.trim() ? JSON.parse(state.paramsJson) : {};
    } catch {
      setError('params JSON 파싱 실패.');
      return;
    }
    try {
      const sshType = (types.find((t) => t.jobType === state.jobType)?.requiresSsh ?? true) !== false;
      const { data } = await create.mutateAsync({
        clusterId: state.clusterId,
        name: state.name.trim(),
        description: state.description.trim() || undefined,
        jobType: state.jobType,
        defaultHost: sshType ? state.defaultHost.trim() || undefined : undefined,
        defaultPort: state.defaultPort,
        defaultUsername: state.defaultUsername.trim() || 'root',
        cron: state.cron.trim() || undefined,
        params,
        savedPassword: sshType ? state.savedPassword || undefined : undefined,
        savedPrivateKey: sshType ? state.savedPrivateKey || undefined : undefined,
      });
      onCreated(data);
      onClose();
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="button"
      tabIndex={0}
      aria-label="wizard 닫기"
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClose(); }}
    >
      <div
        className="bg-card border border-border rounded-2xl shadow-xl w-full max-w-2xl max-h-[92vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold">새 배치 잡 등록</h3>
          <button onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground">
            닫기
          </button>
        </header>

        {/* Step indicator */}
        <div className="px-5 pt-4">
          <ol className="flex items-center gap-2">
            {STEP_LABELS.map((label, idx) => {
              const active = idx === step;
              const done = idx < step;
              return (
                <li
                  key={label}
                  className="flex items-center gap-2 flex-1"
                  aria-current={active ? 'step' : undefined}
                >
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold ${
                      active ? 'bg-primary text-primary-foreground' :
                      done ? 'bg-emerald-500 text-white' :
                      'bg-secondary text-muted-foreground'
                    }`}
                    aria-label={done ? `${label} — 완료` : label}
                  >
                    {idx + 1}
                  </div>
                  <span className={`text-sm ${active ? 'text-foreground font-medium' : 'text-muted-foreground'} truncate`}>
                    {label}
                  </span>
                  {idx < STEP_LABELS.length - 1 && <div className="flex-1 h-px bg-border" />}
                </li>
              );
            })}
          </ol>
        </div>

        <div className="p-5 overflow-y-auto flex-1">
          {step === 0 && (
            <StepType
              clusters={clusters}
              types={types}
              fixedClusterId={defaultClusterId}
              state={state}
              onChange={update}
            />
          )}
          {step === 1 && <StepHost types={types} state={state} onChange={update} requiresSsh={isSshType} />}
          {step === 2 && <StepSchedule state={state} onChange={update} requiresSsh={isSshType} />}

          {error && <div role="alert" className="mt-3 text-sm text-red-500">{error}</div>}
        </div>

        <footer className="px-5 py-3 border-t border-border flex items-center justify-between gap-2">
          <button
            onClick={goBack}
            disabled={step === 0}
            className="px-3 py-1.5 text-sm rounded-xl bg-secondary text-secondary-foreground disabled:opacity-40 hover:bg-secondary/80"
          >
            이전
          </button>
          <div className="text-xs text-muted-foreground">
            {step + 1} / {STEP_LABELS.length}
          </div>
          {step < 2 ? (
            <button
              onClick={goNext}
              className="px-3 py-1.5 text-sm rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 mac-shadow"
            >
              다음
            </button>
          ) : (() => {
            // Design Ref: §2.4.2 — cron + creds/host 누락이면 등록 차단 (백엔드 422 와 동기).
            // non-SSH 타입은 host/자격증명이 필요 없어 차단하지 않는다.
            const credsBlocking = isSshType && cronRequiresCredentials(
              state.cron,
              state.savedPassword,
              state.savedPrivateKey,
            );
            const hostBlocking = isSshType && !!state.cron.trim() && !state.defaultHost.trim();
            return (
              <button
                onClick={submit}
                disabled={create.isPending || credsBlocking || hostBlocking}
                title={
                  credsBlocking
                    ? 'cron 을 사용하려면 비밀번호 또는 개인키 중 하나를 입력하세요'
                    : hostBlocking
                      ? 'cron 을 사용하려면 2단계에서 기본 호스트를 지정하세요'
                      : undefined
                }
                className="px-3 py-1.5 text-sm rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 mac-shadow disabled:opacity-60"
              >
                {create.isPending ? '등록 중…' : '등록'}
              </button>
            );
          })()}
        </footer>
      </div>
    </div>
  );
}
