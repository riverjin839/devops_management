// 적용 설정(admin, 모든 클러스터 공통) — 환경마다 다른 경로·리소스 이름을 코드가 아니라 화면에서 고친다(UI-First).
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { LoadingState, useToast } from '@/components/common';
import { useServiceConfigSettings, useUpdateServiceConfigSettings } from '@/hooks/useServiceConfig';
import { formatApiError } from '@/lib/utils';
import type { ServiceConfigApplySettings } from '@/types';

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

export function ApplySettingsDialog({ open, isAdmin, onClose }: { open: boolean; isAdmin: boolean; onClose: () => void }) {
  const toast = useToast();
  const q = useServiceConfigSettings(open);
  const save = useUpdateServiceConfigSettings();
  const [form, setForm] = useState<ServiceConfigApplySettings | null>(null);
  useEffect(() => { if (open && q.data) setForm(q.data); }, [open, q.data]);
  const set = (p: Partial<ServiceConfigApplySettings>) => setForm((f) => (f ? { ...f, ...p } : f));

  const onSave = async () => {
    if (!form) return;
    try {
      await save.mutateAsync(form);
      toast.success('적용 설정을 저장했습니다');
      onClose();
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !save.isPending) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>적용 설정</DialogTitle>
          <DialogDescription>모든 클러스터 공통 · {isAdmin ? '관리자만 바꿀 수 있다' : '관리자만 바꿀 수 있습니다(읽기 전용)'}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-5 pb-3">
          {!form ? <LoadingState /> : (
            <>
              <Field label="LINUX 관리 sysctl 파일" help="PEP 가 통째로 쓰는 파일. /etc/sysctl.d/99-sysctl.conf 보다 뒤에 읽히는 이름이어야 부팅 때 덮이지 않는다.">
                <input className={INPUT} disabled={!isAdmin} value={form.sysctlFile} onChange={(e) => set({ sysctlFile: e.target.value })} aria-label="관리 sysctl 파일" />
              </Field>
              <div className="grid grid-cols-3 gap-2">
                <Field label="CILIUM 네임스페이스"><input className={INPUT} disabled={!isAdmin} value={form.ciliumNamespace} onChange={(e) => set({ ciliumNamespace: e.target.value })} aria-label="cilium 네임스페이스" /></Field>
                <Field label="ConfigMap"><input className={INPUT} disabled={!isAdmin} value={form.ciliumConfigmap} onChange={(e) => set({ ciliumConfigmap: e.target.value })} aria-label="cilium ConfigMap" /></Field>
                <Field label="DaemonSet"><input className={INPUT} disabled={!isAdmin} value={form.ciliumDaemonset} onChange={(e) => set({ ciliumDaemonset: e.target.value })} aria-label="cilium DaemonSet" /></Field>
              </div>
              <Field label="롤아웃 기본 제한 시간(초)" help="30 ~ 3600. 적용 대화상자에서 실행마다 바꿀 수 있다.">
                <input type="number" min={30} max={3600} className={INPUT} disabled={!isAdmin} value={form.rolloutTimeoutSec}
                  onChange={(e) => set({ rolloutTimeoutSec: Number(e.target.value) || 600 })} aria-label="롤아웃 제한 시간" />
              </Field>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>닫기</Button>
          {isAdmin && <Button onClick={() => { void onSave(); }} disabled={!form || save.isPending}>{save.isPending ? '저장 중…' : '저장'}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
