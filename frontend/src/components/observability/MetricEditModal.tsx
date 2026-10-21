import { useEffect, useId, useState } from 'react';
import { Search, Trash2, X } from 'lucide-react';
import { ConfirmDialog, useToast } from '@/components/common';
import { useModalA11y } from '@/components/common/useModalA11y';
import { useCanOperate } from '@/hooks/useCanOperate';
import {
  useCreateMetric, useDeleteMetric, usePreviewMetric, useUpdateMetric,
} from '@/hooks/useObservability';
import type {
  LabelPair, ObservabilityMetric, ObservabilityMetricInput, ObservabilityPreviewResult, ObservabilityPreviewSample,
} from '@/types';
import { formatApiError } from '@/lib/utils';
import { formatMetricValue, labelsSummary } from './shared';

interface MetricEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  moduleKey: string;
  /** null = 새 지표 추가 */
  editing: ObservabilityMetric | null;
  /** 미리 조회 대상 클러스터 — 없으면 미리 조회 비활성. */
  clusterId?: string | null;
}

const DISPLAY_TYPES = [
  { value: 'value', label: '숫자', hint: '일반 수치 (rate, count 등)' },
  { value: 'bool', label: '가동 여부', hint: '1=가동 / 0=중단' },
  { value: 'ratio', label: '비율(%)', hint: '0~100 백분율' },
  { value: 'bytes', label: '바이트', hint: 'KB/MB/GB 자동 환산' },
  { value: 'duration', label: '시간(초)', hint: 'ms/s/m/h 자동 환산' },
];

const CATEGORY_SUGGESTIONS = ['prometheus', 'alertmanager', 'exporter', 'operator', 'rules', 'general'];

const EMPTY: ObservabilityMetricInput = {
  moduleKey: '',
  key: '',
  label: '',
  category: 'general',
  promql: '',
  unit: '',
  displayType: 'value',
  thresholds: '',
  invert: false,
  help: '',
  docUrl: '',
  sortOrder: 999,
  enabled: true,
};

/**
 * 지표 정의 편집 — UI-First 원칙(CLAUDE.md)의 핵심 진입점.
 * PromQL·임계값·표시 형식이 전부 DB 행이라, 현장 환경이 달라도 코드 수정 없이 여기서 맞춘다.
 */
