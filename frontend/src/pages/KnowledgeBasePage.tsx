import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight, ChevronDown, FileText, Folder, FolderTree, Plus, Trash2,
  History, Save, Lock, Users, RotateCcw, Eye, X, Map as MapIcon, KanbanSquare, Link2,
  DownloadCloud,
} from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { RichTextEditor, RichContent } from '@/components/editor';
import { KnowledgeRoadmap } from '@/components/knowledge/KnowledgeRoadmap';
import { KnowledgeBoard } from '@/components/knowledge/KnowledgeBoard';
import { useToast } from '@/components/common';
import { useAuthStore } from '@/stores/authStore';
import { useSprints } from '@/hooks/useSprints';
import { SERVICE_CATALOG } from '@/components/services/serviceCatalog';
import { knowledgeApi } from '@/services/api';
import { formatApiError } from '@/lib/utils';
import {
  useKnowledgeTree, useKnowledgePage, usePageVersions, useRoadmap,
  useCreatePage, useUpdatePage, useDeletePage, useSaveMilestone, useRestoreVersion,
  useReorder, usePageBacklinks, useImportExisting,
} from '@/hooks/useKnowledge';
import type { KnowledgePageNode, KnowledgeKind, KnowledgeVisibility, KnowledgePresenceUser } from '@/types';

const SERVICES = [{ key: '__common__', label: '공통' }, ...SERVICE_CATALOG.map((s) => ({ key: s.key, label: s.label }))];

const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '— 분류 없음 —' },
  { value: 'enhancement', label: '고도화' },
  { value: 'operation', label: '운영업무' },
  { value: 'learning', label: '기술학습' },
  { value: 'build', label: '구축' },
];
const CATEGORY_LABEL: Record<string, string> = {
  enhancement: '고도화', operation: '운영업무', learning: '기술학습', build: '구축',
};
const KIND_OPTIONS: { value: KnowledgeKind; label: string }[] = [
  { value: 'doc', label: '문서' },
  { value: 'folder', label: '폴더' },
  { value: 'board', label: '보드' },
  { value: 'roadmap', label: '로드맵' },
];

function kindIcon(kind: KnowledgeKind) {
  if (kind === 'folder') return Folder;
  if (kind === 'board') return KanbanSquare;
  if (kind === 'roadmap') return MapIcon;
  return FileText;
}

function flatten(nodes: KnowledgePageNode[], acc: KnowledgePageNode[] = []): KnowledgePageNode[] {
  for (const n of nodes) {
    acc.push(n);
    if (n.children?.length) flatten(n.children, acc);
  }
  return acc;
}

type DropPos = 'before' | 'after' | 'inside';

interface TreeRowProps {
  node: KnowledgePageNode;
  depth: number;
  selectedId?: string;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onAddChild: (parent: KnowledgePageNode) => void;
  onDelete: (node: KnowledgePageNode) => void;
  onDropNode: (dragId: string, target: KnowledgePageNode, pos: DropPos) => void;
}

