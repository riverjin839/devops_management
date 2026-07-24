// frontend/src/components/batch-jobs/BatchJobSlideOver.RunForm.tsx
import { useId, useState } from 'react';
import { Play, Plug, ShieldCheck } from 'lucide-react';
import type { BatchJob, BatchJobRun, BatchJobTestConnectionResponse } from '@/services/api';
import { LogViewer, MasterHostPicker } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import { useRunBatchJob, useTestBatchJobConnection } from '@/hooks/useBatchJobs';
import { StatusPill } from './StatusPill';

interface RunFormProps {
  job: BatchJob;
}

export function RunForm({ job }: RunFormProps) {
  const run = useRunBatchJob();
  const testConn = useTestBatchJobConnection();
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

  const hasSavedCreds = job.hasSavedPassword || job.hasSavedPrivateKey;
  const credsProvided = Boolean(password || privateKey);
  // non-SSH(클러스터 스코프) 잡 — host/자격증명 입력 없이 kubeconfig 로 실행.
  const isSsh = job.requiresSsh !== false;

  const submit = async () => {
    setError(null);
    setResult(null);
    setTestResult(null);
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
    try {
      const { data } = await run.mutateAsync({
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
      });
      setResult(data);
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  const runTest = async () => {
    setError(null);
    setTestResult(null);
    if (!host.trim()) { setError('호스트를 입력해주세요.'); return; }
    if (!credsProvided && !hasSavedCreds) {
      setError('비밀번호 또는 개인키를 입력하거나, 잡에 자격증명을 저장하세요.');
      return;
    }
    try {
      const { data } = await testConn.mutateAsync({
        id: job.id,
        payload: {
          host: host.trim(),
          port,
          username: username.trim() || 'root',
          password: password || undefined,
          privateKey: privateKey || undefined,
        },
      });
      setTestResult(data);
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  return (
    <div className="space-y-3">
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
            <div className="inline-flex items-center gap-1.5 text-xs text-emerald-700 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-2 py-1">
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

      {error && <div className="text-xs text-red-500">{error}</div>}

      <TestConnectionResult result={testResult} />

      <div className="flex items-center gap-1.5">
        {isSsh && (
          <button
            type="button"
            onClick={runTest}
            disabled={testConn.isPending || run.isPending}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm bg-secondary hover:bg-primary/10 hover:text-primary border border-border rounded-xl disabled:opacity-60"
          >
            <Plug className="w-3.5 h-3.5" />
            {testConn.isPending ? '테스트 중…' : '연결 테스트'}
          </button>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={run.isPending || testConn.isPending}
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl mac-shadow disabled:opacity-60"
        >
          <Play className="w-3.5 h-3.5" />
          {run.isPending ? '실행 중…' : '실행'}
        </button>
      </div>

      {result && (
        <div className="border border-border rounded-xl overflow-hidden">
          <div className="px-2.5 py-1.5 border-b border-border bg-secondary/40 flex items-center gap-2 flex-wrap">
            <StatusPill status={result.status} />
            {result.exitCode !== null && result.exitCode !== undefined && (
              <span className="text-xs font-mono text-muted-foreground">exit {result.exitCode}</span>
            )}
            <span className="text-xs font-mono text-muted-foreground">{result.durationMs}ms</span>
          </div>
          <div className="p-2 space-y-2">
            {result.executedCommand && (
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">command</p>
                <pre className="text-xs font-mono bg-background border border-border rounded p-2 overflow-auto whitespace-pre-wrap">
                  {result.executedCommand}
                </pre>
              </div>
            )}
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">stdout</p>
              <LogViewer text={result.stdout} maxHeight="max-h-[200px]" />
            </div>
            {result.stderr && (
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">stderr</p>
                <LogViewer text={result.stderr} maxHeight="max-h-[160px]" asError />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Shared test-connection result banner. Exported so SavedCreds can reuse the
 * same visual treatment (status pill + latency + error + saved-cred indicator).
 */
export function TestConnectionResult({ result }: { result: BatchJobTestConnectionResponse | null }) {
  if (!result) return null;
  const isOk = result.status === 'ok';
  const tone = isOk
    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700'
    : 'bg-red-500/10 border-red-500/30 text-red-600';
  const label = (
    {
      ok: '연결 성공',
      auth_error: '인증 실패',
      connect_error: '연결 실패',
      timeout: '타임아웃',
      error: '오류',
    } as Record<string, string>
  )[result.status] ?? result.status;
  return (
    <div className={`border rounded-xl px-2.5 py-2 text-xs ${tone}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold">{label}</span>
        <span className="font-mono text-xs opacity-70">
          {result.username}@{result.host}:{result.port}
        </span>
        <span className="font-mono text-xs opacity-70">{result.latencyMs}ms</span>
        {(result.usedSavedPassword || result.usedSavedPrivateKey) && (
          <span className="text-xs opacity-70">
            (저장된 {result.usedSavedPassword ? '비밀번호' : '개인키'} 사용)
          </span>
        )}
      </div>
      {result.error && <div className="mt-1 text-xs font-mono break-all">{result.error}</div>}
    </div>
  );
}
