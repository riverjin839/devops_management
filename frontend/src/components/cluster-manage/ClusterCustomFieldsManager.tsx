import { useEffect, useState } from 'react';
import { X, Plus, Trash2, Save, Loader2, GripVertical, Settings2 } from 'lucide-react';
import type {
  ClusterCustomField, ClusterCustomFieldType, ClusterCustomFieldCreate,
} from '@/types';
import { useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import {
  useClusterCustomFields, useCreateClusterCustomField,
  useUpdateClusterCustomField, useDeleteClusterCustomField,
  sortedFields,
} from '@/hooks/useClusterCustomFields';

interface Props {
  open: boolean;
  onClose: () => void;
}

const TYPES: { v: ClusterCustomFieldType; label: string; hint: string }[] = [
  { v: 'text',     label: '텍스트',   hint: '일반 문자열' },
  { v: 'number',   label: '숫자',     hint: '정수/실수' },
  { v: 'date',     label: '날짜',     hint: 'YYYY-MM-DD' },
  { v: 'checkbox', label: '체크박스', hint: 'O / X' },
  { v: 'select',   label: '선택지',   hint: '드롭다운 (옵션 필요)' },
];

// key 자동 생성 (label 에서)
function deriveKey(label: string): string {
  const normalized = label.trim().toLowerCase()
    .replace(/[^a-z0-9가-힣_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  // 첫 문자가 숫자면 접두사
  return /^[a-z]/.test(normalized) ? normalized : `f_${normalized || 'field'}`;
}

export function ClusterCustomFieldsManager({ open, onClose }: Props) {
  const { data: fieldsRaw, isLoading } = useClusterCustomFields();
  const fields = sortedFields(fieldsRaw);

  const createMut = useCreateClusterCustomField();
  const updateMut = useUpdateClusterCustomField();
  const deleteMut = useDeleteClusterCustomField();
  const toast = useToast();

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<ClusterCustomFieldCreate>({
    key: '',
    label: '',
    dataType: 'text',
    options: [],
    description: '',
    sortOrder: 0,
  });
  const [optionsText, setOptionsText] = useState('');   // "AA, BB, CC"
  const [err, setErr] = useState<string | null>(null);

  // label 변경 시 key 미입력이면 자동 생성
  const [keyTouched, setKeyTouched] = useState(false);
  useEffect(() => {
    if (!keyTouched && draft.label) {
      setDraft((d) => ({ ...d, key: deriveKey(draft.label) }));
    }
  }, [draft.label, keyTouched]);

  const resetDraft = () => {
    setAdding(false);
    setDraft({ key: '', label: '', dataType: 'text', options: [], description: '', sortOrder: 0 });
    setOptionsText('');
    setKeyTouched(false);
    setErr(null);
  };

  const save = async () => {
    setErr(null);
    if (!draft.label.trim() || !draft.key.trim()) {
      setErr('라벨과 key 는 필수입니다.');
      return;
    }
    try {
      const payload: ClusterCustomFieldCreate = {
        ...draft,
        options: draft.dataType === 'select'
          ? optionsText.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined,
      };
      if (payload.dataType === 'select' && (payload.options?.length ?? 0) === 0) {
        setErr('선택지 타입은 최소 1개 옵션이 필요합니다 (쉼표로 구분).');
        return;
      }
      await createMut.mutateAsync(payload);
      resetDraft();
    } catch (e: unknown) {
      const xs = e as { response?: { data?: { detail?: string } }; message?: string };
      setErr(xs.response?.data?.detail ?? xs.message ?? '저장 실패');
    }
  };

  const deleteField = async (f: ClusterCustomField) => {
    if (!confirm(`커스텀 컬럼 "${f.label}" 을(를) 삭제하면 저장된 값도 모든 클러스터에서 사라집니다. 계속할까요?`)) return;
    try {
      await deleteMut.mutateAsync(f.id);
      toast.success('커스텀 컬럼 삭제됨', f.label);
    } catch (e: unknown) {
      toast.error('삭제 실패', formatApiError(e));
    }
  };

  const quickLabel = async (f: ClusterCustomField, v: string) => {
    if (v.trim() === f.label) return;
    await updateMut.mutateAsync({ id: f.id, data: { label: v.trim() } });
  };

  const shift = async (f: ClusterCustomField, dir: -1 | 1) => {
    const idx = fields.findIndex((x) => x.id === f.id);
    const target = fields[idx + dir];
    if (!target) return;
    await updateMut.mutateAsync({ id: f.id, data: { sortOrder: target.sortOrder } });
    await updateMut.mutateAsync({ id: target.id, data: { sortOrder: f.sortOrder } });
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border bg-muted/30">
          <Settings2 className="w-5 h-5 text-primary" />
          <h2 className="text-sm font-semibold">클러스터 커스텀 컬럼 관리</h2>
          <button onClick={onClose}
            className="ml-auto p-1 rounded hover:bg-secondary text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <p className="text-xs text-muted-foreground">
            여기서 추가한 컬럼은 모든 클러스터 테이블에 공통으로 표시됩니다.
            클러스터별 값은 해당 행의 셀에서 직접 수정할 수 있습니다.
          </p>

          {/* 기존 필드 목록 */}
          <div className="border border-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-left">
                <tr className="text-xs text-muted-foreground uppercase">
                  <th className="px-2 py-1.5 w-6"></th>
                  <th className="px-2 py-1.5">라벨</th>
                  <th className="px-2 py-1.5">key</th>
                  <th className="px-2 py-1.5">타입</th>
                  <th className="px-2 py-1.5">옵션</th>
                  <th className="px-2 py-1.5 w-20"></th>
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr><td colSpan={6} className="text-center py-4 text-sm text-muted-foreground">
                    <Loader2 className="w-3 h-3 inline animate-spin mr-1" /> 로딩...
                  </td></tr>
                )}
                {!isLoading && fields.length === 0 && !adding && (
                  <tr><td colSpan={6} className="text-center py-6 text-sm text-muted-foreground">
                    등록된 커스텀 컬럼이 없습니다.
                  </td></tr>
                )}
                {fields.map((f, idx) => (
                  <tr key={f.id} className="border-t border-border">
                    <td className="px-1 py-1 text-muted-foreground/60">
                      <div className="flex flex-col">
                        <button onClick={() => shift(f, -1)} disabled={idx === 0}
                          className="hover:text-foreground disabled:opacity-30 text-xs leading-none">▲</button>
                        <button onClick={() => shift(f, 1)} disabled={idx === fields.length - 1}
                          className="hover:text-foreground disabled:opacity-30 text-xs leading-none">▼</button>
                      </div>
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        defaultValue={f.label}
                        onBlur={(e) => quickLabel(f, e.target.value)}
                        className="w-full bg-transparent border border-transparent hover:border-border focus:border-primary rounded px-1 py-0.5 text-sm"
                      />
                    </td>
                    <td className="px-2 py-1.5 font-mono text-xs text-muted-foreground">
                      {f.key}
                    </td>
                    <td className="px-2 py-1.5 text-sm">
                      <select
                        defaultValue={f.dataType}
                        onChange={(e) => updateMut.mutate({
                          id: f.id, data: { dataType: e.target.value as ClusterCustomFieldType },
                        })}
                        className="bg-background border border-border rounded px-1 py-0.5 text-sm"
                      >
                        {TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1.5 text-xs text-muted-foreground">
                      {f.dataType === 'select' ? (
                        <input
                          defaultValue={(f.options ?? []).join(', ')}
                          onBlur={(e) => {
                            const opts = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
                            updateMut.mutate({ id: f.id, data: { options: opts } });
                          }}
                          placeholder="A, B, C"
                          className="w-full bg-transparent border border-transparent hover:border-border focus:border-primary rounded px-1 py-0.5 font-mono text-xs"
                        />
                      ) : <span className="text-muted-foreground/60">-</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <button onClick={() => deleteField(f)}
                        className="p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                {adding && (
                  <tr className="border-t-2 border-primary/40 bg-primary/5">
                    <td className="px-1 py-1 text-primary text-center">
                      <GripVertical className="w-3 h-3 mx-auto" />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        autoFocus value={draft.label}
                        onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                        placeholder="라벨 (예: 운영환경)"
                        className="w-full px-1 py-0.5 text-sm bg-background border border-border rounded"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        value={draft.key}
                        onChange={(e) => { setDraft({ ...draft, key: e.target.value }); setKeyTouched(true); }}
                        placeholder="ops_env"
                        className="w-full px-1 py-0.5 text-xs font-mono bg-background border border-border rounded"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <select
                        value={draft.dataType ?? 'text'}
                        onChange={(e) => setDraft({ ...draft, dataType: e.target.value as ClusterCustomFieldType })}
                        className="w-full px-1 py-0.5 text-sm bg-background border border-border rounded"
                      >
                        {TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      {draft.dataType === 'select' ? (
                        <input
                          value={optionsText}
                          onChange={(e) => setOptionsText(e.target.value)}
                          placeholder="A, B, C"
                          className="w-full px-1 py-0.5 text-xs font-mono bg-background border border-border rounded"
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground/60">-</span>
                      )}
                    </td>
                    <td className="px-2 py-1 text-right">
                      <div className="flex items-center gap-1 justify-end">
                        <button onClick={save} disabled={createMut.isPending}
                          className="p-1 rounded bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-50">
                          {createMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                        </button>
                        <button onClick={resetDraft}
                          className="p-1 rounded hover:bg-secondary text-muted-foreground">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {err && (
            <div className="px-3 py-2 rounded-lg bg-destructive/10 text-destructive border border-destructive/30 text-sm">
              {err}
            </div>
          )}

          {!adding && (
            <button onClick={() => setAdding(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded-lg">
              <Plus className="w-3 h-3" /> 컬럼 추가
            </button>
          )}
        </div>

        <div className="flex justify-end px-5 py-3 border-t border-border bg-muted/10">
          <button onClick={onClose}
            className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg">
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
