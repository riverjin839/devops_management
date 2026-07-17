import { useEffect, useMemo, useState } from 'react';
import { Play, Save, X } from 'lucide-react';
import { ExecutionStepsTimeline } from '@/components/daily-check/ExecutionStepsTimeline';
import { useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import { useCheckTypes, useTestDefinition } from '@/hooks/useDeepCheckDefinitions';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function coerceValue(spec: DeepCheckFieldSpec, raw: any): any {
  if (raw === '' || raw === null || raw === undefined) return null;
  switch (spec.type) {
    case 'int': {
      const n = parseInt(String(raw), 10);
      return Number.isNaN(n) ? null : n; // 잘못된 입력은 조용히 유실되지 않고 null
    }
    case 'float': {
      const n = parseFloat(String(raw));
      return Number.isNaN(n) ? null : n;
    }
    case 'boolean':
      return raw === true || raw === 'true';
    case 'list':
      // 줄바꿈 또는 콤마 구분 모두 허용(endpoints 등은 줄바꿈이 자연스러움).
      return Array.isArray(raw)
        ? raw
        : String(raw)
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
    default:
      return String(raw);
  }
}

/** list 값(배열)을 textarea 표시용 문자열로 — 줄바꿈 구분. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function listToText(v: any): string {
  if (Array.isArray(v)) return v.join('\n');
  return v == null ? '' : String(v);
}

export function DeepCheckDefinitionForm({
  initial,
  clusterId,
  onSubmit,
  onCancel,
}: Props) {
  const { data: schemas } = useCheckTypes();
  const testMut = useTestDefinition();
  const toast = useToast();

  const [checkType, setCheckType] = useState(initial?.checkType ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [scheduleCron, setScheduleCron] = useState(initial?.scheduleCron ?? '');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [thresholds, setThresholds] = useState<Record<string, any>>(
    initial?.thresholds ?? {}
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [params, setParams] = useState<Record<string, any>>(initial?.params ?? {});
  const [testResult, setTestResult] = useState<DeepCheckTestResult | null>(null);
  const [saving, setSaving] = useState(false);

  const schema = useMemo<DeepCheckTypeSchema | undefined>(
    () => schemas?.find((s) => s.checkType === checkType),
    [schemas, checkType],
  );

  // checkType 바뀔 때 기본값으로 채우기 (신규 모드일 때만)
  useEffect(() => {
    if (initial) return;
    if (!schema) return;
    setName((cur) => cur || schema.displayName);
    setDescription((cur) => cur || schema.description);
    setThresholds({ ...schema.defaultThresholds });
    setParams({ ...schema.defaultParams });
  }, [schema, initial]);

  const handleSubmit = async () => {
    setSaving(true);
    try {
      await onSubmit({
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
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!initial) {
      setTestResult({
        definitionId: '',
        checkType,
        status: 'pending',
        message: '먼저 저장 후 Test 가능합니다.',
        durationMs: 0,
      });
      return;
    }
    try {
      const { data } = await testMut.mutateAsync({ id: initial.id, clusterId });
      setTestResult(data);
    } catch (e) {
      const msg = formatApiError(e);
      toast.error('Test 실행 실패', msg);
      setTestResult({
        definitionId: initial.id,
        checkType,
        status: 'pending',
        message: `Test 실행 실패: ${msg}`,
        durationMs: 0,
      });
    }
  };

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
            {schemas?.map((s) => (
              <option key={s.checkType} value={s.checkType}>
                {s.displayName} ({s.checkType})
              </option>
            ))}
          </select>
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
        <Field label="스케줄 cron (선택)">
          <input
            value={scheduleCron ?? ''}
            onChange={(e) => setScheduleCron(e.target.value)}
            placeholder="예: */30 * * * * (비우면 기본 09:15/13:15/18:15)"
            className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm font-mono"
          />
          <div className="text-xs text-muted-foreground">
            표준 5필드 cron (분 시 일 월 요일). 최소 실행 간격은 5분입니다.
          </div>
        </Field>
      </div>

      {schema && (
        <>
          <FieldGroup title="임계값" fields={schema.thresholdFields} values={thresholds} onChange={setThresholds} />
          <FieldGroup title="파라미터" fields={schema.paramFields} values={params} onChange={setParams} />
        </>
      )}

      {testResult && (
        <div className="space-y-2">
          <ExecutionStepsTimeline stepPlan={testResult.stepPlan} steps={testResult.steps} />
          <div className="rounded-xl border border-border bg-muted/30 p-3 text-sm space-y-1">
            <div className="font-semibold">Test 결과: {testResult.status}</div>
            <div className="text-muted-foreground break-words">{testResult.message}</div>
            {testResult.details && (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-muted-foreground">상세(JSON)</summary>
                <pre className="mt-1 rounded bg-muted p-2 overflow-x-auto max-h-48">
                  {JSON.stringify(testResult.details, null, 2)}
                </pre>
              </details>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-2">
        {initial && (
          <button
            type="button"
            onClick={handleTest}
            disabled={testMut.isPending}
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
            {f.type === 'boolean' ? (
              <label className="inline-flex items-center gap-2 text-sm py-1.5">
                <input
                  type="checkbox"
                  checked={values[f.name] === true || values[f.name] === 'true'}
                  onChange={(e) => onChange({ ...values, [f.name]: e.target.checked })}
                  className="accent-primary"
                />
                <span className="text-muted-foreground">
                  {values[f.name] === true || values[f.name] === 'true' ? '켜짐' : '꺼짐'}
                </span>
              </label>
            ) : f.type === 'list' ? (
              <textarea
                rows={3}
                value={listToText(values[f.name])}
                placeholder={Array.isArray(f.default) ? f.default.join('\n') : '한 줄에 하나씩'}
                onChange={(e) => onChange({ ...values, [f.name]: coerceValue(f, e.target.value) })}
                className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm font-mono resize-y"
              />
            ) : (
              <input
                type={f.type === 'int' || f.type === 'float' ? 'number' : 'text'}
                step={f.type === 'float' ? '0.01' : '1'}
                value={values[f.name] ?? ''}
                placeholder={String(f.default ?? '')}
                onChange={(e) =>
                  onChange({ ...values, [f.name]: coerceValue(f, e.target.value) })
                }
                className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm"
              />
            )}
            {f.help && <div className="text-xs text-muted-foreground">{f.help}</div>}
            {f.type === 'list' && (
              <div className="text-xs text-muted-foreground">줄바꿈 또는 콤마로 여러 개 입력</div>
            )}
          </Field>
        ))}
      </div>
    </div>
  );
}
