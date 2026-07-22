import { useState } from 'react';
import { X, Plus, Trash2, Settings2 } from 'lucide-react';
import {
  useWorkItemCustomFields, useCreateWorkItemCustomField, useDeleteWorkItemCustomField,
  sortedWorkItemFields,
} from '@/hooks/useWorkItemCustomFields';
import { useModalA11y } from '@/components/common/useModalA11y';
import { useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import type { WorkItemCustomFieldType } from '@/types';

const TYPES: { v: WorkItemCustomFieldType; label: string }[] = [
  { v: 'text', label: '텍스트' },
  { v: 'number', label: '숫자' },
  { v: 'date', label: '날짜' },
  { v: 'checkbox', label: '체크박스' },
  { v: 'select', label: '선택' },
];
const TYPE_LABEL: Record<string, string> = Object.fromEntries(TYPES.map((t) => [t.v, t.label]));

export function WorkItemCustomFieldsManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useModalA11y(open, onClose);
  const { data: fieldsRaw } = useWorkItemCustomFields();
  const fields = sortedWorkItemFields(fieldsRaw);
  const create = useCreateWorkItemCustomField();
  const del = useDeleteWorkItemCustomField();
  const toast = useToast();

  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [dataType, setDataType] = useState<WorkItemCustomFieldType>('text');
  const [optionsText, setOptionsText] = useState('');

  if (!open) return null;

  const add = () => {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key.trim())) {
      toast.error('잘못된 키', '키는 영문으로 시작하고 영문/숫자/_ 만 사용하세요.');
      return;
    }
    if (!label.trim()) { toast.error('이름 필요', '필드 이름을 입력하세요.'); return; }
    create.mutate(
      {
        key: key.trim(),
        label: label.trim(),
        dataType,
        options: dataType === 'select'
          ? optionsText.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined,
      },
      {
        onSuccess: () => { setKey(''); setLabel(''); setOptionsText(''); setDataType('text'); toast.success('필드 추가됨'); },
        onError: (e) => toast.error('추가 실패', formatApiError(e)),
      },
    );
  };

  const remove = (id: string, lbl: string) => {
    if (!window.confirm(`"${lbl}" 필드를 삭제하면 모든 업무의 해당 값도 제거됩니다. 계속할까요?`)) return;
    del.mutate(id, { onError: (e) => toast.error('삭제 실패', formatApiError(e)) });
  };

  const inputCls = 'px-2.5 py-1.5 bg-secondary border border-border rounded-md text-sm focus:outline-none focus:border-primary/50';

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="work-item-custom-fields-modal-title" className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl border border-border bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border">
          <Settings2 className="w-4 h-4 text-primary" />
          <h2 id="work-item-custom-fields-modal-title" className="text-sm font-semibold">업무 사용자 정의 필드</h2>
          <button onClick={onClose} className="ml-auto p-1 rounded hover:bg-secondary text-muted-foreground" aria-label="닫기">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {fields.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-6">정의된 필드가 없습니다. 아래에서 추가하세요.</p>
          ) : (
            fields.map((f) => (
              <div key={f.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                <span className="font-medium">{f.label}</span>
                <span className="text-xs text-muted-foreground font-mono">{f.key}</span>
                <span className="text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">{TYPE_LABEL[f.dataType] ?? f.dataType}</span>
                {f.dataType === 'select' && f.options?.length ? (
                  <span className="text-xs text-muted-foreground truncate">{f.options.join(', ')}</span>
                ) : null}
                <button onClick={() => remove(f.id, f.label)} className="ml-auto p-1 rounded hover:bg-rose-500/10 text-muted-foreground hover:text-rose-500" title="삭제">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="border-t border-border p-4 space-y-2">
          <p className="text-xs font-medium text-muted-foreground">새 필드 추가</p>
          <div className="flex items-center gap-1.5 flex-wrap">
            <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="키(영문, 예: severity)" className={`${inputCls} w-36`} />
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="이름(예: 심각도)" className={`${inputCls} w-32`} />
            <select value={dataType} onChange={(e) => setDataType(e.target.value as WorkItemCustomFieldType)} className={inputCls}>
              {TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
            </select>
            {dataType === 'select' && (
              <input value={optionsText} onChange={(e) => setOptionsText(e.target.value)} placeholder="옵션,쉼표,구분" className={`${inputCls} flex-1 min-w-[120px]`} />
            )}
            <button onClick={add} disabled={create.isPending}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-md disabled:opacity-50">
              <Plus className="w-3.5 h-3.5" /> 추가
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
