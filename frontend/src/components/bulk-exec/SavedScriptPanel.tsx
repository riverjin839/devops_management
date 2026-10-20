import { useState } from 'react';
import { Save, FileCode2, Trash2, Pencil, Loader2 } from 'lucide-react';
import {
  useSavedScripts, useCreateSavedScript, useUpdateSavedScript, useDeleteSavedScript,
} from '@/hooks/useSavedScripts';
import type { ScriptLanguage, SavedScript } from '@/types';
import { ConfirmDialog, EmptyState, ErrorState, useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';
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
  bash: 'bg-chart-2/15 text-chart-2-text border-chart-2/30',
  python: 'bg-chart-1/15 text-chart-1-text border-chart-1/30',
};

/** 사용자별 저장 스크립트(bash/python) — DB 백엔드, 이름 붙여 저장·수정·재사용.
 *  localStorage 전용이던 SavedCommands 를 대체하는 노드 일괄 실행 전용 위젯. */
export function SavedScriptPanel({
  currentValue, currentLanguage, onPick, canSave = true, className = '',
}: SavedScriptPanelProps) {
  const { data: scripts = [], isLoading, isError, error, refetch } = useSavedScripts();
  const toast = useToast();
  const createMutation = useCreateSavedScript();
  const updateMutation = useUpdateSavedScript();
  const deleteMutation = useDeleteSavedScript();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingScript, setEditingScript] = useState<SavedScript | null>(null);

  const openCreate = () => { setEditingScript(null); setEditorOpen(true); };
  const openEdit = (s: SavedScript) => { setEditingScript(s); setEditorOpen(true); };
  const closeEditor = () => setEditorOpen(false);

  const handleSave = async (data: { name: string; language: ScriptLanguage; content: string; description?: string | null }) => {
    try {
      if (editingScript) {
        await updateMutation.mutateAsync({ id: editingScript.id, data });
      } else {
        await createMutation.mutateAsync({ ...data, description: data.description ?? undefined });
      }
      setEditorOpen(false);
      toast.success(editingScript ? '스크립트 수정됨' : '스크립트 저장됨', data.name);
    } catch (e) {
      // 실패해도 모달은 열어둔다 — 사유를 보고 재시도할 수 있게(D-159).
      toast.error(editingScript ? '스크립트 수정 실패' : '스크립트 저장 실패', formatApiError(e));
    }
  };

  // 삭제는 ConfirmDialog(danger) 를 거친다(D-161) — native confirm() 대신.
  const [deleting, setDeleting] = useState<SavedScript | null>(null);
  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteMutation.mutateAsync(deleting.id);
      toast.success('스크립트 삭제됨', deleting.name);
      setDeleting(null);
    } catch (e) {
      toast.error('스크립트 삭제 실패', formatApiError(e));
    }
  };

  const saving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-sm text-muted-foreground flex items-center gap-1">
          <FileCode2 className="w-3 h-3" />
          저장된 스크립트 <span>({scripts.length})</span>
          {isLoading && <Loader2 className="w-3 h-3 animate-spin ml-1" aria-label="불러오는 중" />}
        </p>
        <button
          type="button"
          onClick={openCreate}
          disabled={!canSave || !currentValue.trim()}
          className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 disabled:opacity-40 disabled:cursor-not-allowed"
          title={!currentValue.trim() ? '먼저 스크립트를 입력하세요' : '현재 입력된 스크립트 저장'}
        >
          <Save className="w-3 h-3" />
          현재 스크립트 저장
        </button>
      </div>

      {isError ? (
        <ErrorState compact error={error} title="저장된 스크립트를 불러오지 못했습니다" onRetry={() => { void refetch(); }} />
      ) : scripts.length === 0 && !isLoading ? (
        <EmptyState
          compact
          icon={FileCode2}
          title="저장된 스크립트가 없습니다."
          description="자주 쓰는 bash/python 스크립트를 저장하면 다음에 클릭 한 번으로 불러올 수 있습니다."
        />
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {scripts.map((s) => (
            <div key={s.id} className="flex items-center gap-0.5 bg-secondary/50 border border-border rounded-md overflow-hidden">
              <span className={`px-1.5 py-1 text-[11px] font-semibold border-r ${LANGUAGE_BADGE[s.language]}`}>
                {s.language}
              </span>
              <button
                type="button"
                onClick={() => onPick(s.content, s.language)}
                title={s.description || s.content}
                className="px-2 py-1 text-xs font-medium hover:bg-secondary max-w-[220px] truncate"
              >
                {s.name}
              </button>
              <button
                type="button"
                onClick={() => openEdit(s)}
                title="수정"
                aria-label={`${s.name} 수정`}
                className="px-1.5 py-1 text-muted-foreground hover:text-primary hover:bg-primary/10"
              >
                <Pencil className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => setDeleting(s)}
                title="삭제"
                aria-label={`${s.name} 삭제`}
                className="px-1.5 py-1 text-muted-foreground hover:text-status-critical hover:bg-status-critical/10"
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
        onSave={(data) => { void handleSave(data); }}
        saving={saving}
      />

      <ConfirmDialog
        open={!!deleting}
        danger
        busy={deleteMutation.isPending}
        title="저장된 스크립트를 삭제할까요?"
        description="삭제하면 되돌릴 수 없습니다. 명령창에 이미 불러온 내용은 그대로 남습니다."
        confirmLabel="삭제"
        onConfirm={() => { void confirmDelete(); }}
        onCancel={() => setDeleting(null)}
      >
        {deleting && (
          <p>
            <span className="font-medium">{deleting.name}</span>
            <span className="text-muted-foreground"> · {deleting.language}</span>
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
