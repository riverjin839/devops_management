// frontend/src/components/batch-jobs/BatchJobSlideOver.RunForm.tsx
import { useId, useState } from 'react';
import { Check, Play, Plug, PowerOff, ShieldCheck, X } from 'lucide-react';
import type { BatchJob, BatchJobRun, BatchJobTestConnectionResponse } from '@/services/api';
import { MasterHostPicker, RunLogPanel } from '@/components/common';
import { useBatchJobTypes, useRunBatchJob, useTestBatchJobConnection } from '@/hooks/useBatchJobs';
import { runLogged, useRunLog } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { BatchJobLogDetail } from './BatchJobLogDetail';
import { PREFLIGHT_CHECK_LABEL, batchJobRunLines, testConnectionLines } from './runLogLines';

interface RunFormProps {
  job: BatchJob;
}

export function RunForm({ job }: RunFormProps) {
  const run = useRunBatchJob();
  const testConn = useTestBatchJobConnection();
  const typesQ = useBatchJobTypes();
  const stepPlan = (typesQ.data ?? []).find((t) => t.jobType === job.jobType)?.stepPlan;
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const [host, setHost] = useState(job.defaultHost ?? '');
  const [hostSelectedName, setHostSelectedName] = useState('');
  const [hostCustom, setHostCustom] = useState(job.defaultHost ?? '');
  const [port, setPort] = useState(job.defaultPort);
  const [username, setUsername] = useState(job.defaultUsername);
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [paramOverrideJson, setParamOverrideJson] = useState('');
  const [timeoutSec, setTimeoutSec] = useState(120);
  const [result, setResult] = useState<BatchJobRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<BatchJobTestConnectionResponse | null>(null);
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('batch-job-run-form');

  const hasSavedCreds = job.hasSavedPassword || job.hasSavedPrivateKey;
  const credsProvided = Boolean(password || privateKey);
  // non-SSH(클러스터 스코프) 잡 — host/자격증명 입력 없이 kubeconfig 로 실행.
  const isSsh = job.requiresSsh !== false;

  const submit = async () => {
    setError(null);
    setResult(null);
    setTestResult(null);
    if (!job.enabled) { setError('비활성화된 잡입니다 — "편집" 버튼에서 먼저 활성화하세요.'); return; }
    if (isSsh && !host.trim()) { setError('호스트를 입력해주세요.'); return; }
    if (isSsh && !credsProvided && !hasSavedCreds) {
      setError('비밀번호 또는 개인키를 입력하거나, 잡에 자격증명을 저장하세요.');
      return;
    }
    let paramOverride: Record<string, unknown> | undefined;
    if (paramOverrideJson.trim()) {
      try {
        paramOverride = JSON.parse(paramOverrideJson) as Record<string, unknown>;
      } catch {
        setError('paramOverride JSON 파싱 실패.');
        return;
      }
    }
    // 요청 실패는 실행 로그 error 줄로 남는다(인라인 오류 텍스트는 입력 검증용으로만 쓴다).
    const target = isSsh ? `${username.trim() || 'root'}@${host.trim()}:${port}` : 'kubeconfig(클러스터 스코프)';
    const r = await runLogged(runLog, {
      title: '배치잡 실행',
      first: `${job.name} — ${target} 대상 실행 요청 (타임아웃 ${timeoutSec}초)`,
      fn: () => run.mutateAsync({
        id: job.id,
        payload: isSsh
          ? {
              host: host.trim(),
              port,
              username: username.trim() || 'root',
              password: password || undefined,
              privateKey: privateKey || undefined,
              paramOverride,
              timeout: timeoutSec,
            }
          : { paramOverride, timeout: timeoutSec },
      }),
      summarize: ({ data }) => batchJobRunLines(data),
    });
    if (r.ok) setResult(r.data.data);
  };

  const runTest = async () => {
    setError(null);
    setTestResult(null);
    // non-SSH(K8s) 잡은 호스트/자격증명 없이 백엔드가 kubeconfig→kubectl→API→RBAC 를 점검
    if (isSsh) {
      if (!host.trim()) { setError('호스트를 입력해주세요.'); return; }
      if (!credsProvided && !hasSavedCreds) {
        setError('비밀번호 또는 개인키를 입력하거나, 잡에 자격증명을 저장하세요.');
        return;
      }
    }
    const r = await runLogged(runLog, {
      title: isSsh ? '연결 테스트' : '사전 점검',
      first: isSsh
        ? `${job.name} — ${username.trim() || 'root'}@${host.trim()}:${port} SSH 연결 테스트 요청`
        : `${job.name} — kubeconfig → kubectl → API → RBAC 사전 점검 요청`,
      fn: () => testConn.mutateAsync({
        id: job.id,
        payload: isSsh
          ? {
              host: host.trim(),
              port,
              username: username.trim() || 'root',
              password: password || undefined,
              privateKey: privateKey || undefined,
            }
          : {},
      }),
      summarize: ({ data }) => testConnectionLines(data),
    });
    if (r.ok) setTestResult(r.data.data);
  };

  return (
    <div className="space-y-3">
      {!job.enabled && (
        <div className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400 bg-slate-400/10 border border-slate-400/30 rounded-lg px-2.5 py-2">
          <PowerOff className="w-3.5 h-3.5 flex-shrink-0" />
          이 잡은 비활성화되어 있습니다 — "편집" 버튼에서 활성화해야 실행할 수 있습니다
          (연결 테스트는 계속 사용할 수 있습니다).
        </div>
      )}
      {!isSsh && (
        <div className="text-xs text-muted-foreground bg-secondary/30 border border-border rounded-lg px-2.5 py-2">
          SSH 불필요 — 클러스터 kubeconfig 로 백엔드에서 직접 실행됩니다.
        </div>
      )}
      {isSsh && (
        <>
          <MasterHostPicker
            clusterId={job.clusterId}
            customHost={hostCustom}
            selectedName={hostSelectedName}
            label="호스트"
            compact
            onChange={({ selectedName, customHost, effectiveHost }) => {
              setHostSelectedName(selectedName);
              setHostCustom(customHost);
              setHost(effectiveHost);
            }}
          />

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor={f('port')} className="block text-xs text-muted-foreground mb-1">포트</label>
              <input
                id={f('port')}
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value) || 22)}
                className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-xl"
              />
            </div>
            <div>
              <label htmlFor={f('user')} className="block text-xs text-muted-foreground mb-1">사용자</label>
              <input
                id={f('user')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-xl font-mono"
              />
            </div>
          </div>

          {hasSavedCreds && !credsProvided && (
            <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground bg-secondary border border-border rounded-lg px-2 py-1">
              <ShieldCheck className="w-3 h-3" />
              저장된 자격증명을 사용합니다 ({[job.hasSavedPassword && '비밀번호', job.hasSavedPrivateKey && '개인키'].filter(Boolean).join(' / ')})
            </div>
          )}

          <div>
            <label htmlFor={f('pw')} className="block text-xs text-muted-foreground mb-1">
              비밀번호 {hasSavedCreds && '(비워두면 저장된 자격증명 사용)'}
            </label>
            <input
              id={f('pw')}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={hasSavedCreds ? '비워두면 저장된 자격증명 사용' : ''}
              className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-xl"
            />
          </div>
        </>
      )}

      <details>
        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
          {isSsh ? '개인키 (PEM, 선택) / paramOverride / 타임아웃' : 'paramOverride / 타임아웃'}
        </summary>
        <div className="mt-2 space-y-2">
          {isSsh && (
            <div>
              <label htmlFor={f('pem')} className="block text-xs text-muted-foreground mb-1">개인키 (PEM)</label>
              <textarea
                id={f('pem')}
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                rows={3}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded-xl font-mono"
              />
            </div>
          )}
          <div>
            <label htmlFor={f('override')} className="block text-xs text-muted-foreground mb-1">paramOverride (JSON)</label>
            <textarea
              id={f('override')}
              value={paramOverrideJson}
              onChange={(e) => setParamOverrideJson(e.target.value)}
              rows={2}
              placeholder='{"endpoints": "https://10.0.0.1:2379"}'
              className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded-xl font-mono"
            />
          </div>
          <div>
            <label htmlFor={f('to')} className="block text-xs text-muted-foreground mb-1">타임아웃 (초)</label>
            <input
              id={f('to')}
              type="number"
              value={timeoutSec}
              onChange={(e) => setTimeoutSec(Number(e.target.value) || 60)}
              className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-xl"
            />
          </div>
        </div>
      </details>

      {error && <div className="text-xs text-status-critical">{error}</div>}

      <TestConnectionResult result={testResult} />

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={runTest}
          disabled={testConn.isPending || run.isPending}
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm bg-secondary hover:bg-primary/10 hover:text-primary border border-border rounded-xl disabled:opacity-60"
        >
          <Plug className="w-3.5 h-3.5" />
          {testConn.isPending
            ? '테스트 중…'
            : isSsh ? '연결 테스트' : '사전 점검'}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={run.isPending || testConn.isPending || !job.enabled}
          title={!job.enabled ? '비활성화된 잡입니다 — "편집" 버튼에서 먼저 활성화하세요.' : undefined}
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl shadow-card disabled:opacity-60"
        >
          <Play className="w-3.5 h-3.5" />
          {run.isPending ? '실행 중…' : '실행'}
        </button>
      </div>

      <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />

      {result && <BatchJobLogDetail run={result} stepPlan={stepPlan} maxHeight="max-h-[240px]" />}
    </div>
  );
}

