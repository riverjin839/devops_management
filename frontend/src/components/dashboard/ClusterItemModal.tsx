import { useEffect, useId, useState } from 'react';
import { X, Hand, Clock3, Sparkles } from 'lucide-react';
import { ClusterItem, ClusterItemCardSize, ClusterItemSource } from '@/types';
import { useCreateClusterItem, useUpdateClusterItem, useClusterItemTypes } from '@/hooks/useClusterItems';
import { useToast } from '@/components/common';
import { useModalA11y } from '@/components/common/useModalA11y';
import { formatApiError } from '@/lib/utils';

interface ClusterItemModalProps {
  isOpen: boolean;
  onClose: () => void;
  clusterId: string;
  editingItem?: ClusterItem | null;
}

const SOURCE_OPTIONS: { value: ClusterItemSource; label: string; icon: typeof Hand; hint: string }[] = [
  { value: 'manual', label: '수동', icon: Hand, hint: '수작업으로 직접 실행' },
  { value: 'auto', label: '자동(배치)', icon: Clock3, hint: '스케줄에 맞춰 자동 수집' },
  { value: 'ai', label: 'AI', icon: Sparkles, hint: 'Ollama LLM 으로 수집 (폐쇄망)' },
];

const SIZE_OPTIONS: { value: ClusterItemCardSize; label: string }[] = [
  { value: 'sm', label: 'Small' },
  { value: 'md', label: 'Medium' },
  { value: 'lg', label: 'Large' },
];

