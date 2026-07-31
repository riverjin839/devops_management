import { useEffect, useState } from 'react';
import { Loader2, Settings2, X } from 'lucide-react';
import { useModalA11y, useToast } from '@/components/common';
import { useConfluenceDocsSettings, useUpdateConfluenceDocsSettings } from '@/hooks/useConfluenceDocs';
import { formatApiError } from '@/lib/utils';

const inputCls =
  'w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm text-foreground ' +
  'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50';

const CATEGORIES = ['배포', '트러블슈팅', '모니터링', '보안', '기타'];

/**
 * 문서 동기화 기본값 설정 (admin) — AppSetting `confluence_documents`.
 * Confluence 접속 정보(SSO)는 Settings → 연동 (Jira) 탭을 그대로 사용하므로 여기서 다루지 않는다.
 */
export function ConfluenceDocsSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useModalA11y(open, onClose);
  const toast = useToast();
  const { data: settings } = useConfluenceDocsSettings();
  const updateMut = useUpdateConfluenceDocsSettings();

  const [spaceKey, setSpaceKey] = useState('');
  const [parentPageId, setParentPageId] = useState('');
  const [defaultCategory, setDefaultCategory] = useState('기타');
  const [titlePrefix, setTitlePrefix] = useState('');

  useEffect(() => {
    if (!open || !settings) return;
    setSpaceKey(settings.spaceKey);
    setParentPageId(settings.parentPageId);
    setDefaultCategory(settings.defaultCategory || '기타');
    setTitlePrefix(settings.titlePrefix);
  }, [open, settings]);

  if (!open) return null;
  const busy = updateMut.isPending;

  const save = async () => {
    try {
      await updateMut.mutateAsync({
        spaceKey: spaceKey.trim(),
        parentPageId: parentPageId.trim(),
        defaultCategory,
        titlePrefix,
      });
      toast.success('저장 완료', '문서 동기화 기본값을 갱신했습니다.');
      onClose();
    } catch (err) {
      toast.error('저장 실패', formatApiError(err));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !busy && onClose()} />
      <div
        ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="confluence-docs-settings-title"
        className="relative bg-card border border-border rounded-2xl mac-shadow w-full max-w-md mx-4"
      >
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Settings2 className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="confluence-docs-settings-title" className="text-base font-semibold leading-tight">문서 동기화 설정</h2>
            <p className="text-xs text-muted-foreground">가져오기/게시 기본값 — 관리자만 수정할 수 있습니다.</p>
          </div>
          <button
            type="button" onClick={onClose} disabled={busy} aria-label="닫기" title="닫기"
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pb-5 space-y-3.5">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium text-muted-foreground">기본 스페이스 키</span>
              <input value={spaceKey} onChange={(e) => setSpaceKey(e.target.value)} placeholder="OPS"
                className={`mt-1 ${inputCls}`} disabled={busy} />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-muted-foreground">기본 부모 페이지 ID</span>
              <input value={parentPageId} onChange={(e) => setParentPageId(e.target.value)} placeholder="비우면 스페이스 루트"
                className={`mt-1 ${inputCls}`} disabled={busy} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium text-muted-foreground">가져오기 기본 분류</span>
              <select value={defaultCategory} onChange={(e) => setDefaultCategory(e.target.value)}
                className={`mt-1 ${inputCls}`} disabled={busy}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-muted-foreground">게시 제목 접두어 (선택)</span>
              <input value={titlePrefix} onChange={(e) => setTitlePrefix(e.target.value)} placeholder="[PEP] "
                className={`mt-1 ${inputCls}`} disabled={busy} />
            </label>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Confluence 접속 정보(SSO 세션·Base URL)는 Settings → <b>연동 (Jira)</b> 탭에서 관리합니다.
          </p>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button" onClick={onClose} disabled={busy}
              className="px-3 py-2 rounded-xl border border-border bg-secondary text-sm hover:bg-secondary/80 disabled:opacity-50"
            >
              취소
            </button>
            <button
              type="button" onClick={save} disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />} 저장
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
