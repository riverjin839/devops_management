import { useState } from 'react';
import type { Cluster, ClusterCustomField } from '@/types';
import { useUpdateClusterCustomValues } from '@/hooks/useClusterCustomFields';
import { useToast } from '@/components/common';

interface Props {
  cluster: Cluster;
  field: ClusterCustomField;
}

function boolLabel(v: unknown): string {
  if (v === true) return 'O';
  if (v === false) return 'X';
  return '·';
}

export function ClusterCustomCell({ cluster, field }: Props) {
  const mut = useUpdateClusterCustomValues();
  const toast = useToast();
  const current = cluster.customValues?.[field.key];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(() => {
    if (current === null || current === undefined) return '';
    if (typeof current === 'boolean') return current ? 'true' : 'false';
    return String(current);
  });

  const commit = async (rawVal: unknown) => {
    await mut.mutateAsync({
      clusterId: cluster.id,
      values: { [field.key]: rawVal === '' ? null : rawVal },
    });
    setEditing(false);
  };

  const save = async () => {
    let val: unknown = draft;
    if (field.dataType === 'number') {
      if (draft.trim() === '') val = null;
      else {
        const n = Number(draft);
        if (!Number.isFinite(n)) { toast.warning('숫자가 아닙니다', `입력값: "${draft}"`); return; }
        val = n;
      }
    }
    await commit(val);
  };

  if (editing) {
    if (field.dataType === 'select') {
      return (
        <select autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          className="w-full px-1 py-0.5 text-sm bg-background border border-primary rounded"
        >
          <option value="">(없음)</option>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    }
    return (
      <div className="flex items-center gap-1">
        <input
          autoFocus
          type={field.dataType === 'date' ? 'date' : field.dataType === 'number' ? 'number' : 'text'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') setEditing(false);
          }}
          onBlur={save}
          className="w-full px-1 py-0.5 text-sm bg-background border border-primary rounded"
        />
      </div>
    );
  }

  // 읽기 모드
  if (field.dataType === 'checkbox') {
    return (
      <button
        type="button"
        onClick={() => {
          // 순환: undefined → true → false → null
          const next = current === true ? false : current === false ? null : true;
          commit(next);
        }}
        className={`font-mono text-sm px-1 rounded hover:bg-primary/10 ${
          current === true ? 'text-emerald-500 font-bold'
          : current === false ? 'text-muted-foreground/60'
          : 'text-muted-foreground/30'
        }`}
        title={`${field.label} (클릭 순환)`}
      >
        {boolLabel(current)}
      </button>
    );
  }

  const text = current === null || current === undefined || current === ''
    ? null
    : String(current);

  return (
    <span
      onDoubleClick={() => setEditing(true)}
      className="cursor-text hover:bg-primary/5 rounded px-0.5 text-sm block min-h-[1.2em]"
      title={`더블클릭으로 편집 — ${field.label}`}
    >
      {text ?? <span className="text-muted-foreground/40">-</span>}
    </span>
  );
}