export function ClusterItemModal({ isOpen, onClose, clusterId, editingItem }: ClusterItemModalProps) {
  const [itemType, setItemType] = useState('node_count');
  const [title, setTitle] = useState('');
  const [icon, setIcon] = useState('🖥️');
  const [description, setDescription] = useState('');
  const [unit, setUnit] = useState('');
  const [sourceMode, setSourceMode] = useState<ClusterItemSource>('auto');
  const [autoEnabled, setAutoEnabled] = useState(true);
  const [scheduleHour, setScheduleHour] = useState(1);
  const [scheduleMinute, setScheduleMinute] = useState(0);
  const [cardSize, setCardSize] = useState<ClusterItemCardSize>('md');

  const typeId = useId();
  const titleId = useId();
  const iconId = useId();
  const descId = useId();
  const unitId = useId();
  const headingId = useId();

  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const createItem = useCreateClusterItem(clusterId);
  const updateItem = useUpdateClusterItem(clusterId);
  const { data: itemTypes = [] } = useClusterItemTypes();
  const dialogRef = useModalA11y(isOpen, onClose);

  const isEdit = !!editingItem;

  useEffect(() => {
    if (!isOpen) return;
    if (editingItem) {
      setItemType(editingItem.itemType);
      setTitle(editingItem.title);
      setIcon(editingItem.icon || '🖥️');
      setDescription(editingItem.description || '');
      setUnit(editingItem.unit || '');
      setSourceMode(editingItem.sourceMode);
      setAutoEnabled(editingItem.autoEnabled);
      setScheduleHour(editingItem.scheduleHour);
      setScheduleMinute(editingItem.scheduleMinute);
      setCardSize(editingItem.cardSize);
    } else {
      setItemType('node_count');
      setTitle('');
      setIcon('🖥️');
      setDescription('');
      setUnit('');
      setSourceMode('auto');
      setAutoEnabled(true);
      setScheduleHour(1);
      setScheduleMinute(0);
      setCardSize('md');
    }
  }, [isOpen, editingItem]);

  if (!isOpen) return null;

  // 생성 모드에서 아이템 타입 선택 시 기본값 prefill.
  const handleTypeSelect = (type: string) => {
    setItemType(type);
    const spec = itemTypes.find((t) => t.itemType === type);
    if (!spec) return;
    setTitle((prev) => (prev.trim() ? prev : spec.label));
    setIcon(spec.icon || '🖥️');
    setUnit(spec.unit || '');
    setSourceMode(spec.defaultSource);
    setScheduleHour(spec.defaultScheduleHour);
    setDescription(spec.description || '');
  };

  const handleSave = async () => {
    if (!title.trim()) return;
    const payload: Partial<ClusterItem> = {
      title: title.trim(),
      icon,
      description: description.trim() || undefined,
      unit: unit.trim(),
      sourceMode,
      autoEnabled,
      scheduleHour,
      scheduleMinute,
      cardSize,
    };
    setSaving(true);
    try {
      if (editingItem) {
        await updateItem.mutateAsync({ id: editingItem.id, data: payload });
      } else {
        await createItem.mutateAsync({ ...payload, itemType, tier: itemType === 'node_count' ? 'basic' : 'advanced' });
      }
      onClose();
    } catch (err) {
      toast.error(isEdit ? '수정 실패' : '추가 실패', formatApiError(err, '저장 중 오류가 발생했습니다.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="bg-card border border-border rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-card rounded-t-2xl z-10">
          <h2 id={headingId} className="text-lg font-semibold">{isEdit ? '아이템 편집' : '아이템 추가'}</h2>
          <button onClick={onClose} aria-label="닫기" className="p-1 hover:bg-secondary rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {isEdit && editingItem?.isBuiltin && (
            <p className="text-xs text-muted-foreground bg-muted/30 rounded-lg px-3 py-2">
              기본 아이템입니다. 제목·아이콘·스케줄·크기 등은 편집할 수 있지만 삭제는 불가합니다.
            </p>
          )}

          {/* Item type picker — 생성 모드에서만 (타입은 생성 후 변경 불가) */}
          {!isEdit && (
            <div>
              <label htmlFor={typeId} className="block text-sm font-medium mb-1">
                아이템 종류 <span className="text-red-400">*</span>
              </label>
              <select
                id={typeId}
                value={itemType}
                onChange={(e) => handleTypeSelect(e.target.value)}
                className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                {itemTypes.map((t) => (
                  <option key={t.itemType} value={t.itemType}>
                    {t.icon} {t.label}
                  </option>
                ))}
              </select>
              {itemTypes.find((t) => t.itemType === itemType)?.description && (
                <p className="text-xs text-muted-foreground mt-1">
                  {itemTypes.find((t) => t.itemType === itemType)?.description}
                </p>
              )}
            </div>
          )}

          {/* Title + Icon */}
          <div className="grid grid-cols-[1fr_72px] gap-3">
            <div>
              <label htmlFor={titleId} className="block text-sm font-medium mb-1">
                제목 <span className="text-red-400">*</span>
              </label>
              <input
                id={titleId}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="예: K8s 노드 수"
                className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
            <div>
              <label htmlFor={iconId} className="block text-sm font-medium mb-1">아이콘</label>
              <input
                id={iconId}
                type="text"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm text-center focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label htmlFor={descId} className="block text-sm font-medium mb-1">설명</label>
            <input
              id={descId}
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="이 아이템이 무엇을 보여주는지"
              className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          {/* Source mode */}
          <div>
            <p className="block text-sm font-medium mb-1.5">결과 수집 방식</p>
            <div className="grid grid-cols-3 gap-2">
              {SOURCE_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const active = sourceMode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setSourceMode(opt.value)}
                    title={opt.hint}
                    className={`flex flex-col items-center gap-1 px-2 py-2.5 rounded-lg border text-sm transition-colors ${
                      active ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:border-primary/40'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Schedule (auto only) */}
          {sourceMode === 'auto' && (
            <div className="rounded-lg border border-border p-3 space-y-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={autoEnabled}
                  onChange={(e) => setAutoEnabled(e.target.checked)}
                  className="rounded"
                />
                자동 점검 활성화
              </label>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">매일</span>
                <select
                  value={scheduleHour}
                  onChange={(e) => setScheduleHour(Number(e.target.value))}
                  disabled={!autoEnabled}
                  className="px-2 py-1.5 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-40"
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{String(h).padStart(2, '0')}</option>
                  ))}
                </select>
                <span className="text-muted-foreground">시</span>
                <select
                  value={scheduleMinute}
                  onChange={(e) => setScheduleMinute(Number(e.target.value))}
                  disabled={!autoEnabled}
                  className="px-2 py-1.5 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-40"
                >
                  {[0, 10, 15, 20, 30, 40, 45, 50].map((m) => (
                    <option key={m} value={m}>{String(m).padStart(2, '0')}</option>
                  ))}
                </select>
                <span className="text-muted-foreground">분 (KST)</span>
              </div>
              <p className="text-xs text-muted-foreground/70">분 단위는 표시용이며 실제 자동 수집은 매시 정각에 시 기준으로 실행됩니다.</p>
            </div>
          )}

          {/* Card size + Unit */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="block text-sm font-medium mb-1.5">카드 크기</p>
              <div className="flex gap-1.5">
                {SIZE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setCardSize(opt.value)}
                    className={`flex-1 px-2 py-1.5 rounded-lg border text-sm transition-colors ${
                      cardSize === opt.value ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:border-primary/40'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label htmlFor={unitId} className="block text-sm font-medium mb-1.5">단위</label>
              <input
                id={unitId}
                type="text"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="예: 대"
                className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors"
            >
              취소
            </button>
            <button
              onClick={handleSave}
              disabled={!title.trim() || saving}
              className="flex-1 px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors disabled:opacity-40"
            >
              {saving ? '저장 중...' : isEdit ? '저장' : '추가'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
