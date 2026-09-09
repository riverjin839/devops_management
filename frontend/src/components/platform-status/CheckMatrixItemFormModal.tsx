import { useEffect, useId, useMemo, useState } from 'react';
import { X, Loader2, PlayCircle } from 'lucide-react';
import { useToast, StatusBadge } from '@/components/common';
import { useClusters } from '@/hooks/useCluster';
import {
  useCreateCheckMatrixItem, useUpdateCheckMatrixItem, useCheckMatrixCatalog, usePreviewCheckMatrixItem,
} from '@/hooks/useCheckMatrix';
import type {
  CheckMatrixItem, CheckMatrixSourceType, CheckMatrixCatalogItem, DeepCheckFieldSpec,
  CheckMatrixItemPreviewResult,
} from '@/types';
import { formatApiError } from '@/lib/utils';
import { useModalA11y } from '@/components/common/useModalA11y';
import { ROW_COLOR_PRESETS, CATEGORY_SUGGESTIONS } from './rowColors';
import { EXEC_TECH_META } from './execTechMeta';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  editingItem?: CheckMatrixItem | null;
}

// addon 은 카탈로그가 필드 스펙을 안 주므로(Addon.config 가 자유 JSON) 뭘 입력해야 하는지
// 최소한의 안내 문구만 보여준다 — 구조화된 소스오브트루스가 아니라 도움말이다.
const ADDON_CONFIG_HINTS: Record<string, string> = {
  nexus: 'url (필수)',
  jenkins: 'url (필수), username / api_token (선택)',
  argocd: 'namespace (선택, 기본 argocd)',
  keycloak: 'url (필수)',
};

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

function FieldRow({ field, value, onChange, disabled }: {
  field: DeepCheckFieldSpec;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor={id}
        className="text-xs font-mono text-muted-foreground w-40 flex-shrink-0 truncate"
        title={field.help ? `${field.label} — ${field.help}` : field.label}
      >
        {field.label}
      </label>
      {field.type === 'boolean' ? (
        <select
          id={id}
          value={value.toLowerCase() === 'true' ? 'true' : 'false'}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="text-xs border border-border rounded-lg px-2 py-1.5 bg-background disabled:opacity-50"
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input
          id={id}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="flex-1 min-w-0 text-xs font-mono border border-border rounded-lg px-2 py-1.5 bg-background disabled:opacity-50"
        />
      )}
    </div>
  );
}

