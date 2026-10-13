import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { StatTile, StatTileRow } from '@/components/common/StatTile';
import { PageHeader } from '@/components/common/PageHeader';
import { useNavigate } from 'react-router-dom';
import {
  HelpCircle, Plus, Pencil, Trash2, X, Pin, PinOff, Search, MessageSquare,
  FileQuestion, ExternalLink, List, LayoutGrid,
  PenLine, Ship, KeyRound, Bug, Hammer, RefreshCw, Package, Layers,
} from 'lucide-react';
import { RichContent } from '@/components/editor';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { opsNotesApi } from '@/services/api';
import type { OpsNote, OpsNoteColor } from '@/types';
import { EmptyState, Skeleton, useToast, ViewModeBar } from '@/components/common';
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
  { value: 'k8s',      label: 'Kubernetes', Icon: Ship,      accent: 'bg-chart-1', ring: 'ring-chart-1/30', soft: 'bg-chart-1/15 text-chart-1' },
  { value: 'keycloak', label: 'Keycloak',   Icon: KeyRound,  accent: 'bg-chart-7', ring: 'ring-chart-7/30', soft: 'bg-chart-7/15 text-chart-7' },
  { value: 'cilium',   label: 'Cilium',     Icon: Bug,       accent: 'bg-chart-3', ring: 'ring-chart-3/30', soft: 'bg-chart-3/15 text-chart-3' },
  { value: 'jenkins',  label: 'Jenkins',    Icon: Hammer,    accent: 'bg-chart-6', ring: 'ring-chart-6/30', soft: 'bg-chart-6/15 text-chart-6' },
  { value: 'argocd',   label: 'ArgoCD',     Icon: RefreshCw, accent: 'bg-chart-4', ring: 'ring-chart-4/30', soft: 'bg-chart-4/15 text-chart-4' },
  { value: 'nexus',    label: 'Nexus',      Icon: Package,   accent: 'bg-chart-2', ring: 'ring-chart-2/30', soft: 'bg-chart-2/15 text-chart-2' },
  { value: 'etc',      label: '기타',        Icon: Layers,    accent: 'bg-chart-8', ring: 'ring-chart-8/30', soft: 'bg-chart-8/15 text-chart-8' },
];
const SERVICE_MAP = Object.fromEntries(SERVICES.map((s) => [s.value, s]));

// ── 카드 색상 (좌측 띠 하나로만 구분 — 사용자 선택 색은 카테고리라 chart-* 토큰) ─────────────
const CARD_TINT: Record<OpsNoteColor, { stripe: string }> = {
  yellow: { stripe: 'bg-chart-3' },
  green:  { stripe: 'bg-chart-2' },
  blue:   { stripe: 'bg-chart-1' },
  pink:   { stripe: 'bg-chart-5' },
  purple: { stripe: 'bg-chart-4' },
};

