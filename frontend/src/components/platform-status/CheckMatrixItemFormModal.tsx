import { useId, useMemo, useRef, useState } from 'react';
import {
  X, Loader2, PlayCircle, Plus, Upload, FileCode, Search, AlertTriangle, RefreshCw, Check, ChevronDown,
} from 'lucide-react';
import { useToast, StatusBadge, LogViewer, Skeleton, RunLogPanel } from '@/components/common';
import { useRunLog, runLogged, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { useClusters } from '@/hooks/useCluster';
import { useCanOperate } from '@/hooks/useCanOperate';
import {
  useCreateCheckMatrixItem, useUpdateCheckMatrixItem, useCheckMatrixCatalog, usePreviewCheckMatrixItem,
  useCheckMatrixItemSourceConfig, useUpdateCheckMatrixItemSourceConfig, useCheckMatrixItems,
} from '@/hooks/useCheckMatrix';
import { usePlaybookFiles, useInventories } from '@/hooks/useAnsibleAssets';
import { useAuthStore, hasRole } from '@/stores/authStore';
import type {
  CheckMatrixItem, CheckMatrixSourceType, CheckMatrixCatalogItem, DeepCheckFieldSpec,
  CheckMatrixItemPreviewResult, CheckMatrixCreatableOption, CheckMatrixNamedValue, Cluster,
  AnsiblePlaybookFile,
} from '@/types';
import { formatApiError } from '@/lib/utils';
import { useModalA11y } from '@/components/common/useModalA11y';
import { ROW_COLOR_PRESETS, CATEGORY_SUGGESTIONS, TARGET_SUGGESTIONS } from './rowColors';
import { EXEC_TECH_META } from './execTechMeta';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  editingItem?: CheckMatrixItem | null;
}

const NAME_MAX = 150;

// addon 은 카탈로그가 필드 스펙을 안 주므로(Addon.config 가 자유 JSON) 뭘 입력해야 하는지
// 최소한의 안내 문구만 보여준다 — 구조화된 소스오브트루스가 아니라 도움말이다.
const ADDON_CONFIG_HINTS: Record<string, string> = {
  nexus: 'url (필수)',
  jenkins: 'url (필수), username / api_token (선택)',
  argocd: 'namespace (선택, 기본 argocd)',
  keycloak: 'url (필수)',
};

const SOURCE_TYPE_LABEL: Record<CheckMatrixSourceType, string> = {
  core_bundle: '핵심 점검 번들',
  deep_check: '자동 점검 (등록된 점검 종류)',
  addon: '자동 점검 (애드온)',
  batch_job: '배치잡 (SSH bash/python)',
  playbook: '플레이북 (Ansible)',
  manual: '수동 입력',
};

const FIELD_TYPE_LABEL: Record<string, string> = {
  int: '정수', float: '숫자', boolean: '참/거짓', list: '목록(쉼표 구분)', string: '문자열',
};

// ──────────────────────────────────────────────────────────────
// 값(임계값/파라미터) 헬퍼
// ──────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function namedValuesToRecord(list: CheckMatrixNamedValue[] | null | undefined): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Record<string, any> = {};
  for (const nv of list ?? []) out[nv.name] = nv.value;
  return out;
}

function valueToDraft(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

/** 저장된/기본 값(이름-값 리스트)을 편집 폼의 문자열 draft 로 — 없으면 필드 default. */
function fieldValuesToDraft(
  fields: DeepCheckFieldSpec[], values: CheckMatrixNamedValue[] | null | undefined,
): Record<string, string> {
  const rec = namedValuesToRecord(values);
  const out: Record<string, string> = {};
  for (const f of fields) out[f.name] = valueToDraft(f.name in rec ? rec[f.name] : f.default);
  return out;
}

function validateFieldValue(raw: string, type: string): string | null {
  const v = raw.trim();
  if (v === '') return null; // 비우면 기본값
  if (type === 'int') return /^[-+]?\d+$/.test(v) ? null : '정수를 입력하세요 (예: 30)';
  if (type === 'float') return Number.isFinite(Number(v)) ? null : '숫자를 입력하세요 (예: 0.5)';
  if (type === 'boolean') return /^(true|false)$/i.test(v) ? null : 'true 또는 false 를 고르세요';
  if (type === 'list') {
    const parts = v.split(/[,\n]/).map((s) => s.trim());
    return parts.slice(0, -1).some((p) => !p) ? '빈 항목이 있습니다 — 쉼표 사이에 값을 넣거나 지우세요' : null;
  }
  return null;
}

function fieldErrors(fields: DeepCheckFieldSpec[], draft: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const err = validateFieldValue(draft[f.name] ?? '', f.type);
    if (err) out[f.name] = err;
  }
  return out;
}

function coerceFieldValue(raw: string, type: string): unknown {
  const v = raw.trim();
  if (v === '') return undefined;
  if (type === 'int') { const n = parseInt(v, 10); return Number.isNaN(n) ? undefined : n; }
  if (type === 'float') { const n = parseFloat(v); return Number.isNaN(n) ? undefined : n; }
  if (type === 'boolean') return v.toLowerCase() === 'true';
  if (type === 'list') return v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  return v;
}

function fieldValuesToObject(
  fields: DeepCheckFieldSpec[], draft: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const coerced = coerceFieldValue(draft[f.name] ?? '', f.type);
    if (coerced !== undefined) out[f.name] = coerced;
  }
  return out;
}

function catalogKey(sourceType: string, sourceRef: string | null | undefined): string {
  return `${sourceType}::${sourceRef ?? ''}`;
}

function execTechLabel(tech: string | null | undefined): string {
  if (!tech) return '기타';
  return EXEC_TECH_META[tech]?.label ?? tech;
}

function isConflictError(e: unknown): boolean {
  return (e as { response?: { status?: number } })?.response?.status === 409;
}

// ──────────────────────────────────────────────────────────────
// 공용 조각
// ──────────────────────────────────────────────────────────────

