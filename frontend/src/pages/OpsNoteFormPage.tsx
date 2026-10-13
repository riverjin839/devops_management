import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/common/PageHeader';
import { ArrowLeft, HelpCircle } from 'lucide-react';
import { OpsNoteForm } from '@/components/ops-notes';

export function OpsNoteFormPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const defaultService = searchParams.get('service') ?? 'k8s';


  return (
    <div className="app-min-h-screen bg-background">
      <div className="sticky top-0 z-10 bg-background border-b border-border">
        <div className="max-w-[1400px] mx-auto px-8 py-2.5 flex items-center gap-2">
          <button
            onClick={() => navigate('/ops-notes')}
            className="p-1.5 hover:bg-secondary rounded-lg transition-colors text-muted-foreground hover:text-foreground"
            title="목록으로"
            aria-label="목록으로"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <HelpCircle className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">새 Q&amp;A</span>
        </div>
      </div>

      <main className="max-w-[1400px] mx-auto px-8 pt-10 pb-16">
        <PageHeader title="새 Q&A" description="서비스, 질문, 답변, 히스토리를 입력하세요." className="mb-8" />

        <div className="bg-card border border-border rounded-md p-8 shadow-card">
          <OpsNoteForm
            defaultService={defaultService}
            onCancel={() => navigate('/ops-notes')}
            onSaved={(savedId) => {
              if (savedId) navigate(`/ops-notes/${savedId}`);
              else navigate('/ops-notes');
            }}
          />
        </div>
      </main>
    </div>
  );
}
