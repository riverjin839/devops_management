import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ListTodo, Plus, Trash2, UploadCloud } from 'lucide-react';
import { WorkItemForm, WorkItemReadView, RelatedServiceEntriesSidebar, JiraPushDialog } from '@/components/work-items';
import { ConfirmDialog, useToast } from '@/components/common';
import { useWorkItems, useDeleteWorkItem } from '@/hooks/useWorkItems';
import { cn, formatApiError } from '@/lib/utils';

export function WorkItemDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  // 별도 /edit 라우트 없이 페이지 내 상태로 편집 모드 전환. ?edit=1 로 진입 시 바로 편집 모드로 연다
  // (칸반 보드 등 다른 화면의 ✏️ 버튼이 여기로 딥링크).
  const [isEditing, setIsEditing] = useState(searchParams.get('edit') === '1');

  const { data: listData } = useWorkItems();
  const item = listData?.data.find((x) => x.id === id) ?? null;
  const deleteTask = useDeleteWorkItem();
  const toast = useToast();
  // G-I9: window.confirm 대신 ConfirmDialog 사용
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);


  if (listData && !item) {
    return (
      <div className="min-h-screen bg-background">
        <main className="max-w-[1200px] mx-auto px-8 py-8">
          <div className="text-center py-20">
            <ListTodo className="w-12 h-12 mx-auto mb-4 text-muted-foreground/30" />
            <p className="text-muted-foreground mb-4">업무를 찾을 수 없습니다.</p>
            <button
              onClick={() => navigate('/tasks-mgmt')}
              className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg"
            >
              업무 목록으로
            </button>
          </div>
        </main>
      </div>
    );
  }

  if (!item) {
    return <div className="min-h-screen bg-background" />;
  }

  const handleDelete = () => setConfirmDeleteOpen(true);
  const doDelete = () => {
    setConfirmDeleteOpen(false);
    const id = item.id;
    deleteTask.mutate(id, {
      onSuccess: () => {
        localStorage.removeItem('k8s:img:work-item:' + id);
        toast.success('업무 삭제됨');
        navigate('/tasks-mgmt');
      },
      onError: (err) => toast.error('삭제 실패', formatApiError(err, '삭제할 수 없습니다.')),
    });
  };

  const pageTitle = isEditing ? '업무 수정' : '업무 상세';

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-10 bg-background/85 backdrop-blur-md border-b border-border">
        <div className="max-w-[1400px] mx-auto px-8 py-2.5 flex items-center gap-2">
          <button
            onClick={() => navigate('/tasks-mgmt')}
            className="p-1.5 hover:bg-secondary rounded-lg transition-colors text-muted-foreground hover:text-foreground"
            title="목록으로"
            aria-label="목록으로"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <ListTodo className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{pageTitle}</span>
          <div className="ml-auto flex items-center gap-2">
            {!isEditing && item.jiraIssueKey && (
              <button
                onClick={() => setPushOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-brand-jira/10 text-brand-jira dark:text-blue-300 hover:bg-brand-jira/20 border border-brand-jira/20 rounded-lg transition-colors disabled:opacity-50"
                title={`편집 내용을 Jira ${item.jiraIssueKey} 에 반영`}
              >
                <UploadCloud className="w-3.5 h-3.5" />
                Jira 반영
              </button>
            )}
            {!isEditing && (
              <>
                <button
                  onClick={() => navigate(`/tasks-mgmt/new?parentId=${item.id}`)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors"
                  title="하위 업무 등록"
                >
                  <Plus className="w-3.5 h-3.5" /> 하위
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

      <main className="max-w-[1400px] mx-auto px-8 pt-4 pb-16">
        {isEditing ? (
          <div className={cn('border border-border rounded-2xl p-5 mac-shadow', 'bg-card')}>
            <WorkItemForm
              initial={item}
              onCancel={() => setIsEditing(false)}
              onSaved={() => setIsEditing(false)}
              embedded
            />
          </div>
        ) : (
          <div className="flex gap-6 items-start">
            <div className={cn('flex-1 min-w-0 border border-border rounded-2xl p-8 mac-shadow', 'bg-card')}>
              <WorkItemReadView item={item} onEdit={() => setIsEditing(true)} />
            </div>
            {/* Cross-view (Phase A) — 같은 service 의 ServiceEntry 5건 sticky sidebar */}
            {item.service && <RelatedServiceEntriesSidebar service={item.service} />}
          </div>
        )}
      </main>
      <ConfirmDialog
        open={confirmDeleteOpen}
        title="업무 삭제"
        description={`"${item.category}" 업무를 삭제하시겠습니까?`}
        confirmLabel="삭제"
        cancelLabel="취소"
        danger
        onConfirm={doDelete}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
      <JiraPushDialog open={pushOpen} onClose={() => setPushOpen(false)} item={item} />
    </div>
  );
}
