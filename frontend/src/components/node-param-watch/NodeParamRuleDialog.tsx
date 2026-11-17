// 감시 규칙 추가·편집 — 무엇을 감시하고(파라미터·노드), 무엇이 정상인지(기준값), 무엇을 알릴지(변경·영구 설정 불일치).
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/common';
import { useSaveNodeParamRule } from '@/hooks/useNodeParamWatch';
import { formatApiError } from '@/lib/utils';
import type { NodeParamOperator, NodeParamRule, NodeParamRuleInput, NodeParamSeverity } from '@/types';

const INPUT = 'w-full text-sm px-2.5 py-1.5 rounded-xl border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60';

const OPERATORS: { value: NodeParamOperator; label: string }[] = [
  { value: 'any', label: '변경만 추적 (기준값 없음)' },
  { value: 'eq', label: '같음' },
  { value: 'ne', label: '다름' },
  { value: 'gte', label: '이상 (숫자)' },
  { value: 'lte', label: '이하 (숫자)' },
  { value: 'in', label: '다음 중 하나 (| 로 구분)' },
];
const SEVERITIES: { value: NodeParamSeverity; label: string }[] = [
  { value: 'info', label: '정보' },
  { value: 'warning', label: '경고' },
  { value: 'critical', label: '위험' },
];

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="mt-1">{children}</div>
      {help && <span className="block mt-1 text-xs text-muted-foreground leading-snug">{help}</span>}
    </label>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** 편집 대상. null 이면 새 규칙. */
  rule: NodeParamRule | null;
  clusterId: string;
  clusterName: string;
  /** 공통 규칙(모든 클러스터)을 만들거나 고칠 수 있는가 — admin 만. */
  canEditCommon: boolean;
}

function emptyInput(clusterId: string): NodeParamRuleInput {
  return {
    clusterId, param: '', operator: 'any', expected: '', nodePattern: '', severity: 'warning',
    alertOnChange: true, checkPersistent: true, description: '', enabled: true,
  };
}

