import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ListTodo, Plus, Trash2, UploadCloud, Ticket } from 'lucide-react';
import { WorkItemForm, WorkItemReadView, JiraPushDialog, ServiceNowRegisterDialog } from '@/components/work-items';
import { ConfirmDialog, useToast, EmptyState, PageHeader, PageShell } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { useWorkItem, useDeleteWorkItem } from '@/hooks/useWorkItems';
import { formatApiError } from '@/lib/utils';

export function WorkItemDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  // 별도 /edit 라우트 없이 페이지 내 상태로 편집 모드 전환. ?edit=1 로 진입 시 바로 편집 모드로 연다
  // (칸반 보드 등 다른 화면의 ✏️ 버튼이 여기로 딥링크).
  const [isEditing, setIsEditing] = useState(searchParams.get('edit') === '1');

  // 단건 API 로 직접 조회 — 목록(useWorkItems) 은 정렬/상한이 있어 그 범위 밖의 업무는
  // 목록에서 못 찾고 "업무를 찾을 수 없습니다"로 오탐했다(홈 위젯 등 더 넓은 범위로 조회한
  // 화면에서 딥링크로 들어올 때 특히 발생).
  const { data: item, isLoading, isError } = useWorkItem(id);
  const deleteTask = useDeleteWorkItem();
  const toast = useToast();
  // G-I9: window.confirm 대신 ConfirmDialog 사용
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const [serviceNowOpen, setServiceNowOpen] = useState(false);

  if (!isLoading && (isError || !item)) {
    return (
      <div className="app-min-h-screen bg-background">
        <PageShell density="hub">
          <EmptyState
            icon={ListTodo}
            title="업무를 찾을 수 없습니다."
            description="삭제됐거나 주소가 잘못됐을 수 있습니다."
            action={{ label: '업무 목록으로', onClick: () => navigate('/tasks-mgmt') }}
          />
        </PageShell>
      </div>
    );
  }

  if (!item) {
    return <div className="app-min-h-screen bg-background" />;
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
    <div className="app-min-h-screen bg-background">
      <div className="sticky top-0 z-10 bg-background border-b border-border">
        {/* D-123: sticky 헤더 폭·좌측 여백을 본문(hub)과 맞춘다 — 세로 패딩만 얇게 덮어쓴다 */}
        <PageShell density="hub" as="div" className="py-2.5">
          <PageHeader
            className="items-center"
            back={{ to: '/tasks-mgmt', label: '업무 목록' }}
            icon={ListTodo}
            title={pageTitle}
            actions={<>
              {!isEditing && item.jiraIssueKey && (
                <button
                  onClick={() => setPushOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-brand-jira/10 text-brand-jira hover:bg-brand-jira/20 border border-brand-jira/20 rounded-lg transition-colors disabled:opacity-50"
                  title={`편집 내용을 Jira ${item.jiraIssueKey} 에 반영`}
                >
                  <UploadCloud className="w-3.5 h-3.5" />
                  Jira 반영
                </button>
              )}
              {!isEditing && item.jiraIssueKey && (
                <button
                  onClick={() => setServiceNowOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-brand-servicenow/10 text-brand-servicenow hover:bg-brand-servicenow/20 border border-brand-servicenow/20 rounded-lg transition-colors disabled:opacity-50"
                  title={item.servicenowNumber
                    ? `ServiceNow ${item.servicenowNumber} 등록됨 — 다시 등록`
                    : '사내 ServiceNow ITSM 에 등록'}
                >
                  <Ticket className="w-3.5 h-3.5" />
                  {item.servicenowNumber ? 'ServiceNow 재등록' : 'ServiceNow 등록'}
                </button>
              )}
              {!isEditing && (
                <>
                  <button
                    onClick={() => navigate(`/tasks-mgmt/new?parentId=${item.id}`)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors"
                    title="하위 업무 추가"
                  >
                    <Plus className="w-3.5 h-3.5" /> 하위
                  </button>
                  <button
                    onClick={handleDelete}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-status-critical hover:bg-status-critical/10 border border-border rounded-lg transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> 삭제
                  </button>
                </>
              )}
            </>}
          />
        </PageShell>
      </div>

      {/* D-123: WorkItemForm 은 최대 10칸 필드 그리드라 4xl(doc)에 안 들어가 hub 밀도 */}
      <PageShell density="hub">
        {isEditing ? (
          <MacCard title="업무 정보" bodyPadding="p-5">
            <WorkItemForm
              initial={item}
              onCancel={() => setIsEditing(false)}
              onSaved={() => setIsEditing(false)}
              embedded
            />
          </MacCard>
        ) : (
          <MacCard title="업무 정보" bodyPadding="p-8">
            <WorkItemReadView item={item} onEdit={() => setIsEditing(true)} />
          </MacCard>
        )}
      </PageShell>
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
      <ServiceNowRegisterDialog open={serviceNowOpen} onClose={() => setServiceNowOpen(false)} item={item} />
    </div>
  );
}
