import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { PageHeader } from '@/components/common/PageHeader';
import { ArrowLeft, HelpCircle, Pencil, Trash2 } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { opsNotesApi } from '@/services/api';
import { OpsNoteForm, OpsNoteReadView } from '@/components/ops-notes';
import { useToast, EmptyState, PageShell } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { formatApiError } from '@/lib/utils';
import { useMemo } from 'react';

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
      <div className="app-min-h-screen bg-background">
        <PageShell density="doc">
          <EmptyState
            icon={HelpCircle}
            title="Q&A 를 찾을 수 없습니다."
            description="삭제됐거나 주소가 잘못됐을 수 있습니다."
            action={{ label: 'Q&A 목록으로', onClick: () => navigate('/ops-notes') }}
          />
        </PageShell>
      </div>
    );
  }

  if (!note) {
    return <div className="app-min-h-screen bg-background" />;
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
    <div className="app-min-h-screen bg-background">
      <div className="sticky top-0 z-10 bg-background border-b border-border">
        <div className="max-w-4xl mx-auto px-8 py-2.5 flex items-center gap-2">
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
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-status-critical hover:bg-status-critical/10 border border-border rounded-lg transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" /> 삭제
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <PageShell density="doc">
        {editMode ? (
          <>
            <PageHeader title="Q&A 수정" description="필요한 항목을 수정한 뒤 폼 하단의 저장 버튼을 누르세요." className="mb-8" />
            <MacCard title="Q&A 정보" bodyPadding="p-8">
              <OpsNoteForm
                initial={note}
                onCancel={() => navigate(`/ops-notes/${note.id}`)}
                onSaved={() => navigate(`/ops-notes/${note.id}`)}
              />
            </MacCard>
          </>
        ) : (
          // D-122: 읽기 뷰 하나만 감싸던 카드를 걷음 — doc 밀도에서 본문으로 바로 읽힌다.
          <OpsNoteReadView note={note} />
        )}
      </PageShell>
    </div>
  );
}