// ── 빈 상태 (리스트·카드 공용) ─────────────────────────────────────────────────
function QnaEmptyState({ hasAny, search, onCreate }: { hasAny: boolean; search: string; onCreate: () => void }) {
  if (!hasAny) {
    return (
      <EmptyState
        icon={FileQuestion}
        title="아직 등록된 Q&A 가 없습니다."
        description="운영 중 만난 질문과 해결책을 첫 Q&A 로 남기세요."
        action={{ label: '첫 Q&A 만들기', onClick: onCreate }}
      />
    );
  }
  return (
    <EmptyState
      icon={FileQuestion}
      title={search.trim() ? `"${search}" 검색 결과가 없습니다.` : '해당 서비스의 Q&A 가 없습니다.'}
      description={search.trim() ? '다른 검색어를 쓰거나 서비스 필터를 해제하세요.' : '다른 서비스를 고르거나 새 Q&A 를 등록하세요.'}
    />
  );
}

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
      className="group relative rounded-md border border-border overflow-hidden bg-card hover:border-muted-foreground/30 transition-colors flex flex-col cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40"
      style={{ minHeight: '230px' }}
    >
      {/* 색상 띠 (좌측) */}
      <span className={`absolute left-0 top-0 bottom-0 w-1 ${tint.stripe}`} aria-hidden />

      {/* 헤더 */}
      <header className="flex items-center justify-between gap-2 pl-4 pr-2 pt-3">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`inline-flex items-center gap-1 text-xs font-semibold px-1.5 py-0.5 rounded-md ${svc?.soft ?? 'bg-secondary text-muted-foreground'}`}>
            {SvcIcon && <SvcIcon className="w-3 h-3" />}
            {svc?.label ?? note.service}
          </span>
          {note.pinned && (
            <span className="inline-flex items-center gap-1 text-xs font-semibold px-1.5 py-0.5 rounded-md bg-primary/15 text-primary">
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
            className="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-status-critical transition-colors"
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
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-primary text-primary-foreground text-xs font-bold flex-shrink-0 mt-0.5">
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
              className={`text-xs px-2 py-0.5 rounded-md transition-colors ${
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
            className={`inline-flex items-center justify-center w-5 h-5 rounded-md text-xs font-bold flex-shrink-0 mt-0.5 ${
              activeTab === 'answer'
                ? 'bg-secondary text-foreground'
                : 'bg-secondary text-muted-foreground'
            }`}
          >
            {activeTab === 'answer' ? 'A' : 'H'}
          </span>
          <div className="text-sm leading-relaxed text-muted-foreground line-clamp-6 flex-1 min-w-0">
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
      <footer className="flex items-center justify-between gap-2 px-4 py-2 border-t border-border/60 bg-background/40 text-xs text-muted-foreground">
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
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors text-xs font-semibold"
              title={note.confluenceUrl}
            >
              <ExternalLink className="w-2.5 h-2.5" /> Confluence
            </a>
          )}
          {note.dlUrl && (
            <a
              href={note.dlUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={stop}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors text-xs font-semibold"
              title={note.dlUrl}
            >
              <ExternalLink className="w-2.5 h-2.5" /> DL
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
    <div className="app-min-h-screen bg-background">
      <main className="mx-auto px-4 lg:px-6 py-5 space-y-4 max-w-[1600px]">
        {/* ── Page header ─────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <PageHeader icon={HelpCircle} title="DevOps Q&A" description="운영 중 만난 질문과 해결책을 한 곳에서." className="flex-1 min-w-0" />
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
              className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors shadow-card"
            >
              <Plus className="w-4 h-4" /> 새 Q&amp;A
            </button>
          </div>
        </div>

        {/* ── Stat strip ──────────────────────────────────────────────── */}
        <StatTileRow>
          <StatTile label="전체 Q&A" value={allNotes.length} icon={MessageSquare} />
          <StatTile label="고정" value={pinnedNotes.length} icon={Pin} />
          <StatTile label="답변 보유율" value={`${meta.answerRate}%`} hint={`${meta.answered}/${allNotes.length}`} icon={MessageSquare} />
          <StatTile label="작성자" value={meta.authorCount} hint="명" icon={HelpCircle} />
        </StatTileRow>

        {/* ── Filter + search ─────────────────────────────────────────── */}
        <MacCard bodyPadding="p-3">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setFilterService('')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-full border transition-colors ${
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
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-full border transition-colors ${
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
                  <Skeleton key={i} className="block w-full h-12 rounded" />
                ))}
              </div>
            ) : tableNotes.length === 0 ? (
              <QnaEmptyState
                hasAny={allNotes.length > 0}
                search={search}
                onCreate={() => navigate('/ops-notes/new')}
              />
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
                    <Skeleton key={i} className="block w-full h-56 rounded-md" />
                  ))}
                </div>
              ) : regularNotes.length === 0 ? (
                <QnaEmptyState
                  hasAny={allNotes.length > 0}
                  search={search}
                  onCreate={() => navigate('/ops-notes/new')}
                />
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


