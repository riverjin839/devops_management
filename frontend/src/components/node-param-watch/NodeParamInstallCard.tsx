// 에이전트 설치 — 설정(admin, 보고 주기·무응답 기준·이미지·주소) + 이 클러스터용 DaemonSet 매니페스트(토큰은 자리표시자).
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Copy, Download, Settings2, TerminalSquare } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState, StatusBadge, useToast } from '@/components/common';
import { useNodeParamManifest, useNodeParamSettings, useUpdateNodeParamSettings } from '@/hooks/useNodeParamWatch';
import { formatApiError } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import type { NodeParamSettings } from '@/types';

const INPUT = 'w-full text-sm px-2.5 py-1.5 rounded-xl border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60';
const ADMIN_HINT = '설정은 관리자만 바꿀 수 있습니다';

type Form = Omit<NodeParamSettings, 'tokenConfigured'>;

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="mt-1">{children}</div>
      {help && <span className="block mt-1 text-xs text-muted-foreground leading-snug">{help}</span>}
    </label>
  );
}

export function NodeParamInstallCard({ clusterId, clusterName }: { clusterId: string; clusterName: string }) {
  const toast = useToast();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const settingsQ = useNodeParamSettings();
  const manifestQ = useNodeParamManifest(clusterId, true);
  const save = useUpdateNodeParamSettings();
  const [form, setForm] = useState<Form | null>(null);

  useEffect(() => {
    if (settingsQ.data) {
      const { tokenConfigured: _ignored, ...rest } = settingsQ.data;
      void _ignored;
      setForm(rest);
    }
  }, [settingsQ.data]);

  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const onSave = async () => {
    if (!form) return;
    try {
      await save.mutateAsync(form);
      toast.success('설정을 저장했습니다', '보고 주기는 에이전트의 다음 보고부터 반영됩니다.');
    } catch (e) {
      toast.error('설정 저장 실패', formatApiError(e));
    }
  };

  const yaml = manifestQ.data?.yaml ?? '';
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(yaml);
      toast.success('매니페스트를 복사했습니다');
    } catch {
      toast.error('복사 실패', '브라우저가 클립보드 접근을 막았습니다. 내려받기를 쓰세요.');
    }
  };
  const onDownload = () => {
    const url = URL.createObjectURL(new Blob([yaml], { type: 'text/yaml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `node-param-agent-${clusterName.replace(/[^\w.-]+/g, '-')}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const tokenConfigured = settingsQ.data?.tokenConfigured ?? manifestQ.data?.tokenConfigured;

  return (
    <div className="space-y-4">
      <MacCard
        title="설치 매니페스트"
        icon={TerminalSquare}
        description={`${clusterName} 용 — 권한 없는 DaemonSet, 노드마다 1개`}
        actions={(
          <>
            <Button size="sm" variant="outline" disabled={!yaml} onClick={() => { void onCopy(); }} title="매니페스트 복사" aria-label="매니페스트 복사">
              <Copy /> 복사
            </Button>
            <Button size="sm" variant="outline" disabled={!yaml} onClick={onDownload} title="YAML 내려받기" aria-label="매니페스트 YAML 내려받기">
              <Download /> 내려받기
            </Button>
          </>
        )}
      >
        <ol className="list-decimal pl-5 space-y-1 text-sm text-foreground mb-3">
          <li>
            PEP backend 환경변수 <code className="font-mono text-xs">NODE_PARAM_INGEST_TOKEN</code> 을 설정한다
            {tokenConfigured === false && (
              <StatusBadge variant="warning" label="아직 설정되지 않음 — 보고가 503 으로 거부됨" className="ml-2" />
            )}
            {tokenConfigured && <span className="ml-2 text-xs text-muted-foreground">(설정됨)</span>}
          </li>
          <li>아래 Secret 의 <code className="font-mono text-xs">NODE_PARAM_INGEST_TOKEN</code> 자리에 같은 값을 넣고 <code className="font-mono text-xs">kubectl apply -f</code> 로 적용한다.</li>
          <li>잠시 뒤 노드 상태 탭에 노드가 &lsquo;보고 중&rsquo; 으로 나타나는지 본다. 파드 로그(<code className="font-mono text-xs">kubectl logs -n {form?.agentNamespace ?? 'k8s-monitor-agent'} ds/node-param-agent</code>)에 보고 결과가 줄마다 찍힌다.</li>
        </ol>
        <p className="text-xs text-muted-foreground mb-3">
          특권·hostPID 없이 비 root 로 돈다. <code className="font-mono">hostNetwork</code>·<code className="font-mono">hostIPC</code> 는 네임스페이스별 값(net.*, kernel.shm*)을 노드 기준으로 읽기 위해서만 켜고,
          호스트 경로는 sysctl 설정 파일 위치만 읽기 전용으로 마운트한다. 저장소의 <code className="font-mono">deploy/k8s/node-param-agent/</code> 와 같은 내용이다(GitOps 배포 시 그쪽을 쓴다).
        </p>
        {manifestQ.isLoading ? (
          <LoadingState />
        ) : manifestQ.isError ? (
          <ErrorState error={manifestQ.error} title="매니페스트를 만들지 못했습니다" onRetry={() => { void manifestQ.refetch(); }} />
        ) : (
          <pre className="text-xs font-mono bg-secondary text-foreground rounded-md p-3 overflow-auto max-h-[420px]" aria-label="설치 매니페스트 YAML">{yaml}</pre>
        )}
      </MacCard>

      <MacCard title="에이전트 설정" icon={Settings2} description="모든 클러스터 공통 · 관리자만 변경">
        {!form ? (
          settingsQ.isError ? <ErrorState error={settingsQ.error} title="설정을 불러오지 못했습니다" /> : <LoadingState />
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="보고 주기 (초)" help="15 ~ 3600. 짧을수록 변경을 빨리 알지만 보고가 잦아진다. 다음 보고부터 반영.">
                <input type="number" min={15} max={3600} className={INPUT} disabled={!isAdmin}
                  value={form.intervalSec} onChange={(e) => set({ intervalSec: Number(e.target.value) })} aria-label="보고 주기(초)" />
              </Field>
              <Field label="무응답 알람 (분)" help="마지막 보고 뒤 이 시간이 지나면 '에이전트 무응답' 알람. 0 = 끔.">
                <input type="number" min={0} max={1440} className={INPUT} disabled={!isAdmin}
                  value={form.offlineMinutes} onChange={(e) => set({ offlineMinutes: Number(e.target.value) })} aria-label="무응답 알람(분)" />
              </Field>
              <Field label="에이전트 이미지" help="전용 노드 에이전트 이미지(node-agent, 정적 바이너리). backend 이미지를 지정하면 Python 에이전트 방식으로 렌더된다. 폐쇄망이면 사내 레지스트리 경로로 바꾼다.">
                <input className={`${INPUT} font-mono`} disabled={!isAdmin} value={form.agentImage}
                  onChange={(e) => set({ agentImage: e.target.value })} aria-label="에이전트 이미지" />
              </Field>
              <Field label="네임스페이스">
                <input className={`${INPUT} font-mono`} disabled={!isAdmin} value={form.agentNamespace}
                  onChange={(e) => set({ agentNamespace: e.target.value })} aria-label="에이전트 네임스페이스" />
              </Field>
              <Field label="PEP API 주소" help="에이전트가 노드에서 접속할 주소(…/api/v1). 비우면 지금 화면을 연 주소를 쓴다 — 노드에서 닿는 주소인지 확인한다.">
                <input className={`${INPUT} font-mono`} disabled={!isAdmin} value={form.ingestBaseUrl}
                  placeholder={manifestQ.data?.apiBaseUrl ?? 'https://pep.example.com/api/v1'}
                  onChange={(e) => set({ ingestBaseUrl: e.target.value })} aria-label="PEP API 주소" />
              </Field>
              <label className="flex items-start gap-2 text-sm pt-5">
                <input type="checkbox" className="accent-primary mt-0.5" disabled={!isAdmin} checked={form.tlsVerify}
                  onChange={(e) => set({ tlsVerify: e.target.checked })} />
                <span>
                  PEP 의 TLS 인증서를 검증
                  <span className="block text-xs text-muted-foreground">사설 인증서라면 끄거나, 에이전트에 CA 를 마운트하고 PEP_CA_FILE 을 지정한다.</span>
                </span>
              </label>
            </div>
            <div className="flex justify-end">
              <Button size="sm" disabled={!isAdmin || save.isPending} onClick={() => { void onSave(); }}
                title={isAdmin ? '설정 저장' : ADMIN_HINT} aria-label={isAdmin ? '설정 저장' : `설정 저장 — ${ADMIN_HINT}`}>
                {save.isPending ? '저장 중…' : '저장'}
              </Button>
            </div>
          </div>
        )}
      </MacCard>
    </div>
  );
}
