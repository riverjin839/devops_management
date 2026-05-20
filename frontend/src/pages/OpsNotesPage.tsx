import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  HelpCircle, Plus, Pencil, Trash2, X, Pin, PinOff, Search, MessageSquare,
  Sparkles, ChevronRight, FileQuestion, ExternalLink, List, LayoutGrid,
  PenLine, Ship, KeyRound, Bug, Hammer, RefreshCw, Package, Layers,
} from 'lucide-react';
import { RichContent } from '@/components/editor';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { opsNotesApi } from '@/services/api';
import type { OpsNote, OpsNoteColor } from '@/types';
import { useToast, ViewModeBar } from '@/components/common';
import { formatApiError, formatRelativeTime } from '@/lib/utils';
import { MacCard } from '@/components/ui/MacCard';
import { OpsNoteTable, type OpsNoteSortKey } from '@/components/ops-notes/OpsNoteTable';

// ── 서비스 목록 ───────────────────────────────────────────────────────────────
type ServiceMeta = {
  value: string;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  accent: string;
  ring: string;
  soft: string;
};

const SERVICES: ServiceMeta[] = [
  { value: 'k8s',      label: 'Kubernetes', Icon: Ship,      accent: 'bg-sky-500',     ring: 'ring-sky-500/30',     soft: 'bg-sky-500/10 text-sky-600 dark:text-sky-300' },
  { value: 'keycloak', label: 'Keycloak',   Icon: KeyRound,  accent: 'bg-orange-500',  ring: 'ring-orange-500/30',  soft: 'bg-orange-500/10 text-orange-600 dark:text-orange-300' },
  { value: 'cilium',   label: 'Cilium',     Icon: Bug,       accent: 'bg-yellow-500',  ring: 'ring-yellow-500/30',  soft: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-300' },
  { value: 'jenkins',  label: 'Jenkins',    Icon: Hammer,    accent: 'bg-blue-500',    ring: 'ring-blue-500/30',    soft: 'bg-blue-500/10 text-blue-600 dark:text-blue-300' },
  { value: 'argocd',   label: 'ArgoCD',     Icon: RefreshCw, accent: 'bg-violet-500',  ring: 'ring-violet-500/30',  soft: 'bg-violet-500/10 text-violet-600 dark:text-violet-300' },
  { value: 'nexus',    label: 'Nexus',      Icon: Package,   accent: 'bg-emerald-500', ring: 'ring-emerald-500/30', soft: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300' },
  { value: 'etc',      label: '기타',        Icon: Layers,    accent: 'bg-slate-500',   ring: 'ring-slate-500/30',   soft: 'bg-slate-500/10 text-slate-600 dark:text-slate-300' },
];
const SERVICE_MAP = Object.fromEntries(SERVICES.map((s) => [s.value, s]));

// ── 카드 색상 (앞면 살짝 은은한 tint) ──────────────────────────────────────────
const CARD_TINT: Record<OpsNoteColor, { stripe: string; tint: string; chip: string }> = {
  yellow: { stripe: 'bg-amber-400',  tint: 'bg-amber-50/60 dark:bg-amber-500/[0.06]',  chip: 'bg-amber-500/15  text-amber-700  dark:text-amber-300' },
  green:  { stripe: 'bg-emerald-400', tint: 'bg-emerald-50/60 dark:bg-emerald-500/[0.06]', chip: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  blue:   { stripe: 'bg-sky-400',    tint: 'bg-sky-50/60 dark:bg-sky-500/[0.06]',     chip: 'bg-sky-500/15    text-sky-700    dark:text-sky-300' },
  pink:   { stripe: 'bg-pink-400',   tint: 'bg-pink-50/60 dark:bg-pink-500/[0.06]',    chip: 'bg-pink-500/15   text-pink-700   dark:text-pink-300' },
  purple: { stripe: 'bg-purple-400', tint: 'bg-purple-50/60 dark:bg-purple-500/[0.06]', chip: 'bg-purple-500/15 text-purple-700 dark:text-purple-300' },
};

// ── Q&A 카드 ──────────────────────────────────────────────────────────────────
interface QnaCardProps {
  note: OpsNote;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
}

type CardTab = 'answer' | 'history';

function QnaCard({ note, onOpen, onEdit, onDelete, onTogglePin }: QnaCardProps) {
  const svc = SERVICE_MAP[note.service];
  const SvcIcon = svc?.Icon;
  const tint = CARD_TINT[note.color] ?? CARD_TINT.yellow;
  const hasBack = Boolean(note.backContent?.trim());
  const hasAnswer = Boolean(note.content?.trim());
  const [tab, setTab] = useState<CardTab>('answer');
  const activeTab = !hasAnswer && hasBack ? 'history' : tab;

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      className={`group relative rounded-2xl border border-border overflow-hidden bg-card hover:shadow-md hover:-translate-y-0.5 transition-all flex flex-col cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40 ${tint.tint}`}
      style={{ minHeight: '230px' }}
    >
      {/* 색상 띠 (좌측) */}
      <span className={`absolute left-0 top-0 bottom-0 w-1 ${tint.stripe}`} aria-hidden />

      {/* 헤더 */}
      <header className="flex items-center justify-between gap-2 pl-4 pr-2 pt-3">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-md text-white ${svc?.accent ?? 'bg-slate-500'}`}>
            {SvcIcon && <SvcIcon className="w-3 h-3" />}
            {svc?.label ?? note.service}
          </span>
          {note.pinned && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-primary/15 text-primary">
              <Pin className="w-2.5 h-2.5" /> 고정
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => { stop(e); onTogglePin(); }}
            className="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-primary transition-colors"
            title={note.pinned ? '고정 해제' : '상단 고정'}
            aria-label={note.pinned ? '고정 해제' : '상단 고정'}
          >
            {note.pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={(e) => { stop(e); onEdit(); }}
            className="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-primary transition-colors"
            title="수정"
            aria-label="수정"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => { stop(e); onDelete(); }}
            className="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-red-500 transition-colors"
            title="삭제"
            aria-label="삭제"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* 질문 */}
      <div className="px-4 pt-2 pb-2">
        <div className="flex items-start gap-1.5">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-primary text-primary-foreground text-[11px] font-bold flex-shrink-0 mt-0.5">
            Q
          </span>
          <h3 className="text-sm font-semibold leading-snug line-clamp-2 text-foreground">
            {note.title}
          </h3>
        </div>
      </div>

      {/* 탭 (답변 / 히스토리) */}
      {hasBack && hasAnswer && (
        <div className="px-4 pb-1 flex items-center gap-1">
          {(['answer', 'history'] as const).map((t) => (
            <button
              key={t}
              onClick={(e) => { stop(e); setTab(t); }}
              className={`text-[11px] px-2 py-0.5 rounded-md transition-colors ${
                activeTab === t
                  ? 'bg-foreground/10 text-foreground font-semibold'
                  : 'text-muted-foreground hover:bg-secondary'
              }`}
            >
              {t === 'answer' ? '답변' : '히스토리'}
            </button>
          ))}
        </div>
      )}

      {/* 본문 */}
      <div className="px-4 pb-3 flex-1 min-h-0">
        <div className="flex items-start gap-1.5">
          <span
            className={`inline-flex items-center justify-center w-5 h-5 rounded-md text-[11px] font-bold flex-shrink-0 mt-0.5 ${
              activeTab === 'answer'
                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                : 'bg-slate-500/15 text-slate-500 dark:text-slate-300'
            }`}
          >
            {activeTab === 'answer' ? 'A' : 'H'}
          </span>
          <div className="text-xs leading-relaxed text-muted-foreground line-clamp-6 flex-1 min-w-0">
            {activeTab === 'answer'
              ? hasAnswer
                ? <RichContent content={note.content!} />
                : <span className="italic opacity-60">답변이 아직 없습니다.</span>
              : hasBack
                ? <RichContent content={note.backContent!} />
                : <span className="italic opacity-60">히스토리가 비어 있습니다.</span>}
          </div>
        </div>
      </div>

      {/* 푸터 */}
      <footer className="flex items-center justify-between gap-2 px-4 py-2 border-t border-border/60 bg-background/40 text-[11px] text-muted-foreground">
        <span className="truncate flex-1 min-w-0 flex items-center gap-1.5">
          {note.author ? (
            <span className="inline-flex items-center gap-1">
              <PenLine className="w-3 h-3" /> {note.author}
            </span>
          ) : (
            <span className="opacity-60">작성자 없음</span>
          )}
          {note.confluenceUrl && (
            <a
              href={note.confluenceUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={stop}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors text-[10px] font-semibold"
              title={note.confluenceUrl}
            >
              <ExternalLink className="w-2.5 h-2.5" /> Confluence
            </a>
          )}
        </span>
        <span className="flex-shrink-0 tabular-nums">{formatRelativeTime(note.updatedAt)}</span>
      </footer>
    </div>
  );
}

// ── 뷰 모드 (테이블 = 디폴트, 카드 = 옵션) ────────────────────────────────────
// localStorage 캐시는 하지 않는다 — 페이지 진입 시 항상 리스트가 기본.
// 과거 'k8s:ops-notes:viewMode' 키에 'card' 가 저장된 사용자도 잔존 캐시를 무력화하기 위해
// 마운트 시 한 번 삭제. 카드 보기는 우상단 토글로 일시적으로만 사용.
const LEGACY_VIEW_MODE_KEY = 'k8s:ops-notes:viewMode';
type ViewMode = 'table' | 'card';

// ── 메인 페이지 ───────────────────────────────────────────────────────────────
export function OpsNotesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();

  const [filterService, setFilterService] = useState('');
  const [search, setSearch]               = useState('');
  const [deletingId, setDeletingId]       = useState<string | null>(null);
  const [viewMode, setViewMode]           = useState<ViewMode>('table');
  const [sortKey, setSortKey]             = useState<OpsNoteSortKey>('updatedAt');
  const [sortDir, setSortDir]             = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    // 과거에 'card' 로 저장된 사용자가 있을 수 있으므로 마운트 시 캐시를 한 번 정리한다.
    try { localStorage.removeItem(LEGACY_VIEW_MODE_KEY); } catch { /* ignore */ }
  }, []);

  const handleSort = (key: OpsNoteSortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'updatedAt' ? 'desc' : 'asc'); }
  };

  const { data, isLoading } = useQuery({
    queryKey: ['ops-notes'],
    queryFn: () => opsNotesApi.getAll().then((r) => r.data),
    staleTime: 1000 * 30,
  });

  const allNotes = useMemo(() => data?.data ?? [], [data]);

  const filtered = useMemo(() => {
    let list = allNotes;
    if (filterService) list = list.filter((n) => n.service === filterService);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((n) =>
        n.title.toLowerCase().includes(q) ||
        n.content?.toLowerCase().includes(q) ||
        n.backContent?.toLowerCase().includes(q) ||
        n.author?.toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [allNotes, filterService, search]);

  const pinnedNotes = useMemo(() => filtered.filter((n) => n.pinned), [filtered]);
  const regularNotes = useMemo(() => filtered.filter((n) => !n.pinned), [filtered]);

  /** 테이블 뷰 — pinned 우선 표시 후 sortKey 기준 정렬. */
  const tableNotes = useMemo(() => {
    return [...filtered].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      let cmp = 0;
      switch (sortKey) {
        case 'title':     cmp = a.title.localeCompare(b.title); break;
        case 'service':   cmp = a.service.localeCompare(b.service); break;
        case 'author':    cmp = (a.author ?? '').localeCompare(b.author ?? ''); break;
        case 'updatedAt': cmp = a.updatedAt.localeCompare(b.updatedAt); break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir]);

  const handleDelete = async (note: OpsNote) => {
    if (!confirm(`"${note.title}" Q&A 를 삭제하시겠습니까?`)) return;
    setDeletingId(note.id);
    try {
      await opsNotesApi.delete(note.id);
      qc.invalidateQueries({ queryKey: ['ops-notes'] });
      toast.success('Q&A 삭제됨');
    } catch (e) {
      toast.error('삭제 실패', formatApiError(e));
    } finally {
      setDeletingId(null);
    }
  };

  const handleTogglePin = async (note: OpsNote) => {
    try {
      await opsNotesApi.update(note.id, { pinned: !note.pinned });
      qc.invalidateQueries({ queryKey: ['ops-notes'] });
    } catch (e) {
      toast.error('수정 실패', formatApiError(e));
    }
  };

  /** 인라인 셀 편집 — 테이블 모드에서 service / title / author 즉시 저장. */
  const handleInlineUpdate = async (id: string, data: Parameters<typeof opsNotesApi.update>[1]) => {
    try {
      await opsNotesApi.update(id, data);
      qc.invalidateQueries({ queryKey: ['ops-notes'] });
    } catch (e) {
      toast.error('수정 실패', formatApiError(e));
    }
  };

  // 서비스별 카운트
  const countByService = useMemo(() => {
    const map: Record<string, number> = {};
    for (const s of SERVICES) map[s.value] = 0;
    for (const n of allNotes) map[n.service] = (map[n.service] ?? 0) + 1;
    return map;
  }, [allNotes]);

  // 메타: 작성자 수, 답변 보유율
  const meta = useMemo(() => {
    const authors = new Set<string>();
    let answered = 0;
    for (const n of allNotes) {
      if (n.author) authors.add(n.author);
      if (n.content && n.content.trim()) answered += 1;
    }
    const answerRate = allNotes.length > 0 ? Math.round((answered / allNotes.length) * 100) : 0;
    return { authorCount: authors.size, answered, answerRate };
  }, [allNotes]);

  const newNoteHref = filterService
    ? `/ops-notes/new?service=${encodeURIComponent(filterService)}`
    : '/ops-notes/new';

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto px-4 lg:px-6 py-5 space-y-4 max-w-[1600px]">
        {/* ── Page header ─────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
              <HelpCircle className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold leading-tight">DevOps Q&amp;A</h1>
              <p className="text-xs text-muted-foreground">운영 중 만난 질문과 해결책을 한 곳에서.</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <ViewModeBar
              modes={[
                { id: 'table', label: '리스트', icon: <List       className="w-3.5 h-3.5" /> },
                { id: 'card',  label: '카드',   icon: <LayoutGrid className="w-3.5 h-3.5" /> },
              ]}
              active={viewMode}
              onChange={(v) => setViewMode(v as ViewMode)}
              showStylePanel={false}
            />
            <button
              onClick={() => navigate(newNoteHref)}
              className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors mac-shadow"
            >
              <Plus className="w-4 h-4" /> 새 Q&amp;A
            </button>
          </div>
        </div>

        {/* ── Stat strip ──────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCell label="전체 Q&A"   value={allNotes.length} icon={<MessageSquare className="w-4 h-4" />} accent="text-primary" />
          <StatCell label="고정"       value={pinnedNotes.length} icon={<Pin className="w-4 h-4" />} accent="text-amber-500" />
          <StatCell label="답변 보유율" value={`${meta.answerRate}%`} hint={`${meta.answered}/${allNotes.length}`} icon={<Sparkles className="w-4 h-4" />} accent="text-emerald-500" />
          <StatCell label="작성자"     value={meta.authorCount} hint="명" icon={<HelpCircle className="w-4 h-4" />} accent="text-sky-500" />
        </div>

        {/* ── Filter + search ─────────────────────────────────────────── */}
        <MacCard bodyPadding="p-3">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setFilterService('')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                !filterService
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background border-border text-muted-foreground hover:border-primary/50'
              }`}
            >
              전체 <span className="opacity-70">({allNotes.length})</span>
            </button>
            {SERVICES.map((s) => {
              const count = countByService[s.value] ?? 0;
              const isActive = filterService === s.value;
              if (count === 0 && !isActive) return null;
              const Icon = s.Icon;
              return (
                <button
                  key={s.value}
                  onClick={() => setFilterService(isActive ? '' : s.value)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                    isActive
                      ? `${s.soft} border-transparent ring-1 ${s.ring}`
                      : 'bg-background border-border text-muted-foreground hover:border-primary/50'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />{s.label}
                  <span className="opacity-70">({count})</span>
                </button>
              );
            })}
            <div className="ml-auto relative w-full sm:w-72">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="질문, 답변, 작성자 검색…"
                className="w-full pl-9 pr-8 py-1.5 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-secondary text-muted-foreground"
                  aria-label="검색어 지우기"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </MacCard>

        {viewMode === 'table' ? (
          /* ── 리스트(테이블) 뷰 — 디폴트 ─────────────────────────────── */
          <MacCard
            title={
              filterService
                ? `${SERVICE_MAP[filterService]?.label ?? filterService} · ${tableNotes.length}`
                : `Q&A · ${tableNotes.length}`
            }
            bodyPadding="p-0"
          >
            {isLoading ? (
              <div className="p-4 space-y-2">
                {[...Array(6)].map((_, i) => (
                  <div key={i} className="h-12 rounded bg-secondary/40 animate-pulse" />
                ))}
              </div>
            ) : tableNotes.length === 0 ? (
              <div className="text-center py-16">
                <FileQuestion className="w-12 h-12 mx-auto mb-4 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  {allNotes.length === 0
                    ? '아직 등록된 Q&A 가 없습니다.'
                    : search.trim()
                      ? `"${search}" 검색 결과가 없습니다.`
                      : '해당 서비스의 Q&A 가 없습니다.'}
                </p>
                {allNotes.length === 0 && (
                  <button
                    onClick={() => navigate('/ops-notes/new')}
                    className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-2 text-sm bg-primary/10 hover:bg-primary/20 text-primary rounded-xl transition-colors"
                  >
                    <Plus className="w-4 h-4" /> 첫 번째 Q&amp;A 만들기
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ) : (
              <OpsNoteTable
                notes={tableNotes}
                services={SERVICES}
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={handleSort}
                onOpen={(n) => navigate(`/ops-notes/${n.id}`)}
                onEdit={(n) => navigate(`/ops-notes/${n.id}/edit`)}
                onDelete={handleDelete}
                onTogglePin={handleTogglePin}
                onUpdate={handleInlineUpdate}
                deletingId={deletingId}
              />
            )}
          </MacCard>
        ) : (
          /* ── 카드 뷰 — 옵션 ─────────────────────────────────────────── */
          <>
            {/* Pinned section */}
            {!isLoading && pinnedNotes.length > 0 && (
              <MacCard title={`고정 Q&A · ${pinnedNotes.length}`} bodyPadding="p-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {pinnedNotes.map((note) => (
                    <div key={note.id} className={deletingId === note.id ? 'opacity-40 pointer-events-none' : ''}>
                      <QnaCard
                        note={note}
                        onOpen={() => navigate(`/ops-notes/${note.id}`)}
                        onEdit={() => navigate(`/ops-notes/${note.id}/edit`)}
                        onDelete={() => handleDelete(note)}
                        onTogglePin={() => handleTogglePin(note)}
                      />
                    </div>
                  ))}
                </div>
              </MacCard>
            )}

            {/* Regular grid */}
            <MacCard
              title={
                filterService
                  ? `${SERVICE_MAP[filterService]?.label ?? filterService} · ${regularNotes.length}`
                  : `최근 Q&A · ${regularNotes.length}`
              }
              bodyPadding="p-4"
            >
              {isLoading ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {[...Array(8)].map((_, i) => (
                    <div key={i} className="h-56 rounded-2xl bg-secondary/40 animate-pulse" />
                  ))}
                </div>
              ) : regularNotes.length === 0 ? (
                <div className="text-center py-16">
                  <FileQuestion className="w-12 h-12 mx-auto mb-4 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">
                    {allNotes.length === 0
                      ? '아직 등록된 Q&A 가 없습니다.'
                      : search.trim()
                        ? `"${search}" 검색 결과가 없습니다.`
                        : '해당 서비스의 Q&A 가 없습니다.'}
                  </p>
                  {allNotes.length === 0 && (
                    <button
                      onClick={() => navigate('/ops-notes/new')}
                      className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-2 text-sm bg-primary/10 hover:bg-primary/20 text-primary rounded-xl transition-colors"
                    >
                      <Plus className="w-4 h-4" /> 첫 번째 Q&amp;A 만들기
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {regularNotes.map((note) => (
                    <div key={note.id} className={deletingId === note.id ? 'opacity-40 pointer-events-none' : ''}>
                      <QnaCard
                        note={note}
                        onOpen={() => navigate(`/ops-notes/${note.id}`)}
                        onEdit={() => navigate(`/ops-notes/${note.id}/edit`)}
                        onDelete={() => handleDelete(note)}
                        onTogglePin={() => handleTogglePin(note)}
                      />
                    </div>
                  ))}
                </div>
              )}
            </MacCard>
          </>
        )}
      </main>
    </div>
  );
}

// ── Stat cell ─────────────────────────────────────────────────────────────────
interface StatCellProps {
  label: string;
  value: number | string;
  hint?: string;
  icon: React.ReactNode;
  accent: string;
}

function StatCell({ label, value, hint, icon, accent }: StatCellProps) {
  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-3 flex items-center gap-3">
      <div className={`w-9 h-9 rounded-xl bg-secondary flex items-center justify-center ${accent}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[11px] text-muted-foreground">{label}</p>
        <p className="text-lg font-bold leading-tight">
          {value}
          {hint && <span className="ml-1 text-xs font-medium text-muted-foreground">{hint}</span>}
        </p>
      </div>
    </div>
  );
}

