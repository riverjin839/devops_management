// 외부 서비스 설정 — 공개 여부·공개 클러스터·정기 수집 cron·NodePort 포함·제외 NS·역조회 방식/명령.
// UI-First: 노드마다 다른 DNS 도구(nslookup/dig/host)도 명령 템플릿으로 화면에서 바꾼다. 변경은 admin 만.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useToast } from '@/components/common';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useClusters } from '@/hooks/useCluster';
import { useExternalServicesSettings, useSaveExternalServicesSettings } from '@/hooks/useExternalServices';
import { formatApiError } from '@/lib/utils';
import type { ExternalServicesSettings } from '@/types';

const INPUT = 'w-full text-sm px-2 py-1 rounded-xl border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary';
const BTN = 'text-sm inline-flex items-center gap-1 px-3 py-1 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-50';
const BTN_PRIMARY = 'text-sm inline-flex items-center gap-1 px-3 py-1 rounded-xl bg-primary text-primary-foreground disabled:opacity-50';

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="mt-0.5">{children}</div>
      {help && <span className="block text-[11px] text-muted-foreground mt-0.5 leading-snug">{help}</span>}
    </label>
  );
}

function Check({ checked, onChange, label, help }: { checked: boolean; onChange: (v: boolean) => void; label: string; help?: string }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-primary mt-0.5" />
      <span>
        {label}
        {help && <span className="block text-[11px] text-muted-foreground leading-snug">{help}</span>}
      </span>
    </label>
  );
}

