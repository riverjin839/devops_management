import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, HelpCircle, Sun } from 'lucide-react';
import { OpsNoteForm } from '@/components/ops-notes';
import { useEditorWhiteBg } from '@/hooks/useEditorWhiteBg';
import { cn } from '@/lib/utils';

export function OpsNoteFormPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const defaultService = searchParams.get('service') ?? 'k8s';

  const { editorWhiteBg, toggle, isLoggedIn } = useEditorWhiteBg();

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-10 bg-background/85 backdrop-blur-md border-b border-border">
        <div className="max-w-[1400px] mx-auto px-8 py-2.5 flex items-center gap-2">
          <button
            onClick={() => navigate('/ops-notes')}
            className="p-1.5 hover:bg-secondary rounded-lg transition-colors text-muted-foreground hover:text-foreground"
            title="목록으로"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <HelpCircle className="w-4 h-4 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">새 Q&amp;A</span>
          {isLoggedIn && (
            <button
              onClick={toggle}
              className={cn(
                'ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors',
                editorWhiteBg
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-secondary',
              )}
              title={editorWhiteBg ? '흰 배경 끄기' : '흰 배경 켜기'}
            >
              <Sun className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">흰 배경</span>
            </button>
          )}
        </div>
      </div>

      <main className="max-w-[1400px] mx-auto px-8 pt-10 pb-16">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground tracking-tight">새 Q&amp;A</h1>
          <p className="text-sm text-muted-foreground mt-1">
            서비스, 질문, 답변, 히스토리를 입력하세요.
          </p>
        </div>

        <div className={cn('border border-border rounded-2xl p-8 mac-shadow', editorWhiteBg ? 'bg-white' : 'bg-card')}>
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
