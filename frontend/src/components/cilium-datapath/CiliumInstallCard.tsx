// 에이전트 설치 — 이 클러스터용 pep-bpf-agent DaemonSet 매니페스트(토큰은 자리표시자) + 공통 설정(admin).
// 수집 관련 설정(주기·시간 예산·고정 경로·접두어)은 에이전트 보고 응답으로 내려가 다음 보고부터 반영된다.
// 권한(CAP_SYS_ADMIN)은 매니페스트에 들어가므로 바꾸면 매니페스트를 다시 적용해야 한다.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Copy, Download, Settings2, TerminalSquare } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState, StatusBadge, useToast } from '@/components/common';
import {
  useCiliumDatapathManifest, useCiliumDatapathSettings, useUpdateCiliumDatapathSettings,
} from '@/hooks/useCiliumDatapath';
import { formatApiError } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import type { CiliumDatapathSettings } from '@/types';

const INPUT = 'w-full text-sm px-2.5 py-1.5 rounded-xl border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60';
const ADMIN_HINT = '설정은 관리자만 바꿀 수 있습니다';

type Form = Omit<CiliumDatapathSettings, 'tokenConfigured' | 'pinDirs' | 'mapPrefixes' | 'programPrefixes'> & {
  pinDirs: string; mapPrefixes: string; programPrefixes: string;
};

const toList = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="mt-1">{children}</div>
      {help && <span className="block mt-1 text-xs text-muted-foreground leading-snug">{help}</span>}
    </label>
  );
}

function Check({ checked, disabled, onChange, title, help }: {
  checked: boolean; disabled: boolean; onChange: (v: boolean) => void; title: string; help: string;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="accent-primary mt-0.5" disabled={disabled} checked={checked}
        onChange={(e) => onChange(e.target.checked)} />
      <span>
        {title}
        <span className="block text-xs text-muted-foreground">{help}</span>
      </span>
    </label>
  );
}