function TreeRow(props: TreeRowProps) {
  const { node, depth, selectedId, expanded, onToggle, onSelect, onAddChild, onDelete, onDropNode } = props;
  const [hint, setHint] = useState<DropPos | null>(null);
  const hasChildren = !!node.children?.length;
  const isOpen = expanded.has(node.id);
  const Icon = kindIcon(node.kind);

  const posFromEvent = (e: React.DragEvent): DropPos => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - r.top;
    if (y < r.height * 0.3) return 'before';
    if (y > r.height * 0.7) return 'after';
    return 'inside';
  };

  return (
    <div>
      <div
        draggable
        onDragStart={(e) => { e.dataTransfer.setData('text/plain', node.id); e.dataTransfer.effectAllowed = 'move'; }}
        onDragOver={(e) => { e.preventDefault(); setHint(posFromEvent(e)); }}
        onDragLeave={() => setHint(null)}
        onDrop={(e) => {
          e.preventDefault();
          const dragId = e.dataTransfer.getData('text/plain');
          const pos = posFromEvent(e);
          setHint(null);
          if (dragId && dragId !== node.id) onDropNode(dragId, node, pos);
        }}
        className={`group relative flex items-center gap-1 pr-1 py-1 rounded-lg cursor-pointer text-sm ${
          selectedId === node.id ? 'bg-primary/10 text-primary' : 'hover:bg-secondary text-foreground'
        } ${hint === 'inside' ? 'ring-1 ring-primary/50' : ''}`}
        style={{ paddingLeft: depth * 14 + 4 }}
        onClick={() => onSelect(node.id)}
      >
        {hint === 'before' && <span className="absolute left-0 right-0 top-0 h-0.5 bg-primary" />}
        {hint === 'after' && <span className="absolute left-0 right-0 bottom-0 h-0.5 bg-primary" />}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); if (hasChildren) onToggle(node.id); }}
          className="w-4 h-4 flex items-center justify-center text-muted-foreground shrink-0"
        >
          {hasChildren ? (isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />) : null}
        </button>
        {node.icon ? <span className="w-4 text-center shrink-0">{node.icon}</span> : <Icon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />}
        <span className="truncate flex-1">{node.title}</span>
        {node.visibility === 'private' && <Lock className="w-3 h-3 text-amber-500 shrink-0" />}
        <button type="button" title="하위 추가" onClick={(e) => { e.stopPropagation(); onAddChild(node); }}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-background text-muted-foreground hover:text-primary">
          <Plus className="w-3.5 h-3.5" />
        </button>
        <button type="button" title="삭제" onClick={(e) => { e.stopPropagation(); onDelete(node); }}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-background text-muted-foreground hover:text-rose-500">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      {hasChildren && isOpen && node.children.map((c) => (
        <TreeRow key={c.id} {...props} node={c} depth={depth + 1} />
      ))}
    </div>
  );
}

