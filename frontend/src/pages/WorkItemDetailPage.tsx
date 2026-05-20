import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { ArrowLeft, ListTodo, Pencil, Trash2, Plus } from 'lucide-react';
import { WorkItemForm, WorkItemReadView } from '@/components/work-items';
import { useWorkItems, useDeleteWorkItem } from '@/hooks/useWorkItems';

export function WorkItemDetailPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const editMode = location.pathname.endsWith('/edit');

  const { data: listData } = useWorkItems();
  const item = listData?.data.find((x) => x.id === id) ?? null;
  const deleteTask = useDeleteWorkItem();

  if (listData && !item) {
    return (
      <div className="min-h-screen bg-background">
        <main className="max-w-[1200px] mx-auto px-8 py-8">
          <div className="text-center py-20">
            <ListTodo className="w-12 h-12 mx-auto mb-4 text-muted-foreground/30" />
            <p className="text-muted-foreground mb-4">작업을 찾을 수 없습니다.</p>
            <button
              onClick={() => navigate('/tasks-mgmt')}
              className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg"
            >
              작업 목록으로
            </button>
          </div>
        </main>
      </div>
    );
  }

  if (!item) {
    return <div className="min-h-screen bg-background" />;
  }

  const handleDelete = () => {
    if (!confirm(`"${item.category}" 작업을 삭제하시겠습니까?`)) return;
    deleteTask.mutate(item.id);
    localStorage.removeItem('k8s:img:work-item:' + item.id);
    navigate('/tasks-mgmt');
  };

  const pageTitle = editMode ? '작업 수정' : '작업 상세';

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
          {!editMode && (
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => navigate(`/tasks-mgmt/new?parentId=${item.id}`)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors"
                title="하위 작업 등록"
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
            </div>
          )}
        </div>
      </div>

      <main className="max-w-[1400px] mx-auto px-8 pt-8 pb-16">
        {editMode ? (
          <>
            <div className="mb-8">
              <h1 className="text-3xl font-bold text-foreground tracking-tight">작업 수정</h1>
              <p className="text-sm text-muted-foreground mt-1">필요한 항목을 수정한 뒤 폼 하단의 저장 버튼을 누르세요.</p>
            </div>
            <WorkItemForm
              initial={item}
              onCancel={() => navigate(`/tasks-mgmt/${item.id}`)}
              onSaved={() => navigate(`/tasks-mgmt/${item.id}`)}
            />
          </>
        ) : (
          <div className="bg-card border border-border rounded-2xl p-8 mac-shadow">
            <WorkItemReadView item={item} />
          </div>
        )}
      </main>
    </div>
  );
}
