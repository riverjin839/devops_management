import { useState } from 'react';
import { Pencil } from 'lucide-react';
import type { Cluster, ClusterCustomField } from '@/types';
import { useUpdateClusterCustomValues } from '@/hooks/useClusterCustomFields';
import { useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';

interface Props {
  cluster: Cluster;
  field: ClusterCustomField;
  /** viewer 역할은 조회만 — 편집 진입점을 노출하지 않는다 */
  canEdit?: boolean;
}

function boolLabel(v: unknown): string {
  if (v === true) return 'O';
  if (v === false) return 'X';
  return '·';
}

export function ClusterCustomCell({ cluster, field, canEdit = true }: Props) {
  const mut = useUpdateClusterCustomValues();
  const toast = useToast();
  const current = cluster.customValues?.[field.key];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  // 편집 진입 시점의 서버 값으로 draft 를 초기화 — 마운트 1회 초기화(stale draft)는
  // 자동수집·타 사용자 변경 이후 재편집에서 옛 값을 되살릴 수 있다. (D-042)
  const beginEdit = () => {
    setDraft(
      current === null || current === undefined
        ? ''
        : typeof current === 'boolean' ? (current ? 'true' : 'false') : String(current),
    );
    setEditing(true);
  };

  const commit = async (rawVal: unknown) => {
    try {
      await mut.mutateAsync({
        clusterId: cluster.id,
        values: { [field.key]: rawVal === '' ? null : rawVal },
      });
      setEditing(false);
    } catch (e) {
      // onBlur 경로의 unhandled rejection 방지 + 실패 고지. 편집은 유지해 재시도 가능하게.
      toast.error(`${field.label} 저장 실패`, formatApiError(e));
    }
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
          aria-label={`${field.label} 값 선택`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          className="w-full px-1 py-0.5 text-sm bg-background border border-primary rounded focus:outline-none focus:ring-1 focus:ring-primary"
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
          aria-label={`${field.label} 값 입력`}
          className="w-full px-1 py-0.5 text-sm bg-background border border-primary rounded focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
    );
  }

  // 읽기 모드
  if (field.dataType === 'checkbox') {
    if (!canEdit) {
      return (
        <span
          className={`font-mono text-sm px-1 ${
            current === true ? 'text-status-healthy font-bold'
            : current === false ? 'text-muted-foreground/60'
            : 'text-muted-foreground/30'
          }`}
          title={field.label}
        >
          {boolLabel(current)}
        </span>
      );
    }
    return (
      <button
        type="button"
        // 저장 중 재클릭을 막는다 — 두 클릭이 같은(아직 갱신 안 된) 값 기준으로 "다음 값"을
        // 계산해 순환이 어긋나고 PATCH 가 레이스한다.
        disabled={mut.isPending}
        onClick={() => {
          // 순환: undefined → true → false → null
          const next = current === true ? false : current === false ? null : true;
          commit(next);
        }}
        className={`font-mono text-sm px-1 rounded hover:bg-primary/10 disabled:opacity-40 ${
          current === true ? 'text-status-healthy font-bold'
          : current === false ? 'text-muted-foreground/60'
          : 'text-muted-foreground/30'
        }`}
        title={`${field.label} (클릭 순환: 미설정 → O → X → 미설정)`}
        // 스크린리더에 "O"/"·" 만 announce 되던 것 — 필드명·현재값·조작법을 이름에 담는다.
        aria-label={`${field.label}: ${current === true ? '예' : current === false ? '아니오' : '미설정'} — 클릭하여 순환 변경`}
        aria-pressed={current === true ? 'true' : current === false ? 'false' : 'mixed'}
      >
        {boolLabel(current)}
      </button>
    );
  }

  const text = current === null || current === undefined || current === ''
    ? null
    : String(current);

  if (!canEdit) {
    return (
      <span className="text-sm px-0.5 block min-h-[1.2em] truncate" title={field.label}>
        {text ?? <span className="text-muted-foreground/40">-</span>}
      </span>
    );
  }

  return (
    <span className="group relative flex items-center gap-1 min-h-[1.2em]">
      <span
        onDoubleClick={beginEdit}
        className="cursor-text hover:bg-primary/5 rounded px-0.5 text-sm flex-1 min-w-0 truncate"
        title={`더블클릭 또는 편집 버튼으로 수정 — ${field.label}`}
      >
        {text ?? <span className="text-muted-foreground/40">-</span>}
      </span>
      <button
        type="button"
        onClick={beginEdit}
        className="flex-shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-primary text-muted-foreground hover:text-primary hover:bg-secondary/80 transition-opacity"
        title={`${field.label} 편집`}
        aria-label={`${field.label} 편집`}
      >
        <Pencil className="w-3 h-3" />
      </button>
    </span>
  );
}


