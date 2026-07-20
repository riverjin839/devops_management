import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { ArrowLeft, HelpCircle, Pencil, Trash2 } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { opsNotesApi } from '@/services/api';
import { OpsNoteForm, OpsNoteReadView } from '@/components/ops-notes';
import { useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';

export function OpsNoteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const editMode = location.pathname.endsWith('/edit');


  const { data, isLoading } = useQuery({
    queryKey: ['ops-notes'],
    queryFn: () => opsNotesApi.getAll().then((r) => r.data),
    staleTime: 1000 * 30,
  });

  const note = useMemo(
    () => (data?.data ?? []).find((n) => n.id === id) ?? null,
    [data, id],
  );

  if (!isLoading && !note) {
    return (
      <div className="min-h-screen bg-background">
        <main className="max-w-[1200px] mx-auto px-8 py-8">
          <div className="text-center py-20">
            <HelpCircle className="w-12 h-12 mx-auto mb-4 text-muted-foreground/30" />
            <p className="text-muted-foreground mb-4">Q&amp;A 를 찾을 수 없습니다.</p>
            <button
              onClick={() => navigate('/ops-notes')}
              className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg"
            >
              Q&amp;A 목록으로
            </button>
          </div>
        </main>
      </div>
    );
  }

  if (!note) {
    return <div className="min-h-screen bg-background" />;
  }

  const handleDelete = async () => {
    if (!confirm(`"${note.title}" Q&A 를 삭제하시겠습니까?`)) return;
    try {
      await opsNotesApi.delete(note.id);
      qc.invalidateQueries({ queryKey: ['ops-notes'] });
      toast.success('Q&A 삭제됨');
      navigate('/ops-notes');
    } catch (e) {
      toast.error('삭제 실패', formatApiError(e));
    }
  };

  const pageTitle = editMode ? 'Q&A 수정' : 'Q&A 상세';

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-10 bg-background/85 backdrop-blur-md border-b border-border">
        <div className="max-w-[1400px] mx-auto px-8 py-2.5 flex items-center gap-2">
          <button
            onClick={() => navigate('/ops-notes')}
            className="p-1.5 hover:bg-secondary rounded-lg transition-colors text-muted-foreground hover:text-foreground"
            title="목록으로"
            aria-label="목록으로"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <HelpCircle className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{pageTitle}</span>
          <div className="ml-auto flex items-center gap-2">
            {!editMode && (
              <>
                <button
                  onClick={() => navigate(`/ops-notes/${note.id}/edit`)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5" /> 수정
                </button>
                <button
                  onClick={handleDelete}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-red-500 hover:bg-red-500/10 border border-border rounded-lg transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" /> 삭제
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <main className="max-w-[1400px] mx-auto px-8 pt-8 pb-16">
        {editMode ? (
          <>
            <div className="mb-8">
              <h1 className="text-3xl font-bold text-foreground tracking-tight">Q&amp;A 수정</h1>
              <p className="text-sm text-muted-foreground mt-1">필요한 항목을 수정한 뒤 폼 하단의 저장 버튼을 누르세요.</p>
            </div>
            <div className={cn('border border-border rounded-2xl p-8 mac-shadow', 'bg-card')}>
              <OpsNoteForm
                initial={note}
                onCancel={() => navigate(`/ops-notes/${note.id}`)}
                onSaved={() => navigate(`/ops-notes/${note.id}`)}
              />
            </div>
          </>
        ) : (
          <div className={cn('border border-border rounded-2xl p-8 mac-shadow', 'bg-card')}>
            <OpsNoteReadView note={note} />
          </div>
        )}
      </main>
    </div>
  );
}
