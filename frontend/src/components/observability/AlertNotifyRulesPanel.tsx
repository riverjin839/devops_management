import { useEffect, useId, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { EmptyState, LoadingState, useToast } from '@/components/common';
import { useNotificationChannels } from '@/hooks/useNotifications';
import {
  useAlertRules,
  useAlertSettings,
  useCreateAlertRule,
  useDeleteAlertRule,
  useUpdateAlertRule,
  useUpdateAlertSettings,
} from '@/hooks/useAlertInbox';
import { useCanOperate } from '@/hooks/useCanOperate';
import type {
  AlertDedupMode, AlertNotifyMode, AlertNotifyRule, AlertNotifyRuleInput,
  AlertSettings, AlertSeverity, Cluster, NotificationChannel,
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

/** 숫자 입력 허용 범위 — 빈칸·범위 밖은 저장을 막고 필드 옆에 사유를 보인다(D-106). */
const PRIORITY_RANGE = { min: 0, max: 1_000_000 } as const;
const DEDUP_RANGE = { min: 0, max: 2_592_000 } as const; // 30일
const RETENTION_RANGE = { min: 1, max: 3650 } as const;

/**
 * 규칙 편집 폼 상태. 숫자·목록 입력은 **원문 문자열**로 들고 있다가 blur·저장 시점에만
 * 파싱한다 — 매 키 입력마다 파싱하면 쉼표를 칠 수 없고, `team` 을 치는 순간 `team=` 이
 * 끼어들며, 숫자 칸을 비우면 0 으로 바뀐다(D-106).
 */
type RuleDraft = Omit<AlertNotifyRuleInput, 'priority' | 'dedupWindowSec' | 'labelMatchers' | 'recipients'> & {
  priority: string;
  dedupWindowSec: string;
  labelsText: string;
  recipientsText: string;
};

type RuleDraftErrors = Partial<Record<'priority' | 'dedupWindowSec' | 'labelsText', string>>;

const EMPTY_RULE: RuleDraft = {
  name: '',
  enabled: true,
  priority: '100',
  clusterId: null,
  moduleKey: null,
  alertnamePattern: null,
  namespacePattern: null,
  labelsText: '',
  severityMin: 'warning',
  notifyMode: 'all',
  recipientsText: '',
  severityOverride: null,
  channelIds: [],
  dedupWindowSec: '300',
  dedupMode: 'summarize',
};

const inputCls = 'w-full px-2.5 py-1.5 rounded-xl bg-secondary border border-border text-sm '
  + 'focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60 disabled:cursor-not-allowed';
const invalidCls = ' border-status-critical';
const labelCls = 'block text-xs font-medium text-muted-foreground mb-1';
const errorCls = 'mt-1 text-[11px] text-status-critical';

/**
 * 알림 규칙 + 전역 기본값 편집 (operator 이상).
 *
 * 규칙은 priority 오름차순으로 평가해 **첫 매칭 1건**만 적용된다. 매칭이 없으면 전역 기본값.
 * 여기서 담당자 매핑 · 중복 억제 창 · 심각도 재정의를 전부 화면에서 조정한다(UI-First).
 * 권한: 규칙·전역 설정 API 는 operator 이상(클러스터 무관)이라 전역 `useCanOperate()` 로 판정하고,
 * viewer 에게는 버튼을 숨기지 않고 비활성 + 사유를 보인다(D-105).
 */
export function AlertNotifyRulesPanel({ clusters }: { clusters: Cluster[] }) {
  const toast = useToast();
  const { canOperate, withHint, ariaWithHint } = useCanOperate();
  const rulesQuery = useAlertRules();
  const rules = rulesQuery.data ?? [];
  const settingsQuery = useAlertSettings();
  // 재전파 대상 후보 — 기존 알림 채널 훅을 그대로 재사용한다.
  const { data: channels = [] } = useNotificationChannels();
  const createRule = useCreateAlertRule();
  const updateRule = useUpdateAlertRule();
  const deleteRule = useDeleteAlertRule();
  const editorId = useId();

  const [editing, setEditing] = useState<AlertNotifyRule | null>(null);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [draftErrors, setDraftErrors] = useState<RuleDraftErrors>({});

  const startNew = () => { setEditing(null); setDraftErrors({}); setDraft({ ...EMPTY_RULE }); };
  const startEdit = (rule: AlertNotifyRule) => {
    setEditing(rule);
    setDraftErrors({});
    setDraft({
      name: rule.name,
      enabled: rule.enabled,
      priority: String(rule.priority),
      clusterId: rule.clusterId ?? null,
      moduleKey: rule.moduleKey ?? null,
      alertnamePattern: rule.alertnamePattern ?? null,
      namespacePattern: rule.namespacePattern ?? null,
      labelsText: formatMatchers(rule.labelMatchers),
      severityMin: rule.severityMin ?? null,
      notifyMode: rule.notifyMode,
      recipientsText: rule.recipients.join(', '),
      severityOverride: rule.severityOverride ?? null,
      channelIds: rule.channelIds,
      dedupWindowSec: String(rule.dedupWindowSec),
      dedupMode: rule.dedupMode,
    });
  };
  const closeEditor = () => { setDraft(null); setEditing(null); setDraftErrors({}); };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      toast.error('규칙 이름은 필수입니다.');
      return;
    }
    const priority = parseIntField(draft.priority, PRIORITY_RANGE);
    const dedup = parseIntField(draft.dedupWindowSec, DEDUP_RANGE);
    const labels = parseMatchers(draft.labelsText);
    const errors: RuleDraftErrors = {
      ...(priority.error ? { priority: priority.error } : {}),
      ...(dedup.error ? { dedupWindowSec: dedup.error } : {}),
      ...(labels.error ? { labelsText: labels.error } : {}),
    };
    setDraftErrors(errors);
    if (priority.value === undefined || dedup.value === undefined || labels.error) {
      toast.error('입력값을 확인하세요.');
      return;
    }
    const data: AlertNotifyRuleInput = {
      name: draft.name,
      enabled: draft.enabled,
      priority: priority.value,
      clusterId: draft.clusterId,
      moduleKey: draft.moduleKey,
      alertnamePattern: draft.alertnamePattern,
      namespacePattern: draft.namespacePattern,
      labelMatchers: labels.pairs,
      severityMin: draft.severityMin,
      notifyMode: draft.notifyMode,
      recipients: splitList(draft.recipientsText),
      severityOverride: draft.severityOverride,
      channelIds: draft.channelIds,
      dedupWindowSec: dedup.value,
      dedupMode: draft.dedupMode,
    };
    try {
      if (editing) await updateRule.mutateAsync({ id: editing.id, data });
      else await createRule.mutateAsync(data);
      toast.success(editing ? '규칙을 수정했습니다.' : '규칙을 추가했습니다.');
      closeEditor();
    } catch (err) {
      toast.error(formatApiError(err, '규칙 저장 실패'));
    }
  };

  const remove = async (rule: AlertNotifyRule) => {
    try {
      await deleteRule.mutateAsync(rule.id);
      toast.success('규칙 삭제됨');
      if (editing?.id === rule.id) closeEditor();
    } catch (err) {
      toast.error(formatApiError(err, '규칙 삭제 실패'));
    }
  };

  return (
    <div className="space-y-3">
      <GlobalSettingsCard query={settingsQuery} />

      <MacCard
        title="알림 규칙"
        bodyPadding="p-0"
        actions={(
          <button
            type="button"
            onClick={startNew}
            disabled={!canOperate}
            title={withHint('규칙 추가')}
            aria-label={ariaWithHint('규칙 추가')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm bg-secondary text-muted-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden /> 규칙 추가
          </button>
        )}
      >
        <p className="px-4 py-2.5 text-xs text-muted-foreground border-b border-border">
          priority 가 작은 규칙부터 평가하고 <b className="text-foreground">첫 매칭 1건</b>만 적용합니다.
          매칭되는 규칙이 없으면 위의 전역 기본값을 씁니다.
        </p>

        {rulesQuery.isError && rulesQuery.data ? (
          <p className="px-4 py-2 border-b border-border text-xs text-status-warning">
            최근 갱신 실패 — {formatApiError(rulesQuery.error)}{' '}
            <button
              type="button"
              onClick={() => { void rulesQuery.refetch(); }}
              className="underline underline-offset-2 hover:text-foreground"
            >
              다시 시도
            </button>
          </p>
        ) : null}

        {rulesQuery.isLoading ? (
          <LoadingState compact />
        ) : rulesQuery.isError && !rulesQuery.data ? (
          <EmptyState
            compact
            title="규칙 목록을 불러오지 못했습니다"
            description={formatApiError(rulesQuery.error)}
            action={{ label: '다시 시도', onClick: () => { void rulesQuery.refetch(); }, variant: 'secondary' }}
          />
        ) : rules.length === 0 ? (
          <EmptyState compact title="등록된 규칙이 없습니다." description="지금은 전역 기본값으로만 동작합니다. 위에서 규칙을 추가하면 라우팅·중복 억제가 적용됩니다." />
        ) : (
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
                  <th className={`${TH} w-24`}>재전파</th>
                  <th className={`${TH} w-16`}>사용</th>
                  <th className={`${TH} w-10`}><span className="sr-only">삭제</span></th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => {
                  const isEditing = editing?.id === rule.id && draft !== null;
                  return (
                    <tr
                      key={rule.id}
                      className={`${ROW} ${canOperate ? 'cursor-pointer' : ''} ${isEditing ? 'bg-muted/20' : ''}`}
                      onClick={canOperate ? () => startEdit(rule) : undefined}
                    >
                      <td className={`${TD} text-right font-mono text-xs`}>{rule.priority}</td>
                      <td className={`${TD} font-medium`}>
                        {/* 키보드 편집 진입 — 행 onClick 은 마우스 편의(D-107). */}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); startEdit(rule); }}
                          disabled={!canOperate}
                          title={withHint('규칙 편집')}
                          aria-label={ariaWithHint(`${rule.name} 규칙 편집`)}
                          aria-controls={isEditing ? editorId : undefined}
                          className="text-left rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-default"
                        >
                          {rule.name}
                        </button>
                      </td>
                      <td className={`${TD} text-xs text-muted-foreground truncate max-w-[10rem]`}>
                        {describeMatchers(rule, clusters)}
                      </td>
                      <td className={`${TD} text-xs`}>
                        {NOTIFY_MODES.find((m) => m.value === rule.notifyMode)?.label ?? rule.notifyMode}
                      </td>
                      <td className={`${TD} text-xs text-muted-foreground truncate max-w-[10rem]`}>
                        {rule.recipients.length ? rule.recipients.join(', ') : '—'}
                      </td>
                      <td className={`${TD} text-xs text-muted-foreground`}>
                        {Math.round(rule.dedupWindowSec / 60)}분 ·{' '}
                        {DEDUP_MODES.find((d) => d.value === rule.dedupMode)?.label ?? rule.dedupMode}
                      </td>
                      <td className={`${TD} text-xs text-muted-foreground`}>
                        {rule.severityMin ?? '—'}
                        {rule.severityOverride ? ` → ${rule.severityOverride}` : ''}
                      </td>
                      <td className={`${TD} text-xs text-muted-foreground`}>
                        {rule.channelIds.length ? `채널 ${rule.channelIds.length}` : '—'}
                      </td>
                      <td className={`${TD} text-xs`}>{rule.enabled ? '사용' : '중지'}</td>
                      <td className={TD}>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); void remove(rule); }}
                          disabled={!canOperate}
                          title={withHint('규칙 삭제')}
                          aria-label={ariaWithHint(`${rule.name} 규칙 삭제`)}
                          className="p-1 rounded-xl text-muted-foreground hover:bg-secondary hover:text-status-critical transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                        >
                          <Trash2 className="w-3.5 h-3.5" aria-hidden />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </MacCard>

      {draft ? (
        <RuleEditor
          id={editorId}
          draft={draft}
          setDraft={setDraft}
          errors={draftErrors}
          clearError={(key) => setDraftErrors((prev) => {
            if (!prev[key]) return prev;
            const next = { ...prev };
            delete next[key];
            return next;
          })}
          clusters={clusters}
          channels={channels}
          isEdit={!!editing}
          busy={createRule.isPending || updateRule.isPending}
          onCancel={closeEditor}
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
  if (rule.moduleKey) parts.push(`module~${rule.moduleKey}`);
  if (rule.alertnamePattern) parts.push(`alert~${rule.alertnamePattern}`);
  if (rule.namespacePattern) parts.push(`ns~${rule.namespacePattern}`);
  rule.labelMatchers.forEach((pair) => parts.push(`${pair.k}=${pair.v}`));
  return parts.length ? parts.join(' · ') : '전체';
}

/** 전역 설정 폼 상태 — 숫자·담당자는 원문 문자열(D-106). */
interface SettingsForm {
  defaultNotifyMode: AlertNotifyMode;
  defaultSeverityMin: AlertSeverity;
  dedupMode: AlertDedupMode;
  dedupWindowSec: string;
  retentionDays: string;
  recipientsText: string;
}

type SettingsErrors = Partial<Record<'dedupWindowSec' | 'retentionDays', string>>;

function toSettingsForm(settings: AlertSettings): SettingsForm {
  return {
    defaultNotifyMode: settings.defaultNotifyMode,
    defaultSeverityMin: settings.defaultSeverityMin,
    dedupMode: settings.dedupMode,
    dedupWindowSec: String(settings.dedupWindowSec),
    retentionDays: String(settings.retentionDays),
    recipientsText: settings.defaultRecipients.join(', '),
  };
}

function GlobalSettingsCard({ query }: { query: ReturnType<typeof useAlertSettings> }) {
  const toast = useToast();
  const { canOperate, hint, withHint, ariaWithHint } = useCanOperate();
  const updateSettings = useUpdateAlertSettings();
  const fieldId = useId();
  const settings = query.data;
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [errors, setErrors] = useState<SettingsErrors>({});
  // 사용자가 고친 뒤에는 30초 주기·무효화 refetch 가 입력을 덮어쓰지 않게 한다(D-106).
  const dirtyRef = useRef(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (settings && !dirtyRef.current) setForm(toSettingsForm(settings));
  }, [settings]);

  const title = '전역 기본값 (매칭 규칙이 없을 때)';

  if (!form) {
    if (query.isError) {
      return (
        <MacCard title={title}>
          <EmptyState
            compact
            title="전역 설정을 불러오지 못했습니다"
            description={formatApiError(query.error)}
            action={{ label: '다시 시도', onClick: () => { void query.refetch(); }, variant: 'secondary' }}
          />
        </MacCard>
      );
    }
    return (
      <MacCard title={title}>
        <LoadingState compact />
      </MacCard>
    );
  }

  const edit = (patch: Partial<SettingsForm>) => {
    dirtyRef.current = true;
    setDirty(true);
    setForm({ ...form, ...patch });
    const touched = Object.keys(patch).filter((k): k is keyof SettingsErrors => k in errors);
    if (touched.length) {
      setErrors((prev) => {
        const next = { ...prev };
        touched.forEach((k) => { delete next[k]; });
        return next;
      });
    }
  };

  const save = async () => {
    const dedup = parseIntField(form.dedupWindowSec, DEDUP_RANGE);
    const retention = parseIntField(form.retentionDays, RETENTION_RANGE);
    const nextErrors: SettingsErrors = {
      ...(dedup.error ? { dedupWindowSec: dedup.error } : {}),
      ...(retention.error ? { retentionDays: retention.error } : {}),
    };
    setErrors(nextErrors);
    if (dedup.value === undefined || retention.value === undefined) {
      toast.error('입력값을 확인하세요.');
      return;
    }
    const recipients = splitList(form.recipientsText);
    try {
      await updateSettings.mutateAsync({
        defaultNotifyMode: form.defaultNotifyMode,
        defaultSeverityMin: form.defaultSeverityMin,
        dedupMode: form.dedupMode,
        dedupWindowSec: dedup.value,
        retentionDays: retention.value,
        defaultRecipients: recipients,
      });
      // 저장한 값으로 정규화하고 dirty 를 풀어 이후 서버 값이 다시 반영되게 한다.
      setForm({
        ...form,
        dedupWindowSec: String(dedup.value),
        retentionDays: String(retention.value),
        recipientsText: recipients.join(', '),
      });
      dirtyRef.current = false;
      setDirty(false);
      toast.success('전역 기본값 저장됨');
    } catch (err) {
      toast.error(formatApiError(err, '설정 저장 실패'));
    }
  };

  return (
    <MacCard
      title={title}
      titleExtra={dirty ? <span className="text-[11px] text-muted-foreground">· 저장하지 않은 변경</span> : undefined}
    >
      {query.isError ? (
        <p className="mb-3 text-xs text-status-warning">
          최근 갱신 실패 — {formatApiError(query.error)}{' '}
          <button
            type="button"
            onClick={() => { void query.refetch(); }}
            className="underline underline-offset-2 hover:text-foreground"
          >
            다시 시도
          </button>
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className={labelCls} htmlFor={`${fieldId}-mode`}>알림 대상</label>
          <select
            id={`${fieldId}-mode`} className={inputCls} value={form.defaultNotifyMode}
            disabled={!canOperate} title={hint}
            onChange={(e) => edit({ defaultNotifyMode: e.target.value as AlertNotifyMode })}
          >
            {NOTIFY_MODES.map((m) => <option key={m.value} value={m.value}>{m.label} — {m.hint}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor={`${fieldId}-sev`}>알림 최소 심각도</label>
          <select
            id={`${fieldId}-sev`} className={inputCls} value={form.defaultSeverityMin}
            disabled={!canOperate} title={hint}
            onChange={(e) => edit({ defaultSeverityMin: e.target.value as AlertSeverity })}
          >
            {SEVERITIES.map((s) => <option key={s} value={s}>{s} 이상</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor={`${fieldId}-window`}>중복 억제 창 (초)</label>
          <input
            id={`${fieldId}-window`} type="number" inputMode="numeric"
            min={DEDUP_RANGE.min} max={DEDUP_RANGE.max}
            className={`${inputCls}${errors.dedupWindowSec ? invalidCls : ''}`}
            value={form.dedupWindowSec} disabled={!canOperate} title={hint}
            aria-invalid={!!errors.dedupWindowSec}
            aria-describedby={errors.dedupWindowSec ? `${fieldId}-window-err` : undefined}
            onChange={(e) => edit({ dedupWindowSec: e.target.value })}
          />
          {errors.dedupWindowSec ? (
            <p id={`${fieldId}-window-err`} className={errorCls}>{errors.dedupWindowSec}</p>
          ) : null}
        </div>
        <div>
          <label className={labelCls} htmlFor={`${fieldId}-dedup`}>중복 처리</label>
          <select
            id={`${fieldId}-dedup`} className={inputCls} value={form.dedupMode}
            disabled={!canOperate} title={hint}
            onChange={(e) => edit({ dedupMode: e.target.value as AlertDedupMode })}
          >
            {DEDUP_MODES.map((d) => <option key={d.value} value={d.value}>{d.label} — {d.hint}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor={`${fieldId}-recipients`}>기본 담당자 (쉼표 구분)</label>
          <input
            id={`${fieldId}-recipients`} className={inputCls} disabled={!canOperate} title={hint}
            value={form.recipientsText}
            onChange={(e) => edit({ recipientsText: e.target.value })}
            onBlur={() => {
              const normalized = splitList(form.recipientsText).join(', ');
              if (normalized !== form.recipientsText) setForm({ ...form, recipientsText: normalized });
            }}
            placeholder="알림 대상이 '담당자'일 때 사용"
          />
        </div>
        <div>
          <label className={labelCls} htmlFor={`${fieldId}-retention`}>알람 보존 (일)</label>
          <input
            id={`${fieldId}-retention`} type="number" inputMode="numeric"
            min={RETENTION_RANGE.min} max={RETENTION_RANGE.max}
            className={`${inputCls}${errors.retentionDays ? invalidCls : ''}`}
            value={form.retentionDays} disabled={!canOperate} title={hint}
            aria-invalid={!!errors.retentionDays}
            aria-describedby={errors.retentionDays ? `${fieldId}-retention-err` : undefined}
            onChange={(e) => edit({ retentionDays: e.target.value })}
          />
          {errors.retentionDays ? (
            <p id={`${fieldId}-retention-err`} className={errorCls}>{errors.retentionDays}</p>
          ) : null}
        </div>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        중복 억제: 같은 알람이 창 안에서 반복 수신되면 인박스의 반복 수만 올라가고 개인 알림은
        1건만 생성됩니다(예: 5분 창에서 10건 → 알림 1건 + &quot;최근 5분간 10회&quot; 표기).
      </p>

      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={() => { void save(); }}
          disabled={!canOperate || updateSettings.isPending}
          title={withHint('기본값 저장')}
          aria-label={ariaWithHint('기본값 저장')}
          className="px-4 py-2 rounded-xl text-sm bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {updateSettings.isPending ? '저장 중…' : '기본값 저장'}
        </button>
      </div>
    </MacCard>
  );
}

function RuleEditor({
  id, draft, setDraft, errors, clearError, clusters, channels, isEdit, busy, onCancel, onSave,
}: {
  id: string;
  draft: RuleDraft;
  setDraft: (next: RuleDraft) => void;
  errors: RuleDraftErrors;
  clearError: (key: keyof RuleDraftErrors) => void;
  clusters: Cluster[];
  channels: NotificationChannel[];
  isEdit: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const fieldId = useId();
  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => {
    setDraft({ ...draft, [key]: value });
    if (key === 'priority' || key === 'dedupWindowSec' || key === 'labelsText') clearError(key);
  };
  const errProps = (key: keyof RuleDraftErrors, suffix: string) => ({
    'aria-invalid': !!errors[key],
    'aria-describedby': errors[key] ? `${fieldId}-${suffix}-err` : undefined,
  });

  return (
    <div id={id}>
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
              id={`${fieldId}-priority`} type="number" inputMode="numeric"
              min={PRIORITY_RANGE.min} max={PRIORITY_RANGE.max}
              className={`${inputCls}${errors.priority ? invalidCls : ''}`} value={draft.priority}
              {...errProps('priority', 'priority')}
              onChange={(e) => set('priority', e.target.value)}
            />
            {errors.priority ? (
              <p id={`${fieldId}-priority-err`} className={errorCls}>{errors.priority}</p>
            ) : null}
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
            <label className={labelCls} htmlFor={`${fieldId}-module`}>모듈 / 서비스 패턴 (정규식)</label>
            <input
              id={`${fieldId}-module`} className={`${inputCls} font-mono`} value={draft.moduleKey ?? ''}
              onChange={(e) => set('moduleKey', e.target.value || null)}
              placeholder="fluent|opensearch"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              알람 라벨 중 <code>module</code> · <code>job</code> · <code>service</code> ·
              {' '}<code>component</code> · <code>app</code> 순으로 처음 있는 값에 매칭합니다
              (대개 <code>job</code>).
            </p>
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
              id={`${fieldId}-labels`} className={`${inputCls} font-mono${errors.labelsText ? invalidCls : ''}`}
              value={draft.labelsText}
              {...errProps('labelsText', 'labels')}
              onChange={(e) => set('labelsText', e.target.value)}
              onBlur={() => {
                const normalized = normalizeList(draft.labelsText);
                if (normalized !== draft.labelsText) setDraft({ ...draft, labelsText: normalized });
              }}
              placeholder="team=platform"
            />
            {errors.labelsText ? (
              <p id={`${fieldId}-labels-err`} className={errorCls}>{errors.labelsText}</p>
            ) : null}
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
              value={draft.recipientsText}
              onChange={(e) => set('recipientsText', e.target.value)}
              onBlur={() => {
                const normalized = splitList(draft.recipientsText).join(', ');
                if (normalized !== draft.recipientsText) setDraft({ ...draft, recipientsText: normalized });
              }}
              placeholder="hong, 김철수 — 알림 대상이 '담당자'일 때만 사용"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor={`${fieldId}-window`}>억제 창 (초)</label>
              <input
                id={`${fieldId}-window`} type="number" inputMode="numeric"
                min={DEDUP_RANGE.min} max={DEDUP_RANGE.max}
                className={`${inputCls}${errors.dedupWindowSec ? invalidCls : ''}`}
                value={draft.dedupWindowSec}
                {...errProps('dedupWindowSec', 'window')}
                onChange={(e) => set('dedupWindowSec', e.target.value)}
              />
              {errors.dedupWindowSec ? (
                <p id={`${fieldId}-window-err`} className={errorCls}>{errors.dedupWindowSec}</p>
              ) : null}
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

          {/* 재전파 채널 — 이 규칙에 걸린 알람을 기존 알림 채널(Slack/webhook/email)로도 보낸다.
              채널 자체의 등록/수정은 Deep Check 설정의 알림 채널 관리에서 한다. */}
          <div className="sm:col-span-2 lg:col-span-3">
            <span className={labelCls}>재전파 채널 (선택)</span>
            {channels.length === 0 ? (
              <EmptyState compact title="등록된 알림 채널이 없습니다." description="점검 항목 관리 → 알림 채널에서 먼저 등록하세요." />
            ) : (
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {channels.map((channel) => (
                  <label key={channel.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="rounded"
                      checked={draft.channelIds.includes(channel.id)}
                      onChange={(e) => set(
                        'channelIds',
                        e.target.checked
                          ? [...draft.channelIds, channel.id]
                          : draft.channelIds.filter((cid) => cid !== channel.id),
                      )}
                    />
                    <span className={channel.enabled ? '' : 'text-muted-foreground'}>
                      {channel.name}
                      <span className="ml-1 text-xs text-muted-foreground">({channel.channelType})</span>
                      {channel.enabled ? null : (
                        <span className="ml-1 text-xs text-muted-foreground">· 중지</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )}
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
    </div>
  );
}

function splitList(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 쉼표 목록의 공백만 정리한다(blur 시) — 항목 내용은 바꾸지 않는다. */
function normalizeList(raw: string): string {
  return splitList(raw).join(', ');
}

function formatMatchers(pairs: Array<{ k: string; v: string }>): string {
  return pairs.map((p) => `${p.k}=${p.v}`).join(', ');
}

/**
 * `k=v, k2=v2` 파싱 — 저장 시점에만 호출한다. `=` 가 없는 항목은 예전엔 `k=''`(빈 값과 일치)로
 * 조용히 바뀌었는데, 백엔드는 이를 "라벨 값이 빈 문자열"로 매칭하므로 오류로 알린다.
 */
function parseMatchers(raw: string): { pairs: Array<{ k: string; v: string }>; error?: string } {
  const chunks = splitList(raw);
  const invalid = chunks.filter((chunk) => {
    const idx = chunk.indexOf('=');
    return idx <= 0;
  });
  if (invalid.length) {
    return { pairs: [], error: `k=v 형식이 아닌 항목: ${invalid.join(', ')}` };
  }
  const pairs = chunks.map((chunk) => {
    const idx = chunk.indexOf('=');
    return { k: chunk.slice(0, idx).trim(), v: chunk.slice(idx + 1).trim() };
  });
  return { pairs };
}

/** 정수 입력 검증 — 빈칸·소수·범위 밖이면 값 대신 사유를 돌려준다(조용히 기본값으로 바꾸지 않는다). */
function parseIntField(raw: string, range: { min: number; max: number }): { value?: number; error?: string } {
  const text = raw.trim();
  if (!text) return { error: '값을 입력하세요.' };
  const value = Number(text);
  if (!Number.isInteger(value)) return { error: '정수를 입력하세요.' };
  if (value < range.min || value > range.max) {
    return { error: `${range.min.toLocaleString()} ~ ${range.max.toLocaleString()} 사이로 입력하세요.` };
  }
  return { value };
}
