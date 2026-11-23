// 적용 설정(admin, 모든 클러스터 공통) — 환경마다 다른 경로·리소스 이름·확인 명령을 코드가 아니라 화면에서 고친다(UI-First).
// 지금 보고 있는 서비스(`service`)의 구역만 보여준다 — 변경 감지는 서비스 공통이라 항상 함께 둔다.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { LoadingState, useToast } from '@/components/common';
import {
  useServiceConfigSettings, useServiceConfigWatchSettings, useUpdateServiceConfigSettings, useUpdateServiceConfigWatchSettings,
} from '@/hooks/useServiceConfig';
import { formatApiError } from '@/lib/utils';
import type { ServiceConfigApplySettings, ServiceConfigWatchSettings } from '@/types';

const INPUT = 'w-full px-2.5 py-1.5 rounded-xl border border-border bg-card text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60';

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="mt-1">{children}</div>
      {help && <span className="block mt-1 text-muted-foreground">{help}</span>}
    </label>
  );
}

const CONTROL_PLANE = new Set(['kube-apiserver', 'kube-controller-manager', 'kube-scheduler']);

interface Props {
  open: boolean;
  isAdmin: boolean;
  /** 지금 화면의 서비스 키 — 이 서비스의 적용 설정만 보여준다. */
  service: string;
  /** 서비스 표시 이름(제목용). */
  serviceLabel: string;
  onClose: () => void;
}

