import { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2, UploadCloud, X, AlertTriangle } from 'lucide-react';
import { RunLogPanel, useModalA11y, useToast } from '@/components/common';
import { useConfluenceDocExport, useConfluenceDocsSettings } from '@/hooks/useConfluenceDocs';
import { useLogPref } from '@/hooks/useLogPref';
import { runLogged, useRunLog, type RunLogEntry } from '@/hooks/useRunLog';
import type { ConfluenceDocExportResult, WorkGuide } from '@/types';

const inputCls =
  'w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm text-foreground ' +
  'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50';

interface Props {
  open: boolean;
  onClose: () => void;
  guide: WorkGuide | null;
}

/**
 * 문서 → Confluence 게시 다이얼로그.
 * 이미 연결된 문서는 같은 페이지의 새 버전으로 갱신되고(스페이스 입력 불필요),
 * 미연결 문서는 스페이스(기본값 = 문서 동기화 설정)에 새 페이지로 생성된다.
 */
export function ConfluenceExportDialog({ open, onClose, guide }: Props) {
  const dialogRef = useModalA11y(open, onClose);
  const toast = useToast();
  const exportMut = useConfluenceDocExport();
  const { data: settings } = useConfluenceDocsSettings();

  const [spaceKey, setSpaceKey] = useState('');
  const [parentPageId, setParentPageId] = useState('');
  const [title, setTitle] = useState('');
  const [result, setResult] = useState<ConfluenceDocExportResult | null>(null);
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('confluence-doc-export');

  useEffect(() => {
    if (!open || !guide) return;
    setSpaceKey(guide.confluenceSpaceKey || settings?.spaceKey || '');
    setParentPageId(settings?.parentPageId || '');
    setTitle(guide.title);
    setResult(null);
    runLog.clear();
    // 설정 로드가 늦게 끝나도 사용자가 입력한 값을 덮지 않도록 open/guide 변경 시에만 초기화
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, guide?.id]);

  if (!open || !guide) return null;
  const linked = Boolean(guide.confluencePageId);
  const busy = exportMut.isPending;

  const publish = async () => {
    const pageTitle = title.trim() || guide.title;
    const r = await runLogged(runLog, {
      title: 'Confluence 게시',
      first: linked
        ? `"${pageTitle}" — 연결된 페이지 ${guide.confluencePageId}(v${guide.confluenceVersion ?? '?'}) 새 버전 게시 요청`
        : `"${pageTitle}" — 스페이스 ${spaceKey.trim()}${parentPageId.trim() ? ` · 부모 ${parentPageId.trim()}` : ' 루트'} 에 새 페이지 생성 요청`,
      fn: () => exportMut.mutateAsync({
        guideId: guide.id,
        data: {
          spaceKey: spaceKey.trim() || undefined,
          parentPageId: parentPageId.trim() || undefined,
          title: title.trim() || undefined,
        },
      }),
      summarize: (res) => {
        const out: RunLogEntry[] = [];
        if (res.status !== 'ok') {
          const soft = res.status === 'conflict' || res.status === 'partial' || res.status === 'missing';
          out.push([soft ? 'warn' : 'error', `게시 실패 · 상태 ${res.status}${res.detail ? ` — ${res.detail}` : ''}`]);
        } else {
          out.push(['info', `${res.action === 'created' ? '페이지 생성' : res.action === 'updated' ? '새 버전 갱신' : `처리 ${res.action}`}`
            + `${res.pageId ? ` · 페이지 ${res.pageId}` : ''} · 버전 v${res.version ?? '?'}`]);
          if (res.pageUrl) out.push(['info', `페이지 URL — ${res.pageUrl}`]);
        }
        for (const w of res.warnings ?? []) out.push(['warn', `변환 경고 — ${w}`]);
        return out;
      },
    });
    if (!r.ok) {
      if (!r.aborted) toast.error('게시 실패', '실행 로그에서 사유를 확인하세요.');
      return;
    }
    const data = r.data;
    if (data.status !== 'ok') {
      toast.error('게시 실패', data.detail);
      return;
    }
    setResult(data);
    toast.success(
      'Confluence 게시됨',
      data.action === 'created' ? '새 페이지를 생성했습니다.' : `새 버전(v${data.version ?? '?'})으로 갱신했습니다.`,
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !busy && onClose()} />
      <div
        ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="confluence-export-title"
        className="relative bg-card border border-border rounded-md shadow-card w-full max-w-md mx-4 max-h-[92vh] overflow-y-auto"
      >
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <UploadCloud className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="confluence-export-title" className="text-base font-semibold leading-tight">Confluence 게시</h2>
            <p className="text-xs text-muted-foreground truncate">{guide.title}</p>
          </div>
          <button
            type="button" onClick={onClose} disabled={busy} aria-label="닫기" title="닫기"
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pb-5 space-y-3.5">
          <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-48" />
          {result ? (
            <>
              <div className="rounded-xl border border-status-healthy/30 bg-status-healthy/5 p-4">
                <div className="flex items-center gap-2 font-medium text-status-healthy">
                  <CheckCircle2 className="w-4 h-4" />
                  {result.action === 'created' ? '페이지 생성 완료' : `새 버전 게시 완료 (v${result.version ?? '?'})`}
                </div>
                {result.pageUrl && (
                  <a
                    href={result.pageUrl} target="_blank" rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                  >
                    <ExternalLink className="w-3.5 h-3.5" /> Confluence 에서 열기
                  </a>
                )}
                {result.warnings.length > 0 && (
                  <div className="mt-2 space-y-0.5 text-xs text-status-warning">
                    {result.warnings.map((w, i) => <div key={i}><AlertTriangle className="inline w-3 h-3 mr-1 align-[-2px]" aria-hidden />{w}</div>)}
                  </div>
                )}
              </div>
              <div className="flex justify-end">
                <button
                  type="button" onClick={onClose}
                  className="px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
                >
                  닫기
                </button>
              </div>
            </>
          ) : (
            <>
              {linked ? (
                <div className="rounded-xl border border-border bg-secondary/60 px-3 py-2.5 text-xs text-muted-foreground">
                  연결된 페이지(v{guide.confluenceVersion ?? '?'})의 <b className="text-foreground">새 버전</b>으로 게시됩니다.
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs font-medium text-muted-foreground">스페이스 키</span>
                    <input
                      value={spaceKey} onChange={(e) => setSpaceKey(e.target.value)}
                      placeholder={settings?.spaceKey || 'OPS'} className={`mt-1 ${inputCls}`} disabled={busy}
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium text-muted-foreground">부모 페이지 ID (선택)</span>
                    <input
                      value={parentPageId} onChange={(e) => setParentPageId(e.target.value)}
                      placeholder="비우면 스페이스 루트" className={`mt-1 ${inputCls}`} disabled={busy}
                    />
                  </label>
                </div>
              )}
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground">페이지 제목</span>
                <input
                  value={title} onChange={(e) => setTitle(e.target.value)}
                  className={`mt-1 ${inputCls}`} disabled={busy}
                />
              </label>
              <p className="text-[11px] text-muted-foreground">
                본문의 붙여넣기 이미지는 페이지 첨부파일로 업로드되고, Callout·토글·코드 블록은
                Confluence 매크로로 변환됩니다.
              </p>
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button" onClick={onClose} disabled={busy}
                  className="px-3 py-2 rounded-xl border border-border bg-secondary text-sm hover:bg-secondary/80 disabled:opacity-50"
                >
                  취소
                </button>
                <button
                  type="button" onClick={publish} disabled={busy || (!linked && !spaceKey.trim())}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
                  게시
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
