import { useMemo, useState } from 'react';
import { StatTile, StatTileRow } from '@/components/common/StatTile';
import { useNavigate } from 'react-router-dom';
import {
  DownloadCloud, FilePlus2, Loader2, Pencil, RefreshCw, Search, Settings2,
  Sparkles, UploadCloud,
} from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { EmptyState, LoadingState, PageShell, RunLogPanel, useToast } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import {
  ConfluenceDocsSettingsDialog, ConfluenceExportDialog, ConfluenceImportModal, SyncStatusBadge,
} from '@/components/documents';
import { useWorkGuides } from '@/hooks/useWorkGuide';
import { useConfluenceDocPull, useGuideSearch } from '@/hooks/useConfluenceDocs';
import { useLogPref } from '@/hooks/useLogPref';
import { runLogged, useRunLog, type RunLogEntry } from '@/hooks/useRunLog';
import { useAuthStore } from '@/stores/authStore';
import { stripHtml } from '@/lib/utils';
import type { GuideSearchItem, WorkGuide } from '@/types';

const CATEGORIES = ['배포', '트러블슈팅', '모니터링', '보안', '기타'];
const STATUS_CFG: Record<string, { label: string; cls: string }> = {
  draft: { label: 'draft', cls: 'bg-secondary text-muted-foreground' },
  active: { label: 'active', cls: 'bg-secondary text-foreground' },
  archived: { label: 'archived', cls: 'bg-secondary text-muted-foreground line-through' },
};

/**
 * 문서 관리 대시보드 (`/documents`) — 파트 문서(WorkGuide)를 한 화면에서 관리하고
 * Confluence 가져오기/게시/재동기화를 실행한다. 문서 편집 자체는 기존
 * `/work-guides/:id` 화면(트리 + 에디터)을 그대로 사용한다.
 */
