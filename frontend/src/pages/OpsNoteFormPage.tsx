import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/common/PageHeader';
import { OpsNoteForm } from '@/components/ops-notes';
import { PageShell } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';

export function OpsNoteFormPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const defaultService = searchParams.get('service') ?? 'k8s';


  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="doc">
        <PageHeader
          title="새 Q&A"
          description="서비스, 질문, 답변, 히스토리를 입력하세요."
          back={{ to: '/ops-notes', label: '목록으로' }}
          className="mb-8"
        />

        <MacCard title="Q&A 정보" bodyPadding="p-8">
          <OpsNoteForm
            defaultService={defaultService}
            onCancel={() => navigate('/ops-notes')}
            onSaved={(savedId) => {
              if (savedId) navigate(`/ops-notes/${savedId}`);
              else navigate('/ops-notes');
            }}
          />
        </MacCard>
      </PageShell>
    </div>
  );
}