export function MetricEditModal({ isOpen, onClose, moduleKey, editing, clusterId }: MetricEditModalProps) {
  const toast = useToast();
  const formId = useId();
  const dialogRef = useModalA11y(isOpen, onClose);
  const { canOperate, withHint, ariaWithHint } = useCanOperate();

  const createMetric = useCreateMetric();
  const updateMetric = useUpdateMetric();
  const deleteMetric = useDeleteMetric();
  const preview = usePreviewMetric();

  const [form, setForm] = useState<ObservabilityMetricInput>(EMPTY);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [previewResult, setPreviewResult] = useState<ObservabilityPreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const resetPreview = preview.reset;

  useEffect(() => {
    if (!isOpen) return;
    setConfirmDelete(false);
    setPreviewResult(null);
    setPreviewError(null);
    resetPreview();
    if (editing) {
      setForm({
        moduleKey: editing.moduleKey,
        key: editing.key,
        label: editing.label,
        category: editing.category,
        promql: editing.promql,
        unit: editing.unit,
        displayType: editing.displayType,
        thresholds: editing.thresholds ?? '',
        invert: editing.invert,
        help: editing.help ?? '',
        docUrl: editing.docUrl ?? '',
        sortOrder: editing.sortOrder,
        enabled: editing.enabled,
      });
    } else {
      setForm({ ...EMPTY, moduleKey });
    }
  }, [isOpen, editing, moduleKey, resetPreview]);

  if (!isOpen) return null;

  const set = <K extends keyof ObservabilityMetricInput>(key: K, value: ObservabilityMetricInput[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const busy = createMetric.isPending || updateMetric.isPending || deleteMetric.isPending;
  const previewDisabledReason = !clusterId
    ? '클러스터를 선택하면 미리 조회할 수 있습니다'
    : !form.promql.trim()
      ? 'PromQL 을 입력하세요'
      : undefined;

  const handleSubmit = async () => {
    if (!form.key.trim() || !form.label.trim() || !form.promql.trim()) {
      toast.error('키 · 이름 · PromQL 은 필수입니다.');
      return;
    }
    try {
      if (editing) {
        await updateMetric.mutateAsync({ id: editing.id, data: form });
        toast.success('지표 수정됨');
      } else {
        await createMetric.mutateAsync(form);
        toast.success('지표 추가됨');
      }
      onClose();
    } catch (err) {
      toast.error(formatApiError(err, '지표 저장 실패'));
    }
  };

  const handleDelete = async () => {
    if (!editing) return;
    try {
      await deleteMetric.mutateAsync(editing.id);
      toast.success('지표 삭제됨');
      setConfirmDelete(false);
      onClose();
    } catch (err) {
      setConfirmDelete(false);
      toast.error(formatApiError(err, '지표 삭제 실패'));
    }
  };

  // 저장 전 PromQL 시험 — 조회일 뿐이라 실행 로그 대신 결과를 인라인으로 보여준다(§12.9.1 예외 ①).
  const handlePreview = async () => {
    if (!clusterId || !form.promql.trim()) return;
    setPreviewResult(null);
    setPreviewError(null);
    try {
      setPreviewResult(await preview.mutateAsync({ clusterId, query: form.promql.trim() }));
    } catch (err) {
      setPreviewError(err);
    }
  };

  const label = 'block text-xs font-medium text-muted-foreground mb-1';
  const input = 'w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm '
    + 'focus:outline-none focus:ring-2 focus:ring-primary/40';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${formId}-title`}
        className="bg-card border border-border rounded-md shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-card z-10">
          <h2 id={`${formId}-title`} className="text-lg font-semibold">
            {editing ? '지표 수정' : '지표 추가'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            title="닫기"
            className="p-1 hover:bg-secondary rounded-xl transition-colors"
          >
            <X className="w-5 h-5" aria-hidden />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            지표는 <b className="text-foreground">PromQL 한 줄</b>로 정의됩니다. 배포마다 job 라벨이
            달라 기본값이 안 맞으면 여기서 표현식을 고치세요 — 코드 수정 없이 즉시 반영됩니다.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor={`${formId}-key`}>키 (모듈 내 고유)</label>
              <input
                id={`${formId}-key`} className={`${input} font-mono`} value={form.key}
                disabled={!!editing}
                onChange={(e) => set('key', e.target.value)}
                placeholder="prometheus_up"
              />
            </div>
            <div>
              <label className={label} htmlFor={`${formId}-label`}>이름</label>
              <input
                id={`${formId}-label`} className={input} value={form.label}
                onChange={(e) => set('label', e.target.value)}
                placeholder="Prometheus 기동"
              />
            </div>
          </div>

          <div>
            <div className="flex items-end justify-between gap-2 mb-1">
              <label className="block text-xs font-medium text-muted-foreground" htmlFor={`${formId}-promql`}>
                PromQL
              </label>
              <button
                type="button"
                onClick={() => void handlePreview()}
                disabled={!canOperate || !!previewDisabledReason || preview.isPending}
                title={withHint(previewDisabledReason ?? '선택한 클러스터의 Prometheus 에 이 표현식을 조회해 봅니다 (저장하지 않음)')}
                aria-label={ariaWithHint('미리 조회')}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl text-xs bg-secondary text-foreground border border-border hover:bg-secondary/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Search className="w-3.5 h-3.5" aria-hidden />
                {preview.isPending ? '조회 중…' : '미리 조회'}
              </button>
            </div>
            <textarea
              id={`${formId}-promql`} className={`${input} font-mono min-h-[5rem]`} value={form.promql}
              onChange={(e) => set('promql', e.target.value)}
              placeholder='min(up{job=~".*prometheus.*"})'
            />
            <PreviewResult
              result={previewResult}
              error={previewError}
              displayType={form.displayType}
              unit={form.unit}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className={label} htmlFor={`${formId}-category`}>카테고리</label>
              <input
                id={`${formId}-category`} className={input} value={form.category}
                list={`${formId}-categories`}
                onChange={(e) => set('category', e.target.value)}
              />
              <datalist id={`${formId}-categories`}>
                {CATEGORY_SUGGESTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </datalist>
            </div>
            <div>
              <label className={label} htmlFor={`${formId}-display`}>표시 형식</label>
              <select
                id={`${formId}-display`} className={input} value={form.displayType}
                onChange={(e) => set('displayType', e.target.value)}
              >
                {DISPLAY_TYPES.map((d) => (
                  <option key={d.value} value={d.value}>{d.label} — {d.hint}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={label} htmlFor={`${formId}-unit`}>단위</label>
              <input
                id={`${formId}-unit`} className={input} value={form.unit}
                onChange={(e) => set('unit', e.target.value)}
                placeholder="count, %, /s …"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor={`${formId}-thresholds`}>임계값</label>
              <input
                id={`${formId}-thresholds`} className={`${input} font-mono`} value={form.thresholds ?? ''}
                onChange={(e) => set('thresholds', e.target.value)}
                placeholder="warning:70,critical:90"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                비우면 항상 정상으로 표시되는 정보성 지표가 됩니다.
              </p>
            </div>
            <div className="flex flex-col justify-center gap-2 pt-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox" checked={form.invert}
                  onChange={(e) => set('invert', e.target.checked)}
                  className="rounded"
                />
                값이 <b>낮을수록</b> 나쁨 (up 처럼 0 이 장애)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox" checked={form.enabled}
                  onChange={(e) => set('enabled', e.target.checked)}
                  className="rounded"
                />
                사용 (끄면 조회하지 않음 — 표 아래 &apos;사용 안 함&apos;에서 다시 켤 수 있음)
              </label>
            </div>
          </div>

          <div>
            <label className={label} htmlFor={`${formId}-help`}>설명 (운영자에게 보이는 도움말)</label>
            <textarea
              id={`${formId}-help`} className={`${input} min-h-[3.5rem]`} value={form.help ?? ''}
              onChange={(e) => set('help', e.target.value)}
              placeholder="0 이면 마지막 설정 적용이 실패한 상태 — rule 문법 오류를 의심한다."
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor={`${formId}-doc`}>참고 문서 URL</label>
              <input
                id={`${formId}-doc`} className={input} value={form.docUrl ?? ''}
                onChange={(e) => set('docUrl', e.target.value)}
                placeholder="https://…"
              />
            </div>
            <div>
              <label className={label} htmlFor={`${formId}-order`}>정렬 순서</label>
              <input
                id={`${formId}-order`} type="number" className={input} value={form.sortOrder}
                onChange={(e) => set('sortOrder', Number(e.target.value) || 0)}
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-border sticky bottom-0 bg-card">
          {editing ? (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={!canOperate || busy}
              title={withHint('지표 삭제')}
              aria-label={ariaWithHint('지표 삭제')}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm text-destructive hover:bg-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Trash2 className="w-4 h-4" aria-hidden /> 삭제
            </button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-sm bg-secondary hover:bg-secondary/80 transition-colors"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canOperate || busy}
              title={withHint('저장')}
              aria-label={ariaWithHint('저장')}
              className="px-4 py-2 rounded-xl text-sm bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {createMetric.isPending || updateMetric.isPending ? '저장 중…' : '저장'}
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete && !!editing}
        danger
        title="지표 삭제"
        description={`'${editing?.label ?? ''}' 지표를 삭제합니다 — 모든 클러스터의 관측 지표 화면에서 사라집니다. 잠시 숨기려면 삭제 대신 '사용'을 끄세요.`}
        confirmLabel="삭제"
        busy={deleteMetric.isPending}
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

const PREVIEW_MAX = 10;

function sampleLabels(labels: ObservabilityPreviewSample['labels']): LabelPair[] {
  if (Array.isArray(labels)) return labels;
  return Object.entries(labels ?? {}).map(([k, v]) => ({ k, v: String(v) }));
}

function sampleValue(value: ObservabilityPreviewSample['value'], displayType: string, unit: string): string {
  if (value === null || value === undefined || value === '') return '—';
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isNaN(num) ? String(value) : formatMetricValue(num, displayType, unit);
}

/** 미리 조회 결과 — 표본 값 또는 실패 사유를 PromQL 입력 바로 아래에 보여준다. */
function PreviewResult({ result, error, displayType, unit }: {
  result: ObservabilityPreviewResult | null;
  error: unknown;
  displayType: string;
  unit: string;
}) {
  if (error) {
    return (
      <p role="alert" className="mt-2 text-xs text-status-critical break-words">
        미리 조회 실패 — {formatApiError(error)}
      </p>
    );
  }
  if (!result) return null;
  const meta = [
    result.resultType ? `결과 형식 ${result.resultType}` : null,
    result.durationMs != null ? `${Math.round(result.durationMs)}ms` : null,
  ].filter(Boolean).join(' · ');
  if (!result.ok) {
    return (
      <p role="alert" className="mt-2 text-xs text-status-critical break-words">
        조회 오류 — {result.error || '사유를 받지 못했습니다'}{meta ? ` (${meta})` : ''}
      </p>
    );
  }
  const samples = result.samples ?? [];
  const total = Math.max(result.seriesCount ?? 0, samples.length);
  const shown = Math.min(samples.length, PREVIEW_MAX);
  return (
    <div role="status" className="mt-2 rounded-xl border border-border bg-secondary/40 p-2 space-y-1">
      <p className="text-xs text-muted-foreground">
        시리즈 {total}개{meta ? ` · ${meta}` : ''}
        {total === 0 ? ' — 결과가 비었습니다. 라벨 셀렉터(job 등)가 이 클러스터와 맞는지 확인하세요.' : ''}
      </p>
      {samples.length > 0 ? (
        <table className="w-full text-xs">
          <tbody>
            {samples.slice(0, PREVIEW_MAX).map((sample, idx) => (
              <tr key={idx} className="align-top">
                <td className="pr-3 py-0.5 font-mono text-muted-foreground break-all">
                  {labelsSummary(sampleLabels(sample.labels), ['__name__']) || '(라벨 없음)'}
                </td>
                <td className="py-0.5 text-right tabular-nums whitespace-nowrap">
                  {sampleValue(sample.value, displayType, unit)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {total > shown ? (
        <p className="text-xs text-muted-foreground">외 {total - shown}개</p>
      ) : null}
    </div>
  );
}