export function KnowledgeBasePage() {
  const { id: routeId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const currentUser = useAuthStore((s) => s.user);

  const [service, setService] = useState<string>('__common__');
  const serviceParam = service === '__common__' ? undefined : service;
  const [view, setView] = useState<'tree' | 'roadmap'>('tree');

  const { data: tree = [], isLoading } = useKnowledgeTree(serviceParam);
  const { data: roadmapItems = [] } = useRoadmap(serviceParam);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | undefined>(routeId);

  const createPage = useCreatePage();
  const updatePage = useUpdatePage();
  const deletePage = useDeletePage();
  const saveMilestone = useSaveMilestone();
  const restoreVersion = useRestoreVersion();
  const reorder = useReorder();
  const importMut = useImportExisting();
  const qc = useQueryClient();

  const { data: page } = useKnowledgePage(selectedId);
  const { data: versions = [] } = usePageVersions(selectedId);
  const { data: backlinks = [] } = usePageBacklinks(selectedId);
  const { data: sprintsData } = useSprints();
  const sprints = sprintsData?.data ?? [];

  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [previewVersion, setPreviewVersion] = useState<{ no: number; content: string } | null>(null);
  const [editors, setEditors] = useState<KnowledgePresenceUser[]>([]);

  useEffect(() => {
    if (page) { setDraftTitle(page.title); setDraftContent(page.content ?? ''); }
  }, [page]);
  useEffect(() => { if (routeId) setSelectedId(routeId); }, [routeId]);

  // 경량 협업 — 열려 있는 동안 15초마다 하트비트, 같은 문서를 보는 다른 사용자 표시.
  useEffect(() => {
    if (!selectedId) { setEditors([]); return; }
    let active = true;
    const beat = () => knowledgeApi.heartbeat(selectedId)
      .then((r) => { if (active) setEditors(r.data.editors ?? []); })
      .catch(() => { /* presence 실패는 조용히 무시 */ });
    beat();
    const t = setInterval(beat, 15_000);
    return () => { active = false; clearInterval(t); };
  }, [selectedId]);

  const flat = useMemo(() => flatten(tree), [tree]);
  const breadcrumb = useMemo(() => {
    if (!page) return [];
    const byId = new Map(flat.map((n) => [n.id, n]));
    const chain: KnowledgePageNode[] = [];
    let cur = byId.get(page.id);
    while (cur) { chain.unshift(cur); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    return chain;
  }, [page, flat]);

  const select = (pid: string) => { setSelectedId(pid); setView('tree'); navigate(`/knowledge/${pid}`); };

  // 에디터 내부 링크([[ ]]) — 같은 서비스 문서로 연결.
  const linkSearch = (q: string) => {
    const ql = q.trim().toLowerCase();
    return flat
      .filter((n) => n.id !== page?.id && (!ql || n.title.toLowerCase().includes(ql)))
      .slice(0, 8)
      .map((n) => ({ id: n.id, label: n.title, href: `/knowledge/${n.id}` }));
  };

  const nextRootOrder = () => (tree.length ? Math.max(...tree.map((n) => n.sortOrder)) + 1 : 0);

  const addRoot = async () => {
    const title = window.prompt('새 문서 제목');
    if (!title?.trim()) return;
    try {
      const created = await createPage.mutateAsync({ service: serviceParam ?? null, parentId: null, kind: 'doc', title: title.trim(), sortOrder: nextRootOrder() });
      select(created.id);
    } catch (e) { toast.error('생성 실패', formatApiError(e, '문서 생성 중 오류')); }
  };

  const addChild = async (parent: KnowledgePageNode) => {
    const title = window.prompt(`'${parent.title}' 하위 문서 제목`);
    if (!title?.trim()) return;
    const order = parent.children?.length ? Math.max(...parent.children.map((c) => c.sortOrder)) + 1 : 0;
    try {
      const created = await createPage.mutateAsync({ service: serviceParam ?? null, parentId: parent.id, kind: 'doc', category: parent.category ?? null, title: title.trim(), sortOrder: order });
      setExpanded((s) => new Set(s).add(parent.id));
      select(created.id);
    } catch (e) { toast.error('생성 실패', formatApiError(e, '문서 생성 중 오류')); }
  };

  const removeNode = async (node: KnowledgePageNode) => {
    if (!window.confirm(`'${node.title}'${node.children?.length ? ' 및 하위 문서' : ''}를 삭제할까요?`)) return;
    try {
      await deletePage.mutateAsync(node.id);
      if (selectedId === node.id) { setSelectedId(undefined); navigate('/knowledge'); }
      toast.success('삭제됨', `'${node.title}' 삭제`);
    } catch (e) { toast.error('삭제 실패', formatApiError(e, '삭제 중 오류')); }
  };

  // 드래그 정렬/이동
  const onDropNode = async (dragId: string, target: KnowledgePageNode, pos: DropPos) => {
    const byId = new Map(flat.map((n) => [n.id, n]));
    const drag = byId.get(dragId);
    if (!drag) return;
    // 자기 자손으로 이동 금지
    let p: KnowledgePageNode | undefined = target;
    while (p) { if (p.id === dragId) return; p = p.parentId ? byId.get(p.parentId) : undefined; }
    try {
      if (pos === 'inside') {
        const order = (target.children?.length ?? 0);
        await knowledgeApi.move(dragId, { parentId: target.id, sortOrder: order });
        setExpanded((s) => new Set(s).add(target.id));
      } else {
        const parentId = target.parentId ?? null;
        const siblings = flat.filter((n) => (n.parentId ?? null) === parentId && n.id !== dragId);
        const idx = siblings.findIndex((n) => n.id === target.id);
        const insertAt = pos === 'before' ? idx : idx + 1;
        const ordered = [...siblings.map((n) => n.id)];
        ordered.splice(insertAt, 0, dragId);
        await reorder.mutateAsync({ parentId, orderedIds: ordered });
      }
    } catch (e) { toast.error('이동 실패', formatApiError(e, '문서 이동 중 오류')); }
  };

  const toggle = (pid: string) => setExpanded((s) => { const n = new Set(s); n.has(pid) ? n.delete(pid) : n.add(pid); return n; });

  const save = async () => {
    if (!page) return;
    try {
      await updatePage.mutateAsync({ id: page.id, data: { title: draftTitle.trim() || page.title, content: draftContent }, expectedUpdatedAt: page.updatedAt });
      toast.success('저장됨', '문서가 저장되었습니다.');
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stsCode = (e as any)?.response?.status;
      if (stsCode === 409) {
        toast.error('저장 충돌', formatApiError(e, '다른 사용자가 먼저 수정했습니다. 최신 내용을 불러옵니다.'));
        qc.invalidateQueries({ queryKey: ['knowledge', 'page', page.id] });
      } else {
        toast.error('저장 실패', formatApiError(e, '저장 중 오류'));
      }
    }
  };

  const onImport = async () => {
    if (!window.confirm('기존 운영노트 · 작업가이드 · 서비스엔트리를 지식베이스로 가져올까요?\n(원본은 그대로 두고 복사 — 이미 가져온 항목은 건너뜁니다)')) return;
    try {
      const r = await importMut.mutateAsync('all');
      toast.success('가져오기 완료', `추가 ${r.imported}건 · 건너뜀 ${r.skipped}건`);
    } catch (e) { toast.error('가져오기 실패', formatApiError(e, '오류')); }
  };

  const patchMeta = async (data: Record<string, unknown>) => {
    if (!page) return;
    try { await updatePage.mutateAsync({ id: page.id, data }); }
    catch (e) { toast.error('변경 실패', formatApiError(e, '변경 중 오류')); }
  };

  const onSaveMilestone = async () => {
    if (!page) return;
    const label = window.prompt('버전(마일스톤) 이름 — 예: v1.0 배포 전');
    if (!label?.trim()) return;
    try { await saveMilestone.mutateAsync({ id: page.id, label: label.trim() }); toast.success('버전 저장', `'${label.trim()}' 마일스톤 저장`); }
    catch (e) { toast.error('버전 저장 실패', formatApiError(e, '오류')); }
  };

  const onRestore = async (versionId: string, no: number) => {
    if (!page || !window.confirm(`버전 v${no} 로 되돌릴까요? (현재 내용은 자동 백업됩니다)`)) return;
    try { await restoreVersion.mutateAsync({ id: page.id, versionId }); toast.success('복원됨', `v${no} 로 복원`); }
    catch (e) { toast.error('복원 실패', formatApiError(e, '오류')); }
  };

  const onPreview = async (versionId: string, no: number) => {
    try { const r = await knowledgeApi.getVersion(versionId); setPreviewVersion({ no, content: r.data.content ?? '' }); }
    catch (e) { toast.error('불러오기 실패', formatApiError(e, '오류')); }
  };

  const ownerLabel = page?.createdBy || '—';
  const isOwner = !!page && (!page.createdBy || page.createdBy === currentUser?.username);
  const showSchedule = !!page && (page.category === 'enhancement' || page.kind === 'roadmap');
  const dateVal = (v?: string | null) => (v ? v.slice(0, 10) : '');

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1600px] mx-auto p-4 space-y-3">
        {/* 서비스 탭 + 뷰 토글 */}
        <div className="flex items-center gap-2 flex-wrap">
          <FolderTree className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-semibold mr-2">지식베이스</h1>
          <div className="flex items-center gap-1 flex-wrap">
            {SERVICES.map((s) => (
              <button key={s.key} type="button"
                onClick={() => { setService(s.key); setSelectedId(undefined); }}
                className={`px-2.5 py-1 rounded-xl text-sm border transition-colors ${
                  service === s.key ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border hover:bg-secondary'
                }`}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          {currentUser?.role === 'admin' && (
            <button type="button" onClick={onImport} disabled={importMut.isPending}
              title="기존 운영노트/작업가이드/서비스엔트리를 지식베이스로 비파괴 복사"
              className="flex items-center gap-1 px-2.5 py-1 rounded-xl text-sm border border-border bg-card hover:bg-secondary disabled:opacity-60">
              <DownloadCloud className="w-3.5 h-3.5" /> {importMut.isPending ? '가져오는 중…' : '기존 자산 가져오기'}
            </button>
          )}
          <div className="flex items-center gap-1 bg-card border border-border rounded-xl p-0.5">
            <button type="button" onClick={() => setView('tree')}
              className={`px-2.5 py-1 rounded-lg text-sm ${view === 'tree' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'}`}>문서</button>
            <button type="button" onClick={() => setView('roadmap')}
              className={`px-2.5 py-1 rounded-lg text-sm flex items-center gap-1 ${view === 'roadmap' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary'}`}>
              <MapIcon className="w-3.5 h-3.5" /> 고도화 로드맵
            </button>
          </div>
        </div>

        {view === 'roadmap' ? (
          <MacCard title={`${SERVICES.find((s) => s.key === service)?.label} · 고도화 로드맵`}>
            <KnowledgeRoadmap items={roadmapItems} onOpen={select} />
          </MacCard>
        ) : (
        <div className="flex gap-3 items-start">
          {/* 좌: 트리 */}
          <div className="w-72 shrink-0 sticky top-4">
            <MacCard title={`${SERVICES.find((s) => s.key === service)?.label} 문서`} bodyPadding="p-2">
              <button type="button" onClick={addRoot}
                className="w-full mb-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-xl text-sm bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20">
                <Plus className="w-3.5 h-3.5" /> 새 문서
              </button>
              {isLoading ? (
                <p className="text-xs text-muted-foreground px-2 py-4 text-center">불러오는 중…</p>
              ) : tree.length === 0 ? (
                <p className="text-xs text-muted-foreground px-2 py-6 text-center">아직 문서가 없습니다.<br />'새 문서'로 시작하세요.</p>
              ) : (
                <div className="space-y-0.5 max-h-[70vh] overflow-y-auto">
                  {tree.map((n) => (
                    <TreeRow key={n.id} node={n} depth={0} selectedId={selectedId}
                      expanded={expanded} onToggle={toggle} onSelect={select}
                      onAddChild={addChild} onDelete={removeNode} onDropNode={onDropNode} />
                  ))}
                </div>
              )}
              <p className="text-[11px] text-muted-foreground px-2 pt-2">드래그로 정렬·이동 (가운데=하위로)</p>
            </MacCard>
          </div>

          {/* 우: 본문 */}
          <div className="flex-1 min-w-0">
            {!page ? (
              <MacCard title="문서">
                <p className="text-sm text-muted-foreground py-16 text-center">좌측에서 문서를 선택하거나 '새 문서'를 만들어 주세요.</p>
              </MacCard>
            ) : (
              <MacCard title="문서">
                <div className="flex items-center gap-1 text-xs text-muted-foreground mb-2 flex-wrap">
                  <span>{SERVICES.find((s) => s.key === service)?.label}</span>
                  {breadcrumb.map((b) => (
                    <span key={b.id} className="flex items-center gap-1">
                      <ChevronRight className="w-3 h-3" />
                      <button onClick={() => select(b.id)} className="hover:text-primary">{b.title}</button>
                    </span>
                  ))}
                </div>

                <input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)}
                  className="w-full text-xl font-semibold bg-transparent border-0 border-b border-transparent focus:border-border outline-none mb-2 px-0"
                  placeholder="문서 제목" />

                <div className="flex items-center gap-2 flex-wrap mb-3 text-sm">
                  <select value={page.category ?? ''} onChange={(e) => patchMeta({ category: e.target.value || null })}
                    className="px-2 py-1 bg-background border border-border rounded-lg text-sm">
                    {CATEGORY_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                  <select value={page.kind} onChange={(e) => patchMeta({ kind: e.target.value as KnowledgeKind })}
                    className="px-2 py-1 bg-background border border-border rounded-lg text-sm">
                    {KIND_OPTIONS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                  </select>
                  <button type="button"
                    onClick={() => patchMeta({ visibility: (page.visibility === 'private' ? 'part' : 'private') as KnowledgeVisibility })}
                    className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-sm ${
                      page.visibility === 'private' ? 'bg-amber-500/10 text-amber-600 border-amber-500/30' : 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30'
                    }`}>
                    {page.visibility === 'private' ? <><Lock className="w-3.5 h-3.5" /> 비공개</> : <><Users className="w-3.5 h-3.5" /> 파트 공유</>}
                  </button>
                  {page.category && <span className="text-xs px-1.5 py-0.5 rounded bg-secondary">{CATEGORY_LABEL[page.category] ?? page.category}</span>}
                  <span className="text-xs text-muted-foreground">소유자: {ownerLabel}</span>
                  {editors.length > 0 && (
                    <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600 border border-amber-500/30" title="같은 문서를 보고 있는 사용자">
                      <Eye className="w-3 h-3" /> 편집 중: {editors.map((e) => e.displayName || e.username).join(', ')}
                    </span>
                  )}
                  <div className="flex-1" />
                  <button type="button" onClick={() => setShowHistory((v) => !v)}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border hover:bg-secondary text-sm">
                    <History className="w-3.5 h-3.5" /> 히스토리 ({versions.length})
                  </button>
                  <button type="button" onClick={save} disabled={updatePage.isPending}
                    className="flex items-center gap-1 px-3 py-1 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 text-sm disabled:opacity-60">
                    <Save className="w-3.5 h-3.5" /> 저장
                  </button>
                </div>

                {/* 고도화 일정/스프린트 — 로드맵 연동 */}
                {showSchedule && (
                  <div className="flex items-center gap-3 flex-wrap mb-3 text-sm bg-muted/20 border border-border rounded-xl px-3 py-2">
                    <span className="text-xs font-medium text-muted-foreground">고도화 일정</span>
                    <label className="flex items-center gap-1">시작
                      <input type="date" value={dateVal(page.startAt)}
                        onChange={(e) => patchMeta({ startAt: e.target.value ? `${e.target.value}T00:00:00` : null })}
                        className="px-2 py-0.5 bg-background border border-border rounded-lg" />
                    </label>
                    <label className="flex items-center gap-1">완료예정
                      <input type="date" value={dateVal(page.dueAt)}
                        onChange={(e) => patchMeta({ dueAt: e.target.value ? `${e.target.value}T00:00:00` : null })}
                        className="px-2 py-0.5 bg-background border border-border rounded-lg" />
                    </label>
                    <label className="flex items-center gap-1">스프린트
                      <select value={page.sprintId ?? ''} onChange={(e) => patchMeta({ sprintId: e.target.value || null })}
                        className="px-2 py-0.5 bg-background border border-border rounded-lg">
                        <option value="">미배정</option>
                        {sprints.map((s) => <option key={s.id} value={s.id}>{s.name}{s.status === 'active' ? ' (진행중)' : ''}</option>)}
                      </select>
                    </label>
                  </div>
                )}

                {showHistory && (
                  <div className="mb-3 border border-border rounded-xl p-3 bg-muted/20">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-medium">버전 히스토리</p>
                      <button type="button" onClick={onSaveMilestone}
                        className="flex items-center gap-1 px-2 py-1 rounded-lg bg-card border border-border hover:bg-secondary text-xs">
                        <Plus className="w-3 h-3" /> 버전 저장(마일스톤)
                      </button>
                    </div>
                    {versions.length === 0 ? (
                      <p className="text-xs text-muted-foreground">버전이 없습니다.</p>
                    ) : (
                      <div className="space-y-1 max-h-64 overflow-y-auto">
                        {versions.map((v) => (
                          <div key={v.id} className="flex items-center gap-2 text-xs py-1 border-b border-border/50 last:border-0">
                            <span className="font-mono text-muted-foreground w-10">v{v.versionNo}</span>
                            <span className={`px-1.5 py-0.5 rounded ${v.kind === 'milestone' ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground'}`}>
                              {v.kind === 'milestone' ? (v.label || '마일스톤') : '자동'}
                            </span>
                            <span className="text-muted-foreground">{v.author ?? '—'}</span>
                            <span className="text-muted-foreground">{v.createdAt?.slice(0, 16).replace('T', ' ')}</span>
                            <div className="flex-1" />
                            <button onClick={() => onPreview(v.id, v.versionNo)} className="p-1 rounded hover:bg-background text-muted-foreground hover:text-primary" title="미리보기"><Eye className="w-3.5 h-3.5" /></button>
                            <button onClick={() => onRestore(v.id, v.versionNo)} className="p-1 rounded hover:bg-background text-muted-foreground hover:text-emerald-600" title="이 버전으로 복원"><RotateCcw className="w-3.5 h-3.5" /></button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {page.kind === 'board' ? (
                  <KnowledgeBoard
                    items={flat.filter((n) => (n.parentId ?? null) === page.id)}
                    onOpen={select}
                    onStatusChange={(id, st) => updatePage.mutate({ id, data: { status: st } })}
                  />
                ) : isOwner || page.visibility !== 'private' ? (
                  <RichTextEditor value={draftContent} onChange={setDraftContent}
                    placeholder="문서 내용을 작성하세요 — '/' 또는 툴바 템플릿, '[[' 로 문서 링크"
                    minHeight="440px" defaultBg="#ffffff" linkSearch={linkSearch} />
                ) : (
                  <RichContent content={page.content ?? ''} />
                )}

                {/* 백링크 — 이 문서를 참조하는 곳 */}
                {backlinks.length > 0 && (
                  <div className="mt-3 border-t border-border pt-3">
                    <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                      <Link2 className="w-3.5 h-3.5" /> 이 문서를 참조하는 곳 ({backlinks.length})
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {backlinks.map((b) => (
                        <button key={b.id} onClick={() => select(b.id)}
                          className="text-xs px-2 py-0.5 rounded-lg border border-border hover:bg-secondary text-primary">
                          {b.title}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </MacCard>
            )}
          </div>
        </div>
        )}
      </div>

      {previewVersion && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setPreviewVersion(null)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-3xl max-h-[80vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2 border-b border-border">
              <p className="text-sm font-medium">버전 v{previewVersion.no} 미리보기</p>
              <button onClick={() => setPreviewVersion(null)} className="p-1 rounded hover:bg-secondary"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 overflow-y-auto"><RichContent content={previewVersion.content} /></div>
          </div>
        </div>
      )}
    </div>
  );
}
