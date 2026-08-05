import { useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';
import { useToast } from '@/components/common';
import { useCheckTypes } from '@/hooks/useDeepCheckDefinitions';
import { useCreateCheckMatrixItem, useUpdateCheckMatrixItem } from '@/hooks/useCheckMatrix';
import type { CheckMatrixItem, CheckMatrixSourceType } from '@/types';
import { formatApiError } from '@/lib/utils';
import { useModalA11y } from '@/components/common/useModalA11y';
import { ROW_COLOR_PRESETS, CATEGORY_SUGGESTIONS } from './rowColors';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  editingItem?: CheckMatrixItem | null;
}

// backend CHECKER_REGISTRY(app/services/checkers/__init__.py) 와 동일한 키.
const ADDON_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'etcd-leader', label: 'ETCD Leader' },
  { value: 'node-check', label: '노드 상태' },
  { value: 'control-plane', label: '컨트롤 플레인' },
  { value: 'system-pod', label: '시스템 파드' },
  { value: 'nexus', label: 'Nexus' },
  { value: 'jenkins', label: 'Jenkins' },
  { value: 'argocd', label: 'ArgoCD' },
  { value: 'keycloak', label: 'Keycloak' },
];

const SOURCE_TYPE_OPTIONS: Array<{ value: CheckMatrixSourceType; label: string; description: string }> = [
  { value: 'deep_check', label: '자동 점검 (Deep Check)', description: 'ETCD/CoreDNS/PVC 등 등록된 점검 로직으로 자동 실행' },
  { value: 'addon', label: '자동 점검 (Addon)', description: 'ArgoCD/Jenkins 등 클러스터별 등록된 애드온으로 자동 실행' },
  { value: 'manual', label: '수동 입력', description: '자동 실행 없이 값을 직접 입력 (예: AiStor, NFS, N/W 스위치)' },
];

export function CheckMatrixItemFormModal({ isOpen, onClose, editingItem }: Props) {
  const toast = useToast();
  const { data: checkTypes } = useCheckTypes();
  const createMut = useCreateCheckMatrixItem();
  const updateMut = useUpdateCheckMatrixItem();
  const isEdit = !!editingItem;
  // 시스템 항목(core_bundle)은 이름/설명/단위/표시 여부만 수정 — 실행 소스는 잠긴다.
  const isSystem = !!editingItem?.isSystem;

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
    setName(editingItem?.name ?? '');
    setDescription(editingItem?.description ?? '');
    setUnit(editingItem?.unit ?? '');
    setSourceType(editingItem?.sourceType ?? 'manual');
    setSourceRef(editingItem?.sourceRef ?? '');
    setCategory(editingItem?.category ?? '');
    setColor(editingItem?.color ?? '');
    setEnabled(editingItem?.enabled ?? true);
  }, [isOpen, editingItem]);

  if (!isOpen) return null;

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
      if (isEdit) {
        await updateMut.mutateAsync({ id: editingItem!.id, body });
        toast.success('항목을 수정했습니다.');
      } else {
        await createMut.mutateAsync(body);
        toast.success('항목을 추가했습니다.');
      }
      onClose();
    } catch (e) {
      toast.error(isEdit ? '수정 실패' : '추가 실패', formatApiError(e));
    }
  };

  const saving = createMut.isPending || updateMut.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-card border border-border rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[88vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-card rounded-t-2xl z-10">
          <h2 id={titleId} className="text-lg font-semibold">{isEdit ? '점검 항목 수정' : '점검 항목 추가'}</h2>
          <button
            onClick={onClose}
            title="닫기"
            aria-label="닫기"
            className="p-1 hover:bg-secondary rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
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
                {(checkTypes ?? []).map((ct) => (
                  <option key={ct.checkType} value={ct.checkType}>{ct.displayName}</option>
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
                {ADDON_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            그리드에 표시
          </label>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-border">
          <button onClick={onClose} className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl">
            취소
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50"
          >
            {isEdit ? '저장' : '추가'}
          </button>
        </div>
      </div>
    </div>
  );
}
