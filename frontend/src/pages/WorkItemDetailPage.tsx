import { useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { ArrowLeft, ListTodo, Pencil, Plus, Trash2 } from 'lucide-react';
import { WorkItemForm, WorkItemReadView, RelatedServiceEntriesSidebar } from '@/components/work-items';
import { ConfirmDialog, useToast } from '@/components/common';
import { useWorkItems, useDeleteWorkItem } from '@/hooks/useWorkItems';
import { cn, formatApiError } from '@/lib/utils';

export function WorkItemDetailPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const editMode = location.pathname.endsWith('/edit');

  const { data: listData } = useWorkItems();
  const item = listData?.data.find((x) => x.id === id) ?? null;
  const deleteTask = useDeleteWorkItem();
  const toast = useToast();
  // G-I9: window.confirm 대신 ConfirmDialog 사용
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);


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

  const pageTitle = editMode ? '업무 수정' : '업무 상세';

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-10 bg-background/85 backdrop-blur-md border-b border-border">
        <div className="max-w-[1400px] mx-auto px-8 py-2.5 flex items-center gap-2">
          <button
            onClick={() => navigate('/tasks-mgmt')}
            className="p-1.5 hover:bg-secondary rounded-lg transition-colors text-muted-foreground hover:text-foreground"
            title="목록으로"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <ListTodo className="w-4 h-4 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">{pageTitle}</span>
          <div className="ml-auto flex items-center gap-2">
            {!editMode && (
              <>
                <button
                  onClick={() => navigate(`/tasks-mgmt/new?parentId=${item.id}`)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors"
                  title="하위 업무 등록"
                >
                  <Plus className="w-3.5 h-3.5" /> 하위
                </button>
                <button
                  onClick={() => navigate(`/tasks-mgmt/${item.id}/edit`)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5" /> 수정
                </button>
                <button
                  onClick={handleDelete}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-500/10 border border-border rounded-lg transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" /> 삭제
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <main className="max-w-[1400px] mx-auto px-8 pt-4 pb-16">
        {editMode ? (
          <div className={cn('border border-border rounded-2xl p-5 mac-shadow', 'bg-card')}>
            <WorkItemForm
              initial={item}
              onCancel={() => navigate(`/tasks-mgmt/${item.id}`)}
              onSaved={() => navigate(`/tasks-mgmt/${item.id}`)}
              embedded
            />
          </div>
        ) : (
          <div className="flex gap-6 items-start">
            <div className={cn('flex-1 min-w-0 border border-border rounded-2xl p-8 mac-shadow', 'bg-card')}>
              <WorkItemReadView item={item} />
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
    </div>
  );
}