function ModalChrome({
  titleId, title, onClose, dialogRef, children, footer, wide,
}: {
  titleId: string;
  title: string;
  onClose: () => void;
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
        className={`bg-card border border-border rounded-2xl shadow-xl w-full ${wide ? 'max-w-xl' : 'max-w-lg'} mx-4 max-h-[88vh] overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-card rounded-t-2xl z-10">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} title="닫기" aria-label="닫기" className="p-1 hover:bg-secondary rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-4">{children}</div>
        <div className="flex justify-between gap-2 px-6 py-4 border-t border-border">{footer}</div>
      </div>
    </div>
  );
}

export function CheckMatrixItemFormModal({ isOpen, onClose, editingItem }: Props) {
  if (editingItem) {
    return <EditItemForm isOpen={isOpen} onClose={onClose} editingItem={editingItem} />;
  }
  return <RegisterItemWizard isOpen={isOpen} onClose={onClose} />;
}

// ──────────────────────────────────────────────────────────────
// 수정 — 기존 항목의 표시 속성·(비시스템이면) 실행 소스를 고친다.
// ──────────────────────────────────────────────────────────────
function EditItemForm({ isOpen, onClose, editingItem }: { isOpen: boolean; onClose: () => void; editingItem: CheckMatrixItem }) {
  const toast = useToast();
  const { data: catalog } = useCheckMatrixCatalog();
  const updateMut = useUpdateCheckMatrixItem();
  const isSystem = editingItem.isSystem;

  const nameId = useId();
  const descId = useId();
  const unitId = useId();
  const categoryId = useId();
  const categoryListId = useId();
  const checkTypeId = useId();
  const addonTypeId = useId();
  const titleId = useId();
  const dialogRef = useModalA11y(isOpen, onClose);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [unit, setUnit] = useState('');
  const [sourceType, setSourceType] = useState<CheckMatrixSourceType>('manual');
  const [sourceRef, setSourceRef] = useState('');
  const [category, setCategory] = useState('');
  const [color, setColor] = useState('');
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (!isOpen) return;
    setName(editingItem.name ?? '');
    setDescription(editingItem.description ?? '');
    setUnit(editingItem.unit ?? '');
    setSourceType(editingItem.sourceType ?? 'manual');
    setSourceRef(editingItem.sourceRef ?? '');
    setCategory(editingItem.category ?? '');
    setColor(editingItem.color ?? '');
    setEnabled(editingItem.enabled ?? true);
  }, [isOpen, editingItem]);

  if (!isOpen) return null;

  const deepCheckOptions = (catalog?.items ?? []).filter((i) => i.sourceType === 'deep_check');
  const addonOptions = (catalog?.items ?? []).filter((i) => i.sourceType === 'addon');

  const SOURCE_TYPE_OPTIONS: Array<{ value: CheckMatrixSourceType; label: string; description: string }> = [
    { value: 'deep_check', label: '자동 점검 (등록된 점검 종류)', description: 'ETCD/CoreDNS/PVC 등 등록된 점검 로직으로 자동 실행' },
    { value: 'addon', label: '자동 점검 (애드온)', description: 'ArgoCD/Jenkins 등 클러스터별 등록된 애드온으로 자동 실행' },
    { value: 'manual', label: '수동 입력', description: '자동 실행 없이 값을 직접 입력 (예: AiStor, NFS, N/W 스위치)' },
  ];

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error('이름을 입력하세요.');
      return;
    }
    if ((sourceType === 'deep_check' || sourceType === 'addon') && !sourceRef) {
      toast.error('점검 종류를 선택하세요.');
      return;
    }
    const body = {
      name: name.trim(),
      description: description.trim() || null,
      unit: unit.trim() || null,
      sourceType,
      sourceRef: sourceType === 'manual' ? null : sourceRef,
      category: category.trim() || null,
      color: color || null,
      enabled,
    };
    try {
      await updateMut.mutateAsync({ id: editingItem.id, body });
      toast.success('항목을 수정했습니다.');
      onClose();
    } catch (e) {
      toast.error('수정 실패', formatApiError(e));
    }
  };

  return (
    <ModalChrome
      titleId={titleId}
      title="점검 항목 수정"
      onClose={onClose}
      dialogRef={dialogRef}
      footer={(
        <>
          <button onClick={onClose} className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl">
            취소
          </button>
          <button
            onClick={handleSave}
            disabled={updateMut.isPending}
            className="px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50"
          >
            저장
          </button>
        </>
      )}
    >
      <div>
        <label htmlFor={nameId} className="text-xs font-medium text-muted-foreground mb-1 block">이름</label>
        <input
          id={nameId}
          type="text"
          value={name}
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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor={categoryId} className="text-xs font-medium text-muted-foreground mb-1 block">
            영역 (선택 — 행 구분용)
          </label>
          <input
            id={categoryId}
            type="text"
            list={categoryListId}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="예: k8s, network, storage"
            className="w-full text-sm border border-border rounded-xl px-3 py-2 bg-background"
          />
          <datalist id={categoryListId}>
            {CATEGORY_SUGGESTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
          </datalist>
        </div>
        <div>
          <span className="text-xs font-medium text-muted-foreground mb-1 block">행 배경 색 (선택)</span>
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <button
              type="button"
              onClick={() => setColor('')}
              title="무색"
              aria-label="행 배경 색 없음"
              className={`w-6 h-6 rounded-full border text-[10px] text-muted-foreground flex items-center justify-center ${
                color === '' ? 'border-primary ring-2 ring-primary/40' : 'border-border'
              }`}
            >
              ×
            </button>
            {ROW_COLOR_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setColor(p.key)}
                title={p.label}
                aria-label={`행 배경 색 ${p.label}`}
                className={`w-6 h-6 rounded-full ${p.swatch} ${
                  color === p.key ? 'ring-2 ring-primary ring-offset-2 ring-offset-card' : ''
                }`}
              />
            ))}
          </div>
        </div>
      </div>

      {isSystem ? (
        <p className="text-xs text-muted-foreground rounded-lg border border-border bg-secondary/40 px-3 py-2">
          시스템 항목입니다 — 클러스터 전체 상태 계산에 쓰이는 실행 소스(핵심 점검 번들)는
          바꿀 수 없고, 이름/설명/단위/표시 여부만 수정할 수 있습니다.
        </p>
      ) : (
      <div>
        <span className="text-xs font-medium text-muted-foreground mb-1.5 block">실행 방식</span>
        <div className="space-y-1.5">
          {SOURCE_TYPE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                sourceType === opt.value ? 'border-primary bg-primary/5' : 'border-border hover:bg-secondary/50'
              }`}
            >
              <input
                type="radio"
                name="sourceType"
                aria-label={opt.label}
                className="mt-0.5"
                checked={sourceType === opt.value}
                onChange={() => { setSourceType(opt.value); setSourceRef(''); }}
              />
              <div className="min-w-0">
                <div className="text-sm font-medium">{opt.label}</div>
                <div className="text-xs text-muted-foreground">{opt.description}</div>
              </div>
            </label>
          ))}
        </div>
      </div>
      )}

      {!isSystem && sourceType === 'deep_check' && (
        <div>
          <label htmlFor={checkTypeId} className="text-xs font-medium text-muted-foreground mb-1 block">점검 종류</label>
          <select
            id={checkTypeId}
            value={sourceRef}
            onChange={(e) => setSourceRef(e.target.value)}
            className="w-full text-sm border border-border rounded-xl px-3 py-2 bg-background"
          >
            <option value="">선택하세요</option>
            {deepCheckOptions.map((ct) => (
              <option key={ct.sourceRef ?? ''} value={ct.sourceRef ?? ''}>{ct.displayName}</option>
            ))}
          </select>
        </div>
      )}

      {!isSystem && sourceType === 'addon' && (
        <div>
          <label htmlFor={addonTypeId} className="text-xs font-medium text-muted-foreground mb-1 block">애드온 종류</label>
          <select
            id={addonTypeId}
            value={sourceRef}
            onChange={(e) => setSourceRef(e.target.value)}
            className="w-full text-sm border border-border rounded-xl px-3 py-2 bg-background"
          >
            <option value="">선택하세요</option>
            {addonOptions.map((opt) => (
              <option key={opt.sourceRef ?? ''} value={opt.sourceRef ?? ''}>{opt.displayName}</option>
            ))}
          </select>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        그리드에 표시
      </label>
    </ModalChrome>
  );
}

