import { useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, DownloadCloud,
  ExternalLink, Loader2, RotateCcw, Search, X,
} from 'lucide-react';
import { useModalA11y, useToast } from '@/components/common';
import { useConfluenceDocImport, useConfluenceDocSearch } from '@/hooks/useConfluenceDocs';
import { useWorkGuides } from '@/hooks/useWorkGuide';
import { formatApiError } from '@/lib/utils';
import type { ConfluenceDocImportResult, ConfluenceDocSearchItem } from '@/types';

const inputCls =
  'w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm text-foreground ' +
  'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50';

const ACTION_META: Record<string, { label: string; cls: string }> = {
  create: { label: 'create', cls: 'bg-emerald-500/10 text-emerald-500' },
  update: { label: 'update', cls: 'bg-blue-500/10 text-blue-500' },
  unchanged: { label: 'unchanged', cls: 'bg-secondary text-muted-foreground' },
  error: { label: 'error', cls: 'bg-red-500/10 text-red-500' },
};

type SearchMode = 'simple' | 'cql';
type ContributorMode = 'me' | 'user' | 'any';

const CONTRIBUTOR_OPTIONS: { id: ContributorMode; label: string }[] = [
  { id: 'me', label: '나 (기본)' },
  { id: 'user', label: '특정 사용자' },
  { id: 'any', label: '전체' },
];

const PERIOD_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '전체 기간' },
  { value: '7', label: '최근 7일' },
  { value: '30', label: '최근 30일' },
  { value: '90', label: '최근 90일' },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Confluence 문서 가져오기 위저드 — JiraImportModal 과 동일한 dry-run → 선택 → 커밋 흐름.
 * 1) 검색(간편/CQL) → 페이지 선택  2) dry-run 미리보기(action/changes)  3) 커밋 결과.
 */
