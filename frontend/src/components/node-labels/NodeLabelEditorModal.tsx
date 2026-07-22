import { useEffect, useId, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { NodeInfo } from '@/hooks/useNodeLabels';
import { useModalA11y } from '@/components/common/useModalA11y';

interface Props {
  node: NodeInfo | null;
  isOpen: boolean;
  onClose: () => void;
  onApply: (payload: { add: Record<string, string>; remove: string[] }) => void;
}

export function NodeLabelEditorModal({ node, isOpen, onClose, onApply }: Props) {
  const dialogRef = useModalA11y(isOpen, onClose);
  const titleId = useId();
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
  }, [isOpen, node]);

  const removableKeys = useMemo(() => Object.keys(node?.labels || {}), [node]);

  if (!isOpen || !node) return null;

  const addPair = () => {
    if (!addKey.trim()) return;
    setPendingAdd((prev) => ({ ...prev, [addKey.trim()]: addValue.trim() }));
    setAddKey('');
    setAddValue('');
  };

  const apply = () => {
    const remove = Object.keys(removeSet).filter((k) => removeSet[k]);
    onApply({ add: pendingAdd, remove });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-card border border-border rounded-xl w-full max-w-3xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 id={titleId} className="font-semibold text-lg">Edit Node Labels: {node.name}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-secondary"><X className="w-4 h-4" /></button>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <input className="px-3 py-2 bg-secondary border border-border rounded" placeholder="label key" value={addKey} onChange={(e)=>setAddKey(e.target.value)} />
          <div className="flex gap-2">
            <input className="flex-1 px-3 py-2 bg-secondary border border-border rounded" placeholder="label value" value={addValue} onChange={(e)=>setAddValue(e.target.value)} />
            <button onClick={addPair} className="px-3 py-2 bg-primary text-primary-foreground rounded">Add</button>
          </div>
        </div>

        <div className="mb-4">
          <p className="text-sm font-medium mb-2">Current labels (check to remove)</p>
          <div className="max-h-40 overflow-y-auto border border-border rounded p-2 space-y-1">
            {removableKeys.map((key) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={!!removeSet[key]} onChange={(e)=>setRemoveSet((prev)=>({ ...prev, [key]: e.target.checked }))} />
                <span className="font-mono">{key}={node.labels[key]}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="mb-4 text-sm">
          <p className="font-medium mb-1">Preview</p>
          {Object.entries(pendingAdd).map(([k, v]) => <div key={k} className="text-green-400 font-mono">+ {k}={v}</div>)}
          {Object.keys(removeSet).filter((k)=>removeSet[k]).map((k) => <div key={k} className="text-red-400 font-mono">- {k}</div>)}
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 bg-secondary rounded border border-border">Cancel</button>
          <button onClick={apply} className="px-3 py-2 bg-primary text-primary-foreground rounded">Apply</button>
        </div>
      </div>
    </div>
  );
}
