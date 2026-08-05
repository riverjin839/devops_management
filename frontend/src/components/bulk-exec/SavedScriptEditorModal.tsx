import { useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';
import { useModalA11y } from '@/components/common/useModalA11y';
import type { SavedScript, ScriptLanguage } from '@/types';

interface SavedScriptEditorModalProps {
  open: boolean;
  /** 지정하면 수정 모드, 없으면 새로 만들기 */
  script?: SavedScript | null;
  /** "현재 명령 저장" 진입 시 명령창 내용을 초기값으로 채움 */
  initialContent?: string;
  initialLanguage?: ScriptLanguage;
  onCancel: () => void;
  onSave: (data: { name: string; language: ScriptLanguage; content: string; description?: string }) => void;
  saving?: boolean;
}

/** 저장 스크립트 생성/수정 폼 — ConfirmDialog 와 동일한 커스텀 모달 패턴(useModalA11y). */
export function SavedScriptEditorModal({
  open, script, initialContent = '', initialLanguage = 'bash',
  onCancel, onSave, saving = false,
}: SavedScriptEditorModalProps) {
  const dialogRef = useModalA11y(open, onCancel);
  const titleId = useId();
  const nameId = useId();
  const descriptionId = useId();
  const contentId = useId();

  const [name, setName] = useState('');
  const [language, setLanguage] = useState<ScriptLanguage>('bash');
  const [content, setContent] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(script?.name ?? '');
    setLanguage(script?.language ?? initialLanguage);
    setContent(script?.content ?? initialContent);
    setDescription(script?.description ?? '');
    // 열릴 때만 초기화 — 이후 입력 중 initialContent 재계산으로 덮어쓰지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, script?.id]);

  if (!open) return null;

  const canSave = name.trim().length > 0 && content.trim().length > 0;

  const submit = () => {
    if (!canSave || saving) return;
    onSave({ name: name.trim(), language, content, description: description.trim() || undefined });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative bg-card border border-border rounded-2xl mac-shadow w-full max-w-xl mx-4 overflow-hidden"
      >
        <div className="flex items-start gap-3 px-5 py-4 border-b border-border bg-muted/30">
          <div className="flex-1 min-w-0">
            <h2 id={titleId} className="text-sm font-semibold">
              {script ? '스크립트 수정' : '스크립트 저장'}
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              bash/python 스크립트를 이름 붙여 저장하면 다음에 목록에서 바로 불러올 수 있습니다.
            </p>
          </div>
          <button
            onClick={onCancel}
            aria-label="닫기"
            className="p-1 rounded hover:bg-secondary text-muted-foreground flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-2">
              <label htmlFor={nameId} className="block text-sm text-muted-foreground mb-1">이름</label>
              <input
                id={nameId}
                data-autofocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="예: 디스크 사용량 점검"
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <p className="block text-sm text-muted-foreground mb-1">언어</p>
              <div className="flex items-center bg-secondary/60 rounded-lg p-[3px] gap-px">
                {(['bash', 'python'] as const).map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setLanguage(l)}
                    className={`flex-1 px-2 py-1.5 text-sm font-medium rounded-md transition-all ${
                      language === l
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground/70 hover:text-foreground'
                    }`}
                  >
                    {l === 'bash' ? 'bash' : 'python'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <label htmlFor={descriptionId} className="block text-sm text-muted-foreground mb-1">설명 (선택)</label>
            <input
              id={descriptionId}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="이 스크립트가 무엇을 하는지 한 줄로"
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div>
            <label htmlFor={contentId} className="block text-sm text-muted-foreground mb-1">
              스크립트 본문 {language === 'python' && '(python3 로 원격 실행됩니다)'}
            </label>
            <textarea
              id={contentId}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={language === 'python' ? 'import os\nprint(os.uname())' : 'uname -a && free -m && uptime'}
              rows={10}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary resize-y"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/10">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl"
          >
            취소
          </button>
          <button
            onClick={submit}
            disabled={!canSave || saving}
            className="px-4 py-1.5 text-sm font-semibold rounded-xl text-primary-foreground bg-primary hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