export function ApplySettingsDialog({ open, isAdmin, service, serviceLabel, onClose }: Props) {
  const toast = useToast();
  const q = useServiceConfigSettings(open);
  const save = useUpdateServiceConfigSettings();
  const [form, setForm] = useState<ServiceConfigApplySettings | null>(null);
  useEffect(() => { if (open && q.data) setForm(q.data); }, [open, q.data]);
  const set = (p: Partial<ServiceConfigApplySettings>) => setForm((f) => (f ? { ...f, ...p } : f));
  const wq = useServiceConfigWatchSettings(open);
  const wsave = useUpdateServiceConfigWatchSettings();
  const [watch, setWatch] = useState<ServiceConfigWatchSettings | null>(null);
  useEffect(() => { if (open && wq.data) setWatch(wq.data); }, [open, wq.data]);
  const setW = (p: Partial<ServiceConfigWatchSettings>) => setWatch((w) => (w ? { ...w, ...p } : w));

  const onSave = async () => {
    if (!form) return;
    try {
      await save.mutateAsync(form);
      if (watch) await wsave.mutateAsync(watch);
      toast.success('적용 설정을 저장했습니다');
      onClose();
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !save.isPending) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{serviceLabel} 적용 설정</DialogTitle>
          <DialogDescription>모든 클러스터 공통 · {isAdmin ? '관리자만 바꿀 수 있습니다' : '관리자만 바꿀 수 있습니다(읽기 전용)'}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[64vh] overflow-y-auto space-y-3 px-5 pb-3">
          {!form ? <LoadingState /> : (
            <>
              {watch && (
                <>
                  <p className="text-xs font-semibold text-foreground">변경 감지 <span className="font-normal text-muted-foreground">· 모든 서비스 공통</span></p>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" disabled={!isAdmin} checked={watch.enabled} onChange={(e) => setW({ enabled: e.target.checked })} />
                    주기 수집 켜기 — V1 이 있는 클러스터의 정적 파드·cilium-config 를 K8S API 로 읽는다(containerd·kubelet 은 노드 파라미터 에이전트가 보고)
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    <Field label="수집 주기(분)">
                      <input type="number" min={1} max={1440} className={INPUT} disabled={!isAdmin || !watch.enabled} value={watch.intervalMin}
                        onChange={(e) => setW({ intervalMin: Number(e.target.value) || 5 })} aria-label="변경 감지 수집 주기(분)" />
                    </Field>
                    <Field label="변경 알람 심각도">
                      <select className={INPUT} disabled={!isAdmin || !watch.changeAlert} value={watch.changeSeverity}
                        onChange={(e) => setW({ changeSeverity: e.target.value as ServiceConfigWatchSettings['changeSeverity'] })} aria-label="변경 알람 심각도">
                        <option value="info">info</option><option value="warning">warning</option><option value="critical">critical</option>
                      </select>
                    </Field>
                    <Field label="드리프트 알람 심각도">
                      <select className={INPUT} disabled={!isAdmin || !watch.driftAlert} value={watch.driftSeverity}
                        onChange={(e) => setW({ driftSeverity: e.target.value as ServiceConfigWatchSettings['driftSeverity'] })} aria-label="드리프트 알람 심각도">
                        <option value="info">info</option><option value="warning">warning</option><option value="critical">critical</option>
                      </select>
                    </Field>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" disabled={!isAdmin} checked={watch.changeAlert} onChange={(e) => setW({ changeAlert: e.target.checked })} />
                    변경 알람 — PEP 적용이 아닌 값 변경을 감지하면 알람
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" disabled={!isAdmin} checked={watch.driftAlert} onChange={(e) => setW({ driftAlert: e.target.checked })} />
                    드리프트 알람 — 노드 값이 기준 버전과 다르면 열고, 맞아지면 닫는다
                  </label>
                  <p className="pt-2 text-xs font-semibold text-foreground">{serviceLabel} 적용</p>
                </>
              )}
              {service === 'linux' && (
              <Field label="LINUX 관리 sysctl 파일" help="PEP 가 통째로 쓰는 파일. /etc/sysctl.d/99-sysctl.conf 보다 뒤에 읽히는 이름이어야 부팅 때 덮이지 않는다.">
                <input className={INPUT} disabled={!isAdmin} value={form.sysctlFile} onChange={(e) => set({ sysctlFile: e.target.value })} aria-label="관리 sysctl 파일" />
              </Field>
              )}
              {service === 'cilium' && (<>
              <div className="grid grid-cols-3 gap-2">
                <Field label="CILIUM 네임스페이스"><input className={INPUT} disabled={!isAdmin} value={form.ciliumNamespace} onChange={(e) => set({ ciliumNamespace: e.target.value })} aria-label="cilium 네임스페이스" /></Field>
                <Field label="ConfigMap"><input className={INPUT} disabled={!isAdmin} value={form.ciliumConfigmap} onChange={(e) => set({ ciliumConfigmap: e.target.value })} aria-label="cilium ConfigMap" /></Field>
                <Field label="DaemonSet"><input className={INPUT} disabled={!isAdmin} value={form.ciliumDaemonset} onChange={(e) => set({ ciliumDaemonset: e.target.value })} aria-label="cilium DaemonSet" /></Field>
              </div>
              <Field label="롤아웃 기본 제한 시간(초)" help="30 ~ 3600. 적용 대화상자에서 실행마다 바꿀 수 있다.">
                <input type="number" min={30} max={3600} className={INPUT} disabled={!isAdmin} value={form.rolloutTimeoutSec}
                  onChange={(e) => set({ rolloutTimeoutSec: Number(e.target.value) || 600 })} aria-label="롤아웃 제한 시간" />
              </Field>
              </>)}
              {service === 'etcd' && (<>
              <div className="grid grid-cols-2 gap-2">
                <Field label="실행 방식" help="auto = 노드에 매니페스트가 있으면 정적 파드, 없으면 systemd.">
                  <select className={INPUT} disabled={!isAdmin} value={form.etcdMode} onChange={(e) => set({ etcdMode: e.target.value as ServiceConfigApplySettings['etcdMode'] })} aria-label="etcd 실행 방식">
                    <option value="auto">auto(자동 판별)</option>
                    <option value="static_pod">정적 파드</option>
                    <option value="systemd">systemd</option>
                  </select>
                </Field>
                <Field label="systemd 유닛"><input className={INPUT} disabled={!isAdmin} value={form.etcdService} onChange={(e) => set({ etcdService: e.target.value })} aria-label="etcd systemd 유닛" /></Field>
                <Field label="정적 파드 매니페스트"><input className={INPUT} disabled={!isAdmin} value={form.etcdManifest} onChange={(e) => set({ etcdManifest: e.target.value })} aria-label="etcd 매니페스트 경로" /></Field>
                <Field label="systemd env 파일"><input className={INPUT} disabled={!isAdmin} value={form.etcdEnvFile} onChange={(e) => set({ etcdEnvFile: e.target.value })} aria-label="etcd env 파일 경로" /></Field>
              </div>
              <Field label="백업 디렉터리(정적 파드 공용)" help="매니페스트 디렉터리 밖이어야 한다 — 안에 두면 kubelet 이 백업본을 정적 파드로 띄운다.">
                <input className={INPUT} disabled={!isAdmin} value={form.etcdBackupDir} onChange={(e) => set({ etcdBackupDir: e.target.value })} aria-label="etcd 백업 디렉터리" />
              </Field>
              <Field label="health 확인 명령" help="노드에서 실행해 아래 문자열이 출력에 있으면 정상. 사전 점검·재시작 뒤 대기에 쓴다.">
                <input className={INPUT} disabled={!isAdmin} value={form.etcdHealthCmd} onChange={(e) => set({ etcdHealthCmd: e.target.value })} aria-label="etcd health 명령" />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="정상 판정 문자열"><input className={INPUT} disabled={!isAdmin} value={form.etcdHealthExpect} onChange={(e) => set({ etcdHealthExpect: e.target.value })} aria-label="health 정상 문자열" /></Field>
                <Field label="정상 기동 대기 기본값(초)">
                  <input type="number" min={30} max={1800} className={INPUT} disabled={!isAdmin} value={form.etcdHealthTimeoutSec}
                    onChange={(e) => set({ etcdHealthTimeoutSec: Number(e.target.value) || 180 })} aria-label="etcd health 대기 시간" />
                </Field>
              </div>
              </>)}
              {CONTROL_PLANE.has(service) && (<>
              <Field label="매니페스트 디렉터리" help="<디렉터리>/<서비스>.yaml 을 고친다. 세 컨트롤 플레인 서비스가 같은 값을 쓴다.">
                <input className={INPUT} disabled={!isAdmin} value={form.staticPodManifestDir} onChange={(e) => set({ staticPodManifestDir: e.target.value })} aria-label="정적 파드 매니페스트 디렉터리" />
              </Field>
              <Field label="백업 디렉터리(정적 파드 공용)" help="ETCD 와 같은 값을 쓴다. 매니페스트 디렉터리 밖이어야 한다 — 안에 두면 kubelet 이 백업본을 정적 파드로 띄운다.">
                <input className={INPUT} disabled={!isAdmin} value={form.etcdBackupDir} onChange={(e) => set({ etcdBackupDir: e.target.value })} aria-label="정적 파드 백업 디렉터리" />
              </Field>
              {service === 'kube-apiserver' && (
              <Field label="API 서버 health 명령"><input className={INPUT} disabled={!isAdmin} value={form.apiserverHealthCmd} onChange={(e) => set({ apiserverHealthCmd: e.target.value })} aria-label="API 서버 health 명령" /></Field>
              )}
              {service === 'kube-controller-manager' && (
              <Field label="컨트롤러 매니저 health 명령"><input className={INPUT} disabled={!isAdmin} value={form.controllerManagerHealthCmd} onChange={(e) => set({ controllerManagerHealthCmd: e.target.value })} aria-label="컨트롤러 매니저 health 명령" /></Field>
              )}
              {service === 'kube-scheduler' && (
              <Field label="스케줄러 health 명령"><input className={INPUT} disabled={!isAdmin} value={form.schedulerHealthCmd} onChange={(e) => set({ schedulerHealthCmd: e.target.value })} aria-label="스케줄러 health 명령" /></Field>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Field label="정상 판정 문자열"><input className={INPUT} disabled={!isAdmin} value={form.controlPlaneHealthExpect} onChange={(e) => set({ controlPlaneHealthExpect: e.target.value })} aria-label="컨트롤 플레인 health 정상 문자열" /></Field>
                <Field label="정상 기동 대기 기본값(초)">
                  <input type="number" min={30} max={1800} className={INPUT} disabled={!isAdmin} value={form.controlPlaneHealthTimeoutSec}
                    onChange={(e) => set({ controlPlaneHealthTimeoutSec: Number(e.target.value) || 300 })} aria-label="컨트롤 플레인 health 대기 시간" />
                </Field>
              </div>
              </>)}
              {service === 'kubelet' && (<>
              <div className="grid grid-cols-2 gap-2">
                <Field label="설정 파일"><input className={INPUT} disabled={!isAdmin} value={form.kubeletConfig} onChange={(e) => set({ kubeletConfig: e.target.value })} aria-label="kubelet 설정 파일" /></Field>
                <Field label="systemd 유닛"><input className={INPUT} disabled={!isAdmin} value={form.kubeletService} onChange={(e) => set({ kubeletService: e.target.value })} aria-label="kubelet systemd 유닛" /></Field>
              </div>
              <Field label="재시작 명령"><input className={INPUT} disabled={!isAdmin} value={form.kubeletRestartCmd} onChange={(e) => set({ kubeletRestartCmd: e.target.value })} aria-label="kubelet 재시작 명령" /></Field>
              <Field label="노드 Ready 대기 기본값(초)" help="CONTAINERD 와 같은 값을 쓴다.">
                <input type="number" min={30} max={1800} className={INPUT} disabled={!isAdmin} value={form.nodeReadyTimeoutSec}
                  onChange={(e) => set({ nodeReadyTimeoutSec: Number(e.target.value) || 300 })} aria-label="노드 Ready 대기 시간" />
              </Field>
              </>)}
              {service === 'containerd' && (<>
              <div className="grid grid-cols-2 gap-2">
                <Field label="설정 파일"><input className={INPUT} disabled={!isAdmin} value={form.containerdConfig} onChange={(e) => set({ containerdConfig: e.target.value })} aria-label="containerd 설정 파일" /></Field>
                <Field label="systemd 유닛"><input className={INPUT} disabled={!isAdmin} value={form.containerdService} onChange={(e) => set({ containerdService: e.target.value })} aria-label="containerd systemd 유닛" /></Field>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="재시작 명령"><input className={INPUT} disabled={!isAdmin} value={form.containerdRestartCmd} onChange={(e) => set({ containerdRestartCmd: e.target.value })} aria-label="containerd 재시작 명령" /></Field>
                <Field label="노드 Ready 대기 기본값(초)">
                  <input type="number" min={30} max={1800} className={INPUT} disabled={!isAdmin} value={form.nodeReadyTimeoutSec}
                    onChange={(e) => set({ nodeReadyTimeoutSec: Number(e.target.value) || 300 })} aria-label="노드 Ready 대기 시간" />
                </Field>
              </div>
              </>)}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>닫기</Button>
          {isAdmin && <Button onClick={() => { void onSave(); }} disabled={!form || save.isPending || wsave.isPending}>{save.isPending || wsave.isPending ? '저장 중…' : '저장'}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