/**
 * Shared test-connection result banner. Exported so SavedCreds can reuse the
 * same visual treatment (status pill + latency + error + saved-cred indicator).
 * K8s(non-SSH) 사전 점검 응답(mode="k8s")은 단계별 체크 결과를 행으로 펼친다.
 */
export function TestConnectionResult({ result }: { result: BatchJobTestConnectionResponse | null }) {
  if (!result) return null;
  const isOk = result.status === 'ok';
  const tone = isOk
    ? 'bg-status-healthy/10 border-status-healthy/30 text-status-healthy'
    : 'bg-status-critical/10 border-status-critical/30 text-status-critical';
  const label = (
    {
      ok: '연결 성공',
      auth_error: '인증 실패',
      connect_error: '연결 실패',
      timeout: '타임아웃',
      error: '오류',
    } as Record<string, string>
  )[result.status] ?? result.status;
  const isK8s = result.mode === 'k8s';
  return (
    <div className={`border rounded-xl px-2.5 py-2 text-xs ${tone}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold">{label}</span>
        <span className="font-mono text-xs opacity-70">
          {isK8s ? `클러스터 ${result.host}` : `${result.username}@${result.host}:${result.port}`}
        </span>
        <span className="font-mono text-xs opacity-70">{result.latencyMs}ms</span>
        {(result.usedSavedPassword || result.usedSavedPrivateKey) && (
          <span className="text-xs opacity-70">
            (저장된 {result.usedSavedPassword ? '비밀번호' : '개인키'} 사용)
          </span>
        )}
      </div>
      {isK8s && (result.checks?.length ?? 0) > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {result.checks!.map((c) => (
            <li key={c.check} className="flex items-start gap-1.5 text-foreground/90">
              <span className="flex-shrink-0 mt-px">
                {c.ok === true
                  ? <Check className="w-3.5 h-3.5 text-muted-foreground" aria-label="통과" />
                  : c.ok === false
                    ? <X className="w-3.5 h-3.5 text-status-critical" aria-label="실패" />
                    : '—'}
              </span>
              <span className="flex-shrink-0 font-medium">
                {PREFLIGHT_CHECK_LABEL[c.check] ?? c.check}
              </span>
              <span className="min-w-0 opacity-80 break-all">{c.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {!isK8s && result.error && <div className="mt-1 text-xs font-mono break-all">{result.error}</div>}
    </div>
  );
}