function FieldRow({ field, value, onChange, error, disabled }: {
  field: DeepCheckFieldSpec;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  const errId = `${id}-err`;
  const describedBy = [field.help ? helpId : null, error ? errId : null].filter(Boolean).join(' ') || undefined;
  const inputCls = `w-full text-xs font-mono border rounded-xl px-2.5 py-1.5 bg-background disabled:opacity-50 focus:outline-none focus:ring-1 ${
    error ? 'border-status-critical focus:ring-status-critical' : 'border-border focus:ring-primary'
  }`;
  const boolValue = /^true$/i.test(value.trim()) ? 'true' : /^false$/i.test(value.trim()) ? 'false' : '';
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-foreground">{field.label}</label>
        <span className="text-[11px] font-mono text-muted-foreground truncate">
          {field.name} · {FIELD_TYPE_LABEL[field.type] ?? field.type}
        </span>
      </div>
      {field.type === 'boolean' ? (
        <select
          id={id}
          value={boolValue}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={!!error || undefined}
          className={inputCls}
        >
          <option value="">
            (기본값{field.default !== undefined && field.default !== null ? `: ${String(field.default)}` : ''})
          </option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input
          id={id}
          type="text"
          inputMode={field.type === 'int' || field.type === 'float' ? 'decimal' : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={field.type === 'list' ? '쉼표로 구분 (예: a, b, c)' : '비우면 기본값'}
          aria-describedby={describedBy}
          aria-invalid={!!error || undefined}
          className={inputCls}
        />
      )}
      {field.help && <p id={helpId} className="text-[11px] text-muted-foreground leading-relaxed">{field.help}</p>}
      {error && (
        <p id={errId} className="text-[11px] text-status-critical inline-flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" aria-hidden="true" /> {error}
        </p>
      )}
    </div>
  );
}

function FieldGroup({ title, fields, draft, errors, onChange, disabled }: {
  title: string;
  fields: DeepCheckFieldSpec[];
  draft: Record<string, string>;
  errors: Record<string, string>;
  onChange: (name: string, v: string) => void;
  disabled?: boolean;
}) {
  if (fields.length === 0) return null;
  return (
    <fieldset className="space-y-3">
      <legend className="text-xs font-semibold text-muted-foreground mb-1">{title}</legend>
      {fields.map((f) => (
        <FieldRow
          key={f.name}
          field={f}
          value={draft[f.name] ?? ''}
          error={errors[f.name]}
          disabled={disabled}
          onChange={(v) => onChange(f.name, v)}
        />
      ))}
    </fieldset>
  );
}

function ModalChrome({
  titleId, title, onClose, closeDisabled, dialogRef, children, footer, wide,
}: {
  titleId: string;
  title: string;
  onClose: () => void;
  closeDisabled?: boolean;
  dialogRef: React.RefObject<HTMLDivElement>;
  children: React.ReactNode;
  footer: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`bg-card border border-border rounded-md shadow-xl w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} mx-4 max-h-[88vh] flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          <button
            onClick={onClose}
            disabled={closeDisabled}
            title={closeDisabled ? '저장 중에는 닫을 수 없습니다' : '닫기'}
            aria-label="닫기"
            className="p-1 hover:bg-secondary rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto flex-1 min-h-0">{children}</div>
        <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-border">{footer}</div>
      </div>
    </div>
  );
}

function RowColorPicker({ color, onChange }: { color: string; onChange: (v: string) => void }) {
  return (
    <div>
      <span className="text-xs font-medium text-muted-foreground mb-1 block">행 배경 색 (선택)</span>
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <button
          type="button"
          onClick={() => onChange('')}
          title="무색"
          aria-label="행 배경 색 없음"
          aria-pressed={color === ''}
          className={`w-6 h-6 rounded-full border text-[11px] text-muted-foreground flex items-center justify-center ${
            color === '' ? 'border-primary ring-1 ring-primary/40' : 'border-border'
          }`}
        >
          ×
        </button>
        {ROW_COLOR_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => onChange(p.key)}
            title={p.label}
            aria-label={`행 배경 색 ${p.label}`}
            aria-pressed={color === p.key}
            className={`w-6 h-6 rounded-full ${p.swatch} ${
              color === p.key ? 'ring-1 ring-primary ring-offset-2 ring-offset-card' : ''
            }`}
          />
        ))}
      </div>
    </div>
  );
}

/** 클러스터 종합 상태 반영(opt-in) 을 쓸 수 있는 실행 소스 — 등록된 점검은 정의의 같은 스위치,
 *  애드온은 항상 반영이라 여기서 다루지 않는다(서버도 같은 규칙으로 400). */
const STATUS_OPT_IN_SOURCES: CheckMatrixSourceType[] = ['batch_job', 'playbook', 'manual'];

function ClusterStatusOptIn({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 rounded-xl border border-border px-3 py-2 text-sm cursor-pointer select-none">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        클러스터 상태에 반영
        <span className="block text-[11px] text-muted-foreground">
          켜면 이 항목이 경고·위험일 때 클러스터 종합 상태(사이드바 색·열 머리글 점)도 경고·위험이 됩니다.
          클러스터 상세의 「종합 상태」 원인 목록에도 나옵니다. 기본은 꺼짐.
        </span>
      </span>
    </label>
  );
}

/** 영역 / 같은 대상 묶기 / 행 색 — 대부분의 사용자는 건드리지 않으므로 접어 둔다. */
function AdvancedSection({
  category, onCategory, targetKey, onTargetKey, color, onColor, defaultOpen,
}: {
  category: string; onCategory: (v: string) => void;
  targetKey: string; onTargetKey: (v: string) => void;
  color: string; onColor: (v: string) => void;
  defaultOpen?: boolean;
}) {
  const categoryId = useId();
  const categoryListId = useId();
  const targetKeyId = useId();
  const targetKeyListId = useId();
  const targetHelpId = useId();
  return (
    <details className="group rounded-xl border border-border" open={defaultOpen}>
      <summary className="flex items-center justify-between gap-2 px-3 py-2 cursor-pointer select-none text-xs font-medium text-muted-foreground hover:text-foreground list-none">
        <span>고급 — 영역 · 같은 대상 묶기 · 행 색</span>
        <ChevronDown className="w-3.5 h-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="px-3 pb-3 pt-1 space-y-3 border-t border-border">
        <div>
          <label htmlFor={categoryId} className="text-xs font-medium text-muted-foreground mb-1 block">
            영역 (선택 — 매트릭스 행 구분)
          </label>
          <input
            id={categoryId}
            type="text"
            list={categoryListId}
            value={category}
            onChange={(e) => onCategory(e.target.value)}
            placeholder="예: k8s, network, storage"
            className="w-full text-sm border border-border rounded-xl px-3 py-2 bg-background"
          />
          <datalist id={categoryListId}>
            {CATEGORY_SUGGESTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
          </datalist>
        </div>
        <div>
          <label htmlFor={targetKeyId} className="text-xs font-medium text-muted-foreground mb-1 block">
            같은 대상을 점검하는 다른 항목과 묶기 (예: etcd)
          </label>
          <input
            id={targetKeyId}
            type="text"
            list={targetKeyListId}
            value={targetKey}
            onChange={(e) => onTargetKey(e.target.value)}
            placeholder="예: etcd, node, api-server"
            aria-describedby={targetHelpId}
            className="w-full text-sm border border-border rounded-xl px-3 py-2 bg-background"
          />
          <datalist id={targetKeyListId}>
            {TARGET_SUGGESTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
          </datalist>
          <p id={targetHelpId} className="text-[11px] text-muted-foreground mt-1">
            같은 값을 가진 다른 실행 방식의 항목이 있으면 매트릭스에 "중복 점검" 배지가 뜹니다(같은
            실행 방식끼리는 표시하지 않음).
          </p>
        </div>
        <RowColorPicker color={color} onChange={onColor} />
      </div>
    </details>
  );
}

function KeyValueRows({ rows, onChange, keyPlaceholder, labelPrefix, addLabel }: {
  rows: { key: string; value: string }[];
  onChange: (rows: { key: string; value: string }[]) => void;
  keyPlaceholder: string;
  labelPrefix: string;
  addLabel: string;
}) {
  return (
    <div className="space-y-1.5">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            type="text"
            value={row.key}
            placeholder={keyPlaceholder}
            aria-label={`${labelPrefix} 키 ${i + 1}`}
            onChange={(e) => onChange(rows.map((r, idx) => (idx === i ? { ...r, key: e.target.value } : r)))}
            className="w-36 text-xs font-mono border border-border rounded-xl px-2 py-1.5 bg-background"
          />
          <input
            type="text"
            value={row.value}
            placeholder="값"
            aria-label={`${labelPrefix} 값 ${i + 1}`}
            onChange={(e) => onChange(rows.map((r, idx) => (idx === i ? { ...r, value: e.target.value } : r)))}
            className="flex-1 min-w-0 text-xs font-mono border border-border rounded-xl px-2 py-1.5 bg-background"
          />
          <button
            type="button"
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
            title="항목 제거"
            aria-label={`${labelPrefix} ${i + 1} 제거`}
            className="p-1 rounded-xl text-muted-foreground hover:text-status-critical"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, { key: '', value: '' }])}
        className="text-xs text-primary hover:underline"
      >
        + {addLabel}
      </button>
    </div>
  );
}

/** 미리 실행 응답 → 실행 로그 요약 줄(상태·소요·메시지 첫 줄·상세 로그 줄 수). */
function previewRunLines(res: CheckMatrixItemPreviewResult): RunLogEntry[] {
  if (res.skipped) return [['warn', `실행 안 함 — ${res.message || '안전상 실제 실행을 건너뜀'}`]];
  const level: RunLogEntry[0] = res.status === 'critical' ? 'error' : res.status === 'warning' ? 'warn' : 'info';
  const msg = (res.message ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  const out: RunLogEntry[] = [[level, `결과 ${res.status}${typeof res.durationMs === 'number' ? ` · ${res.durationMs}ms` : ''}${msg ? ` — ${msg.slice(0, 200)}` : ''}`]];
  const logLines = res.log ? res.log.split('\n').length : 0;
  if (logLines) out.push(['info', `상세 로그 ${logLines}줄 — 아래 결과의 상세 로그에서 확인`]);
  return out;
}

/** 미리 실행 결과 — 상태 배지 + 메시지 + 상세 로그(펼친 상태). 요청 중엔 스피너. */
function PreviewResultView({ result, pending }: { result: CheckMatrixItemPreviewResult | null; pending: boolean }) {
  if (pending) {
    return (
      <div className="rounded-xl border border-border bg-secondary/30 p-3 flex items-center gap-2 text-sm" role="status" aria-live="polite">
        <Loader2 className="w-4 h-4 animate-spin text-primary" aria-hidden="true" />
        실행 중… <span className="text-xs text-muted-foreground">결과와 상세 로그가 끝나면 여기에 표시됩니다.</span>
      </div>
    );
  }
  if (!result) return null;
  const log = result.log
    || (result.details ? JSON.stringify(result.details, null, 2) : '')
    || '(상세 로그 없음)';
  return (
    <div className="rounded-xl border border-border bg-secondary/30 p-3 space-y-2" aria-live="polite">
      <div className="flex items-center gap-2">
        {result.skipped
          ? <StatusBadge variant="neutral" label="실행 안 함" size="sm" />
          : <StatusBadge variant={result.status} size="sm" />}
        {typeof result.durationMs === 'number' && (
          <span className="text-xs text-muted-foreground tabular-nums">{result.durationMs}ms</span>
        )}
      </div>
      {result.message && <p className="text-xs whitespace-pre-wrap break-words">{result.message}</p>}
      <div>
        <span className="text-[11px] font-medium text-muted-foreground mb-1 block">상세 로그</span>
        <LogViewer text={log} maxHeight="max-h-72" />
      </div>
    </div>
  );
}

export function CheckMatrixItemFormModal({ isOpen, onClose, editingItem }: Props) {
  // 닫히면 언마운트 → 다시 열 때 상태가 처음부터 시작한다(이전 세션 값이 한 프레임 비치는 문제 없음).
  if (!isOpen) return null;
  if (editingItem) {
    return <EditItemForm key={editingItem.id} onClose={onClose} editingItem={editingItem} />;
  }
  return <RegisterItemWizard onClose={onClose} />;
}

// ──────────────────────────────────────────────────────────────
// 수정 — 기존 항목의 표시 속성·(비시스템이면) 실행 소스·실행 설정을 고친다.
// ──────────────────────────────────────────────────────────────
function EditItemForm({ onClose, editingItem }: { onClose: () => void; editingItem: CheckMatrixItem }) {
  const toast = useToast();
  const { data: catalog, isLoading: catalogLoading } = useCheckMatrixCatalog();
  const updateMut = useUpdateCheckMatrixItem();
  const updateConfigMut = useUpdateCheckMatrixItemSourceConfig();
  const { data: sourceConfig } = useCheckMatrixItemSourceConfig(editingItem.id, true);
  const user = useAuthStore((s) => s.user);
  const isAdmin = hasRole(user, 'admin');
  const { canOperate, withHint } = useCanOperate();
  const isSystem = editingItem.isSystem;
  const saving = updateMut.isPending || updateConfigMut.isPending;

  const safeClose = () => { if (!saving) onClose(); };
  const dialogRef = useModalA11y(true, safeClose);

  const nameId = useId();
  const descId = useId();
  const unitId = useId();
  const sourceId = useId();
  const sourceHelpId = useId();
  const titleId = useId();

  const [name, setName] = useState(editingItem.name ?? '');
  const [description, setDescription] = useState(editingItem.description ?? '');
  const [unit, setUnit] = useState(editingItem.unit ?? '');
  const [sourceType, setSourceType] = useState<CheckMatrixSourceType>(editingItem.sourceType ?? 'manual');
  const [sourceRef, setSourceRef] = useState(editingItem.sourceRef ?? '');
  const [category, setCategory] = useState(editingItem.category ?? '');
  const [targetKey, setTargetKey] = useState(editingItem.targetKey ?? '');
  const [affectsStatus, setAffectsStatus] = useState(!!editingItem.affectsClusterStatus);
  const [color, setColor] = useState(editingItem.color ?? '');
  const [enabled, setEnabled] = useState(editingItem.enabled ?? true);
  // 저장된 값 위에 사용자가 고친 것만 얹는다 — 저장 후 재조회가 와도 편집 중인 값이 날아가지 않는다.
  const [thresholdEdits, setThresholdEdits] = useState<Record<string, string>>({});
  const [paramEdits, setParamEdits] = useState<Record<string, string>>({});
  const [dedicatedEdit, setDedicatedEdit] = useState<boolean | null>(null);

  const sourceUnchanged = sourceType === editingItem.sourceType && (sourceRef || '') === (editingItem.sourceRef ?? '');
  const configApplies = !!sourceConfig?.editable && sourceUnchanged;

  const thresholdBase = useMemo(
    () => (sourceConfig ? fieldValuesToDraft(sourceConfig.thresholdFields, sourceConfig.thresholdValues) : {}),
    [sourceConfig],
  );
  const paramBase = useMemo(
    () => (sourceConfig ? fieldValuesToDraft(sourceConfig.paramFields, sourceConfig.paramValues) : {}),
    [sourceConfig],
  );
  const thresholdDraft = { ...thresholdBase, ...thresholdEdits };
  const paramDraft = { ...paramBase, ...paramEdits };
  const valuesDirty = Object.entries(thresholdEdits).some(([k, v]) => v !== (thresholdBase[k] ?? ''))
    || Object.entries(paramEdits).some(([k, v]) => v !== (paramBase[k] ?? ''));

  // 공유 정의(다른 항목·클러스터가 같이 쓰는 값)는 admin 만 직접 고칠 수 있다 — 나머지는 이 항목 전용으로 분리해 저장.
  const forceDedicated = !!sourceConfig?.shared && !sourceConfig.dedicated && !isAdmin;
  const dedicated = forceDedicated ? true : (dedicatedEdit ?? sourceConfig?.dedicated ?? false);
  const dedicatedDirty = !forceDedicated && dedicatedEdit !== null && dedicatedEdit !== (sourceConfig?.dedicated ?? false);
  const configDirty = configApplies && (valuesDirty || dedicatedDirty);

  const thresholdErrors = configApplies && sourceConfig ? fieldErrors(sourceConfig.thresholdFields, thresholdDraft) : {};
  const paramErrors = configApplies && sourceConfig ? fieldErrors(sourceConfig.paramFields, paramDraft) : {};
  const hasFieldErrors = Object.keys(thresholdErrors).length + Object.keys(paramErrors).length > 0;

  // 실행 소스 선택지 — 카탈로그(점검 종류·애드온·배치잡·플레이북·수동)를 그대로 쓴다.
  const sourceGroups = useMemo(() => {
    const groups = new Map<CheckMatrixSourceType, { key: string; label: string }[]>();
    for (const it of catalog?.items ?? []) {
      const list = groups.get(it.sourceType) ?? [];
      list.push({
        key: catalogKey(it.sourceType, it.sourceRef),
        label: it.sourceType === 'manual' ? it.displayName : `${it.displayName} · ${execTechLabel(it.execTech)}`,
      });
      groups.set(it.sourceType, list);
    }
    // 카탈로그에 없는 현재 소스(예: 삭제된 플레이북 이름)도 선택된 채로 보이게 한다.
    const currentKey = catalogKey(editingItem.sourceType, editingItem.sourceType === 'manual' ? null : editingItem.sourceRef);
    const exists = [...groups.values()].some((l) => l.some((o) => o.key === currentKey));
    if (!exists && editingItem.sourceType !== 'core_bundle') {
      const list = groups.get(editingItem.sourceType) ?? [];
      list.unshift({ key: currentKey, label: `(현재) ${editingItem.sourceRef ?? SOURCE_TYPE_LABEL[editingItem.sourceType]}` });
      groups.set(editingItem.sourceType, list);
    }
    return groups;
  }, [catalog, editingItem]);
  const selectedSourceKey = catalogKey(sourceType, sourceType === 'manual' ? null : sourceRef);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) { toast.error('이름을 입력하세요.'); return; }
    if (trimmed.length > NAME_MAX) { toast.error(`이름은 ${NAME_MAX}자 이하로 입력하세요.`); return; }
    if (sourceType !== 'manual' && sourceType !== 'core_bundle' && !sourceRef) {
      toast.error('실행 소스를 선택하세요.');
      return;
    }
    if (hasFieldErrors) { toast.error('실행 설정 값을 확인하세요.'); return; }
    const body = {
      name: trimmed,
      description: description.trim() || null,
      unit: unit.trim() || null,
      sourceType,
      sourceRef: sourceType === 'manual' ? null : sourceRef,
      category: category.trim() || null,
      targetKey: targetKey.trim() || null,
      color: color || null,
      enabled,
      affectsClusterStatus: STATUS_OPT_IN_SOURCES.includes(sourceType as CheckMatrixSourceType) ? affectsStatus : false,
    };
    try {
      await updateMut.mutateAsync({ id: editingItem.id, body });
    } catch (e) {
      toast.error('수정 실패', formatApiError(e));
      return;
    }
    // 실행 설정은 소스가 그대로이고 실제로 바뀐 값이 있을 때만 보낸다 — 소스를 바꿨는데 예전
    // 종류의 값을 새 소스에 덮어쓰거나, 이름만 고쳤는데 공유 정의를 분리해버리는 일이 없게.
    if (configDirty && sourceConfig) {
      try {
        await updateConfigMut.mutateAsync({
          itemId: editingItem.id,
          body: {
            thresholds: fieldValuesToObject(sourceConfig.thresholdFields, thresholdDraft),
            params: fieldValuesToObject(sourceConfig.paramFields, paramDraft),
            dedicated,
          },
        });
      } catch (e) {
        toast.error('일부만 저장됨', `항목은 저장됐지만 실행 설정 저장에 실패했습니다: ${formatApiError(e)}`);
        return;
      }
    }
    toast.success('항목 수정됨');
    onClose();
  };

  const saveDisabled = saving || !canOperate || !name.trim() || hasFieldErrors;

  return (
    <ModalChrome
      titleId={titleId}
      title="점검 항목 수정"
      onClose={safeClose}
      closeDisabled={saving}
      dialogRef={dialogRef}
      footer={(
        <>
          <button
            onClick={safeClose}
            disabled={saving}
            className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl disabled:opacity-50"
          >
            취소
          </button>
          <button
            onClick={handleSave}
            disabled={saveDisabled}
            title={withHint('저장')}
            aria-busy={saving || undefined}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
            {saving ? '저장 중…' : '저장'}
          </button>
        </>
      )}
    >
      <div>
        <label htmlFor={nameId} className="text-xs font-medium text-muted-foreground mb-1 block">이름 (필수)</label>
        <input
          id={nameId}
          type="text"
          value={name}
          maxLength={NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          placeholder="예: N/W 스위치"
          className="w-full text-sm border border-border rounded-xl px-3 py-2 bg-background"
        />
      </div>

      <div>
        <label htmlFor={descId} className="text-xs font-medium text-muted-foreground mb-1 block">설명 (선택)</label>
        <input
          id={descId}
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full text-sm border border-border rounded-xl px-3 py-2 bg-background"
        />
      </div>

      <div>
        <label htmlFor={unitId} className="text-xs font-medium text-muted-foreground mb-1 block">단위 (선택, 예: ms, %)</label>
        <input
          id={unitId}
          type="text"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          className="w-full text-sm border border-border rounded-xl px-3 py-2 bg-background"
        />
      </div>

      {isSystem ? (
        <p className="text-xs text-muted-foreground rounded-xl border border-border bg-secondary/40 px-3 py-2">
          시스템 항목입니다 — 클러스터 전체 상태 계산에 쓰이는 실행 소스(핵심 점검 번들)는
          바꿀 수 없고, 이름/설명/단위/표시 여부만 수정할 수 있습니다.
        </p>
      ) : (
        <div>
          <label htmlFor={sourceId} className="text-xs font-medium text-muted-foreground mb-1 block">실행 소스</label>
          <select
            id={sourceId}
            value={selectedSourceKey}
            disabled={catalogLoading}
            aria-describedby={sourceHelpId}
            onChange={(e) => {
              const [st, ref] = e.target.value.split('::');
              setSourceType(st as CheckMatrixSourceType);
              setSourceRef(ref ?? '');
            }}
            className="w-full text-sm border border-border rounded-xl px-3 py-2 bg-background disabled:opacity-60"
          >
            {catalogLoading && <option value={selectedSourceKey}>불러오는 중…</option>}
            {(['deep_check', 'addon', 'batch_job', 'playbook', 'manual'] as CheckMatrixSourceType[]).map((st) => {
              const opts = sourceGroups.get(st);
              if (!opts?.length) return null;
              return (
                <optgroup key={st} label={SOURCE_TYPE_LABEL[st]}>
                  {opts.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </optgroup>
              );
            })}
          </select>
          <p id={sourceHelpId} className="text-[11px] text-muted-foreground mt-1">
            이 항목이 셀마다 실제로 무엇을 실행하는지 고릅니다. 배치잡/플레이북은 각 클러스터에 같은 이름으로
            등록된 것을 찾아 실행합니다.
          </p>
          {!sourceUnchanged && sourceConfig?.editable && (
            <p className="text-[11px] text-status-warning mt-1">
              실행 소스를 바꾸면 기존 임계값·파라미터는 새 소스에 적용되지 않습니다 — 저장 후 다시 열어 새 소스의 값을 설정하세요.
            </p>
          )}
        </div>
      )}

      {configApplies && sourceConfig && (
        <div className="space-y-3 rounded-xl border border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold">실행 설정 (임계값 · 파라미터)</span>
            {sourceConfig.dedicated ? (
              <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">이 항목 전용</span>
            ) : sourceConfig.shared ? (
              <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground">공유 중</span>
            ) : null}
          </div>
          {sourceConfig.note && <p className="text-xs text-muted-foreground">{sourceConfig.note}</p>}
          <FieldGroup
            title="임계값"
            fields={sourceConfig.thresholdFields}
            draft={thresholdDraft}
            errors={thresholdErrors}
            onChange={(n, v) => setThresholdEdits((cur) => ({ ...cur, [n]: v }))}
          />
          <FieldGroup
            title="파라미터"
            fields={sourceConfig.paramFields}
            draft={paramDraft}
            errors={paramErrors}
            onChange={(n, v) => setParamEdits((cur) => ({ ...cur, [n]: v }))}
          />
          {!sourceConfig.dedicated && (
            <label className="flex items-start gap-2 text-xs rounded-xl bg-secondary/40 px-3 py-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={dedicated}
                disabled={forceDedicated}
                onChange={(e) => setDedicatedEdit(e.target.checked)}
                aria-describedby={forceDedicated ? `${sourceId}-force` : undefined}
              />
              <span>
                <span className="font-medium text-foreground">이 항목 전용 설정으로 분리</span> — 같은 점검 종류를 쓰는
                다른 항목은 영향받지 않습니다.
                {forceDedicated && (
                  <span id={`${sourceId}-force`} className="block text-muted-foreground mt-0.5">
                    이 설정은 다른 항목·클러스터와 공유 중이라 직접 수정은 admin 만 할 수 있습니다 — 값을 바꾸면 이 항목 전용으로
                    분리해 저장합니다.
                  </span>
                )}
                {!forceDedicated && sourceConfig.shared && !dedicated && (
                  <span className="block text-status-warning mt-0.5">
                    끈 채로 저장하면 이 값을 공유하는 다른 항목·클러스터에도 함께 반영됩니다.
                  </span>
                )}
              </span>
            </label>
          )}
        </div>
      )}

      {STATUS_OPT_IN_SOURCES.includes(sourceType as CheckMatrixSourceType) && (
        <ClusterStatusOptIn checked={affectsStatus} onChange={setAffectsStatus} />
      )}

      <AdvancedSection
        category={category} onCategory={setCategory}
        targetKey={targetKey} onTargetKey={setTargetKey}
        color={color} onColor={setColor}
        defaultOpen={!!(editingItem.category || editingItem.targetKey || editingItem.color)}
      />

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        그리드에 표시
      </label>
    </ModalChrome>
  );
}

// ──────────────────────────────────────────────────────────────
// 등록 마법사 — ① 점검 선택 → ② 설정 → ③ 테스트 · 저장
// ──────────────────────────────────────────────────────────────
const WIZARD_STEPS = ['점검 선택', '설정', '테스트 · 저장'] as const;

interface PlaybookDraft {
  name: string;
  content: string;
  tags: string;
  fileId: string;
  extraVars: { key: string; value: string }[];
  clusterIds: string[];
  /** clusterId → inventoryId ('' = 클러스터 기본/자동) */
  inventories: Record<string, string>;
}

const EMPTY_PLAYBOOK: PlaybookDraft = {
  name: '', content: '', tags: '', fileId: '', extraVars: [], clusterIds: [], inventories: {},
};

type Selection =
  | { kind: 'catalog'; item: CheckMatrixCatalogItem }
  | { kind: 'custom'; item: CheckMatrixCatalogItem; label: string }
  | { kind: 'new_playbook' };

function selectionKey(sel: Selection | null): string {
  if (!sel) return '';
  if (sel.kind === 'new_playbook') return 'new_playbook';
  return `${sel.kind}:${catalogKey(sel.item.sourceType, sel.item.sourceRef)}`;
}

function InventoryPicker({ cluster, value, onChange }: {
  cluster: Cluster; value: string; onChange: (v: string) => void;
}) {
  const id = useId();
  const { data: inventories, isLoading } = useInventories(cluster.id);
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-xs w-32 flex-shrink-0 truncate" title={cluster.name}>{cluster.name}</label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={isLoading}
        className="flex-1 min-w-0 text-xs border border-border rounded-xl px-2 py-1.5 bg-background disabled:opacity-60"
      >
        <option value="">{isLoading ? '불러오는 중…' : '(클러스터 기본 인벤토리 / 없으면 K8s 노드 자동)'}</option>
        {(inventories ?? []).map((inv) => (
          <option key={inv.id} value={inv.id}>{inv.name}{inv.isDefault ? ' (기본)' : ''}</option>
        ))}
      </select>
    </div>
  );
}

function PlaybookEditor({ value, onChange, clusters, playbookFiles }: {
  value: PlaybookDraft;
  onChange: (patch: Partial<PlaybookDraft>) => void;
  clusters: Cluster[];
  playbookFiles: AnsiblePlaybookFile[];
}) {
  const toast = useToast();
  const nameId = useId();
  const contentId = useId();
  const tagsId = useId();
  const libraryId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadFile = async (file: File) => {
    try {
      const text = await file.text();
      onChange({ content: text, fileId: '', name: value.name.trim() ? value.name : file.name.replace(/\.(ya?ml)$/i, '') });
    } catch {
      toast.error('파일을 읽지 못했습니다.');
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-border p-3">
      <div className="flex items-center gap-2">
        <FileCode className="w-4 h-4 text-primary" aria-hidden="true" />
        <span className="text-xs font-semibold">플레이북</span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        저장하면 선택한 클러스터마다 같은 이름의 플레이북이 만들어지고, 이 항목의 셀이 그것을 실행합니다
        (`/playbooks` 화면에서도 관리됩니다).
      </p>
      <div>
        <label htmlFor={nameId} className="text-xs font-medium text-muted-foreground mb-1 block">
          플레이북 이름 (필수 — 실행 대상을 찾는 키)
        </label>
        <input
          id={nameId}
          type="text"
          value={value.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="예: etcd-health-check"
          className="w-full text-sm border border-border rounded-xl px-3 py-2 bg-background"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={libraryId} className="text-xs text-muted-foreground">라이브러리에서 불러오기</label>
        <select
          id={libraryId}
          value={value.fileId}
          onChange={(e) => {
            const fid = e.target.value;
            const f = playbookFiles.find((x) => x.id === fid);
            onChange(f
              ? { fileId: fid, content: f.content, name: value.name.trim() ? value.name : f.name }
              : { fileId: '' });
          }}
          className="text-xs border border-border rounded-xl px-2 py-1.5 bg-background"
        >
          <option value="">(직접 작성)</option>
          {playbookFiles.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1 text-xs px-2 py-1.5 border border-border rounded-xl hover:bg-secondary/60"
        >
          <Upload className="w-3.5 h-3.5" aria-hidden="true" /> 파일 불러오기
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".yml,.yaml,text/yaml"
          aria-label="플레이북 YAML 파일 선택"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void loadFile(f);
            e.target.value = '';
          }}
        />
      </div>

      <div>
        <label htmlFor={contentId} className="text-xs font-medium text-muted-foreground mb-1 block">
          Playbook YAML (필수)
        </label>
        <textarea
          id={contentId}
          value={value.content}
          onChange={(e) => onChange({ content: e.target.value, fileId: '' })}
          rows={10}
          spellCheck={false}
          placeholder={'- hosts: all\n  gather_facts: false\n  tasks:\n    - name: check etcd\n      command: systemctl is-active etcd'}
          className="w-full text-xs font-mono border border-border rounded-xl px-3 py-2 bg-background"
        />
      </div>

      <div>
        <label htmlFor={tagsId} className="text-xs font-medium text-muted-foreground mb-1 block">태그 (선택 — --tags)</label>
        <input
          id={tagsId}
          type="text"
          value={value.tags}
          onChange={(e) => onChange({ tags: e.target.value })}
          className="w-full text-sm border border-border rounded-xl px-3 py-2 bg-background"
        />
      </div>

      <div>
        <span className="text-xs font-medium text-muted-foreground mb-1 block">extra vars (선택)</span>
        <KeyValueRows
          rows={value.extraVars}
          onChange={(rows) => onChange({ extraVars: rows })}
          keyPlaceholder="키"
          labelPrefix="extra var"
          addLabel="변수 추가"
        />
      </div>

      <div>
        <span className="text-xs font-medium text-muted-foreground mb-1 block">실행할 클러스터 (필수 — 1개 이상)</span>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="실행할 클러스터">
          {clusters.map((c) => {
            const on = value.clusterIds.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onChange({
                  clusterIds: on ? value.clusterIds.filter((x) => x !== c.id) : [...value.clusterIds, c.id],
                })}
                aria-pressed={on}
                className={`inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-xl border transition-colors ${
                  on ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-secondary/60'
                }`}
              >
                {on && <Check className="w-3 h-3" aria-hidden="true" />}
                {c.name}
              </button>
            );
          })}
          {clusters.length === 0 && (
            <p className="text-xs text-status-warning">등록된 클러스터가 없습니다 — 먼저 클러스터를 등록하세요.</p>
          )}
        </div>
      </div>

      {value.clusterIds.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground block">인벤토리 (클러스터별, 선택)</span>
          {clusters.filter((c) => value.clusterIds.includes(c.id)).map((c) => (
            <InventoryPicker
              key={c.id}
              cluster={c}
              value={value.inventories[c.id] ?? ''}
              onChange={(v) => onChange({ inventories: { ...value.inventories, [c.id]: v } })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StepIndicator({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2" aria-label="등록 단계">
      {WIZARD_STEPS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex items-center gap-2 min-w-0" aria-current={active ? 'step' : undefined}>
            {i > 0 && <span className={`h-px w-6 ${done || active ? 'bg-primary' : 'bg-border'}`} aria-hidden="true" />}
            <span
              className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-semibold flex-shrink-0 ${
                active ? 'bg-primary text-primary-foreground'
                  : done ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'
              }`}
              aria-hidden="true"
            >
              {done ? <Check className="w-3 h-3" /> : i + 1}
            </span>
            <span className={`text-xs truncate ${active ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function RegisterItemWizard({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const catalogQuery = useCheckMatrixCatalog();
  const catalog = catalogQuery.data;
  const { data: clusters = [] } = useClusters();
  const { data: playbookFiles = [] } = usePlaybookFiles();
  const { data: existingItems = [] } = useCheckMatrixItems();
  const createMut = useCreateCheckMatrixItem();
  const previewMut = usePreviewCheckMatrixItem();
  const user = useAuthStore((s) => s.user);
  const isAdmin = hasRole(user, 'admin');
  const { canOperate, withHint } = useCanOperate();

  const saving = createMut.isPending;
  const safeClose = () => { if (!saving) onClose(); };
  const dialogRef = useModalA11y(true, safeClose);

  const titleId = useId();
  const searchId = useId();
  const nameId = useId();
  const nameHelpId = useId();
  const descId = useId();
  const unitId = useId();
  const clusterFieldId = useId();
  const dedicatedHelpId = useId();

  const [step, setStep] = useState(0);
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  // 선택한 종류에서 자동으로 채운 값 — 사용자가 고치지 않았을 때만 다른 종류로 바꾸면 따라 바뀐다.
  const [autoFill, setAutoFill] = useState({ name: '', description: '', category: '' });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [unit, setUnit] = useState('');
  const [category, setCategory] = useState('');
  const [targetKey, setTargetKey] = useState('');
  const [affectsStatus, setAffectsStatus] = useState(false);
  const [color, setColor] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [thresholdDraft, setThresholdDraft] = useState<Record<string, string>>({});
  const [paramDraft, setParamDraft] = useState<Record<string, string>>({});
  const [dedicated, setDedicated] = useState(false);
  const [dedicatedAuto, setDedicatedAuto] = useState(false);
  const [dedicatedUserSet, setDedicatedUserSet] = useState(false);
  const [addonConfigRows, setAddonConfigRows] = useState<{ key: string; value: string }[]>([{ key: '', value: '' }]);
  const [pb, setPb] = useState<PlaybookDraft>(EMPTY_PLAYBOOK);
  const [pbConflict, setPbConflict] = useState<string | null>(null);
  const [pbOverwrite, setPbOverwrite] = useState(false);
  const [checkMode, setCheckMode] = useState(true);
  const [testClusterPick, setTestClusterPick] = useState('');
  const [test, setTest] = useState<{ sig: string; result: CheckMatrixItemPreviewResult } | null>(null);
  const [pendingSig, setPendingSig] = useState<string | null>(null);
  const [ackFor, setAckFor] = useState<string | null>(null);
  // 테스트 실행 로그(D-089/D-135) — 요청·대기·결과 요약·실패 사유. 상세 출력은 아래 결과 뷰의 LogViewer.
  const testLog = useRunLog();
  const [showTestLog, setShowTestLog] = useLogPref('check-matrix-item-test');

  const catalogItem = selection && selection.kind !== 'new_playbook' ? selection.item : null;
  const newPlaybookMode = selection?.kind === 'new_playbook';
  const isCustom = selection?.kind === 'custom';
  const sourceType: CheckMatrixSourceType | null = newPlaybookMode ? 'playbook' : (catalogItem?.sourceType ?? null);
  const isDeepCheck = sourceType === 'deep_check';
  const isExistingRunner = !newPlaybookMode && (sourceType === 'batch_job' || sourceType === 'playbook');
  const testable = newPlaybookMode || sourceType === 'deep_check' || sourceType === 'addon';

  const testClusterId = (testClusterPick && clusters.some((c) => c.id === testClusterPick))
    ? testClusterPick
    : (newPlaybookMode ? (pb.clusterIds[0] ?? '') : '') || clusters[0]?.id || '';
  const testOperate = useCanOperate(testClusterId || null);

  // ── 점검 선택 목록 ───────────────────────────────────────
  const q = search.trim().toLowerCase();
  const matches = (text: string | null | undefined) => !q || (text ?? '').toLowerCase().includes(q);
  const groupedItems = useMemo(() => {
    const items = (catalog?.items ?? []).filter((i) => matches(i.displayName) || matches(i.description));
    const order = [...(catalog?.execTechs ?? [])];
    for (const i of items) {
      const t = i.execTech ?? '';
      if (!order.includes(t)) order.push(t);
    }
    return order
      .map((tech) => ({ tech, items: items.filter((i) => (i.execTech ?? '') === tech) }))
      .filter((g) => g.items.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, q]);
  const creatable = (catalog?.creatable ?? []).filter((c) => matches(c.label) || matches(c.description));

  const resetForKind = (item: CheckMatrixCatalogItem | null, opts: { custom?: boolean; label?: string }) => {
    const nextAuto = {
      name: item && !opts.custom ? item.displayName : '',
      description: item?.description ?? '',
      category: item?.category ?? '',
    };
    // 사용자가 직접 고친 값은 유지하고, 자동으로 채웠던 값만 새 종류 기준으로 바꾼다.
    setName((cur) => (cur === '' || cur === autoFill.name ? nextAuto.name : cur));
    setDescription((cur) => (cur === '' || cur === autoFill.description ? nextAuto.description : cur));
    setCategory((cur) => (cur === '' || cur === autoFill.category ? nextAuto.category : cur));
    setAutoFill(nextAuto);
    setThresholdDraft(item ? fieldValuesToDraft(item.thresholdFields, item.defaultThresholdValues) : {});
    setParamDraft(item ? fieldValuesToDraft(item.paramFields, item.defaultParamValues) : {});
    setDedicated(!!opts.custom);
    setDedicatedAuto(false);
    setDedicatedUserSet(false);
    setAddonConfigRows([{ key: '', value: '' }]);
    setPbConflict(null);
  };

  const pickCatalog = (item: CheckMatrixCatalogItem) => {
    // 같은 종류를 다시 누르면(이전 단계로 돌아왔다가) 입력해 둔 값을 지우지 않는다.
    if (selectionKey(selection) === selectionKey({ kind: 'catalog', item })) return;
    setSelection({ kind: 'catalog', item });
    resetForKind(item, {});
  };

  const pickCreatable = (opt: CheckMatrixCreatableOption) => {
    if (opt.kind === 'new_playbook') {
      if (selection?.kind === 'new_playbook') return;
      setSelection({ kind: 'new_playbook' });
      resetForKind(null, {});
      return;
    }
    // custom_check — 템플릿형 점검(HTTP/kubectl/PromQL 등)의 새 인스턴스. 인스턴스마다 이름이
    // 달라야 구분되므로 종류 이름을 그대로 쓰지 않고, 설정은 항상 이 항목 전용이다.
    const target = (catalog?.items ?? []).find(
      (i) => i.sourceType === opt.sourceType && i.sourceRef === opt.sourceRef,
    );
    if (!target) {
      toast.error('이 종류를 카탈로그에서 찾지 못했습니다.', '목록을 새로 고친 뒤 다시 시도하세요.');
      return;
    }
    if (selection?.kind === 'custom' && selection.item.sourceRef === target.sourceRef) return;
    setSelection({ kind: 'custom', item: target, label: opt.label });
    resetForKind(target, { custom: true });
  };

  // ── 값 편집 — 공유 정의가 있는 종류에서 값을 고치면 자동으로 "따로 설정" 을 켠다 ──
  const onValueEdited = () => {
    if (isDeepCheck && catalogItem?.seedDefault && !isCustom && !dedicated && !dedicatedUserSet) {
      setDedicated(true);
      setDedicatedAuto(true);
    }
  };
  const editThreshold = (n: string, v: string) => { setThresholdDraft((cur) => ({ ...cur, [n]: v })); onValueEdited(); };
  const editParam = (n: string, v: string) => { setParamDraft((cur) => ({ ...cur, [n]: v })); onValueEdited(); };

  const thresholdErrs = catalogItem && isDeepCheck ? fieldErrors(catalogItem.thresholdFields, thresholdDraft) : {};
  const paramErrs = catalogItem && isDeepCheck ? fieldErrors(catalogItem.paramFields, paramDraft) : {};
  const fieldErrCount = Object.keys(thresholdErrs).length + Object.keys(paramErrs).length;

  const trimmedName = name.trim();
  const duplicateName = !!trimmedName && existingItems.some(
    (i) => i.name.trim().toLowerCase() === trimmedName.toLowerCase(),
  );

  const settingsIssues: string[] = [];
  if (!trimmedName) settingsIssues.push('이름을 입력하세요');
  if (trimmedName.length > NAME_MAX) settingsIssues.push(`이름은 ${NAME_MAX}자 이하`);
  if (fieldErrCount > 0) settingsIssues.push(`값 형식 오류 ${fieldErrCount}건`);
  if (newPlaybookMode) {
    if (!pb.name.trim()) settingsIssues.push('플레이북 이름');
    if (!pb.fileId && !pb.content.trim()) settingsIssues.push('플레이북 YAML');
    if (pb.clusterIds.length === 0) settingsIssues.push('실행할 클러스터 1개 이상');
  }

  // ── 테스트 — 결과는 "그때의 설정" 서명과 함께 보관하고, 설정이 바뀌면 자동으로 무효가 된다 ──
  const pbExtraVars = () => pb.extraVars
    .filter((r) => r.key.trim())
    .map((r) => ({ name: r.key.trim(), value: r.value }));
  const testSig = JSON.stringify({
    sel: selectionKey(selection),
    thresholdDraft, paramDraft, addonConfigRows,
    pb: newPlaybookMode ? {
      content: pb.content, tags: pb.tags, extraVars: pb.extraVars, inv: pb.inventories[testClusterId] ?? '',
    } : null,
    checkMode: newPlaybookMode ? checkMode : null,
    cluster: testClusterId,
  });
  const testResult = test && test.sig === testSig ? test.result : null;
  const testPending = previewMut.isPending && pendingSig === testSig;
  const testFailed = !!testResult && !testResult.skipped && testResult.status === 'critical';
  const acknowledged = ackFor === testSig;

  const handleTest = async () => {
    if (!testClusterId || !sourceType) return;
    if (!newPlaybookMode && !catalogItem) return;
    const sig = testSig;
    setPendingSig(sig);
    const clusterName = clusters.find((c) => c.id === testClusterId)?.name ?? testClusterId;
    const what = newPlaybookMode
      ? `새 플레이북${checkMode ? ' (--check, dry-run)' : ' (실제 적용)'}`
      : (catalogItem?.displayName ?? sourceType);
    const r = await runLogged(testLog, {
      title: '점검 항목 테스트 실행',
      first: `${what} — ${clusterName} 에서 1회 실행 요청 (저장 안 함)`,
      fn: () => (newPlaybookMode || !catalogItem
        ? previewMut.mutateAsync({
          sourceType: 'playbook',
          sourceRef: null,
          clusterId: testClusterId,
          playbookContent: pb.content,
          inventoryId: pb.inventories[testClusterId] || null,
          extraVars: pbExtraVars(),
          tags: pb.tags.trim() || null,
          checkMode,
        })
        : previewMut.mutateAsync({
          sourceType: catalogItem.sourceType,
          sourceRef: catalogItem.sourceRef,
          clusterId: testClusterId,
          thresholds: isDeepCheck ? fieldValuesToObject(catalogItem.thresholdFields, thresholdDraft) : undefined,
          params: isDeepCheck ? fieldValuesToObject(catalogItem.paramFields, paramDraft) : undefined,
          config: catalogItem.sourceType === 'addon'
            ? Object.fromEntries(addonConfigRows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]))
            : undefined,
        })),
      summarize: previewRunLines,
    });
    if (r.ok) setTest({ sig, result: r.data });
    else setTest({ sig, result: { status: 'critical', message: formatApiError(r.error, '테스트 실행 중 오류가 발생했습니다.') } });
    setPendingSig(null);
  };

  // ── 저장 ─────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (saving) return;
    if (settingsIssues.length > 0) {
      toast.error('설정을 확인하세요.', settingsIssues.join(' · '));
      setStep(1);
      return;
    }
    if (testFailed && !acknowledged) {
      toast.warning('테스트 결과가 실패입니다.', '"결과를 확인했고 그래도 저장" 을 체크해야 저장할 수 있습니다.');
      return;
    }
    const thresholds = catalogItem && isDeepCheck ? fieldValuesToObject(catalogItem.thresholdFields, thresholdDraft) : {};
    const params = catalogItem && isDeepCheck ? fieldValuesToObject(catalogItem.paramFields, paramDraft) : {};
    try {
      await createMut.mutateAsync({
        name: trimmedName,
        description: description.trim() || null,
        unit: unit.trim() || null,
        sourceType: (sourceType ?? 'manual') as CheckMatrixSourceType,
        sourceRef: newPlaybookMode
          ? pb.name.trim()
          : (!catalogItem || catalogItem.sourceType === 'manual' ? null : catalogItem.sourceRef),
        category: category.trim() || null,
        targetKey: targetKey.trim() || null,
        color: color || null,
        enabled,
        affectsClusterStatus: STATUS_OPT_IN_SOURCES.includes((sourceType ?? 'manual') as CheckMatrixSourceType) ? affectsStatus : false,
        thresholds: Object.keys(thresholds).length ? thresholds : undefined,
        params: Object.keys(params).length ? params : undefined,
        dedicatedDefinition: isDeepCheck ? dedicated : undefined,
        newPlaybook: newPlaybookMode ? {
          name: pb.name.trim(),
          content: pb.content,
          description: description.trim() || null,
          tags: pb.tags.trim() || null,
          extraVars: pbExtraVars(),
          clusterIds: pb.clusterIds,
          inventories: pb.clusterIds
            .filter((cid) => pb.inventories[cid])
            .map((cid) => ({ clusterId: cid, inventoryId: pb.inventories[cid] })),
          playbookFileId: pb.fileId || null,
          overwrite: pbOverwrite,
        } : undefined,
      });
      toast.success('항목 추가됨', trimmedName);
      onClose();
    } catch (e) {
      const msg = formatApiError(e);
      if (newPlaybookMode && isConflictError(e)) setPbConflict(msg);
      toast.error('추가 실패', msg);
    }
  };

  const canNext = step === 0 ? !!selection : step === 1 ? settingsIssues.length === 0 : false;
  const saveBlocked = saving || !canOperate || settingsIssues.length > 0 || (testFailed && !acknowledged)
    || (!!pbConflict && !pbOverwrite);

  const selectedClusters = clusters.filter((c) => pb.clusterIds.includes(c.id));

  return (
    <ModalChrome
      titleId={titleId}
      title="점검 항목 추가"
      onClose={safeClose}
      closeDisabled={saving}
      dialogRef={dialogRef}
      wide
      footer={(
        <>
          <button
            onClick={step === 0 ? safeClose : () => setStep((s) => s - 1)}
            disabled={saving}
            className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl disabled:opacity-50"
          >
            {step === 0 ? '취소' : '이전'}
          </button>
          <div className="flex items-center gap-2 min-w-0">
            {step === 1 && settingsIssues.length > 0 && (
              <span className="text-[11px] text-muted-foreground truncate" aria-live="polite">
                남은 항목: {settingsIssues.join(' · ')}
              </span>
            )}
            {step < 2 ? (
              <button
                onClick={() => setStep((s) => s + 1)}
                disabled={!canNext}
                className="px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                다음
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={saveBlocked}
                title={withHint('점검 항목 저장')}
                aria-busy={saving || undefined}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                {saving ? '저장 중…' : '저장'}
              </button>
            )}
          </div>
        </>
      )}
    >
      <StepIndicator current={step} />

      {/* ① 점검 선택 ─────────────────────────────────────── */}
      {step === 0 && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            어떤 점검을 추가할지 고르세요 — 실행 기술별로 묶여 있습니다. 목록에 없으면 아래 "직접 만들기"를 쓰세요.
          </p>
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              id={searchId}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="이름·설명으로 검색 (예: etcd, 인증서, PVC)"
              aria-label="점검 종류 검색"
              className="w-full text-sm border border-border rounded-xl pl-8 pr-3 py-2 bg-background"
            />
          </div>

          {catalogQuery.isLoading ? (
            <div className="space-y-2" aria-busy="true" aria-label="점검 종류 불러오는 중">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="block rounded-xl" height={44} width="100%" />
              ))}
            </div>
          ) : catalogQuery.isError ? (
            <div className="rounded-xl border border-status-critical/40 bg-status-critical/5 p-3 space-y-2" role="alert">
              <p className="text-sm text-status-critical inline-flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4" aria-hidden="true" /> 점검 종류 목록을 불러오지 못했습니다.
              </p>
              <p className="text-xs text-muted-foreground">{formatApiError(catalogQuery.error)}</p>
              <button
                type="button"
                onClick={() => void catalogQuery.refetch()}
                disabled={catalogQuery.isFetching}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-secondary border border-border rounded-xl hover:bg-secondary/80 disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${catalogQuery.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
                다시 시도
              </button>
            </div>
          ) : (
            <div className="space-y-3 max-h-[48vh] overflow-y-auto pr-1">
              {groupedItems.map((g) => {
                const meta = EXEC_TECH_META[g.tech];
                const Icon = meta?.icon;
                return (
                  <section key={g.tech || 'none'} aria-label={execTechLabel(g.tech)} className="space-y-1">
                    <h3 className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                      {Icon && <Icon className="w-3.5 h-3.5" aria-hidden="true" />}
                      {execTechLabel(g.tech)}
                      {meta?.hint && <span className="font-normal normal-case tracking-normal">· {meta.hint}</span>}
                    </h3>
                    {g.items.map((opt) => {
                      const selected = selection?.kind === 'catalog'
                        && catalogKey(selection.item.sourceType, selection.item.sourceRef) === catalogKey(opt.sourceType, opt.sourceRef);
                      return (
                        <button
                          key={catalogKey(opt.sourceType, opt.sourceRef)}
                          type="button"
                          onClick={() => pickCatalog(opt)}
                          onDoubleClick={() => { pickCatalog(opt); setStep(1); }}
                          aria-pressed={selected}
                          className={`w-full flex items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors ${
                            selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-secondary/50'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium truncate">{opt.displayName}</div>
                            {opt.description && (
                              <div className="text-xs text-muted-foreground truncate" title={opt.description}>{opt.description}</div>
                            )}
                          </div>
                          {(opt.sourceType === 'batch_job' || opt.sourceType === 'playbook') && (
                            <span className="flex-shrink-0 text-[11px] px-1.5 py-0.5 rounded-full border border-border text-muted-foreground">
                              {opt.sourceType === 'batch_job' ? '등록된 배치잡' : '등록된 플레이북'}
                            </span>
                          )}
                          {selected && <Check className="w-4 h-4 text-primary flex-shrink-0" aria-hidden="true" />}
                        </button>
                      );
                    })}
                  </section>
                );
              })}
              {groupedItems.length === 0 && creatable.length === 0 && (
                <p className="text-xs text-muted-foreground py-4 text-center">
                  {q ? `"${search}" 와 맞는 점검 종류가 없습니다.` : '등록된 점검 종류가 없습니다.'}
                </p>
              )}
              {creatable.length > 0 && (
                <section aria-label="직접 만들기" className="space-y-1">
                  <div className="flex items-center gap-2 pt-1">
                    <h3 className="text-[11px] font-semibold text-muted-foreground">직접 만들기</h3>
                    <span className="flex-1 h-px bg-border" aria-hidden="true" />
                  </div>
                  {creatable.map((opt) => {
                    const selected = opt.kind === 'new_playbook'
                      ? selection?.kind === 'new_playbook'
                      : selection?.kind === 'custom' && selection.item.sourceRef === opt.sourceRef;
                    return (
                      <button
                        key={`${opt.kind}:${opt.sourceRef ?? ''}`}
                        type="button"
                        onClick={() => pickCreatable(opt)}
                        aria-pressed={selected}
                        className={`w-full flex items-center gap-2 rounded-xl border border-dashed px-3 py-2 text-left transition-colors ${
                          selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-secondary/50'
                        }`}
                      >
                        {opt.kind === 'new_playbook'
                          ? <FileCode className="w-4 h-4 flex-shrink-0 text-primary" aria-hidden="true" />
                          : <Plus className="w-4 h-4 flex-shrink-0 text-primary" aria-hidden="true" />}
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium truncate">{opt.label}</div>
                          {opt.description && (
                            <div className="text-xs text-muted-foreground truncate" title={opt.description}>{opt.description}</div>
                          )}
                        </div>
                        <span className="flex-shrink-0 text-[11px] text-muted-foreground">{execTechLabel(opt.execTech)}</span>
                        {selected && <Check className="w-4 h-4 text-primary flex-shrink-0" aria-hidden="true" />}
                      </button>
                    );
                  })}
                </section>
              )}
            </div>
          )}
        </div>
      )}

      {/* ② 설정 ──────────────────────────────────────────── */}
      {step === 1 && selection && (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            선택: <span className="font-medium text-foreground">
              {selection.kind === 'new_playbook' ? '새 플레이북' : selection.kind === 'custom' ? selection.label : selection.item.displayName}
            </span>
            {sourceType && <> · {SOURCE_TYPE_LABEL[sourceType]}</>}
          </p>

          <div>
            <label htmlFor={nameId} className="text-xs font-medium text-muted-foreground mb-1 block">이름 (필수)</label>
            <input
              id={nameId}
              type="text"
              value={name}
              maxLength={NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: N/W 스위치"
              aria-describedby={nameHelpId}
              aria-invalid={!trimmedName || undefined}
              className="w-full text-sm border border-border rounded-xl px-3 py-2 bg-background"
            />
            <div id={nameHelpId} className="flex items-center justify-between gap-2 mt-1 text-[11px]">
              <span className={duplicateName ? 'text-status-warning inline-flex items-center gap-1' : 'text-muted-foreground'}>
                {duplicateName ? (
                  <><AlertTriangle className="w-3 h-3" aria-hidden="true" /> 같은 이름의 항목이 이미 있습니다 — 매트릭스에서 구분하기 어려울 수 있습니다.</>
                ) : '매트릭스 행에 표시되는 이름입니다.'}
              </span>
              <span className="text-muted-foreground tabular-nums">{trimmedName.length}/{NAME_MAX}</span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label htmlFor={descId} className="text-xs font-medium text-muted-foreground mb-1 block">설명 (선택)</label>
              <input
                id={descId}
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full text-sm border border-border rounded-xl px-3 py-2 bg-background"
              />
            </div>
            <div>
              <label htmlFor={unitId} className="text-xs font-medium text-muted-foreground mb-1 block">단위 (선택, 예: ms, %)</label>
              <input
                id={unitId}
                type="text"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                className="w-full text-sm border border-border rounded-xl px-3 py-2 bg-background"
              />
            </div>
          </div>

          {isDeepCheck && catalogItem && (
            <div className="space-y-3 rounded-xl border border-border p-3">
              <span className="text-xs font-semibold block">값 설정</span>
              {catalogItem.thresholdFields.length === 0 && catalogItem.paramFields.length === 0 && (
                <p className="text-xs text-muted-foreground">이 점검은 따로 설정할 값이 없습니다.</p>
              )}
              <FieldGroup title="임계값" fields={catalogItem.thresholdFields} draft={thresholdDraft} errors={thresholdErrs} onChange={editThreshold} />
              <FieldGroup title="파라미터" fields={catalogItem.paramFields} draft={paramDraft} errors={paramErrs} onChange={editParam} />
              <label className="flex items-start gap-2 text-xs rounded-xl bg-secondary/40 px-3 py-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={dedicated}
                  disabled={isCustom}
                  aria-describedby={dedicatedHelpId}
                  onChange={(e) => { setDedicated(e.target.checked); setDedicatedUserSet(true); setDedicatedAuto(false); }}
                />
                <span>
                  <span className="font-medium text-foreground">이 항목만 따로 설정 (다른 항목과 공유하지 않음)</span>
                  <span id={dedicatedHelpId} className="block text-muted-foreground mt-0.5">
                    {isCustom
                      ? '직접 만드는 점검은 항목마다 대상이 달라 항상 따로 설정됩니다.'
                      : catalogItem.seedDefault
                        ? '끄면 이미 등록된 같은 종류의 기본 설정을 함께 씁니다. 켜면 위 값이 이 항목에만 적용됩니다.'
                        : '켜면 위 값이 이 항목에만 적용되어, 같은 종류로 설정이 다른 항목을 여러 개 만들 수 있습니다.'}
                  </span>
                  {dedicatedAuto && (
                    <span className="block text-primary mt-0.5" aria-live="polite">
                      값을 바꿔서 자동으로 켰습니다 — 공유 중인 기본 설정은 그대로 두고 이 항목에만 적용합니다.
                    </span>
                  )}
                </span>
              </label>
            </div>
          )}

          {sourceType === 'addon' && catalogItem && (
            <div className="rounded-xl border border-border p-3">
              <span className="text-xs font-semibold mb-1 block">
                테스트용 설정 (선택{ADDON_CONFIG_HINTS[catalogItem.sourceRef ?? ''] ? ` — ${ADDON_CONFIG_HINTS[catalogItem.sourceRef ?? '']}` : ''})
              </span>
              <KeyValueRows
                rows={addonConfigRows}
                onChange={setAddonConfigRows}
                keyPlaceholder="키 (예: url)"
                labelPrefix="애드온 설정"
                addLabel="필드 추가"
              />
              <p className="text-[11px] text-muted-foreground mt-2">
                실제 클러스터별 등록(자격증명 포함)은 대시보드의 "애드온 추가"에서 별도로 합니다 —
                여기 값은 다음 단계의 테스트에만 쓰입니다.
              </p>
            </div>
          )}

          {isExistingRunner && (
            <p className="text-xs text-muted-foreground rounded-xl border border-border bg-secondary/40 px-3 py-2">
              이미 등록된 {sourceType === 'batch_job' ? '배치잡' : '플레이북'}을 이름으로 연결합니다 — 실행 내용과
              자격증명은 {sourceType === 'batch_job' ? '/batch-jobs' : '/playbooks'} 화면에서 관리합니다.
            </p>
          )}

          {newPlaybookMode && (
            <PlaybookEditor
              value={pb}
              onChange={(patch) => { setPb((cur) => ({ ...cur, ...patch })); if (patch.name !== undefined) setPbConflict(null); }}
              clusters={clusters}
              playbookFiles={playbookFiles}
            />
          )}

          {STATUS_OPT_IN_SOURCES.includes((sourceType ?? 'manual') as CheckMatrixSourceType) && (
            <ClusterStatusOptIn checked={affectsStatus} onChange={setAffectsStatus} />
          )}

          <AdvancedSection
            category={category} onCategory={setCategory}
            targetKey={targetKey} onTargetKey={setTargetKey}
            color={color} onColor={setColor}
          />
        </div>
      )}

      {/* ③ 테스트 · 저장 ─────────────────────────────────── */}
      {step === 2 && selection && (
        <div className="space-y-4">
          {testable ? (
            <section className="space-y-3 rounded-xl border border-border p-3" aria-label="테스트 (선택)">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold">테스트 (선택)</span>
                <span className="text-[11px] text-muted-foreground">아무것도 저장되지 않습니다</span>
              </div>
              <p className="text-xs text-muted-foreground">
                저장 전에 실제 클러스터에서 지금 설정으로 1회 실행해 결과와 상세 로그를 확인합니다.
              </p>
              {clusters.length === 0 ? (
                <p className="text-xs text-status-warning">등록된 클러스터가 없어 테스트할 수 없습니다 — 바로 저장할 수 있습니다.</p>
              ) : (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex-1 min-w-[12rem]">
                    <label htmlFor={clusterFieldId} className="text-xs font-medium text-muted-foreground mb-1 block">테스트할 클러스터</label>
                    <select
                      id={clusterFieldId}
                      value={testClusterId}
                      onChange={(e) => setTestClusterPick(e.target.value)}
                      className="w-full text-sm border border-border rounded-xl px-3 py-2 bg-background"
                    >
                      {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <button
                    type="button"
                    onClick={handleTest}
                    disabled={!testClusterId || previewMut.isPending || !testOperate.canOperate}
                    title={testOperate.withHint('선택한 클러스터에서 1회 테스트 실행')}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {previewMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <PlayCircle className="w-4 h-4" aria-hidden="true" />}
                    {previewMut.isPending ? '실행 중…' : '테스트 실행'}
                  </button>
                  {!testResult && !testPending && (
                    <button
                      type="button"
                      onClick={handleSubmit}
                      disabled={saveBlocked}
                      title={withHint('테스트 없이 바로 저장')}
                      className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground rounded-xl disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      건너뛰고 저장
                    </button>
                  )}
                </div>
              )}
              {newPlaybookMode && (
                <label className="flex items-start gap-2 text-xs rounded-xl bg-secondary/40 px-3 py-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={checkMode}
                    disabled={!isAdmin && checkMode}
                    title={!isAdmin && checkMode ? '실제 적용 테스트(--check 해제)는 admin 만 가능합니다' : undefined}
                    onChange={(e) => setCheckMode(e.target.checked)}
                  />
                  <span>
                    <span className="font-medium text-foreground">점검 모드로 테스트 (ansible --check, dry-run)</span> — 실제 변경 없이
                    결과만 확인합니다.
                    {!isAdmin && <span className="block text-muted-foreground mt-0.5">끄고 실제로 적용해 보는 테스트는 admin 만 할 수 있습니다.</span>}
                    {!checkMode && <span className="block text-status-critical mt-0.5">점검 모드가 꺼져 있습니다 — 테스트가 클러스터에 실제로 적용됩니다.</span>}
                  </span>
                </label>
              )}
              <RunLogPanel run={testLog} show={showTestLog} onShowChange={setShowTestLog} maxHeight="max-h-56" />
              <PreviewResultView result={testResult} pending={testPending} />
              {testFailed && (
                <label className="flex items-start gap-2 text-xs rounded-xl border border-status-critical/40 bg-status-critical/5 px-3 py-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={acknowledged}
                    onChange={(e) => setAckFor(e.target.checked ? testSig : null)}
                  />
                  <span>
                    <span className="font-medium text-foreground">결과를 확인했고 그래도 저장</span> — 테스트가 실패했습니다.
                    설정이 맞는지 다시 확인하세요. 저장하면 이 항목은 매트릭스에서 실패로 표시될 수 있습니다.
                  </span>
                </label>
              )}
            </section>
          ) : (
            <p className="text-xs text-muted-foreground rounded-xl border border-border bg-secondary/40 px-3 py-2">
              {isExistingRunner
                ? `이미 등록된 ${sourceType === 'batch_job' ? '배치잡' : '플레이북'}은 안전상 저장 전 테스트로 실행하지 않습니다 — 저장 후 매트릭스 셀이나 항목 상세의 실행(재생 아이콘) 버튼으로 실행하면 실시간 로그로 결과를 볼 수 있습니다.`
                : '수동 입력 항목은 자동 실행이 없어 테스트할 것이 없습니다 — 저장 후 매트릭스 셀에서 값을 직접 기록합니다.'}
            </p>
          )}

          {newPlaybookMode && (
            <p className="text-xs rounded-xl border border-status-warning/40 bg-status-warning/5 px-3 py-2 inline-flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-status-warning" aria-hidden="true" />
              <span>
                테스트는 기본이 dry-run(--check)입니다. <span className="font-medium">저장 후 실행은 --check 없이 실제로 적용됩니다</span> —
                예약(cron)·수동 실행 모두 선택한 클러스터에 그대로 반영되니 플레이북 내용을 다시 확인하세요.
              </span>
            </p>
          )}

          {pbConflict && newPlaybookMode && (
            <div className="rounded-xl border border-status-critical/40 bg-status-critical/5 px-3 py-2 space-y-1.5" role="alert">
              <p className="text-xs text-status-critical">{pbConflict}</p>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={pbOverwrite} onChange={(e) => setPbOverwrite(e.target.checked)} />
                덮어쓰기 — 라이브러리의 같은 이름 플레이북 파일을 이 내용으로 바꿉니다.
              </label>
            </div>
          )}

          <section className="rounded-xl border border-border bg-secondary/30 p-3 space-y-1 text-xs" aria-label="저장 요약">
            <div className="text-[11px] font-semibold text-muted-foreground mb-1">저장 요약</div>
            <div><span className="text-muted-foreground">이름</span> · {trimmedName || '(미입력)'}</div>
            <div>
              <span className="text-muted-foreground">점검</span> ·{' '}
              {newPlaybookMode
                ? `Ansible · 새 플레이북 «${pb.name.trim() || '(이름 없음)'}»`
                : catalogItem ? `${execTechLabel(catalogItem.execTech)} · ${catalogItem.displayName}` : '—'}
            </div>
            {newPlaybookMode && (
              <div>
                <span className="text-muted-foreground">대상 클러스터</span> ·{' '}
                {selectedClusters.map((c) => c.name).join(', ') || '(선택 없음)'}
              </div>
            )}
            {isDeepCheck && (
              <div><span className="text-muted-foreground">설정</span> · {dedicated ? '이 항목만 따로' : '같은 종류의 항목과 공유'}</div>
            )}
            {category && <div><span className="text-muted-foreground">영역</span> · {category}</div>}
            {targetKey && <div><span className="text-muted-foreground">묶을 대상</span> · {targetKey}</div>}
            <div>
              <span className="text-muted-foreground">테스트</span> ·{' '}
              {!testable ? '해당 없음' : testResult ? (testResult.skipped ? '실행 안 함' : testResult.status) : '건너뜀'}
            </div>
          </section>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            그리드에 표시
          </label>
        </div>
      )}
    </ModalChrome>
  );
}