export function ConfluenceImportModal({ open, onClose }: Props) {
  const dialogRef = useModalA11y(open, onClose);
  const toast = useToast();
  const searchMut = useConfluenceDocSearch();
  const importMut = useConfluenceDocImport();
  const { data: guides } = useWorkGuides();

  const [mode, setMode] = useState<SearchMode>('simple');
  const [spaceKey, setSpaceKey] = useState('');
  const [text, setText] = useState('');
  // 기본값 '나' — 본인이 기여한 문서를 기준으로 가져오기 시작 (요청사항)
  const [contributorMode, setContributorMode] = useState<ContributorMode>('me');
  const [contributorUser, setContributorUser] = useState('');
  const [labelsInput, setLabelsInput] = useState('');
  const [period, setPeriod] = useState('');
  const [cql, setCql] = useState('');
  const [found, setFound] = useState<ConfluenceDocSearchItem[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [parentGuideId, setParentGuideId] = useState('');
  const [inlineImages, setInlineImages] = useState(false);
  const [preview, setPreview] = useState<ConfluenceDocImportResult | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<ConfluenceDocImportResult | null>(null);

  // 가져올 위치(상위 문서) 후보 — 최상위 문서만 간단히 노출
  const parentOptions = useMemo(
    () => (guides?.data ?? []).filter((g) => !g.parentId).slice(0, 100),
    [guides],
  );

  if (!open) return null;
  const busy = searchMut.isPending || importMut.isPending;

  const resetAll = () => {
    setFound(null); setPicked(new Set()); setPreview(null);
    setExcluded(new Set()); setExpanded(new Set()); setDone(null);
  };

  const runSearch = async () => {
    setFound(null); setPicked(new Set()); setPreview(null);
    try {
      const data = await searchMut.mutateAsync(
        mode === 'cql'
          ? { cql: cql.trim(), limit: 50 }
          : {
              spaceKey: spaceKey.trim() || undefined,
              text: text.trim() || undefined,
              contributorMode,
              contributor: contributorMode === 'user' ? contributorUser.trim() || undefined : undefined,
              labels: labelsInput.trim()
                ? labelsInput.split(',').map((l) => l.trim()).filter(Boolean)
                : undefined,
              updatedSinceDays: period ? Number(period) : undefined,
              limit: 50,
            },
      );
      if (data.status !== 'ok') {
        toast.error('Confluence ' + (data.status === 'offline' ? '연결 실패' : '오류'), data.detail || '검색에 실패했습니다.');
        return;
      }
      setFound(data.items);
      // 미연결 페이지는 기본 선택 — 대개 그대로 가져오려는 흐름이다.
      setPicked(new Set(data.items.filter((i) => !i.linked).map((i) => i.id)));
      if (data.items.length === 0) toast.info('검색 결과 없음', '조건에 맞는 페이지가 없습니다.');
    } catch (err) {
      toast.error('검색 실패', formatApiError(err));
    }
  };

  const runImport = async (dryRun: boolean) => {
    const pageIds = [...picked];
    if (!pageIds.length) { toast.error('선택된 페이지가 없습니다'); return; }
    try {
      const data = await importMut.mutateAsync({
        pageIds,
        dryRun,
        onlyPageIds: !dryRun && excluded.size > 0 ? pageIds.filter((p) => !excluded.has(p)) : undefined,
        parentGuideId: parentGuideId || undefined,
        inlineImages,
      });
      if (data.status !== 'ok') {
        toast.error('가져오기 ' + (data.status === 'offline' ? '연결 실패' : '오류'), data.detail || '가져오기에 실패했습니다.');
        return;
      }
      if (dryRun) {
        setPreview(data);
        setExcluded(new Set());
        const c = data.items.filter((i) => i.action === 'create').length;
        const u = data.items.filter((i) => i.action === 'update').length;
        toast.info('미리보기 완료', `신규 ${c} · 갱신 ${u} · 변경없음 ${data.items.filter((i) => i.action === 'unchanged').length}`);
      } else {
        setDone(data);
        setPreview(null);
        toast.success('Confluence 가져오기 완료', `신규 ${data.imported} · 갱신 ${data.updated}`);
      }
    } catch (err) {
      toast.error('요청 실패', formatApiError(err));
    }
  };

  const toggleSet = (set: Set<string>, id: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    setter(next);
  };

  const applicable = (preview?.items ?? []).filter((i) => i.action === 'create' || i.action === 'update');
  const commitCount = applicable.filter((i) => !excluded.has(i.pageId)).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !busy && onClose()} />
      <div
        ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="confluence-import-title"
        className="relative bg-card border border-border rounded-2xl mac-shadow w-full max-w-2xl mx-4 max-h-[92vh] overflow-y-auto"
      >
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <DownloadCloud className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="confluence-import-title" className="text-base font-semibold leading-tight">Confluence 문서 가져오기</h2>
            <p className="text-xs text-muted-foreground">
              페이지를 검색해 미리보기로 확인한 뒤 선택한 문서만 가져옵니다. 가져온 문서는 AI 검색 대상에 자동 포함됩니다.
            </p>
          </div>
          <button
            type="button" onClick={onClose} disabled={busy} aria-label="닫기" title="닫기"
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pb-5 space-y-3.5">
          {done ? (
            /* ── 3단계: 결과 ─────────────────────────────────────────── */
            <>
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
                <div className="flex items-center gap-2 font-medium text-emerald-500">
                  <CheckCircle2 className="w-4 h-4" /> 가져오기 완료
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
                  <div><span className="text-muted-foreground">신규</span> <b className="text-emerald-500">{done.imported}</b></div>
                  <div><span className="text-muted-foreground">갱신</span> <b className="text-blue-500">{done.updated}</b></div>
                  <div><span className="text-muted-foreground">건너뜀</span> <b>{done.skipped}</b></div>
                </div>
                {done.errors.length > 0 && (
                  <div className="mt-2 text-xs text-red-500">
                    {done.errors.slice(0, 5).map((e, i) => <div key={i}>⚠ {e}</div>)}
                  </div>
                )}
              </div>
              {done.warnings.length > 0 && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-500 space-y-0.5">
                  <div className="flex items-center gap-1.5 font-medium"><AlertTriangle className="w-3.5 h-3.5" /> 변환 경고 {done.warnings.length}건</div>
                  {done.warnings.slice(0, 6).map((w, i) => <div key={i}>· {w}</div>)}
                  {done.warnings.length > 6 && <div>… 외 {done.warnings.length - 6}건</div>}
                </div>
              )}
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button" onClick={resetAll}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border bg-secondary text-sm hover:bg-secondary/80"
                >
                  <RotateCcw className="w-4 h-4" /> 다시 가져오기
                </button>
                <button
                  type="button" onClick={onClose}
                  className="ml-auto px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
                >
                  닫기
                </button>
              </div>
            </>
          ) : preview ? (
            /* ── 2단계: dry-run 미리보기 ─────────────────────────────── */
            <>
              <div className="rounded-xl border border-border overflow-hidden">
                {preview.items.map((item) => {
                  const meta = ACTION_META[item.action] ?? ACTION_META.error;
                  const selectable = item.action === 'create' || item.action === 'update';
                  const checked = selectable && !excluded.has(item.pageId);
                  const isOpen = expanded.has(item.pageId);
                  return (
                    <div key={item.pageId} className="border-b border-border last:border-b-0">
                      <div className={`flex items-center gap-2.5 px-3 py-2 text-sm ${selectable ? '' : 'opacity-60'}`}>
                        <input
                          type="checkbox" checked={checked} disabled={!selectable}
                          onChange={() => toggleSet(excluded, item.pageId, setExcluded)}
                          className="accent-[hsl(var(--primary))]" aria-label={`${item.title} 선택`}
                        />
                        <button
                          type="button"
                          onClick={() => toggleSet(expanded, item.pageId, setExpanded)}
                          className="flex-1 min-w-0 text-left"
                        >
                          <span className="font-medium truncate block">{item.title || item.pageId}</span>
                          <span className="text-[11px] text-muted-foreground">
                            {item.spaceKey}{item.version ? ` · v${item.version}` : ''}
                            {item.warnings.length > 0 && ` · ⚠ ${item.warnings.length}`}
                          </span>
                        </button>
                        <span className={`px-2 py-0.5 rounded-md text-[11px] font-semibold ${meta.cls}`}>{meta.label}</span>
                        {(item.changes.length > 0 || item.warnings.length > 0) && (
                          <button
                            type="button" onClick={() => toggleSet(expanded, item.pageId, setExpanded)}
                            className="p-1 rounded text-muted-foreground hover:text-foreground"
                            aria-label="상세 보기" title="상세 보기"
                          >
                            {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          </button>
                        )}
                      </div>
                      {isOpen && (
                        <div className="px-9 pb-2.5 space-y-0.5 text-xs">
                          {item.changes.map((c, i) => (
                            <div key={i} className="text-muted-foreground">
                              <span className="font-mono">{c.field}</span>
                              {c.old != null && <> : <span className="line-through">{c.old}</span></>}
                              {c.new != null && <> → <span className="text-foreground">{c.new}</span></>}
                            </div>
                          ))}
                          {item.warnings.map((w, i) => <div key={`w${i}`} className="text-amber-500">⚠ {w}</div>)}
                          {item.detail && <div className="text-red-500">{item.detail}</div>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">
                체크된 문서만 가져옵니다. unchanged 는 원격 버전이 그대로라 건너뜁니다.
              </p>
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button" onClick={() => setPreview(null)} disabled={busy}
                  className="px-3 py-2 rounded-xl border border-border bg-secondary text-sm hover:bg-secondary/80 disabled:opacity-50"
                >
                  뒤로
                </button>
                <button
                  type="button" onClick={() => runImport(false)} disabled={busy || commitCount === 0}
                  className="ml-auto inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <DownloadCloud className="w-4 h-4" />}
                  선택 {commitCount}건 가져오기
                </button>
              </div>
            </>
          ) : (
            /* ── 1단계: 검색 + 페이지 선택 ───────────────────────────── */
            <>
              <div className="flex items-stretch gap-1.5">
                {([
                  { id: 'simple' as const, label: '간편 검색' },
                  { id: 'cql' as const, label: 'CQL 직접 입력' },
                ]).map((m) => (
                  <button
                    key={m.id} type="button" onClick={() => setMode(m.id)} aria-pressed={mode === m.id}
                    className={`flex-1 px-3 py-2 rounded-xl border text-sm font-medium transition-colors ${
                      mode === m.id
                        ? 'bg-primary/10 text-primary border-primary/30 ring-2 ring-primary/20'
                        : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              {mode === 'simple' ? (
                <div className="space-y-3">
                  <div>
                    <span className="text-xs font-medium text-muted-foreground">기여자 (contributor)</span>
                    <div className="mt-1 flex items-stretch gap-1.5">
                      {CONTRIBUTOR_OPTIONS.map((c) => (
                        <button
                          key={c.id} type="button" onClick={() => setContributorMode(c.id)}
                          aria-pressed={contributorMode === c.id}
                          className={`flex-1 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                            contributorMode === c.id
                              ? 'bg-primary/10 text-primary border-primary/30 ring-2 ring-primary/20'
                              : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                    {contributorMode === 'user' && (
                      <input
                        value={contributorUser} onChange={(e) => setContributorUser(e.target.value)}
                        placeholder="사용자명 (콤마로 여러 명)"
                        className={`mt-1.5 ${inputCls}`} disabled={busy}
                      />
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-xs font-medium text-muted-foreground">스페이스 키</span>
                      <input
                        value={spaceKey} onChange={(e) => setSpaceKey(e.target.value)} placeholder="예: OPS (비우면 전체)"
                        className={`mt-1 ${inputCls}`} disabled={busy}
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium text-muted-foreground">라벨</span>
                      <input
                        value={labelsInput} onChange={(e) => setLabelsInput(e.target.value)} placeholder="예: runbook, etcd (콤마 구분)"
                        className={`mt-1 ${inputCls}`} disabled={busy}
                      />
                    </label>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-xs font-medium text-muted-foreground">최근 수정 기간</span>
                      <select
                        value={period} onChange={(e) => setPeriod(e.target.value)}
                        className={`mt-1 ${inputCls}`} disabled={busy}
                      >
                        {PERIOD_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium text-muted-foreground">검색어</span>
                      <input
                        value={text} onChange={(e) => setText(e.target.value)} placeholder="제목·본문 텍스트"
                        className={`mt-1 ${inputCls}`} disabled={busy}
                        onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
                      />
                    </label>
                  </div>
                </div>
              ) : (
                <label className="block">
                  <span className="text-xs font-medium text-muted-foreground">CQL</span>
                  <input
                    value={cql} onChange={(e) => setCql(e.target.value)}
                    placeholder='예: space = "OPS" and type = page and text ~ "etcd"'
                    className={`mt-1 font-mono ${inputCls}`} disabled={busy}
                    onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
                  />
                </label>
              )}

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs font-medium text-muted-foreground">가져올 위치 (상위 문서)</span>
                  <select
                    value={parentGuideId} onChange={(e) => setParentGuideId(e.target.value)}
                    className={`mt-1 ${inputCls}`} disabled={busy}
                  >
                    <option value="">— 최상위 —</option>
                    {parentOptions.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
                  </select>
                </label>
                <label className="flex items-end gap-2 pb-2 text-sm text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox" checked={inlineImages} onChange={(e) => setInlineImages(e.target.checked)}
                    className="accent-[hsl(var(--primary))]" disabled={busy}
                  />
                  첨부 이미지를 본문에 저장
                  <span className="text-[10px]">(기본: 원본 링크)</span>
                </label>
              </div>

              <button
                type="button" onClick={runSearch}
                disabled={busy || (mode === 'cql'
                  ? !cql.trim()
                  : (contributorMode === 'user' && !contributorUser.trim())
                    || !(contributorMode !== 'any' || spaceKey.trim() || labelsInput.trim() || period || text.trim()))}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
              >
                {searchMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                검색
              </button>

              {found && found.length > 0 && (
                <>
                  <div className="rounded-xl border border-border overflow-hidden max-h-72 overflow-y-auto">
                    {found.map((item) => (
                      <label
                        key={item.id}
                        className={`flex items-center gap-2.5 px-3 py-2 text-sm border-b border-border last:border-b-0 cursor-pointer hover:bg-secondary/60 ${item.linked ? 'opacity-60' : ''}`}
                      >
                        <input
                          type="checkbox" checked={picked.has(item.id)}
                          onChange={() => toggleSet(picked, item.id, setPicked)}
                          className="accent-[hsl(var(--primary))]"
                        />
                        <span className="flex-1 min-w-0">
                          <span className="font-medium truncate block">{item.title}</span>
                          <span className="text-[11px] text-muted-foreground">
                            {item.spaceKey}{item.updated ? ` · ${item.updated.slice(0, 10)}` : ''}
                            {item.linked && ' · 이미 연결됨'}
                          </span>
                        </span>
                        {item.url && (
                          <a
                            href={item.url} target="_blank" rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="p-1 rounded text-muted-foreground hover:text-foreground"
                            aria-label="Confluence 에서 열기" title="Confluence 에서 열기"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}
                      </label>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-xs text-muted-foreground">{picked.size}건 선택됨 (최대 50)</span>
                    <button
                      type="button" onClick={() => runImport(true)} disabled={busy || picked.size === 0 || picked.size > 50}
                      className="ml-auto inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                    >
                      {importMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
                      미리보기
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
