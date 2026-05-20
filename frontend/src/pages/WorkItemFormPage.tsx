import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ListTodo } from 'lucide-react';
import { WorkItemForm } from '@/components/work-items';
import { useWorkItems } from '@/hooks/useWorkItems';
import type { WorkItemType } from '@/types';

export function WorkItemFormPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isEdit = !!id;
  const parentId = searchParams.get('parentId') || undefined;
  const queryType = searchParams.get('type');
  const VALID_TYPES: WorkItemType[] = ['task', 'issue', 'meeting', 'training', 'etc'];
  const defaultType: WorkItemType = VALID_TYPES.includes(queryType as WorkItemType)
    ? (queryType as WorkItemType)
    : 'task';

  const { data: listData } = useWorkItems();
  const editTask = isEdit ? listData?.data.find((x) => x.id === id) ?? null : null;
  const parentItem = parentId ? listData?.data.find((x) => x.id === parentId) ?? null : null;

  if (isEdit && listData && !editTask) {
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

  const pageTitle = parentItem ? '하위 작업 등록' : isEdit ? '작업 수정' : '작업 등록';

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
          {parentItem && (
            <span className="ml-2 text-xs text-muted-foreground/80 truncate max-w-[400px]">
              ↳ 상위:&nbsp;
              <span className="text-foreground/80">
                {parentItem.content.replace(/<[^>]*>/g, '').slice(0, 60)}
                {parentItem.content.replace(/<[^>]*>/g, '').length > 60 ? '…' : ''}
              </span>
            </span>
          )}
        </div>
      </div>

      <main className="max-w-[1400px] mx-auto px-6 pt-4 pb-6">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-foreground tracking-tight">{pageTitle}</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {parentItem
                ? '상위 작업의 분류와 담당자가 자동으로 채워집니다.'
                : isEdit
                  ? '필요한 항목을 수정한 뒤 저장 버튼을 누르세요.'
                  : '담당자/분류/일정 후 작업 내용을 작성하세요. 결과·추가 옵션은 접혀 있습니다.'}
            </p>
          </div>
        </div>

        <WorkItemForm
          initial={editTask ?? undefined}
          defaultType={defaultType}
          parentItem={parentItem}
          onCancel={() => navigate('/tasks-mgmt')}
          onSaved={() => navigate('/tasks-mgmt')}
        />
      </main>
    </div>
  );
}