// ──────────────────────────────────────────────────────────────
// 등록 마법사 — 실행기술 → 종류 → 세부정보 → 값 설정 → 테스트 → 적용
// ──────────────────────────────────────────────────────────────
type WizardStep = 'execTech' | 'kind' | 'detail' | 'values' | 'test' | 'apply';
const STEP_LABEL: Record<WizardStep, string> = {
  execTech: '실행 기술', kind: '종류', detail: '세부 정보', values: '값 설정', test: '테스트', apply: '적용',
};

function RegisterItemWizard({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const toast = useToast();
  const { data: catalog } = useCheckMatrixCatalog();
  const { data: clusters } = useClusters();
  const createMut = useCreateCheckMatrixItem();
  const previewMut = usePreviewCheckMatrixItem();

  const nameId = useId();
  const descId = useId();
  const unitId = useId();
  const categoryId = useId();
  const categoryListId = useId();
  const clusterFieldId = useId();
  const titleId = useId();
  const dialogRef = useModalA11y(isOpen, onClose);

  const [stepIdx, setStepIdx] = useState(0);
  const [execTech, setExecTech] = useState<string | null>(null);
  const [catalogItem, setCatalogItem] = useState<CheckMatrixCatalogItem | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [unit, setUnit] = useState('');
  const [category, setCategory] = useState('');
  const [color, setColor] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [thresholdDraft, setThresholdDraft] = useState<Record<string, string>>({});
  const [paramDraft, setParamDraft] = useState<Record<string, string>>({});
  const [addonConfigRows, setAddonConfigRows] = useState<{ key: string; value: string }[]>([{ key: '', value: '' }]);
  const [testClusterId, setTestClusterId] = useState('');
  const [testResult, setTestResult] = useState<CheckMatrixItemPreviewResult | null>(null);
  const [testAttempted, setTestAttempted] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setStepIdx(0);
    setExecTech(null);
    setCatalogItem(null);
    setName(''); setDescription(''); setUnit(''); setCategory(''); setColor(''); setEnabled(true);
    setThresholdDraft({}); setParamDraft({});
    setAddonConfigRows([{ key: '', value: '' }]);
    setTestClusterId(''); setTestResult(null); setTestAttempted(false);
  }, [isOpen]);

  const sourceType: CheckMatrixSourceType | null = catalogItem?.sourceType ?? (execTech === 'manual' ? 'manual' : null);

  const steps = useMemo<WizardStep[]>(() => {
    const arr: WizardStep[] = ['execTech'];
    if (execTech && execTech !== 'manual') arr.push('kind');
    arr.push('detail');
    if (sourceType && sourceType !== 'manual') arr.push('values', 'test');
    arr.push('apply');
    return arr;
  }, [execTech, sourceType]);

  const step = steps[Math.min(stepIdx, steps.length - 1)];

  const kindOptions = useMemo(
    () => (catalog?.items ?? []).filter((i) => i.execTech === execTech && i.sourceType !== 'manual'),
    [catalog, execTech],
  );
  const manualItem = useMemo(() => catalog?.items.find((i) => i.sourceType === 'manual') ?? null, [catalog]);

  if (!isOpen) return null;

  function applyCatalogSelection(item: CheckMatrixCatalogItem) {
    setCatalogItem(item);
    setName((cur) => cur || item.displayName);
    setDescription((cur) => cur || item.description || '');
    setCategory((cur) => cur || item.category || '');
    setThresholdDraft(Object.fromEntries(
      item.thresholdFields.map((f) => [f.name, String(item.defaultThresholds[f.name] ?? f.default ?? '')]),
    ));
    setParamDraft(Object.fromEntries(
      item.paramFields.map((f) => [f.name, String(item.defaultParams[f.name] ?? f.default ?? '')]),
    ));
  }

  const handlePickExecTech = (tech: string) => {
    setExecTech(tech);
    setCatalogItem(null);
    if (tech === 'manual' && manualItem) applyCatalogSelection(manualItem);
    setStepIdx((i) => i + 1);
  };

  const handlePickKind = (item: CheckMatrixCatalogItem) => {
    applyCatalogSelection(item);
    setStepIdx((i) => i + 1);
  };

  const goNext = () => setStepIdx((i) => Math.min(i + 1, steps.length - 1));
  const goBack = () => setStepIdx((i) => Math.max(i - 1, 0));

  const canGoNext = (() => {
    switch (step) {
      case 'execTech': return !!execTech;
      case 'kind': return !!catalogItem;
      case 'detail': return name.trim().length > 0;
      case 'test': return testAttempted || (clusters?.length ?? 0) === 0;
      default: return true;
    }
  })();

  const handleTest = async () => {
    if (!catalogItem || !testClusterId) return;
    const thresholds = catalogItem.sourceType === 'deep_check'
      ? fieldValuesToObject(catalogItem.thresholdFields, thresholdDraft) : undefined;
    const params = catalogItem.sourceType === 'deep_check'
      ? fieldValuesToObject(catalogItem.paramFields, paramDraft) : undefined;
    const config = catalogItem.sourceType === 'addon'
      ? Object.fromEntries(addonConfigRows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]))
      : undefined;
    try {
      const res = await previewMut.mutateAsync({
        sourceType: catalogItem.sourceType,
        sourceRef: catalogItem.sourceRef,
        clusterId: testClusterId,
        thresholds,
        params,
        config,
      });
      setTestResult(res);
    } catch (e) {
      setTestResult({ status: 'critical', message: formatApiError(e, '테스트 실행 중 오류가 발생했습니다.') });
    } finally {
      setTestAttempted(true);
    }
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error('이름을 입력하세요.');
      return;
    }
    const thresholds = catalogItem?.sourceType === 'deep_check'
      ? fieldValuesToObject(catalogItem.thresholdFields, thresholdDraft) : {};
    const params = catalogItem?.sourceType === 'deep_check'
      ? fieldValuesToObject(catalogItem.paramFields, paramDraft) : {};
    try {
      await createMut.mutateAsync({
        name: name.trim(),
        description: description.trim() || null,
        unit: unit.trim() || null,
        sourceType: (catalogItem?.sourceType ?? 'manual') as CheckMatrixSourceType,
        sourceRef: catalogItem?.sourceType === 'manual' || !catalogItem ? null : catalogItem.sourceRef,
        category: category.trim() || null,
        color: color || null,
        enabled,
        thresholds: Object.keys(thresholds).length ? thresholds : undefined,
        params: Object.keys(params).length ? params : undefined,
      });
      toast.success('항목을 추가했습니다.');
      onClose();
    } catch (e) {
      toast.error('추가 실패', formatApiError(e));
    }
  };

  return (
    <ModalChrome
      titleId={titleId}
      title="점검 항목 추가"
      onClose={onClose}
      dialogRef={dialogRef}
      wide
      footer={(
        <>
          <button
            onClick={stepIdx === 0 ? onClose : goBack}
            className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl"
          >
            {stepIdx === 0 ? '취소' : '이전'}
          </button>
          {step === 'apply' ? (
            <button
              onClick={handleSubmit}
              disabled={createMut.isPending}
              className="px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50"
            >
              {createMut.isPending ? '추가 중…' : '추가'}
            </button>
          ) : (
            <button
              onClick={goNext}
              disabled={!canGoNext}
              className="px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50"
            >
              다음
            </button>
          )}
        </>
      )}
    >
      <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
        {steps.map((s, i) => (
          <span key={s} className={`flex items-center gap-1 ${i === stepIdx ? 'text-foreground font-medium' : ''}`}>
            {i > 0 && <span className="opacity-40">›</span>}
            {STEP_LABEL[s]}
          </span>
        ))}
      </div>

      {step === 'execTech' && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">이 점검이 실제로 어떤 방식으로 실행되는지 먼저 고릅니다.</p>
          <div className="grid grid-cols-2 gap-2">
            {(catalog?.execTechs ?? []).map((tech) => {
              const meta = EXEC_TECH_META[tech];
              const Icon = meta?.icon;
              return (
                <button
                  key={tech}
                  type="button"
                  onClick={() => handlePickExecTech(tech)}
                  className={`flex items-center gap-2 p-3 rounded-xl border text-left transition-colors ${
                    execTech === tech ? 'border-primary bg-primary/5' : 'border-border hover:bg-secondary/50'
                  }`}
                >
                  {Icon && <Icon className="w-4 h-4 flex-shrink-0" />}
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{meta?.label ?? tech}</div>
                    <div className="text-xs text-muted-foreground truncate">{meta?.hint}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {step === 'kind' && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {EXEC_TECH_META[execTech ?? '']?.label ?? execTech} 로 실행되는 점검 종류를 고르세요.
          </p>
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {kindOptions.map((opt) => (
              <button
                key={`${opt.sourceType}:${opt.sourceRef}`}
                type="button"
                onClick={() => handlePickKind(opt)}
                className={`w-full flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                  catalogItem?.sourceRef === opt.sourceRef && catalogItem?.sourceType === opt.sourceType
                    ? 'border-primary bg-primary/5' : 'border-border hover:bg-secondary/50'
                }`}
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium">{opt.displayName}</div>
                  {opt.description && <div className="text-xs text-muted-foreground">{opt.description}</div>}
                </div>
              </button>
            ))}
            {kindOptions.length === 0 && (
              <p className="text-xs text-muted-foreground">이 실행 기술을 쓰는 등록된 점검 종류가 없습니다.</p>
            )}
          </div>
        </div>
      )}

      {step === 'detail' && (
        <div className="space-y-4">
          <div>
            <label htmlFor={nameId} className="text-xs font-medium text-muted-foreground mb-1 block">이름</label>
            <input
              id={nameId}
              type="text"
              value={name}
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor={categoryId} className="text-xs font-medium text-muted-foreground mb-1 block">
                영역 (컴포넌트 구분)
              </label>
              <input
                id={categoryId}
                type="text"
                list={categoryListId}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="예: k8s, network, storage"
                className="w-full text-sm border border-border rounded-xl px-3 py-2 bg-background"
              />
              <datalist id={categoryListId}>
                {CATEGORY_SUGGESTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </datalist>
            </div>
            <div>
              <span className="text-xs font-medium text-muted-foreground mb-1 block">행 배경 색 (선택)</span>
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <button
                  type="button"
                  onClick={() => setColor('')}
                  title="무색"
                  aria-label="행 배경 색 없음"
                  className={`w-6 h-6 rounded-full border text-[10px] text-muted-foreground flex items-center justify-center ${
                    color === '' ? 'border-primary ring-2 ring-primary/40' : 'border-border'
                  }`}
                >
                  ×
                </button>
                {ROW_COLOR_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setColor(p.key)}
                    title={p.label}
                    aria-label={`행 배경 색 ${p.label}`}
                    className={`w-6 h-6 rounded-full ${p.swatch} ${
                      color === p.key ? 'ring-2 ring-primary ring-offset-2 ring-offset-card' : ''
                    }`}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {step === 'values' && catalogItem && (
        <div className="space-y-3">
          {catalogItem.sourceType === 'deep_check' && catalogItem.seedDefault && (
            <p className="text-xs text-muted-foreground rounded-lg border border-border bg-secondary/40 px-3 py-2">
              이미 등록된 기본 점검 정의가 있어 아래 값은 참고용(기본값)입니다 — 저장 후 매트릭스
              셀에서 클러스터별로 임계값을 조정할 수 있습니다.
            </p>
          )}
          {catalogItem.sourceType === 'deep_check' && (
            <>
              {catalogItem.thresholdFields.length > 0 && (
                <div>
                  <span className="text-xs font-medium text-muted-foreground mb-1 block">임계값</span>
                  <div className="space-y-1.5">
                    {catalogItem.thresholdFields.map((f) => (
                      <FieldRow
                        key={f.name}
                        field={f}
                        value={thresholdDraft[f.name] ?? ''}
                        onChange={(v) => setThresholdDraft((cur) => ({ ...cur, [f.name]: v }))}
                        disabled={catalogItem.seedDefault}
                      />
                    ))}
                  </div>
                </div>
              )}
              {catalogItem.paramFields.length > 0 && (
                <div>
                  <span className="text-xs font-medium text-muted-foreground mb-1 block">파라미터</span>
                  <div className="space-y-1.5">
                    {catalogItem.paramFields.map((f) => (
                      <FieldRow
                        key={f.name}
                        field={f}
                        value={paramDraft[f.name] ?? ''}
                        onChange={(v) => setParamDraft((cur) => ({ ...cur, [f.name]: v }))}
                        disabled={catalogItem.seedDefault}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          {catalogItem.sourceType === 'addon' && (
            <div>
              <span className="text-xs font-medium text-muted-foreground mb-1 block">
                설정 (선택{ADDON_CONFIG_HINTS[catalogItem.sourceRef ?? ''] ? ` — ${ADDON_CONFIG_HINTS[catalogItem.sourceRef ?? '']}` : ''})
              </span>
              <div className="space-y-1.5">
                {addonConfigRows.map((row, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={row.key}
                      placeholder="키 (예: url)"
                      onChange={(e) => setAddonConfigRows((cur) => cur.map((r, idx) => (idx === i ? { ...r, key: e.target.value } : r)))}
                      className="w-32 text-xs font-mono border border-border rounded-lg px-2 py-1.5 bg-background"
                    />
                    <input
                      type="text"
                      value={row.value}
                      placeholder="값"
                      onChange={(e) => setAddonConfigRows((cur) => cur.map((r, idx) => (idx === i ? { ...r, value: e.target.value } : r)))}
                      className="flex-1 min-w-0 text-xs font-mono border border-border rounded-lg px-2 py-1.5 bg-background"
                    />
                    <button
                      type="button"
                      onClick={() => setAddonConfigRows((cur) => cur.filter((_, idx) => idx !== i))}
                      aria-label="필드 제거"
                      className="p-1 text-muted-foreground hover:text-status-critical"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setAddonConfigRows((cur) => [...cur, { key: '', value: '' }])}
                  className="text-xs text-primary hover:underline"
                >
                  + 필드 추가
                </button>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                실제 클러스터별 등록(자격증명 포함)은 대시보드의 "애드온 추가"에서 별도로 합니다 —
                여기 값은 테스트에만 쓰입니다.
              </p>
            </div>
          )}
        </div>
      )}

      {step === 'test' && catalogItem && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            저장하기 전에 실제 클러스터를 대상으로 1회 실행해봅니다 — 아무것도 저장되지 않습니다.
          </p>
          <div>
            <label htmlFor={clusterFieldId} className="text-xs font-medium text-muted-foreground mb-1 block">테스트할 클러스터</label>
            <select
              id={clusterFieldId}
              value={testClusterId}
              onChange={(e) => { setTestClusterId(e.target.value); setTestResult(null); }}
              className="w-full text-sm border border-border rounded-xl px-3 py-2 bg-background"
            >
              <option value="">선택하세요</option>
              {(clusters ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <button
            type="button"
            onClick={handleTest}
            disabled={!testClusterId || previewMut.isPending}
            className="w-full flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl disabled:opacity-50"
          >
            {previewMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
            테스트 실행
          </button>
          {testResult && (
            <div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-1.5">
              <StatusBadge variant={testResult.status} size="sm" />
              {testResult.message && <p className="text-xs">{testResult.message}</p>}
              {typeof testResult.durationMs === 'number' && (
                <p className="text-xs text-muted-foreground">{testResult.durationMs}ms</p>
              )}
            </div>
          )}
          {(clusters?.length ?? 0) === 0 && (
            <p className="text-xs text-status-warning">등록된 클러스터가 없어 테스트를 건너뛸 수 있습니다.</p>
          )}
        </div>
      )}

      {step === 'apply' && (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-1 text-xs">
            <div><span className="text-muted-foreground">이름</span> · {name || '(미입력)'}</div>
            <div>
              <span className="text-muted-foreground">실행 방식</span> · {EXEC_TECH_META[execTech ?? '']?.label ?? execTech}
              {catalogItem && ` · ${catalogItem.displayName}`}
            </div>
            {category && <div><span className="text-muted-foreground">영역</span> · {category}</div>}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            그리드에 표시
          </label>
        </div>
      )}
    </ModalChrome>
  );
}