export function CiliumInstallCard({ clusterId, clusterName }: { clusterId: string; clusterName: string }) {
  const toast = useToast();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const settingsQ = useCiliumDatapathSettings();
  const manifestQ = useCiliumDatapathManifest(clusterId, true);
  const save = useUpdateCiliumDatapathSettings();
  const [form, setForm] = useState<Form | null>(null);

  useEffect(() => {
    if (settingsQ.data) {
      const { tokenConfigured: _ignored, pinDirs, mapPrefixes, programPrefixes, ...rest } = settingsQ.data;
      void _ignored;
      setForm({ ...rest, pinDirs: pinDirs.join(', '), mapPrefixes: mapPrefixes.join(', '), programPrefixes: programPrefixes.join(', ') });
    }
  }, [settingsQ.data]);

  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const onSave = async () => {
    if (!form) return;
    if (form.warnPct >= form.critPct) {
      toast.error('설정 확인', '주의 임계치는 위험 임계치보다 작아야 합니다.');
      return;
    }
    const sysAdminChanged = settingsQ.data ? settingsQ.data.sysAdmin !== form.sysAdmin : false;
    try {
      await save.mutateAsync({
        ...form,
        pinDirs: toList(form.pinDirs),
        mapPrefixes: toList(form.mapPrefixes),
        programPrefixes: toList(form.programPrefixes),
      });
      toast.success('설정을 저장했습니다', sysAdminChanged
        ? '권한이 바뀌었습니다 — 위 매니페스트를 각 클러스터에 다시 적용해야 반영됩니다.'
        : '수집 설정은 에이전트의 다음 보고부터 반영됩니다.');
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
    a.download = `cilium-bpf-agent-${clusterName.replace(/[^\w.-]+/g, '-')}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const tokenConfigured = settingsQ.data?.tokenConfigured ?? manifestQ.data?.tokenConfigured;
  const dis = !isAdmin;

  return (
    <div className="space-y-4">
      <MacCard
        title="설치 매니페스트"
        icon={TerminalSquare}
        description={`${clusterName} 용 — 노드마다 1개, CAP_BPF 만 가진 DaemonSet`}
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
            PEP backend 환경변수 <code className="font-mono text-xs">CILIUM_BPF_AGENT_TOKEN</code> 을 설정한다
            {tokenConfigured === false && (
              <StatusBadge variant="warning" label="아직 설정되지 않음 — 보고가 503 으로 거부됨" className="ml-2" />
            )}
            {tokenConfigured && <span className="ml-2 text-xs text-muted-foreground">(설정됨)</span>}
          </li>
          <li>아래 Secret 의 <code className="font-mono text-xs">CILIUM_BPF_AGENT_TOKEN</code> 자리에 같은 값을 넣고 <code className="font-mono text-xs">kubectl apply -f</code> 로 적용한다.</li>
          <li>
            잠시 뒤 「프로그램·에이전트」 탭에 노드가 &lsquo;보고 중&rsquo; 으로 나타나는지 본다. 노드에서 바로 확인하려면
            <code className="font-mono text-xs"> kubectl -n {form?.agentNamespace ?? 'k8s-monitor-agent'} exec ds/cilium-bpf-agent -- /pep-bpf-agent --dry-run</code>
          </li>
        </ol>
        <p className="text-xs text-muted-foreground mb-3">
          특권·hostNetwork·hostPID 없이 capability 를 모두 제거하고 <code className="font-mono">BPF</code> 하나만 더한다.
          <code className="font-mono"> /sys/fs/bpf</code> 만 읽기 전용으로 마운트하고 맵은 <code className="font-mono">BPF_F_RDONLY</code> 로 연다 — 원본 키·값은 노드 밖으로 나가지 않는다.
          {manifestQ.data?.sysAdmin && ' 지금 설정은 CAP_SYS_ADMIN 도 더한다(프로그램 목록).'}
          {' '}저장소의 <code className="font-mono">deploy/k8s/cilium-bpf-agent/</code> 와 같은 내용이다(GitOps 배포 시 그쪽을 쓴다).
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
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              <Field label="주의 임계치 (%)" help="맵 사용률이 이 값 이상이면 주의(노란색)·주의 알람.">
                <input type="number" min={1} max={99} className={INPUT} disabled={dis} value={form.warnPct}
                  onChange={(e) => set({ warnPct: Number(e.target.value) })} aria-label="주의 임계치(%)" />
              </Field>
              <Field label="위험 임계치 (%)" help="이 값 이상이면 위험(빨간색)·위험 알람. 주의보다 커야 한다.">
                <input type="number" min={2} max={100} className={INPUT} disabled={dis} value={form.critPct}
                  onChange={(e) => set({ critPct: Number(e.target.value) })} aria-label="위험 임계치(%)" />
              </Field>
              <Field label="보고 주기 (초)" help="30 ~ 3600. 「지금 수집」 은 주기와 상관없이 바로 실행된다.">
                <input type="number" min={30} max={3600} className={INPUT} disabled={dis} value={form.intervalSec}
                  onChange={(e) => set({ intervalSec: Number(e.target.value) })} aria-label="보고 주기(초)" />
              </Field>
              <Field label="맵당 시간 예산 (ms)" help="맵 하나의 키를 세는 최대 시간. 넘기면 그때까지 센 값을 하한(≥)으로 보고한다.">
                <input type="number" min={50} max={30000} className={INPUT} disabled={dis} value={form.mapBudgetMs}
                  onChange={(e) => set({ mapBudgetMs: Number(e.target.value) })} aria-label="맵당 시간 예산(ms)" />
              </Field>
              <Field label="전체 시간 예산 (ms)" help="한 번의 수집 전체 상한 — 노드 CPU 사용을 묶어 둔다. 넘기면 남은 맵은 세지 않는다.">
                <input type="number" min={500} max={120000} className={INPUT} disabled={dis} value={form.totalBudgetMs}
                  onChange={(e) => set({ totalBudgetMs: Number(e.target.value) })} aria-label="전체 시간 예산(ms)" />
              </Field>
              <Field label="지금 수집 대기 (초)" help="「지금 수집」 이 노드 보고를 기다리는 최대 시간. 넘기면 응답 없는 노드를 표시하고 끝낸다.">
                <input type="number" min={15} max={600} className={INPUT} disabled={dis} value={form.runTimeoutSec}
                  onChange={(e) => set({ runTimeoutSec: Number(e.target.value) })} aria-label="지금 수집 대기(초)" />
              </Field>
              <Field label="무응답 표시 (분)" help="마지막 보고 뒤 이 시간이 지나면 노드를 '무응답' 으로 표시하고 「지금 수집」 대상에서 뺀다.">
                <input type="number" min={1} max={1440} className={INPUT} disabled={dis} value={form.offlineMinutes}
                  onChange={(e) => set({ offlineMinutes: Number(e.target.value) })} aria-label="무응답 표시(분)" />
              </Field>
              <Field label="고정 경로 (쉼표로 구분)" help="Cilium 이 맵을 고정하는 호스트 경로. 기본 /sys/fs/bpf/tc/globals — /sys/fs/bpf 아래만 마운트된다.">
                <input className={`${INPUT} font-mono`} disabled={dis} value={form.pinDirs}
                  onChange={(e) => set({ pinDirs: e.target.value })} aria-label="고정 경로" />
              </Field>
              <Field label="맵 이름 접두어" help="이 접두어로 시작하는 맵만 센다. 기본 cilium_.">
                <input className={`${INPUT} font-mono`} disabled={dis} value={form.mapPrefixes}
                  onChange={(e) => set({ mapPrefixes: e.target.value })} aria-label="맵 이름 접두어" />
              </Field>
              <Field label="프로그램 이름 접두어" help="프로그램 목록에 넣을 이름 접두어. 기본 cil_, tail_.">
                <input className={`${INPUT} font-mono`} disabled={dis} value={form.programPrefixes}
                  onChange={(e) => set({ programPrefixes: e.target.value })} aria-label="프로그램 이름 접두어" />
              </Field>
              <Field label="에이전트 이미지" help="폐쇄망이면 사내 레지스트리 경로로 바꾼다.">
                <input className={`${INPUT} font-mono`} disabled={dis} value={form.agentImage}
                  onChange={(e) => set({ agentImage: e.target.value })} aria-label="에이전트 이미지" />
              </Field>
              <Field label="네임스페이스">
                <input className={`${INPUT} font-mono`} disabled={dis} value={form.agentNamespace}
                  onChange={(e) => set({ agentNamespace: e.target.value })} aria-label="에이전트 네임스페이스" />
              </Field>
              <Field label="PEP API 주소" help="에이전트가 노드에서 접속할 주소(…/api/v1). 비우면 지금 화면을 연 주소를 쓴다.">
                <input className={`${INPUT} font-mono`} disabled={dis} value={form.ingestBaseUrl}
                  placeholder={manifestQ.data?.apiBaseUrl ?? 'https://pep.example.com/api/v1'}
                  onChange={(e) => set({ ingestBaseUrl: e.target.value })} aria-label="PEP API 주소" />
              </Field>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Check checked={form.alertsEnabled} disabled={dis} onChange={(v) => set({ alertsEnabled: v })}
                title="사용률 알람" help="임계치를 넘은 맵마다 알람 인박스에 CiliumBpfMapPressure(노드·맵 단위)를 연다. 내려가면 닫힌다." />
              <Check checked={form.sysAdmin} disabled={dis} onChange={(v) => set({ sysAdmin: v })}
                title="CAP_SYS_ADMIN 부여"
                help="프로그램 목록·고정되지 않은 맵 조회와 5.8 미만 커널(CAP_BPF 없음)에 필요하다. 매니페스트에 권한이 추가되므로 다시 적용해야 한다." />
              <Check checked={form.tlsVerify} disabled={dis} onChange={(v) => set({ tlsVerify: v })}
                title="PEP 의 TLS 인증서를 검증" help="사설 인증서라면 에이전트에 CA 를 마운트하고 PEP_CA_FILE 을 지정한다(끄는 것은 임시로만)." />
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
