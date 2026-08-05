import { useState } from 'react';
import { Save, FileCode2, Trash2, Pencil, Loader2 } from 'lucide-react';
import {
  useSavedScripts, useCreateSavedScript, useUpdateSavedScript, useDeleteSavedScript,
} from '@/hooks/useSavedScripts';
import type { ScriptLanguage, SavedScript } from '@/types';
import { SavedScriptEditorModal } from './SavedScriptEditorModal';

interface SavedScriptPanelProps {
  /** 현재 명령창 값 — "저장" 시 이 값으로 새 스크립트를 만든다 */
  currentValue: string;
  currentLanguage: ScriptLanguage;
  /** 저장된 스크립트 클릭 시 명령창+언어토글에 주입 */
  onPick: (content: string, language: ScriptLanguage) => void;
  canSave?: boolean;
  className?: string;
}

const LANGUAGE_BADGE: Record<ScriptLanguage, string> = {
  bash: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  python: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
};

/** 사용자별 저장 스크립트(bash/python) — DB 백엔드, 이름 붙여 저장·수정·재사용.
 *  localStorage 전용이던 SavedCommands 를 대체하는 노드 일괄 실행 전용 위젯. */
export function SavedScriptPanel({
  currentValue, currentLanguage, onPick, canSave = true, className = '',
}: SavedScriptPanelProps) {
  const { data: scripts = [], isLoading } = useSavedScripts();
  const createMutation = useCreateSavedScript();
  const updateMutation = useUpdateSavedScript();
  const deleteMutation = useDeleteSavedScript();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingScript, setEditingScript] = useState<SavedScript | null>(null);

  const openCreate = () => { setEditingScript(null); setEditorOpen(true); };
  const openEdit = (s: SavedScript) => { setEditingScript(s); setEditorOpen(true); };
  const closeEditor = () => setEditorOpen(false);

  const handleSave = (data: { name: string; language: ScriptLanguage; content: string; description?: string }) => {
    const mutation = editingScript
      ? updateMutation.mutateAsync({ id: editingScript.id, data })
      : createMutation.mutateAsync(data);
    mutation.then(() => setEditorOpen(false)).catch(() => {
      // 실패해도 모달은 열어둔다 — 사용자가 재시도할 수 있게
    });
  };

  const handleDelete = (s: SavedScript) => {
    if (!confirm(`"${s.name}" 저장된 스크립트를 삭제하시겠습니까?`)) return;
    deleteMutation.mutate(s.id);
  };

  const saving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-sm text-muted-foreground flex items-center gap-1">
          <FileCode2 className="w-3 h-3" />
          저장된 스크립트 <span className="opacity-60">({scripts.length})</span>
          {isLoading && <Loader2 className="w-3 h-3 animate-spin ml-1" />}
        </p>
        <button
          onClick={openCreate}
          disabled={!canSave || !currentValue.trim()}
          className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 disabled:opacity-40 disabled:cursor-not-allowed"
          title={!currentValue.trim() ? '먼저 스크립트를 입력하세요' : '현재 입력된 스크립트 저장'}
        >
          <Save className="w-3 h-3" />
          현재 스크립트 저장
        </button>
      </div>

      {scripts.length === 0 && !isLoading ? (
        <p className="text-xs text-muted-foreground/70 italic py-1">
          저장된 스크립트가 없습니다. 자주 쓰는 bash/python 스크립트를 저장하면 다음에 클릭 한 번으로 불러올 수 있어요.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {scripts.map((s) => (
            <div key={s.id} className="flex items-center gap-0.5 bg-secondary/50 border border-border rounded-md overflow-hidden">
              <span className={`px-1.5 py-1 text-[10px] font-semibold border-r ${LANGUAGE_BADGE[s.language]}`}>
                {s.language}
              </span>
              <button
                onClick={() => onPick(s.content, s.language)}
                title={s.description || s.content}
                className="px-2 py-1 text-xs font-medium hover:bg-secondary max-w-[220px] truncate"
              >
                {s.name}
              </button>
              <button
                onClick={() => openEdit(s)}
                title="수정"
                aria-label={`${s.name} 수정`}
                className="px-1.5 py-1 text-muted-foreground hover:text-primary hover:bg-primary/10"
              >
                <Pencil className="w-3 h-3" />
              </button>
              <button
                onClick={() => handleDelete(s)}
                title="삭제"
                aria-label={`${s.name} 삭제`}
                className="px-1.5 py-1 text-muted-foreground hover:text-red-400 hover:bg-red-500/10"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <SavedScriptEditorModal
        open={editorOpen}
        script={editingScript}
        initialContent={currentValue}
        initialLanguage={currentLanguage}
        onCancel={closeEditor}
        onSave={handleSave}
        saving={saving}
      />
    </div>
  );
}
