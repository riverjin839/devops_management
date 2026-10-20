import { useEffect, useId, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { NodeRow } from '@/hooks/useNodeLabels';
import { ConfirmDialog } from '@/components/common';
import { useModalA11y } from '@/components/common/useModalA11y';

export interface NodeLabelPatch { add: Record<string, string>; remove: string[] }

interface Props {
  node: NodeRow | null;
  isOpen: boolean;
  onClose: () => void;
  /** 적용 — 성공하면 true(모달을 닫는다). 실패하면 false(입력을 그대로 두고 모달 유지, 사유는 호출부 토스트). */
  onApply: (payload: NodeLabelPatch) => Promise<boolean>;
  /** 권한(§12.9) — false 면 "적용" 비활성 + 사유. */
  canApply?: boolean;
  applyHint?: string;
}

const inputCls = 'w-full px-3 py-2 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/50';

export function NodeLabelEditorModal({ node, isOpen, onClose, onApply, canApply = true, applyHint }: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // 적용 중에는 Escape·배경 클릭으로 닫지 않는다(요청은 이미 나갔다 — 결과를 보고 닫는다).
  const dismiss = () => { if (!busy) onClose(); };
  // 확인창이 위에 뜨면 Escape·Tab 은 그 확인창 몫이다(modalStack).
  const dialogRef = useModalA11y(isOpen, dismiss);
  const titleId = useId();
  const keyId = useId();
  const valueId = useId();
  const [addKey, setAddKey] = useState('');
  const [addValue, setAddValue] = useState('');
  const [pendingAdd, setPendingAdd] = useState<Record<string, string>>({});
  const [removeSet, setRemoveSet] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!isOpen || !node) return;
    setAddKey('');
    setAddValue('');
    setPendingAdd({});
    setRemoveSet({});
    setConfirmOpen(false);
    setBusy(false);
  }, [isOpen, node]);

  const removableKeys = useMemo(() => Object.keys(node?.labels || {}), [node]);

  if (!isOpen || !node) return null;

  const removeKeys = Object.keys(removeSet).filter((k) => removeSet[k]);
  const addEntries = Object.entries(pendingAdd);
  const hasChanges = addEntries.length > 0 || removeKeys.length > 0;

  const addPair = () => {
    if (!addKey.trim()) return;
    setPendingAdd((prev) => ({ ...prev, [addKey.trim()]: addValue.trim() }));
    setAddKey('');
    setAddValue('');
  };

  const confirmApply = async () => {
    setBusy(true);
    const ok = await onApply({ add: pendingAdd, remove: removeKeys });
    setBusy(false);
    setConfirmOpen(false);
    if (ok) onClose();
  };

  const applyTitle = !canApply && applyHint
    ? applyHint
    : hasChanges ? '변경 내용을 확인한 뒤 노드에 적용' : '추가하거나 삭제할 라벨을 먼저 고르세요';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={dismiss}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-card border border-border rounded-md w-full max-w-3xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 id={titleId} className="font-semibold text-lg">
            노드 라벨 편집: <span className="font-mono">{node.name}</span>
          </h3>
          <button
            type="button"
            onClick={dismiss}
            title="닫기"
            aria-label="노드 라벨 편집 닫기"
            className="p-1 rounded-xl hover:bg-secondary"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label htmlFor={keyId} className="block text-xs text-muted-foreground mb-1">키</label>
            <input
              id={keyId}
              className={`${inputCls} font-mono`}
              placeholder="예: node-role/gpu"
              value={addKey}
              onChange={(e) => setAddKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) addPair(); }}
            />
          </div>
          <div>
            <label htmlFor={valueId} className="block text-xs text-muted-foreground mb-1">값</label>
            <div className="flex gap-2">
              <input
                id={valueId}
                className={`flex-1 ${inputCls} font-mono`}
                placeholder="비우면 키만 붙음"
                value={addValue}
                onChange={(e) => setAddValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) addPair(); }}
              />
              <button
                type="button"
                onClick={addPair}
                disabled={!addKey.trim()}
                className="px-3 py-2 text-sm bg-secondary border border-border rounded-xl hover:bg-secondary/80 disabled:opacity-50"
              >
                추가
              </button>
            </div>
          </div>
        </div>

        <fieldset className="mb-4">
          <legend className="text-sm font-medium mb-2">현재 라벨(선택하면 삭제)</legend>
          <div className="max-h-40 overflow-y-auto border border-border rounded-md p-2 space-y-1">
            {removableKeys.length === 0 && (
              <p className="text-sm text-muted-foreground">라벨이 없습니다.</p>
            )}
            {removableKeys.map((key) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!removeSet[key]}
                  onChange={(e) => setRemoveSet((prev) => ({ ...prev, [key]: e.target.checked }))}
                />
                <span className="font-mono">{node.labels[key] ? `${key}=${node.labels[key]}` : key}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mb-4 text-sm">
          <p className="font-medium mb-1">변경 미리보기</p>
          {!hasChanges && <p className="text-muted-foreground">변경 없음</p>}
          {addEntries.map(([k, v]) => (
            <div key={k} className="font-mono text-foreground">
              <span className="sr-only">추가 </span>+ {v ? `${k}=${v}` : k}
            </div>
          ))}
          {removeKeys.map((k) => (
            <div key={k} className="font-mono text-muted-foreground line-through">
              <span className="sr-only">삭제 </span>- {k}
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={dismiss}
            className="px-3 py-2 text-sm bg-secondary rounded-xl border border-border hover:bg-secondary/80"
          >
            취소
          </button>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={!canApply || !hasChanges || busy}
            title={applyTitle}
            aria-label={!canApply && applyHint ? `적용 — ${applyHint}` : '적용'}
            className="px-3 py-2 text-sm font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50"
          >
            적용
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        danger
        busy={busy}
        title="노드 라벨을 변경할까요?"
        description="라벨은 nodeSelector·affinity·DaemonSet 배치 기준이라 워크로드가 재배치되거나 스케줄이 실패할 수 있습니다."
        confirmLabel="적용"
        onConfirm={() => { void confirmApply(); }}
        onCancel={() => { if (!busy) setConfirmOpen(false); }}
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 mb-2">
          <dt className="text-muted-foreground">클러스터</dt>
          <dd className="font-medium">{node.clusterName}</dd>
          <dt className="text-muted-foreground">노드</dt>
          <dd className="font-mono">{node.name}</dd>
        </dl>
        <ul className="font-mono text-xs space-y-0.5 max-h-40 overflow-y-auto">
          {addEntries.map(([k, v]) => <li key={`+${k}`}>+ {v ? `${k}=${v}` : k}</li>)}
          {removeKeys.map((k) => <li key={`-${k}`}>- {k}</li>)}
        </ul>
      </ConfirmDialog>
    </div>
  );
}
