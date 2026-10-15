import { useNavigate, useSearchParams } from 'react-router-dom';
import { ListTodo } from 'lucide-react';
import { PageHeader, PageShell } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
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

  const pageTitle = parentItem ? '하위 업무 추가' : '업무 추가';

  return (
    <div className="app-min-h-screen bg-background">
      <div className="sticky top-0 z-10 bg-background border-b border-border">
        {/* D-123: sticky 헤더 폭·좌측 여백을 본문(hub)과 맞춘다 — 세로 패딩만 얇게 덮어쓴다 */}
        <PageShell density="hub" as="div" className="py-2.5">
          <PageHeader
            className="items-center"
            back={{ to: '/tasks-mgmt', label: '업무 목록' }}
            icon={ListTodo}
            title={pageTitle}
            titleExtra={parentItem && (
              <span className="text-sm text-muted-foreground truncate max-w-[400px]">
                상위:&nbsp;
                <span className="text-foreground/80">
                  {parentItem.content.replace(/<[^>]*>/g, '').slice(0, 60)}
                  {parentItem.content.replace(/<[^>]*>/g, '').length > 60 ? '…' : ''}
                </span>
              </span>
            )}
          />
        </PageShell>
      </div>

      {/* D-123: WorkItemForm 은 최대 10칸 필드 그리드라 4xl(doc)에 안 들어가 hub 밀도 */}
      <PageShell density="hub">
        <MacCard title="업무 정보" bodyPadding="p-5">
          <WorkItemForm
            defaultType={defaultType}
            parentItem={parentItem}
            defaultStartedAt={defaultStartedAt}
            onCancel={() => navigate('/tasks-mgmt')}
            onSaved={() => navigate('/tasks-mgmt')}
            embedded
          />
        </MacCard>
      </PageShell>
    </div>
  );
}
