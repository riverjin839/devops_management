import { useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Search, Plus, Pin, Pencil, Trash2, Share2, Copy, Tag, Loader2,
  Filter,
} from 'lucide-react';
import {
  DebugLogPanel, ConfirmDialog, useToast,
  EmptyState, SkeletonCard,
} from '@/components/common';
import { RichContent } from '@/components/editor';
import { serviceEntriesApi } from '@/services/api';
import { KIND_CATALOG, KIND_BY_KEY, colorBadgeClass } from '@/components/services/serviceCatalog';
import { useGetServiceDef } from '@/hooks/useServiceCatalog';
import type { ServiceEntry, ServiceEntryKind } from '@/types';
import { formatApiError } from '@/lib/utils';
import { ServiceEntryEditModal } from '@/components/services/ServiceEntryEditModal';
import { RelatedWorkItemsPanel } from '@/components/services/RelatedWorkItemsPanel';
import { RelatedOpsNotesPanel } from '@/components/services/RelatedOpsNotesPanel';

type KindFilter = 'all' | ServiceEntryKind;

export function ServiceHubPage() {
  const { service = '' } = useParams<{ service: string }>();
  const toast = useToast();
  const qc = useQueryClient();

  const getServiceDef = useGetServiceDef();
  const def = getServiceDef(service);

  // 클러스터 picker 제거 — 서비스 hub 는 서비스 기준으로 모든 클러스터 항목을 통합 표시.
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState('');

  const listQ = useQuery({
    queryKey: ['service-entries', service, kindFilter, search, tagFilter],
    queryFn: () => serviceEntriesApi.list(service, {
      kind: kindFilter === 'all' ? undefined : kindFilter,
      search: search.trim() || undefined,
      tag: tagFilter || undefined,
    }).then((r) => r.data.data),
  });
  const entries: ServiceEntry[] = useMemo(() => listQ.data ?? [], [listQ.data]);

  // kind 별 카운트 (탭에 표시)
  const kindCounts = useMemo(() => {
    const m: Record<string, number> = { all: entries.length };
    for (const e of entries) m[e.kind] = (m[e.kind] ?? 0) + 1;
    return m;
  }, [entries]);

  // 모든 태그 모음 (필터 드롭다운)
  const allTags = useMemo(() => {
    const s = new Set<string>();
    entries.forEach((e) => (e.tags ?? []).forEach((t) => s.add(t)));
    return Array.from(s).sort();
  }, [entries]);

  const [editEntry, setEditEntry] = useState<ServiceEntry | null>(null);
  const [creating, setCreating] = useState<ServiceEntryKind | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ServiceEntry | null>(null);

  const togglePin = async (e: ServiceEntry) => {
    try {
      await serviceEntriesApi.update(e.id, { pinned: !e.pinned });
      qc.invalidateQueries({ queryKey: ['service-entries'] });
      qc.invalidateQueries({ queryKey: ['service-catalog'] });
    } catch (err) {
      toast.error('고정 상태 변경 실패', formatApiError(err));
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await serviceEntriesApi.delete(confirmDelete.id);
      qc.invalidateQueries({ queryKey: ['service-entries'] });
      qc.invalidateQueries({ queryKey: ['service-catalog'] });
      toast.success('항목 삭제됨', confirmDelete.title);
      setConfirmDelete(null);
    } catch (err) {
      toast.error('삭제 실패', formatApiError(err));
    }
  };

  const shareUrl = (entry: ServiceEntry): string => {
    const base = window.location.origin;
    return `${base}/services/${service}/entries/${entry.id}`;
  };

  const handleCopyShare = async (e: ServiceEntry) => {
    try {
      await navigator.clipboard.writeText(shareUrl(e));
      toast.success('공유 URL 복사됨');
    } catch {
      toast.warning('클립보드 접근 불가', '주소창에서 직접 복사하세요.');
    }
  };

  const handleCopyMarkdown = async (e: ServiceEntry) => {
    const kindMeta = KIND_BY_KEY[e.kind];
    const md = [
      `## [${kindMeta?.label ?? e.kind}] ${e.title}`,
      e.severity ? `- 심각도: **${e.severity}**` : null,
      e.occurredAt ? `- 발생: ${new Date(e.occurredAt).toLocaleString()}` : null,
      e.author ? `- 작성: ${e.author}` : null,
      (e.tags ?? []).length > 0 ? `- 태그: ${(e.tags ?? []).map((t) => `\`${t}\``).join(' ')}` : null,
      e.url ? `- 링크: ${e.url}` : null,
      '',
      // 간단 HTML→텍스트 변환 (rich content 라 완벽 변환은 아님)
      e.content.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
      '',
      `🔗 ${shareUrl(e)}`,
    ].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(md);
      toast.success('Markdown 복사됨', 'Slack/Teams 에 바로 붙여넣을 수 있습니다.');
    } catch {
      toast.warning('클립보드 접근 불가');
    }
  };

  const Icon = def.icon;

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto px-6 py-6">
        <div className="flex-1 min-w-0">
          <DebugLogPanel pageKey="services" extra={{ service, kindFilter, search, count: entries.length }} />

          {/* 헤더 */}
          <div className="flex items-center gap-3 mb-4">
            <Link to="/services"
              className="p-1.5 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
              title="서비스 카탈로그">
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${colorBadgeClass(def.color)}`}>
              <Icon className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-bold">{def.label}</h1>
              {def.description && (
                <p className="text-xs text-muted-foreground">{def.description}</p>
              )}
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              {KIND_CATALOG.map((k) => (
                <button key={k.key} onClick={() => setCreating(k.key)}
                  className="flex items-center gap-1 px-2.5 py-1 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg text-muted-foreground hover:text-foreground"
                  title={`새 ${k.label} 추가`}>
                  <Plus className="w-3 h-3" /> {k.label}
                </button>
              ))}
            </div>
          </div>

          {/* 탭 + 검색 + 태그 */}
          <div className="bg-card border border-border rounded-xl p-3 mb-3 flex flex-wrap items-center gap-2">
            <div className="flex items-center bg-secondary/60 rounded-lg p-[3px] gap-px">
              <button onClick={() => setKindFilter('all')}
                className={`px-3 py-1 text-sm font-medium rounded-md ${
                  kindFilter === 'all' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground/80 hover:text-foreground'
                }`}>
                전체 <span className="text-muted-foreground ml-1">{kindCounts.all ?? 0}</span>
              </button>
              {KIND_CATALOG.map((k) => (
                <button key={k.key} onClick={() => setKindFilter(k.key)}
                  className={`flex items-center gap-1 px-3 py-1 text-sm font-medium rounded-md ${
                    kindFilter === k.key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground/80 hover:text-foreground'
                  }`}>
                  <k.icon className="w-3 h-3" />
                  {k.label}
                  <span className="text-muted-foreground">{kindCounts[k.key] ?? 0}</span>
                </button>
              ))}
            </div>

            <div className="ml-auto flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="제목/내용 검색..."
                  className="pl-8 pr-3 py-1 text-sm bg-background border border-border rounded-lg w-56 focus:outline-none focus:ring-1 focus:ring-primary" />
              </div>
              {allTags.length > 0 && (
                <div className="flex items-center gap-1">
                  <Filter className="w-3 h-3 text-muted-foreground" />
                  <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}
                    className="px-2 py-1 text-sm bg-background border border-border rounded-lg">
                    <option value="">태그 전체</option>
                    {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              )}
            </div>
          </div>

          {/* 항목 목록 */}
          {listQ.isLoading ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
            </div>
          ) : entries.length === 0 ? (
            <EmptyState
              icon={Icon}
              title={`${def.label} 에 등록된 항목이 없습니다`}
              description="가이드 / 트러블슈팅 / 변경이력 / 메모 / 링크 중 원하는 종류로 시작하세요."
              action={{ label: '운영 가이드 추가', onClick: () => setCreating('guide') }}
              secondaryAction={{ label: '트러블슈팅 추가', onClick: () => setCreating('troubleshoot') }}
            />
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {entries.map((e) => {
                const kindMeta = KIND_BY_KEY[e.kind];
                const KindIcon = kindMeta?.icon;
                return (
                  <article key={e.id}
                    className={`bg-card border rounded-xl p-4 transition-shadow hover:shadow-md ${
                      e.pinned ? 'border-primary/40 bg-primary/[0.02]' : 'border-border'
                    }`}>
                    <header className="flex items-start gap-2 mb-2">
                      {KindIcon && (
                        <span className={`mt-0.5 inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full border ${colorBadgeClass(kindMeta.color)} flex-shrink-0`}>
                          <KindIcon className="w-3 h-3" />
                          {kindMeta.label}
                        </span>
                      )}
                      {e.severity && (
                        <span className={`text-xs px-1.5 py-0.5 rounded-full border flex-shrink-0 ${
                          e.severity === 'critical' ? 'bg-red-500/10 text-red-500 border-red-500/30'
                          : e.severity === 'warning' ? 'bg-amber-500/10 text-amber-500 border-amber-500/30'
                          : 'bg-sky-500/10 text-sky-500 border-sky-500/30'
                        }`}>{e.severity}</span>
                      )}
                      <h3 className="flex-1 font-semibold text-sm leading-snug line-clamp-2">{e.title}</h3>
                      <button onClick={() => togglePin(e)}
                        className={`p-1 rounded hover:bg-secondary flex-shrink-0 ${e.pinned ? 'text-primary' : 'text-muted-foreground'}`}
                        title={e.pinned ? '고정 해제' : '상단 고정'}>
                        <Pin className={`w-3.5 h-3.5 ${e.pinned ? 'fill-current' : ''}`} />
                      </button>
                    </header>

                    {e.kind === 'link' && e.url ? (
                      <a href={e.url} target="_blank" rel="noopener noreferrer"
                        className="block text-sm font-mono text-primary hover:underline mb-2 break-all">
                        {e.url}
                      </a>
                    ) : null}

                    {e.content && (
                      <div className="text-sm text-foreground/80 line-clamp-4 mb-2">
                        <RichContent content={e.content} />
                      </div>
                    )}

                    <div className="flex items-center flex-wrap gap-1 mb-2">
                      {(e.tags ?? []).map((t) => (
                        <button key={t} onClick={() => setTagFilter(t)}
                          className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded-full bg-muted/40 text-muted-foreground border border-border hover:bg-secondary">
                          <Tag className="w-2.5 h-2.5" /> {t}
                        </button>
                      ))}
                    </div>

                    <footer className="flex items-center gap-2 text-xs text-muted-foreground pt-2 border-t border-border">
                      <span>{e.author ?? '-'}</span>
                      <span>·</span>
                      <span>{new Date(e.updatedAt).toLocaleString()}</span>
                      {e.clusterName && (
                        <>
                          <span>·</span>
                          <span className="px-1.5 py-0.5 rounded-full bg-secondary text-foreground">{e.clusterName}</span>
                        </>
                      )}
                      {!e.clusterName && e.clusterId === null && (
                        <>
                          <span>·</span>
                          <span className="text-muted-foreground/70">전역</span>
                        </>
                      )}
                      <div className="ml-auto flex items-center gap-0.5">
                        <button onClick={() => handleCopyShare(e)} title="공유 URL 복사"
                          className="p-1 rounded hover:bg-secondary"><Share2 className="w-3 h-3" /></button>
                        <button onClick={() => handleCopyMarkdown(e)} title="Markdown 복사 (Slack/Teams)"
                          className="p-1 rounded hover:bg-secondary"><Copy className="w-3 h-3" /></button>
                        <button onClick={() => setEditEntry(e)} title="수정"
                          className="p-1 rounded hover:bg-secondary"><Pencil className="w-3 h-3" /></button>
                        <button onClick={() => setConfirmDelete(e)} title="삭제"
                          className="p-1 rounded hover:bg-red-500/10 hover:text-red-400"><Trash2 className="w-3 h-3" /></button>
                      </div>
                    </footer>
                  </article>
                );
              })}
            </div>
          )}

          {/* 로딩 indicator (refetch 중) */}
          {listQ.isFetching && !listQ.isLoading && (
            <div className="fixed bottom-4 right-4 px-3 py-1.5 rounded-full bg-card border border-border shadow text-xs text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> 갱신 중
            </div>
          )}

          {/* Cross-view (Phase A) — 같은 service 의 WorkItem / OpsNote 통합 표시 */}
          <RelatedWorkItemsPanel service={service} />
          <RelatedOpsNotesPanel service={service} />
        </div>
      </main>

      {(editEntry || creating) && (
        <ServiceEntryEditModal
          mode={editEntry ? 'edit' : 'create'}
          service={service}
          defaultKind={creating ?? undefined}
          defaultClusterId={null}
          clusters={[]}
          entry={editEntry}
          onClose={() => { setEditEntry(null); setCreating(null); }}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['service-entries'] });
            qc.invalidateQueries({ queryKey: ['service-catalog'] });
            setEditEntry(null);
            setCreating(null);
          }}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="항목 삭제"
        description={`"${confirmDelete?.title}" 항목을 삭제합니다. 되돌릴 수 없습니다.`}
        confirmLabel="삭제"
        danger
        onCancel={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
      />
    </div>
  );
}