export function NodeParamRuleDialog({ open, onClose, rule, clusterId, clusterName, canEditCommon }: Props) {
  const toast = useToast();
  const save = useSaveNodeParamRule();
  const [form, setForm] = useState<NodeParamRuleInput>(() => emptyInput(clusterId));

  useEffect(() => {
    if (!open) return;
    setForm(rule ? {
      clusterId: rule.clusterId, param: rule.param, operator: rule.operator, expected: rule.expected ?? '',
      nodePattern: rule.nodePattern ?? '', severity: rule.severity, alertOnChange: rule.alertOnChange,
      checkPersistent: rule.checkPersistent, description: rule.description ?? '', enabled: rule.enabled,
    } : emptyInput(clusterId));
  }, [open, rule, clusterId]);

  const set = (patch: Partial<NodeParamRuleInput>) => setForm((f) => ({ ...f, ...patch }));
  const isCommon = form.clusterId === null;
  const needsExpected = form.operator !== 'any';
  const scopeLocked = !canEditCommon;
  const invalid = !form.param.trim() || (needsExpected && !(form.expected ?? '').trim());

  const onSave = async () => {
    try {
      await save.mutateAsync({
        id: rule?.id,
        body: {
          ...form,
          param: form.param.trim(),
          expected: needsExpected ? (form.expected ?? '').trim() : null,
          nodePattern: (form.nodePattern ?? '').trim() || null,
          description: (form.description ?? '').trim() || null,
        },
      });
      toast.success(rule ? '규칙을 고쳤습니다' : '규칙을 추가했습니다', '다음 에이전트 보고부터 반영됩니다.');
      onClose();
    } catch (e) {
      toast.error('규칙 저장 실패', formatApiError(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !save.isPending) onClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{rule ? '감시 규칙 편집' : '감시 규칙 추가'}</DialogTitle>
          <DialogDescription>
            에이전트는 다음 보고부터 이 파라미터를 읽어 보낸다. 값이 바뀌거나 기준값을 벗어나면 알람 인박스로 알린다.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 max-h-[60vh] overflow-y-auto px-5 pb-3">
          <Field label="파라미터" help="sysctl 이름 그대로 (예: net.core.somaxconn, vm.max_map_count).">
            <input className={`${INPUT} font-mono`} value={form.param} placeholder="net.core.somaxconn"
              onChange={(e) => set({ param: e.target.value })} aria-label="파라미터 이름" autoFocus />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="적용 범위" help={scopeLocked && isCommon ? '공통 규칙은 관리자만 고칠 수 있다.' : '같은 파라미터에 이 클러스터 규칙이 있으면 공통 규칙은 이 클러스터에서 쓰지 않는다.'}>
              <select className={INPUT} value={isCommon ? 'common' : 'cluster'} disabled={scopeLocked}
                onChange={(e) => set({ clusterId: e.target.value === 'common' ? null : clusterId })} aria-label="적용 범위">
                <option value="cluster">이 클러스터만 ({clusterName})</option>
                <option value="common">모든 클러스터 공통</option>
              </select>
            </Field>
            <Field label="적용 노드" help="노드 이름 패턴, 쉼표로 여러 개 (예: gpu-*, es-?). 비우면 모든 노드.">
              <input className={`${INPUT} font-mono`} value={form.nodePattern ?? ''} placeholder="모든 노드"
                onChange={(e) => set({ nodePattern: e.target.value })} aria-label="적용 노드 패턴" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="판정 방식">
              <select className={INPUT} value={form.operator}
                onChange={(e) => set({ operator: e.target.value as NodeParamOperator })} aria-label="판정 방식">
                {OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="기준값" help={form.operator === 'in' ? '허용 값들을 | 로 구분 (예: cubic|bbr). 공백이 든 값도 그대로 적는다.' : needsExpected ? '여러 값(예: 1024 65000)은 공백으로 구분해 그대로 적는다.' : '변경만 추적하면 기준값이 없다.'}>
              <input className={`${INPUT} font-mono`} value={form.expected ?? ''} disabled={!needsExpected}
                placeholder={needsExpected ? '1' : '—'} onChange={(e) => set({ expected: e.target.value })} aria-label="기준값" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="심각도" help="이 규칙의 알람(변경·기준값 위반) 심각도.">
              <select className={INPUT} value={form.severity}
                onChange={(e) => set({ severity: e.target.value as NodeParamSeverity })} aria-label="심각도">
                {SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </Field>
            <div className="space-y-2 pt-5 text-sm">
              <label className="flex items-start gap-2">
                <input type="checkbox" className="accent-primary mt-0.5" checked={form.alertOnChange}
                  onChange={(e) => set({ alertOnChange: e.target.checked })} />
                <span>값이 바뀌면 알람</span>
              </label>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="accent-primary mt-0.5" checked={form.checkPersistent}
                  onChange={(e) => set({ checkPersistent: e.target.checked })} />
                <span>현재 값이 영구 설정(sysctl.d)과 다르면 알람</span>
              </label>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="accent-primary mt-0.5" checked={form.enabled}
                  onChange={(e) => set({ enabled: e.target.checked })} />
                <span>사용</span>
              </label>
            </div>
          </div>
          <Field label="설명 (선택)" help="알람을 받은 사람이 이 값이 왜 중요한지 알 수 있게 적는다.">
            <textarea className={`${INPUT} min-h-[60px]`} value={form.description ?? ''}
              onChange={(e) => set({ description: e.target.value })} aria-label="설명" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>취소</Button>
          <Button onClick={() => { void onSave(); }} disabled={invalid || save.isPending}
            title={invalid ? '파라미터와 기준값을 입력하세요' : undefined}>
            {save.isPending ? '저장 중…' : '저장'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
