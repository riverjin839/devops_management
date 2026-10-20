import { Link, useNavigate, useParams, useLocation } from 'react-router-dom';
import { PageHeader } from '@/components/common/PageHeader';
import { ArrowLeft, HelpCircle, Pencil, Trash2 } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { opsNotesApi } from '@/services/api';
import { OpsNoteForm, OpsNoteReadView } from '@/components/ops-notes';
import { useToast, ConfirmDialog, EmptyState, ErrorState, LoadingState, PageShell } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { formatApiError } from '@/lib/utils';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useMemo, useState } from 'react';

export function OpsNoteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const editMode = location.pathname.endsWith('/edit');
  const { canOperate, withHint, ariaWithHint } = useCanOperate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['ops-notes'],
    queryFn: () => opsNotesApi.getAll().then((r) => r.data),
    staleTime: 1000 * 30,
  });

  const note = useMemo(
    () => (data?.data ?? []).find((n) => n.id === id) ?? null,
    [data, id],
  );

  // 분기 순서: 로딩 → 조회 실패 → 없음(조회 성공 + 목록에 없을 때만, D-137).
  if (isLoading) {
    return (
      <div className="app-min-h-screen bg-background">
        <PageShell density="doc"><LoadingState /></PageShell>
      </div>
    );
  }

  if (isError && !note) {
    return (
      <div className="app-min-h-screen bg-background">
        <PageShell density="doc">
          <ErrorState error={error} title="Q&A 를 불러오지 못했습니다" onRetry={() => { void refetch(); }} />
        </PageShell>
      </div>
    );
  }

  if (!note) {
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

  // 삭제는 ConfirmDialog(danger) 로 확인한다(D-142).
  const handleDelete = async () => {
    setDeleting(true);
    try {
      await opsNotesApi.delete(note.id);
      qc.invalidateQueries({ queryKey: ['ops-notes'] });
      toast.success('Q&A 삭제됨');
      setConfirmOpen(false);
      navigate('/ops-notes');
    } catch (e) {
      toast.error('삭제 실패', formatApiError(e));
    } finally {
      setDeleting(false);
    }
  };

  // D-149 ⑤: PageShell 밖에서 폭을 따로 잡던 sticky 바(`max-w-4xl mx-auto px-8`)와 h1 과 겹치던
  // 바 라벨을 걷었다. 편집 모드는 PageHeader back 슬롯, 읽기 모드는 h1(제목)을 읽기 뷰가 그리므로
  // 뒤로가기·수정·삭제만 PageShell 안 한 줄로 둔다.
  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="doc">
        {editMode ? (
          <>
            <PageHeader
              title="Q&A 수정"
              description="필요한 항목을 수정한 뒤 폼 하단의 저장 버튼을 누르세요."
              back={{ to: `/ops-notes/${note.id}`, label: '상세로' }}
              className="mb-8"
            />
            <MacCard title="Q&A 정보" bodyPadding="p-8">
              <OpsNoteForm
                initial={note}
                onCancel={() => navigate(`/ops-notes/${note.id}`)}
                onSaved={() => navigate(`/ops-notes/${note.id}`)}
              />
            </MacCard>
          </>
        ) : (
          <>
            <nav aria-label="Q&A 상세 도구" className="flex items-center gap-2 mb-6">
              <Link
                to="/ops-notes"
                className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground whitespace-nowrap"
              >
                <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                Q&amp;A 목록
              </Link>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => navigate(`/ops-notes/${note.id}/edit`)}
                  disabled={!canOperate}
                  title={withHint('수정')}
                  aria-label={canOperate ? undefined : ariaWithHint('수정')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Pencil className="w-3.5 h-3.5" aria-hidden="true" /> 수정
                </button>
                <button
                  onClick={() => setConfirmOpen(true)}
                  disabled={!canOperate}
                  title={withHint('삭제')}
                  aria-label={canOperate ? undefined : ariaWithHint('삭제')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-status-critical hover:bg-status-critical/10 border border-border rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> 삭제
                </button>
              </div>
            </nav>
            {/* D-122: 읽기 뷰 하나만 감싸던 카드를 걷음 — doc 밀도에서 본문으로 바로 읽힌다. */}
            <OpsNoteReadView note={note} />
          </>
        )}
      </PageShell>

      <ConfirmDialog
        open={confirmOpen}
        title="Q&A 삭제"
        description={`"${note.title}" Q&A 를 삭제합니다. 답변·히스토리도 함께 지워지며 되돌릴 수 없습니다.`}
        confirmLabel="삭제"
        danger
        busy={deleting}
        onConfirm={() => { void handleDelete(); }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
