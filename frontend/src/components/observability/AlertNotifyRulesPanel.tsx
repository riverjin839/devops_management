import { useEffect, useId, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { useToast } from '@/components/common';
import {
  useAlertRules,
  useAlertSettings,
  useCreateAlertRule,
  useDeleteAlertRule,
  useUpdateAlertRule,
  useUpdateAlertSettings,
} from '@/hooks/useAlertInbox';
import type {
  AlertDedupMode, AlertNotifyMode, AlertNotifyRule, AlertNotifyRuleInput,
  AlertSettings, AlertSeverity, Cluster,
} from '@/types';
import { formatApiError } from '@/lib/utils';
import { ROW, TD, TH } from './shared';

const NOTIFY_MODES: Array<{ value: AlertNotifyMode; label: string; hint: string }> = [
  { value: 'all', label: '전체', hint: '활성 사용자 전원에게 개인 알림' },
  { value: 'users', label: '담당자', hint: '지정한 담당자에게만' },
  { value: 'none', label: '알림 없음', hint: '인박스에만 적재 (종 배지 없음)' },
];

const DEDUP_MODES: Array<{ value: AlertDedupMode; label: string; hint: string }> = [
  { value: 'summarize', label: '요약', hint: '창 안에서는 기존 알림을 "N회"로 갱신' },
  { value: 'first_only', label: '최초 1회', hint: '창 안 반복은 알림 없이 카운트만' },
];

const SEVERITIES: AlertSeverity[] = ['info', 'warning', 'critical'];

const EMPTY_RULE: AlertNotifyRuleInput = {
  name: '',
  enabled: true,
  priority: 100,
  clusterId: null,
  moduleKey: null,
  alertnamePattern: null,
  namespacePattern: null,
  labelMatchers: [],
  severityMin: 'warning',
  notifyMode: 'all',
  recipients: [],
  severityOverride: null,
  channelIds: [],
  dedupWindowSec: 300,
  dedupMode: 'summarize',
};

const inputCls = 'w-full px-2.5 py-1.5 rounded-xl bg-secondary border border-border text-sm '
  + 'focus:outline-none focus:ring-2 focus:ring-primary/40';
const labelCls = 'block text-xs font-medium text-muted-foreground mb-1';

/**
 * 알림 규칙 + 전역 기본값 편집 (operator 이상).
 *
 * 규칙은 priority 오름차순으로 평가해 **첫 매칭 1건**만 적용된다. 매칭이 없으면 전역 기본값.
 * 여기서 담당자 매핑 · 중복 억제 창 · 심각도 재정의를 전부 화면에서 조정한다(UI-First).
 */
export function AlertNotifyRulesPanel({ clusters, canEdit }: {
  clusters: Cluster[];
  canEdit: boolean;
}) {
  const toast = useToast();
  const { data: rules = [], isLoading } = useAlertRules();
  const { data: settings } = useAlertSettings();
  const createRule = useCreateAlertRule();
  const updateRule = useUpdateAlertRule();
  const deleteRule = useDeleteAlertRule();

  const [editing, setEditing] = useState<AlertNotifyRule | null>(null);
  const [draft, setDraft] = useState<AlertNotifyRuleInput | null>(null);

  const startNew = () => { setEditing(null); setDraft({ ...EMPTY_RULE }); };
  const startEdit = (rule: AlertNotifyRule) => {
    setEditing(rule);
    // id 를 뺀 나머지가 그대로 입력 폼(AlertNotifyRuleInput)의 형태다.
    setDraft({
      name: rule.name,
      enabled: rule.enabled,
      priority: rule.priority,
      clusterId: rule.clusterId ?? null,
      moduleKey: rule.moduleKey ?? null,
      alertnamePattern: rule.alertnamePattern ?? null,
      namespacePattern: rule.namespacePattern ?? null,
      labelMatchers: rule.labelMatchers,
      severityMin: rule.severityMin ?? null,
      notifyMode: rule.notifyMode,
      recipients: rule.recipients,
      severityOverride: rule.severityOverride ?? null,
      channelIds: rule.channelIds,
      dedupWindowSec: rule.dedupWindowSec,
      dedupMode: rule.dedupMode,
    });
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      toast.error('규칙 이름은 필수입니다.');
      return;
    }
    try {
      if (editing) await updateRule.mutateAsync({ id: editing.id, data: draft });
      else await createRule.mutateAsync(draft);
      toast.success(editing ? '규칙을 수정했습니다.' : '규칙을 추가했습니다.');
      setDraft(null);
      setEditing(null);
    } catch (err) {
      toast.error(formatApiError(err, '규칙 저장 실패'));
    }
  };

  const remove = async (rule: AlertNotifyRule) => {
    try {
      await deleteRule.mutateAsync(rule.id);
      toast.success('규칙을 삭제했습니다.');
      if (editing?.id === rule.id) { setDraft(null); setEditing(null); }
    } catch (err) {
      toast.error(formatApiError(err, '규칙 삭제 실패'));
    }
  };

  return (
    <div className="space-y-3">
      <GlobalSettingsCard settings={settings} canEdit={canEdit} />

      <MacCard title="알림 규칙" bodyPadding="p-0">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <p className="text-xs text-muted-foreground">
            priority 가 작은 규칙부터 평가하고 <b className="text-foreground">첫 매칭 1건</b>만 적용합니다.
            매칭되는 규칙이 없으면 위의 전역 기본값을 씁니다.
          </p>
          {canEdit ? (
            <button
              type="button"
              onClick={startNew}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm bg-secondary text-muted-foreground hover:bg-secondary/80 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden /> 규칙 추가
            </button>
          ) : null}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/20">
              <tr>
                <th className={`${TH} w-16 text-right`}>순위</th>
                <th className={TH}>이름</th>
                <th className={`${TH} w-40`}>조건</th>
                <th className={`${TH} w-28`}>알림 대상</th>
                <th className={`${TH} w-40`}>담당자</th>
                <th className={`${TH} w-32`}>중복 억제</th>
                <th className={`${TH} w-24`}>심각도</th>
                <th className={`${TH} w-16`}>사용</th>
                <th className={`${TH} w-10`}><span className="sr-only">삭제</span></th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={9} className="py-8 text-center text-sm text-muted-foreground">불러오는 중…</td></tr>
              ) : rules.length === 0 ? (
                <tr><td colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                  등록된 규칙이 없습니다 — 전역 기본값으로만 동작합니다.
                </td></tr>
              ) : (
                rules.map((rule) => (
                  <tr
                    key={rule.id}
                    className={`${ROW} ${canEdit ? 'cursor-pointer' : ''}`}
                    onClick={canEdit ? () => startEdit(rule) : undefined}
                  >
                    <td className={`${TD} text-right font-mono text-xs`}>{rule.priority}</td>
                    <td className={`${TD} font-medium`}>{rule.name}</td>
                    <td className={`${TD} text-xs text-muted-foreground truncate max-w-[10rem]`}>
                      {describeMatchers(rule, clusters)}
                    </td>
                    <td className={`${TD} text-xs`}>
                      {NOTIFY_MODES.find((m) => m.value === rule.notifyMode)?.label ?? rule.notifyMode}
                    </td>
                    <td className={`${TD} text-xs text-muted-foreground truncate max-w-[10rem]`}>
                      {rule.recipients.length ? rule.recipients.join(', ') : '-'}
                    </td>
                    <td className={`${TD} text-xs text-muted-foreground`}>
                      {Math.round(rule.dedupWindowSec / 60)}분 ·{' '}
                      {DEDUP_MODES.find((d) => d.value === rule.dedupMode)?.label ?? rule.dedupMode}
                    </td>
                    <td className={`${TD} text-xs text-muted-foreground`}>
                      {rule.severityMin ?? '-'}
                      {rule.severityOverride ? ` → ${rule.severityOverride}` : ''}
                    </td>
                    <td className={`${TD} text-xs`}>{rule.enabled ? '사용' : '중지'}</td>
                    <td className={TD}>
                      {canEdit ? (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); void remove(rule); }}
                          title="규칙 삭제"
                          aria-label={`${rule.name} 규칙 삭제`}
                          className="p-1 rounded-xl text-muted-foreground hover:bg-secondary hover:text-[hsl(var(--status-critical))] transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </MacCard>

      {draft && canEdit ? (
        <RuleEditor
          draft={draft}
          setDraft={setDraft}
          clusters={clusters}
          isEdit={!!editing}
          busy={createRule.isPending || updateRule.isPending}
          onCancel={() => { setDraft(null); setEditing(null); }}
          onSave={save}
        />
      ) : null}
    </div>
  );
}

function describeMatchers(rule: AlertNotifyRule, clusters: Cluster[]): string {
  const parts: string[] = [];
  if (rule.clusterId) {
    parts.push(clusters.find((c) => c.id === rule.clusterId)?.name ?? '클러스터');
  }
  if (rule.alertnamePattern) parts.push(`alert~${rule.alertnamePattern}`);
  if (rule.namespacePattern) parts.push(`ns~${rule.namespacePattern}`);
  rule.labelMatchers.forEach((pair) => parts.push(`${pair.k}=${pair.v}`));
  return parts.length ? parts.join(' · ') : '전체';
}

function GlobalSettingsCard({ settings, canEdit }: {
  settings?: AlertSettings;
  canEdit: boolean;
}) {
  const toast = useToast();
  const updateSettings = useUpdateAlertSettings();
  const fieldId = useId();
  const [form, setForm] = useState<AlertSettings | null>(null);

  useEffect(() => { if (settings) setForm(settings); }, [settings]);

  if (!form) {
    return <MacCard title="전역 기본값"><p className="text-sm text-muted-foreground">불러오는 중…</p></MacCard>;
  }

  const save = async () => {
    try {
      await updateSettings.mutateAsync(form);
      toast.success('전역 기본값을 저장했습니다.');
    } catch (err) {
      toast.error(formatApiError(err, '설정 저장 실패'));
    }
  };

  return (
    <MacCard title="전역 기본값 (매칭 규칙이 없을 때)">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className={labelCls} htmlFor={`${fieldId}-mode`}>알림 대상</label>
          <select
            id={`${fieldId}-mode`} className={inputCls} value={form.defaultNotifyMode} disabled={!canEdit}
            onChange={(e) => setForm({ ...form, defaultNotifyMode: e.target.value as AlertNotifyMode })}
          >
            {NOTIFY_MODES.map((m) => <option key={m.value} value={m.value}>{m.label} — {m.hint}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor={`${fieldId}-sev`}>알림 최소 심각도</label>
          <select
            id={`${fieldId}-sev`} className={inputCls} value={form.defaultSeverityMin} disabled={!canEdit}
            onChange={(e) => setForm({ ...form, defaultSeverityMin: e.target.value as AlertSeverity })}
          >
            {SEVERITIES.map((s) => <option key={s} value={s}>{s} 이상</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor={`${fieldId}-window`}>중복 억제 창 (초)</label>
          <input
            id={`${fieldId}-window`} type="number" min={0} className={inputCls}
            value={form.dedupWindowSec} disabled={!canEdit}
            onChange={(e) => setForm({ ...form, dedupWindowSec: Number(e.target.value) || 0 })}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor={`${fieldId}-dedup`}>중복 처리</label>
          <select
            id={`${fieldId}-dedup`} className={inputCls} value={form.dedupMode} disabled={!canEdit}
            onChange={(e) => setForm({ ...form, dedupMode: e.target.value as AlertDedupMode })}
          >
            {DEDUP_MODES.map((d) => <option key={d.value} value={d.value}>{d.label} — {d.hint}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor={`${fieldId}-recipients`}>기본 담당자 (쉼표 구분)</label>
          <input
            id={`${fieldId}-recipients`} className={inputCls} disabled={!canEdit}
            value={form.defaultRecipients.join(', ')}
            onChange={(e) => setForm({ ...form, defaultRecipients: splitList(e.target.value) })}
            placeholder="알림 대상이 '담당자'일 때 사용"
          />
        </div>
        <div>
          <label className={labelCls} htmlFor={`${fieldId}-retention`}>알람 보존 (일)</label>
          <input
            id={`${fieldId}-retention`} type="number" min={1} className={inputCls}
            value={form.retentionDays} disabled={!canEdit}
            onChange={(e) => setForm({ ...form, retentionDays: Number(e.target.value) || 90 })}
          />
        </div>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        중복 억제: 같은 알람이 창 안에서 반복 수신되면 인박스의 반복 수만 올라가고 개인 알림은
        1건만 생성됩니다(예: 5분 창에서 10건 → 알림 1건 + &quot;최근 5분간 10회&quot; 표기).
      </p>

      {canEdit ? (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={save}
            disabled={updateSettings.isPending}
            className="px-4 py-2 rounded-xl text-sm bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {updateSettings.isPending ? '저장 중…' : '기본값 저장'}
          </button>
        </div>
      ) : null}
    </MacCard>
  );
}

function RuleEditor({ draft, setDraft, clusters, isEdit, busy, onCancel, onSave }: {
  draft: AlertNotifyRuleInput;
  setDraft: (next: AlertNotifyRuleInput) => void;
  clusters: Cluster[];
  isEdit: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const fieldId = useId();
  const set = <K extends keyof AlertNotifyRuleInput>(key: K, value: AlertNotifyRuleInput[K]) =>
    setDraft({ ...draft, [key]: value });

  return (
    <MacCard title={isEdit ? '규칙 수정' : '규칙 추가'}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label className={labelCls} htmlFor={`${fieldId}-name`}>이름</label>
          <input
            id={`${fieldId}-name`} className={inputCls} value={draft.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="플랫폼팀 — etcd 계열 알람"
          />
        </div>
        <div>
          <label className={labelCls} htmlFor={`${fieldId}-priority`}>순위 (작을수록 먼저)</label>
          <input
            id={`${fieldId}-priority`} type="number" className={inputCls} value={draft.priority}
            onChange={(e) => set('priority', Number(e.target.value) || 0)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor={`${fieldId}-cluster`}>클러스터</label>
          <select
            id={`${fieldId}-cluster`} className={inputCls} value={draft.clusterId ?? ''}
            onChange={(e) => set('clusterId', e.target.value || null)}
          >
            <option value="">전체</option>
            {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <div>
          <label className={labelCls} htmlFor={`${fieldId}-alertname`}>알람명 패턴 (정규식)</label>
          <input
            id={`${fieldId}-alertname`} className={`${inputCls} font-mono`} value={draft.alertnamePattern ?? ''}
            onChange={(e) => set('alertnamePattern', e.target.value || null)}
            placeholder="^Etcd|^KubeAPI"
          />
        </div>
        <div>
          <label className={labelCls} htmlFor={`${fieldId}-ns`}>네임스페이스 패턴 (정규식)</label>
          <input
            id={`${fieldId}-ns`} className={`${inputCls} font-mono`} value={draft.namespacePattern ?? ''}
            onChange={(e) => set('namespacePattern', e.target.value || null)}
            placeholder="^kube-system$"
          />
        </div>
        <div>
          <label className={labelCls} htmlFor={`${fieldId}-labels`}>라벨 조건 (k=v, 쉼표 구분)</label>
          <input
            id={`${fieldId}-labels`} className={`${inputCls} font-mono`}
            value={draft.labelMatchers.map((p) => `${p.k}=${p.v}`).join(', ')}
            onChange={(e) => set('labelMatchers', parseMatchers(e.target.value))}
            placeholder="team=platform"
          />
        </div>

        <div>
          <label className={labelCls} htmlFor={`${fieldId}-min`}>최소 심각도</label>
          <select
            id={`${fieldId}-min`} className={inputCls} value={draft.severityMin ?? ''}
            onChange={(e) => set('severityMin', (e.target.value || null) as AlertSeverity | null)}
          >
            <option value="">제한 없음</option>
            {SEVERITIES.map((s) => <option key={s} value={s}>{s} 이상</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor={`${fieldId}-override`}>심각도 재정의</label>
          <select
            id={`${fieldId}-override`} className={inputCls} value={draft.severityOverride ?? ''}
            onChange={(e) => set('severityOverride', (e.target.value || null) as AlertSeverity | null)}
          >
            <option value="">그대로 사용</option>
            {SEVERITIES.map((s) => <option key={s} value={s}>{s} 로 변경</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor={`${fieldId}-mode`}>알림 대상</label>
          <select
            id={`${fieldId}-mode`} className={inputCls} value={draft.notifyMode}
            onChange={(e) => set('notifyMode', e.target.value as AlertNotifyMode)}
          >
            {NOTIFY_MODES.map((m) => <option key={m.value} value={m.value}>{m.label} — {m.hint}</option>)}
          </select>
        </div>

        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor={`${fieldId}-recipients`}>담당자 (쉼표 구분)</label>
          <input
            id={`${fieldId}-recipients`} className={inputCls}
            value={draft.recipients.join(', ')}
            onChange={(e) => set('recipients', splitList(e.target.value))}
            placeholder="hong, 김철수 — 알림 대상이 '담당자'일 때만 사용"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls} htmlFor={`${fieldId}-window`}>억제 창 (초)</label>
            <input
              id={`${fieldId}-window`} type="number" min={0} className={inputCls}
              value={draft.dedupWindowSec}
              onChange={(e) => set('dedupWindowSec', Number(e.target.value) || 0)}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor={`${fieldId}-dedup`}>중복 처리</label>
            <select
              id={`${fieldId}-dedup`} className={inputCls} value={draft.dedupMode}
              onChange={(e) => set('dedupMode', e.target.value as AlertDedupMode)}
            >
              {DEDUP_MODES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox" checked={draft.enabled} className="rounded"
            onChange={(e) => set('enabled', e.target.checked)}
          />
          사용
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-xl text-sm bg-secondary hover:bg-secondary/80 transition-colors"
          >
            취소
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={busy}
            className="px-4 py-2 rounded-xl text-sm bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {busy ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </MacCard>
  );
}

function splitList(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseMatchers(raw: string): Array<{ k: string; v: string }> {
  return raw
    .split(',')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const idx = chunk.indexOf('=');
      if (idx < 0) return { k: chunk, v: '' };
      return { k: chunk.slice(0, idx).trim(), v: chunk.slice(idx + 1).trim() };
    })
    .filter((pair) => pair.k);
}
