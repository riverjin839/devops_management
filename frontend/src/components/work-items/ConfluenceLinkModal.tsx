import { useState } from 'react';
import { DownloadCloud, X, Loader2, Search, CheckCircle2, AlertTriangle, ExternalLink, RotateCcw } from 'lucide-react';
import { useModalA11y, useToast } from '@/components/common';
import { useConfluenceSearch, useConfluenceLink } from '@/hooks/useJira';
import { formatApiError } from '@/lib/utils';
import type { ConfluenceSearchItem } from '@/types';

interface ConfluenceLinkModalProps {
  open: boolean;
  onClose: () => void;
}

const inputCls =
  'w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm text-foreground ' +
  'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50';

/** 자유 검색어를 CQL 로 변환 — 제목/본문 어느 쪽이든 걸리도록 OR 로 묶는다. 큰따옴표는
 * CQL 문자열 리터럴을 깨므로 이스케이프한다. */
function buildCql(q: string): string {
  const escaped = q.trim().replace(/"/g, '\\"');
  return `title ~ "${escaped}" OR text ~ "${escaped}"`;
}

/**
 * "Confluence 연동" — Jira 가져오기와 동일한 검색→선택→반영 패턴. 본인 세션(SSO/PAT)으로
 * Confluence 를 검색해 고른 페이지를 새 work item(유형=기타, category="Confluence")으로
 * 만들어 게시판에 등록한다. 이미 있는 업무에 문서를 붙이려면 업무 등록/수정 폼의
 * Confluence 링크 입력을 그대로 쓰면 된다 — 이 모달은 "문서를 업무로 들여오기" 전용.
 */
export function ConfluenceLinkModal({ open, onClose }: ConfluenceLinkModalProps) {
  const toast = useToast();
  const dialogRef = useModalA11y(open, onClose);
  const searchMut = useConfluenceSearch();
  const linkMut = useConfluenceLink();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ConfluenceSearchItem[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [searchError, setSearchError] = useState('');
  const [done, setDone] = useState<{ imported: number; failed: string[] } | null>(null);

  if (!open) return null;
  const busy = searchMut.isPending || linkMut.isPending;

  const resetAll = () => {
    setResults(null);
    setPicked(new Set());
    setSearchError('');
    setDone(null);
  };

  const runSearch = async () => {
    if (!query.trim()) return;
    setSearchError('');
    setResults(null);
    setPicked(new Set());
    try {
      const { data } = await searchMut.mutateAsync({ cql: buildCql(query) });
      if (data.status !== 'ok') {
        setSearchError(data.detail || 'Confluence 검색에 실패했습니다.');
        return;
      }
      setResults(data.items);
      if (data.items.length === 0) setSearchError('검색 결과가 없습니다.');
    } catch (err) {
      setSearchError(formatApiError(err));
    }
  };

  const togglePick = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const runImport = async () => {
    const targets = (results ?? []).filter((r) => picked.has(r.id));
    if (!targets.length) return;
    let imported = 0;
    const failed: string[] = [];
    for (const t of targets) {
      try {
        const { data } = await linkMut.mutateAsync({ pageId: t.id, title: t.title, url: t.url });
        if (data?.id) imported += 1; else failed.push(t.title);
      } catch (err) {
        failed.push(`${t.title}: ${formatApiError(err)}`);
      }
    }
    setDone({ imported, failed });
    if (imported) toast.success('업무 등록 완료', `${imported}건을 업무 관리 게시판에 추가했습니다.`);
    if (failed.length) toast.error('일부 실패', failed.slice(0, 3).join(' / '));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !busy && onClose()} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="confluence-link-modal-title"
        className="relative bg-card border border-border rounded-2xl mac-shadow w-full max-w-lg mx-4 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <DownloadCloud className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="confluence-link-modal-title" className="text-base font-semibold leading-tight">Confluence 연동</h2>
            <p className="text-xs text-muted-foreground">
              Confluence 문서를 검색해 업무 관리 게시판에 새 업무로 가져옵니다.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50" aria-label="닫기">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pb-5 space-y-3.5">
          {done ? (
            <>
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
                <div className="flex items-center gap-2 font-medium text-emerald-500">
                  <CheckCircle2 className="w-4 h-4" /> 가져오기 완료
                </div>
                <p className="mt-2 text-sm"><span className="text-muted-foreground">신규</span> <b className="text-emerald-500">{done.imported}</b>건</p>
                {done.failed.length > 0 && (
                  <div className="mt-2 text-xs text-red-500">
                    {done.failed.slice(0, 5).map((e, i) => <div key={i}>⚠ {e}</div>)}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button type="button" onClick={resetAll}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-secondary text-sm hover:bg-secondary/80">
                  <RotateCcw className="w-4 h-4" /> 다시 검색
                </button>
                <button type="button" onClick={onClose}
                  className="ml-auto inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90">
                  닫기
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex gap-2">
                <input
                  className={inputCls}
                  placeholder="문서 제목/내용 검색어"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
                  disabled={busy}
                />
                <button type="button" onClick={runSearch} disabled={busy || !query.trim()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 whitespace-nowrap">
                  {searchMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                  검색
                </button>
              </div>

              {searchError && (
                <div className="rounded-xl bg-red-500/10 text-red-500 px-3 py-2 text-sm flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" /> {searchError}
                </div>
              )}

              {results && results.length > 0 && (
                <div className="rounded-xl border border-border overflow-hidden">
                  <ul className="max-h-64 overflow-y-auto divide-y divide-border/60">
                    {results.map((r) => (
                      <li key={r.id} className="flex items-center gap-2 px-3 py-2 hover:bg-secondary/50">
                        <input
                          type="checkbox"
                          checked={picked.has(r.id)}
                          onChange={() => togglePick(r.id)}
                          aria-label={`${r.title} 선택`}
                        />
                        <span className="flex-1 min-w-0 truncate text-sm">{r.title}</span>
                        {r.spaceKey && <span className="text-xs text-muted-foreground flex-shrink-0">{r.spaceKey}</span>}
                        <a href={r.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                          className="text-muted-foreground hover:text-primary flex-shrink-0" aria-label="새 탭에서 열기">
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button type="button" onClick={onClose} disabled={busy}
                  className="px-3.5 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors disabled:opacity-50">
                  취소
                </button>
                <button type="button" onClick={runImport} disabled={busy || picked.size === 0}
                  className="ml-auto inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50">
                  {linkMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  선택한 {picked.size}건 가져오기
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