export function ExternalServicesSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const { data } = useExternalServicesSettings(open);
  const { data: clusters = [] } = useClusters();
  const save = useSaveExternalServicesSettings();
  const [form, setForm] = useState<ExternalServicesSettings | null>(null);
  const [excludeText, setExcludeText] = useState('');

  useEffect(() => {
    if (open && data) {
      setForm(data);
      setExcludeText(data.excludeNamespaces.join(', '));
    }
  }, [open, data]);

  const set = <K extends keyof ExternalServicesSettings>(k: K, v: ExternalServicesSettings[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  const onSave = async () => {
    if (!form) return;
    try {
      await save.mutateAsync({
        ...form,
        excludeNamespaces: excludeText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
      });
      toast.success('외부 서비스 설정 저장됨');
      onClose();
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !save.isPending) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>외부 서비스 설정</DialogTitle>
          <DialogDescription>공개 범위·정기 수집·역조회 방식을 정한다. 공개 화면은 저장된 스냅샷만 보여준다.</DialogDescription>
        </DialogHeader>
        {!form ? (
          <p className="text-sm text-muted-foreground px-5 py-6 text-center">불러오는 중…</p>
        ) : (
          <div className="space-y-3 max-h-[60vh] overflow-y-auto px-5 pb-3">
            <Check checked={form.publicEnabled} onChange={(v) => set('publicEnabled', v)}
              label="공개 페이지 사용" help="끄면 /external-services 와 공개 API 가 404 를 돌려준다." />
            <div className="grid grid-cols-2 gap-3">
              <Check checked={form.scheduleEnabled} onChange={(v) => set('scheduleEnabled', v)}
                label="정기 수집" help="자격증명 없이 수집 — 역조회는 backend 방식, 노드 nslookup 으로 찾은 이름은 유지." />
              <Field label="정기 수집 cron" help="기본 매시 정각(0 * * * *). 시간대는 BATCH_JOBS_TIMEZONE.">
                <input className={`${INPUT} font-mono`} value={form.scheduleCron} onChange={(e) => set('scheduleCron', e.target.value)} />
              </Field>
            </div>
            <Check checked={form.includeNodeport} onChange={(v) => set('includeNodeport', v)}
              label="NodePort 포함" help="NodePort Service 를 목록에 넣고 노드 주소를 함께 공개한다." />
            <Field label="제외 네임스페이스" help="쉼표·공백으로 구분. 정확히 일치하는 NS 의 Service·Ingress 를 뺀다.">
              <input className={`${INPUT} font-mono`} value={excludeText} onChange={(e) => setExcludeText(e.target.value)}
                placeholder="kube-system, monitoring" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Check checked={form.backendPtr} onChange={(v) => set('backendPtr', v)}
                label="backend 역조회" help="노드 nslookup 으로 못 찾은 IP 와 정기 수집에서 사용." />
              <Field label="역조회 타임아웃(초)" help="IP 당(1~10).">
                <input type="number" min={1} max={10} className={INPUT} value={form.dnsTimeoutSec}
                  onChange={(e) => set('dnsTimeoutSec', Number(e.target.value))} />
              </Field>
            </div>
            <Field label="노드 역조회 명령" help="{ip} 가 대상 IP 로 바뀐다. nslookup·host·getent 출력에서 이름을 읽는다(dig 는 'dig +short -x {ip}').">
              <input className={`${INPUT} font-mono`} value={form.ptrCommand} onChange={(e) => set('ptrCommand', e.target.value)} />
            </Field>
            <Field label="점검 실행 위치" help="자동: SSH 자격증명을 준 수동 수집이면 그 노드(사내 DNS·내부망 기준), 아니면 backend. 노드: SSH 가 없으면 backend 로 폴백.">
              <select className={INPUT} value={form.checkSource}
                onChange={(e) => set('checkSource', e.target.value as ExternalServicesSettings['checkSource'])}>
                <option value="auto">자동</option>
                <option value="node">노드</option>
                <option value="backend">backend</option>
              </select>
            </Field>
            <Check checked={form.forwardCheck} onChange={(v) => set('forwardCheck', v)}
              label="도메인 정방향 검증" help="Ingress host·역조회 이름의 A 레코드가 엔드포인트 IP 를 가리키는지 확인한다." />
            <Field label="노드 정방향 조회 명령" help="{domain} 이 도메인으로 바뀐다. getent ahosts·nslookup 출력에서 IP 를 읽는다.">
              <input className={`${INPUT} font-mono`} value={form.fwdCommand} onChange={(e) => set('fwdCommand', e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Check checked={form.probeEnabled} onChange={(v) => set('probeEnabled', v)}
                label="응답 확인" help="IP:Port 에 TCP 연결(NodePort 는 첫 노드 주소)." />
              <Check checked={form.probeHttp} onChange={(v) => set('probeHttp', v)}
                label="Ingress 는 HTTP 로" help="Host 헤더를 실어 GET / — 상태코드까지 본다(인증서 검증 안 함)." />
              <Field label="응답 타임아웃(초)" help="엔드포인트 당(1~15).">
                <input type="number" min={1} max={15} className={INPUT} value={form.probeTimeoutSec}
                  onChange={(e) => set('probeTimeoutSec', Number(e.target.value))} />
              </Field>
              <Field label="응답 확인 최대 건수" help="수집 1회당(1~2000). 넘는 엔드포인트는 건너뛴다.">
                <input type="number" min={1} max={2000} className={INPUT} value={form.probeMax}
                  onChange={(e) => set('probeMax', Number(e.target.value))} />
              </Field>
            </div>
            <Field label="노드 TCP 확인 명령" help="{ip}·{port}·{timeout}. 종료코드 0 이면 열림.">
              <input className={`${INPUT} font-mono`} value={form.probeTcpCommand} onChange={(e) => set('probeTcpCommand', e.target.value)} />
            </Field>
            <Field label="노드 HTTP 확인 명령" help="{scheme}·{host}·{ip}·{port}·{timeout}. 마지막 줄의 3자리 숫자를 상태코드로 읽는다. 리터럴 중괄호는 {{ }}.">
              <input className={`${INPUT} font-mono`} value={form.probeHttpCommand} onChange={(e) => set('probeHttpCommand', e.target.value)} />
            </Field>
            <Field label="공개 클러스터"
              help="아무것도 고르지 않으면 테넌트에 묶이지 않은 클러스터 전체가 공개된다. 고르면 고른 것만 공개된다.">
              <div className="max-h-40 overflow-y-auto rounded-xl border border-border p-2 space-y-1">
                {clusters.map((c) => (
                  <Check key={c.id} checked={form.publicClusterIds.includes(c.id)} label={c.name}
                    onChange={(v) => set('publicClusterIds', v ? [...form.publicClusterIds, c.id]
                      : form.publicClusterIds.filter((x) => x !== c.id))} />
                ))}
                {clusters.length === 0 && <span className="text-xs text-muted-foreground">등록된 클러스터 없음</span>}
              </div>
            </Field>
          </div>
        )}
        <DialogFooter>
          <button type="button" className={BTN} onClick={onClose} disabled={save.isPending}>취소</button>
          <button type="button" className={BTN_PRIMARY} onClick={() => void onSave()} disabled={!form || save.isPending}>
            {save.isPending ? '저장 중…' : '저장'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
