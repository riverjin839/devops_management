import { useEffect, useMemo, useState } from 'react';
import { FlaskConical, Play, Save, X } from 'lucide-react';
import { ExecutionStepsTimeline } from '@/components/daily-check/ExecutionStepsTimeline';
import {
  useCheckTypes,
  usePreviewCheck,
  useTestDefinition,
} from '@/hooks/useDeepCheckDefinitions';
import type {
  DeepCheckDefinition,
  DeepCheckDefinitionInput,
  DeepCheckFieldSpec,
  DeepCheckTestResult,
  DeepCheckTypeSchema,
} from '@/types';

interface Props {
  initial?: DeepCheckDefinition;
  clusterId?: string;
  onSubmit: (body: DeepCheckDefinitionInput) => Promise<void> | void;
  onCancel?: () => void;
}

const CRON_PRESETS: { label: string; value: string }[] = [
  { label: '매트릭스 스케줄 사용 (비움)', value: '' },
  { label: '5분마다', value: '*/5 * * * *' },
  { label: '15분마다', value: '*/15 * * * *' },
  { label: '30분마다', value: '*/30 * * * *' },
  { label: '매시 정각', value: '0 * * * *' },
  { label: '매일 09:00', value: '0 9 * * *' },
  { label: '매일 09/13/18시', value: '0 9,13,18 * * *' },
];

