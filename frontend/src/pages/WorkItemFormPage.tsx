import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ListTodo } from 'lucide-react';
import { WorkItemForm } from '@/components/work-items';
import { useWorkItems } from '@/hooks/useWorkItems';
import type { WorkItemType } from '@/types';

// 업무 신규 등록 전용 페이지 (`/tasks-mgmt/new`). 기존 업무 수정은 상세 페이지에서 바로 진행하며
// 별도 수정 페이지/라우트는 없다 (WorkItemDetailPage 참고).
export function WorkItemFormPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const parentId = searchParams.get('parentId') || undefined;
  const queryType = searchParams.get('type');
  const VALID_TYPES: WorkItemType[] = ['task', 'issue', 'meeting', 'training', 'etc'];
  const defaultType: WorkItemType = VALID_TYPES.includes(queryType as WorkItemType)
    ? (queryType as WorkItemType)
    : 'task';
  const defaultStartedAt = searchParams.get('startedAt') || undefined;

  const { data: listData } = useWorkItems();
  const parentItem = parentId ? listData?.data.find((x) => x.id === parentId) ?? null : null;

  const pageTitle = parentItem ? '하위 업무 등록' : '업무 등록';

  return (
    <div className="app-min-h-screen bg-background">
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
          {parentItem && (
            <span className="ml-2 text-sm text-muted-foreground/80 truncate max-w-[400px]">
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
        <div className="border border-border rounded-2xl p-5 mac-shadow bg-card">
          <WorkItemForm
            defaultType={defaultType}
            parentItem={parentItem}
            defaultStartedAt={defaultStartedAt}
            onCancel={() => navigate('/tasks-mgmt')}
            onSaved={() => navigate('/tasks-mgmt')}
            embedded
          />
        </div>
      </main>
    </div>
  );
}