export function DocumentsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { data, isLoading } = useWorkGuides();
  const pullMut = useConfluenceDocPull();
  const isAdmin = useAuthStore((s) => s.user?.role) === 'admin';
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('documents-pull');

  const [query, setQuery] = useState('');
  const [aiMode, setAiMode] = useState(false);
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportTarget, setExportTarget] = useState<WorkGuide | null>(null);
  const [pullingId, setPullingId] = useState<string | null>(null);

  // AI 검색 — 토글 on + 검색어 입력 시에만 서버 시맨틱 검색을 호출한다
  const aiSearch = useGuideSearch(query, aiMode);

  const guides = useMemo(() => data?.data ?? [], [data]);
  const stats = useMemo(() => ({
    total: guides.length,
    pep: guides.filter((g) => (g.source ?? 'pep') === 'pep').length,
    confluence: guides.filter((g) => g.confluencePageId).length,
    needSync: guides.filter((g) => g.confluenceSyncStatus === 'modified' || g.confluenceSyncStatus === 'error').length,
  }), [guides]);

  const filtered = useMemo(() => {
    let rows = guides;
    if (category) rows = rows.filter((g) => g.category === category);
    if (status) rows = rows.filter((g) => g.status === status);
    if (source === 'pep') rows = rows.filter((g) => !g.confluencePageId && (g.source ?? 'pep') === 'pep');
    if (source === 'confluence') rows = rows.filter((g) => Boolean(g.confluencePageId) || g.source === 'confluence');
    if (source === 'needSync') rows = rows.filter((g) => g.confluenceSyncStatus === 'modified' || g.confluenceSyncStatus === 'error');
    if (!aiMode && query.trim()) {
      const q = query.trim().toLowerCase();
      rows = rows.filter((g) =>
        g.title.toLowerCase().includes(q)
        || stripHtml(g.content ?? '').toLowerCase().includes(q)
        || (g.tags ?? '').toLowerCase().includes(q));
    }
    return [...rows].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }, [guides, category, status, source, query, aiMode]);

  // AI 검색 모드에선 시맨틱 결과 순서대로, 로컬 필터(분류/상태/출처)만 덧입힌다
  const aiData = aiSearch.data;
  const aiRows = useMemo(() => {
    if (!aiMode || !aiData) return null;
    const byId = new Map(guides.map((g) => [g.id, g]));
    const localFiltered = new Set(filtered.map((g) => g.id));
    return aiData.items
      .map((item) => ({ item, guide: byId.get(item.id) }))
      .filter((r): r is { item: GuideSearchItem; guide: WorkGuide } =>
        Boolean(r.guide) && localFiltered.has(r.item.id));
  }, [aiMode, aiData, guides, filtered]);

  const rows: Array<{ guide: WorkGuide; similarity?: number | null }> =
    aiMode && query.trim()
      ? (aiRows ?? []).map((r) => ({ guide: r.guide, similarity: r.item.similarity }))
      : filtered.map((g) => ({ guide: g }));

  const pull = async (guide: WorkGuide) => {
    setPullingId(guide.id);
    const r = await runLogged(runLog, {
      title: 'Confluence 다시 가져오기',
      first: `「${guide.title}」 — 페이지 ${guide.confluencePageId ?? '?'}(현재 v${guide.confluenceVersion ?? '?'}) 최신본 가져오기 요청`,
      fn: () => pullMut.mutateAsync(guide.id),
      summarize: (res) => {
        const out: RunLogEntry[] = [];
        if (res.status !== 'ok') {
          const soft = res.status === 'conflict' || res.status === 'partial' || res.status === 'missing';
          out.push([soft ? 'warn' : 'error', `다시 가져오기 실패 · 상태 ${res.status}${res.detail ? ` — ${res.detail}` : ''}`]);
        } else {
          out.push(['info', `갱신 완료 · v${guide.confluenceVersion ?? '?'} → v${res.version ?? '?'}`]);
        }
        for (const w of res.warnings ?? []) out.push(['warn', `변환 경고 — ${w}`]);
        return out;
      },
    });
    setPullingId(null);
    if (!r.ok) {
      if (!r.aborted) toast.error('다시 가져오기 실패', '실행 로그에서 사유를 확인하세요.');
      return;
    }
    const res = r.data;
    if (res.status !== 'ok') toast.error('다시 가져오기 실패', res.detail);
    else {
      const warn = res.warnings?.length ? ` · 변환 경고 ${res.warnings.length}건(실행 로그 참고)` : '';
      toast.success('다시 가져옴', `「${guide.title}」 v${res.version ?? '?'} 로 갱신했습니다.${warn}`);
    }
  };

  return (
    <PageShell density="hub" className="space-y-4">
      {/* 헤더 + 툴바 */}
      <PageHeader
        title="문서 관리"
        description="파트 문서를 한곳에서 관리하고 Confluence 와 동기화합니다 — 가져온 문서는 AI 검색·LLM 학습 소스로 자동 편입됩니다."
        actions={
          <>
          <button
            type="button" onClick={() => navigate('/work-guides/new')}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-border bg-secondary text-sm font-medium hover:bg-secondary/80"
          >
            <FilePlus2 className="w-4 h-4" /> 새 문서
          </button>
          <button
            type="button" onClick={() => setImportOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
          >
            <DownloadCloud className="w-4 h-4" /> Confluence 가져오기
          </button>
          {isAdmin && (
            <button
              type="button" onClick={() => setSettingsOpen(true)}
              className="p-2 rounded-xl border border-border bg-secondary text-muted-foreground hover:text-foreground"
              aria-label="문서 동기화 설정" title="문서 동기화 설정"
            >
              <Settings2 className="w-4 h-4" />
            </button>
          )}
          </>
        }
      />

      {/* 요약 타일 */}
      <StatTileRow>
        {([
          { key: '', label: '전체 문서', value: stats.total },
          { key: 'pep', label: 'PEP 작성', value: stats.pep },
          { key: 'confluence', label: 'Confluence 연동', value: stats.confluence },
          { key: 'needSync', label: '동기화 필요', value: stats.needSync, tone: 'warning' as const },
        ]).map((t) => (
          <StatTile key={t.label} label={t.label} value={t.value} tone={t.tone} onClick={() => setSource(t.key)} active={source === t.key} />
        ))}
      </StatTileRow>

      {/* 검색 + 필터 */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={aiMode ? '의미 기반 검색 — 예: etcd 스냅샷 복구 방법' : '제목·내용·태그 검색'}
            className="w-full pl-9 pr-3 py-2 bg-card border border-border rounded-xl text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
          />
        </div>
        <button
          type="button" onClick={() => setAiMode((v) => !v)} aria-pressed={aiMode}
          title="임베딩 기반 의미 검색 (Ollama 미기동 시 일반 검색으로 폴백)"
          className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border text-sm font-medium transition-colors ${
            aiMode ? 'bg-primary/10 text-primary border-primary/40'
              : 'bg-card border-border text-muted-foreground hover:text-foreground'
          }`}
        >
          <Sparkles className="w-4 h-4" /> AI 검색
        </button>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="분류 필터"
          className="px-3 py-2 bg-card border border-border rounded-xl text-sm">
          <option value="">분류: 전체</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="상태 필터"
          className="px-3 py-2 bg-card border border-border rounded-xl text-sm">
          <option value="">상태: 전체</option>
          <option value="draft">draft</option>
          <option value="active">active</option>
          <option value="archived">archived</option>
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="출처 필터"
          className="px-3 py-2 bg-card border border-border rounded-xl text-sm">
          <option value="">출처: 전체</option>
          <option value="pep">PEP 작성</option>
          <option value="confluence">Confluence 연동</option>
          <option value="needSync">동기화 필요</option>
        </select>
      </div>

      {aiMode && query.trim() && aiSearch.data && !aiSearch.data.embeddingAvailable && (
        <p className="text-[11px] text-muted-foreground">
          시맨틱 검색을 사용할 수 없어 일반 텍스트 매칭 결과를 보여줍니다 (Ollama 임베딩 모델 미기동 또는 임베딩 미계산).
        </p>
      )}

      {/* 문서 테이블 */}
      <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />

      <MacCard title="문서" bodyPadding="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="px-4 py-2.5 font-medium">제목</th>
                <th className="px-3 py-2.5 font-medium">분류</th>
                <th className="px-3 py-2.5 font-medium">상태</th>
                <th className="px-3 py-2.5 font-medium">작성자</th>
                <th className="px-3 py-2.5 font-medium">출처</th>
                <th className="px-3 py-2.5 font-medium">동기화</th>
                <th className="px-3 py-2.5 font-medium">수정일</th>
                <th className="px-3 py-2.5" aria-label="행 동작" />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ guide, similarity }) => {
                const st = STATUS_CFG[guide.status] ?? STATUS_CFG.draft;
                return (
                  <tr
                    key={guide.id}
                    onClick={() => navigate(`/work-guides/${guide.id}`)}
                    className="border-b border-border last:border-b-0 hover:bg-secondary/50 cursor-pointer group"
                  >
                    <td className="px-4 py-2.5">
                      <div className="font-medium">{guide.title}</div>
                      {similarity != null && (
                        <div className="text-[11px] text-primary">유사도 {(similarity * 100).toFixed(0)}%</div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">{guide.category || '—'}</td>
                    <td className="px-3 py-2.5">
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${st.cls}`}>{st.label}</span>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">{guide.author || '—'}</td>
                    <td className="px-3 py-2.5">
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${
                        guide.confluencePageId || guide.source === 'confluence'
                          ? 'bg-chart-1/15 text-chart-1' : 'bg-secondary text-muted-foreground'
                      }`}>
                        {guide.confluencePageId || guide.source === 'confluence' ? 'Confluence' : 'PEP'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      {guide.confluencePageId
                        ? <SyncStatusBadge guide={guide} showVersion />
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground tabular-nums whitespace-nowrap">
                      {(guide.updatedAt || '').slice(0, 10)}
                    </td>
                    <td className="px-3 py-2.5">
                      <div
                        className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button" onClick={() => setExportTarget(guide)}
                          className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary"
                          aria-label="Confluence 게시" title="Confluence 게시"
                        >
                          <UploadCloud className="w-4 h-4" />
                        </button>
                        {guide.confluencePageId && (
                          <button
                            type="button" onClick={() => pull(guide)} disabled={pullingId === guide.id}
                            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50"
                            aria-label="Confluence 에서 다시 가져오기" title="Confluence 에서 다시 가져오기"
                          >
                            {pullingId === guide.id
                              ? <Loader2 className="w-4 h-4 animate-spin" />
                              : <RefreshCw className="w-4 h-4" />}
                          </button>
                        )}
                        <button
                          type="button" onClick={() => navigate(`/work-guides/${guide.id}/edit`)}
                          className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary"
                          aria-label="편집" title="편집"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!isLoading && rows.length === 0 && (
            <div className="py-10">
              <EmptyState
                title={query.trim() ? '검색 결과가 없습니다' : '문서가 없습니다'}
                description={query.trim() ? '다른 검색어나 필터를 시도해 보세요.' : '새 문서를 작성하거나 Confluence 에서 가져오세요.'}
              />
            </div>
          )}
          {isLoading && (
            <LoadingState />
          )}
        </div>
      </MacCard>

      <ConfluenceImportModal open={importOpen} onClose={() => setImportOpen(false)} />
      <ConfluenceExportDialog open={Boolean(exportTarget)} onClose={() => setExportTarget(null)} guide={exportTarget} />
      <ConfluenceDocsSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </PageShell>
  );
}