function toSnake(str: string): string {
  return str.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`);
}

/**
 * axios 응답 인터셉터가 thresholds/params 의 키까지 camelCase 로 바꿔버리므로
 * (warning_days → warningDays) 스키마 필드명(snake_case)으로 되돌려 맞춘다.
 * 이 정규화가 없으면 편집 폼이 저장된 값을 보여주지 못한다.
 */
function normalizeValues(
  fields: DeepCheckFieldSpec[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: Record<string, any> | null | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Record<string, any> = {};
  const source = raw ?? {};
  const camelToSnake = Object.fromEntries(
    Object.entries(source).map(([k, v]) => [toSnake(k), v]),
  );
  for (const f of fields) {
    const v = source[f.name] ?? camelToSnake[f.name];
    if (v !== undefined) out[f.name] = v;
  }
  // 스키마에 없는 (사용자 정의) 키도 보존
  for (const [k, v] of Object.entries(camelToSnake)) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function coerceValue(spec: DeepCheckFieldSpec, raw: any): any {
  if (raw === '' || raw === null || raw === undefined) return null;
  switch (spec.type) {
    case 'int':
      return parseInt(String(raw), 10);
    case 'float':
      return parseFloat(String(raw));
    case 'boolean':
      return raw === true || raw === 'true';
    case 'list':
      return Array.isArray(raw)
        ? raw
        : String(raw)
            .split(/\n|,/)
            .map((s) => s.trim())
            .filter(Boolean);
    default:
      return String(raw);
  }
}

/** 라벨의 "(a|b|c)" 패턴에서 select 옵션 추출 — 예: "비교 방향 (gte|lte)" */
function enumOptionsFromLabel(label: string): string[] | null {
  const m = label.match(/\(([\w-]+(?:\|[\w-]+)+)\)/);
  return m ? m[1].split('|') : null;
}

export function DeepCheckDefinitionForm({
  initial,
  clusterId,
  onSubmit,
  onCancel,
}: Props) {
  const { data: schemas } = useCheckTypes();
  const testMut = useTestDefinition();
  const previewMut = usePreviewCheck();

  const [checkType, setCheckType] = useState(initial?.checkType ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [scheduleCron, setScheduleCron] = useState(initial?.scheduleCron ?? '');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [thresholds, setThresholds] = useState<Record<string, any>>({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [params, setParams] = useState<Record<string, any>>({});
  const [testResult, setTestResult] = useState<DeepCheckTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const schema = useMemo<DeepCheckTypeSchema | undefined>(
    () => schemas?.find((s) => s.checkType === checkType),
    [schemas, checkType],
  );

  // 편집 모드: 스키마 로드 후 저장값을 필드명(snake_case)으로 정규화해 채운다.
  useEffect(() => {
    if (!initial || !schema) return;
    setThresholds(normalizeValues(schema.thresholdFields, initial.thresholds));
    setParams(normalizeValues(schema.paramFields, initial.params));
  }, [initial, schema]);

  // 신규 모드: checkType 선택 시 기본값 채움.
  useEffect(() => {
    if (initial) return;
    if (!schema) return;
    setName((cur) => cur || schema.displayName);
    setDescription((cur) => cur || schema.description);
    setThresholds(normalizeValues(schema.thresholdFields, schema.defaultThresholds));
    setParams(normalizeValues(schema.paramFields, schema.defaultParams));
  }, [schema, initial]);

  const buildBody = (): DeepCheckDefinitionInput => ({
    clusterId: clusterId || initial?.clusterId || null,
    checkType,
    name: name || schema?.displayName || checkType,
    description: description || null,
    enabled,
    scheduleCron: scheduleCron || null,
    thresholds,
    params,
    sortOrder: initial?.sortOrder ?? 0,
  });

  const handleSubmit = async () => {
    setSaving(true);
    try {
      await onSubmit(buildBody());
    } finally {
      setSaving(false);
    }
  };

  /** 저장 전에도 현재 폼 값 그대로 ad-hoc 실행해 미리 확인. */
  const handlePreview = async () => {
    setTestError(null);
    try {
      const { data } = await previewMut.mutateAsync({
        checkType,
        clusterId: clusterId || initial?.clusterId || null,
        thresholds,
        params,
      });
      setTestResult(data);
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setTestError(String((e as any)?.response?.data?.detail ?? e));
    }
  };

  const handleTest = async () => {
    if (!initial) return handlePreview();
    setTestError(null);
    try {
      const { data } = await testMut.mutateAsync({ id: initial.id, clusterId });
      setTestResult(data);
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setTestError(String((e as any)?.response?.data?.detail ?? e));
    }
  };

  const customTypes = schemas?.filter((s) => s.seedDefault === false) ?? [];
  const builtinTypes = schemas?.filter((s) => s.seedDefault !== false) ?? [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Check Type">
          <select
            value={checkType}
            onChange={(e) => setCheckType(e.target.value)}
            disabled={!!initial}
            className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm disabled:opacity-60"
          >
            <option value="">선택…</option>
            {customTypes.length > 0 && (
              <optgroup label="커스텀 (UI 에서 직접 정의)">
                {customTypes.map((s) => (
                  <option key={s.checkType} value={s.checkType}>
                    {s.displayName} ({s.checkType})
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="내장 체커">
              {builtinTypes.map((s) => (
                <option key={s.checkType} value={s.checkType}>
                  {s.displayName} ({s.checkType})
                </option>
              ))}
            </optgroup>
          </select>
          {schema?.description && (
            <div className="text-xs text-muted-foreground mt-1">{schema.description}</div>
          )}
        </Field>
        <Field label="이름">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm"
            placeholder="예: 인증서 만료 (prod)"
          />
        </Field>
      </div>

      <Field label="설명">
        <textarea
          value={description ?? ''}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm resize-y"
        />
      </Field>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="활성">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span>이 정의를 활성화</span>
          </label>
        </Field>
        <Field label="스케줄 cron (선택 — 정의별 단독 실행)">
          <div className="flex gap-2">
            <select
              value={CRON_PRESETS.some((p) => p.value === (scheduleCron ?? '')) ? scheduleCron ?? '' : '__custom__'}
              onChange={(e) => {
                if (e.target.value !== '__custom__') setScheduleCron(e.target.value);
              }}
              className="rounded-xl border border-border bg-card px-2 py-2 text-sm"
            >
              {CRON_PRESETS.map((p) => (
                <option key={p.label} value={p.value}>
                  {p.label}
                </option>
              ))}
              <option value="__custom__">직접 입력…</option>
            </select>
            <input
              value={scheduleCron ?? ''}
              onChange={(e) => setScheduleCron(e.target.value)}
              placeholder="예: */30 * * * * (비우면 매트릭스 스케줄만)"
              className="flex-1 rounded-xl border border-border bg-card px-3 py-2 text-sm font-mono"
            />
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            지정 시 디스패처가 이 정의만 해당 주기로 자동 실행합니다 (최소 5분 간격, 글로벌 정의는 전체 클러스터 대상).
          </div>
        </Field>
      </div>

      {schema && (
        <>
          <FieldGroup title="임계값" fields={schema.thresholdFields} values={thresholds} onChange={setThresholds} />
          <FieldGroup title="파라미터" fields={schema.paramFields} values={params} onChange={setParams} />
        </>
      )}

      {testError && (
        <div className="rounded-xl border border-red-300 bg-red-500/10 p-3 text-sm text-red-600 break-words">
          실행 실패: {testError}
        </div>
      )}

      {testResult && (
        <div className="space-y-2">
          <ExecutionStepsTimeline stepPlan={testResult.stepPlan} steps={testResult.steps} />
          <div className="rounded-xl border border-border bg-muted/30 p-3 text-sm space-y-1">
            <div className="font-semibold">
              실행 결과: {testResult.status}
              {testResult.durationMs != null && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {testResult.durationMs}ms
                </span>
              )}
            </div>
            <div className="text-muted-foreground break-words">{testResult.message}</div>
            {testResult.details && (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-muted-foreground">상세(JSON)</summary>
                <pre className="mt-1 rounded bg-muted p-2 overflow-x-auto max-h-48 text-xs">
                  {JSON.stringify(testResult.details, null, 2)}
                </pre>
              </details>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={handlePreview}
          disabled={!checkType || previewMut.isPending}
          title="현재 폼 값 그대로 저장 없이 1회 실행"
          className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        >
          <FlaskConical className="w-3.5 h-3.5" />
          미리 실행
        </button>
        {initial && (
          <button
            type="button"
            onClick={handleTest}
            disabled={testMut.isPending}
            title="저장된 정의 값으로 1회 실행 (기록 없음)"
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" />
            Test now
          </button>
        )}
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
          >
            <X className="w-3.5 h-3.5" />
            취소
          </button>
        )}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!checkType || saving}
          className="inline-flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          <Save className="w-3.5 h-3.5" />
          저장
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

function FieldInput({
  spec,
  value,
  onChange,
}: {
  spec: DeepCheckFieldSpec;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onChange: (v: any) => void;
}) {
  if (spec.type === 'boolean') {
    return (
      <label className="inline-flex items-center gap-2 text-sm py-2">
        <input
          type="checkbox"
          checked={value === true || value === 'true'}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="text-muted-foreground">사용</span>
      </label>
    );
  }
  if (spec.type === 'list') {
    const text = Array.isArray(value) ? value.join('\n') : String(value ?? '');
    return (
      <textarea
        value={text}
        rows={Math.min(Math.max(2, (Array.isArray(value) ? value.length : 1) + 1), 6)}
        placeholder={Array.isArray(spec.default) ? spec.default.join('\n') : '한 줄에 하나씩'}
        onChange={(e) => onChange(coerceValue(spec, e.target.value))}
        className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm font-mono resize-y"
      />
    );
  }
  const enumOptions = spec.type === 'string' ? enumOptionsFromLabel(spec.label) : null;
  if (enumOptions) {
    return (
      <select
        value={String(value ?? spec.default ?? '')}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm"
      >
        {enumOptions.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      type={spec.type === 'int' || spec.type === 'float' ? 'number' : 'text'}
      step={spec.type === 'float' ? '0.01' : '1'}
      value={value ?? ''}
      placeholder={String(spec.default ?? '')}
      onChange={(e) => onChange(coerceValue(spec, e.target.value))}
      className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm"
    />
  );
}

function FieldGroup({
  title,
  fields,
  values,
  onChange,
}: {
  title: string;
  fields: DeepCheckFieldSpec[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  values: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onChange: (next: Record<string, any>) => void;
}) {
  if (fields.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-card/50 p-3 space-y-2">
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {fields.map((f) => (
          <Field key={f.name} label={f.label}>
            <FieldInput
              spec={f}
              value={values[f.name]}
              onChange={(v) => onChange({ ...values, [f.name]: v })}
            />
            {f.help && <div className="text-xs text-muted-foreground">{f.help}</div>}
          </Field>
        ))}
      </div>
    </div>
  );
}
