import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ChevronRight, ChevronDown, FileText, Folder, FolderTree, Plus, Trash2,
  History, Save, Lock, Users, RotateCcw, Eye, X, Map as MapIcon, KanbanSquare,
} from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { RichTextEditor, RichContent } from '@/components/editor';
import { useToast } from '@/components/common';
import { useAuthStore } from '@/stores/authStore';
import { SERVICE_CATALOG } from '@/components/services/serviceCatalog';
import { knowledgeApi } from '@/services/api';
import { formatApiError } from '@/lib/utils';
import {
  useKnowledgeTree, useKnowledgePage, usePageVersions,
  useCreatePage, useUpdatePage, useDeletePage, useSaveMilestone, useRestoreVersion,
} from '@/hooks/useKnowledge';
import type { KnowledgePageNode, KnowledgeKind, KnowledgeVisibility } from '@/types';

// 서비스 탭: 카탈로그 12종 + '공통'(service=null)
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

/** 트리를 평면화 + 부모 경로 계산용. */
function flatten(nodes: KnowledgePageNode[], acc: KnowledgePageNode[] = []): KnowledgePageNode[] {
  for (const n of nodes) {
    acc.push(n);
    if (n.children?.length) flatten(n.children, acc);
  }
  return acc;
}

interface TreeRowProps {
  node: KnowledgePageNode;
  depth: number;
  selectedId?: string;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onAddChild: (parent: KnowledgePageNode) => void;
  onDelete: (node: KnowledgePageNode) => void;
}

function TreeRow({ node, depth, selectedId, expanded, onToggle, onSelect, onAddChild, onDelete }: TreeRowProps) {
  const hasChildren = !!node.children?.length;
  const isOpen = expanded.has(node.id);
  const Icon = kindIcon(node.kind);
  return (
    <div>
      <div
        className={`group flex items-center gap-1 pr-1 py-1 rounded-lg cursor-pointer text-sm ${
          selectedId === node.id ? 'bg-primary/10 text-primary' : 'hover:bg-secondary text-foreground'
        }`}
        style={{ paddingLeft: depth * 14 + 4 }}
        onClick={() => onSelect(node.id)}
      >
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
        <button
          type="button"
          title="하위 추가"
          onClick={(e) => { e.stopPropagation(); onAddChild(node); }}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-background text-muted-foreground hover:text-primary"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          title="삭제"
          onClick={(e) => { e.stopPropagation(); onDelete(node); }}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-background text-muted-foreground hover:text-rose-500"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      {hasChildren && isOpen && node.children.map((c) => (
        <TreeRow key={c.id} node={c} depth={depth + 1} selectedId={selectedId}
          expanded={expanded} onToggle={onToggle} onSelect={onSelect}
          onAddChild={onAddChild} onDelete={onDelete} />
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
  const { data: tree = [], isLoading } = useKnowledgeTree(serviceParam);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | undefined>(routeId);

  const createPage = useCreatePage();
  const updatePage = useUpdatePage();
  const deletePage = useDeletePage();
  const saveMilestone = useSaveMilestone();
  const restoreVersion = useRestoreVersion();

  const { data: page } = useKnowledgePage(selectedId);
  const { data: versions = [] } = usePageVersions(selectedId);

  // 편집 로컬 상태
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [previewVersion, setPreviewVersion] = useState<{ no: number; content: string } | null>(null);

  useEffect(() => {
    if (page) {
      setDraftTitle(page.title);
      setDraftContent(page.content ?? '');
    }
  }, [page]);

  // routeId 동기화
  useEffect(() => { if (routeId) setSelectedId(routeId); }, [routeId]);

  const flat = useMemo(() => flatten(tree), [tree]);
  const breadcrumb = useMemo(() => {
    if (!page) return [];
    const byId = new Map(flat.map((n) => [n.id, n]));
    const chain: KnowledgePageNode[] = [];
    let cur = byId.get(page.id);
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return chain;
  }, [page, flat]);

  const select = (pid: string) => {
    setSelectedId(pid);
    navigate(`/knowledge/${pid}`);
  };

  const nextRootOrder = () => (tree.length ? Math.max(...tree.map((n) => n.sortOrder)) + 1 : 0);

  const addRoot = async () => {
    const title = window.prompt('새 문서 제목');
    if (!title?.trim()) return;
    try {
      const created = await createPage.mutateAsync({
        service: serviceParam ?? null, parentId: null, kind: 'doc',
        title: title.trim(), sortOrder: nextRootOrder(),
      });
      select(created.id);
    } catch (e) { toast.error('생성 실패', formatApiError(e, '문서 생성 중 오류')); }
  };

  const addChild = async (parent: KnowledgePageNode) => {
    const title = window.prompt(`'${parent.title}' 하위 문서 제목`);
    if (!title?.trim()) return;
    const order = parent.children?.length ? Math.max(...parent.children.map((c) => c.sortOrder)) + 1 : 0;
    try {
      const created = await createPage.mutateAsync({
        service: serviceParam ?? null, parentId: parent.id, kind: 'doc',
        category: parent.category ?? null, title: title.trim(), sortOrder: order,
      });
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

  const toggle = (pid: string) => setExpanded((s) => {
    const n = new Set(s); n.has(pid) ? n.delete(pid) : n.add(pid); return n;
  });

  const save = async () => {
    if (!page) return;
    try {
      await updatePage.mutateAsync({ id: page.id, data: { title: draftTitle.trim() || page.title, content: draftContent } });
      toast.success('저장됨', '문서가 저장되었습니다.');
    } catch (e) { toast.error('저장 실패', formatApiError(e, '저장 중 오류')); }
  };

  const patchMeta = async (data: { category?: string | null; kind?: KnowledgeKind; visibility?: KnowledgeVisibility }) => {
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

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1600px] mx-auto p-4 space-y-3">
        {/* 서비스 탭 */}
        <div className="flex items-center gap-2 flex-wrap">
          <FolderTree className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-semibold mr-2">지식베이스</h1>
          <div className="flex items-center gap-1 flex-wrap">
            {SERVICES.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => { setService(s.key); setSelectedId(undefined); }}
                className={`px-2.5 py-1 rounded-xl text-sm border transition-colors ${
                  service === s.key ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border hover:bg-secondary'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-3 items-start">
          {/* 좌: 트리 */}
          <div className="w-72 shrink-0 sticky top-4">
            <MacCard title={`${SERVICES.find((s) => s.key === service)?.label} 문서`} bodyPadding="p-2">
              <button
                type="button"
                onClick={addRoot}
                className="w-full mb-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-xl text-sm bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20"
              >
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
                      onAddChild={addChild} onDelete={removeNode} />
                  ))}
                </div>
              )}
            </MacCard>
          </div>

          {/* 우: 본문 */}
          <div className="flex-1 min-w-0">
            {!page ? (
              <MacCard title="문서">
                <p className="text-sm text-muted-foreground py-16 text-center">
                  좌측에서 문서를 선택하거나 '새 문서'를 만들어 주세요.
                </p>
              </MacCard>
            ) : (
              <MacCard title="문서">
                {/* breadcrumb */}
                <div className="flex items-center gap-1 text-xs text-muted-foreground mb-2 flex-wrap">
                  <span>{SERVICES.find((s) => s.key === service)?.label}</span>
                  {breadcrumb.map((b) => (
                    <span key={b.id} className="flex items-center gap-1">
                      <ChevronRight className="w-3 h-3" />
                      <button onClick={() => select(b.id)} className="hover:text-primary">{b.title}</button>
                    </span>
                  ))}
                </div>

                {/* 제목 */}
                <input
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  className="w-full text-xl font-semibold bg-transparent border-0 border-b border-transparent focus:border-border outline-none mb-2 px-0"
                  placeholder="문서 제목"
                />

                {/* 메타 행 */}
                <div className="flex items-center gap-2 flex-wrap mb-3 text-sm">
                  <select
                    value={page.category ?? ''}
                    onChange={(e) => patchMeta({ category: e.target.value || null })}
                    className="px-2 py-1 bg-background border border-border rounded-lg text-sm"
                  >
                    {CATEGORY_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                  <select
                    value={page.kind}
                    onChange={(e) => patchMeta({ kind: e.target.value as KnowledgeKind })}
                    className="px-2 py-1 bg-background border border-border rounded-lg text-sm"
                  >
                    {KIND_OPTIONS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                  </select>
                  <button
                    type="button"
                    onClick={() => patchMeta({ visibility: page.visibility === 'private' ? 'part' : 'private' })}
                    className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-sm ${
                      page.visibility === 'private'
                        ? 'bg-amber-500/10 text-amber-600 border-amber-500/30'
                        : 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30'
                    }`}
                  >
                    {page.visibility === 'private' ? <><Lock className="w-3.5 h-3.5" /> 비공개</> : <><Users className="w-3.5 h-3.5" /> 파트 공유</>}
                  </button>
                  <span className="text-xs text-muted-foreground">소유자: {ownerLabel}</span>
                  {page.category && <span className="text-xs px-1.5 py-0.5 rounded bg-secondary">{CATEGORY_LABEL[page.category] ?? page.category}</span>}
                  <div className="flex-1" />
                  <button
                    type="button"
                    onClick={() => setShowHistory((v) => !v)}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border hover:bg-secondary text-sm"
                  >
                    <History className="w-3.5 h-3.5" /> 히스토리 ({versions.length})
                  </button>
                  <button
                    type="button"
                    onClick={save}
                    disabled={updatePage.isPending}
                    className="flex items-center gap-1 px-3 py-1 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 text-sm disabled:opacity-60"
                  >
                    <Save className="w-3.5 h-3.5" /> 저장
                  </button>
                </div>

                {/* 히스토리 패널 */}
                {showHistory && (
                  <div className="mb-3 border border-border rounded-xl p-3 bg-muted/20">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-medium">버전 히스토리</p>
                      <button
                        type="button"
                        onClick={onSaveMilestone}
                        className="flex items-center gap-1 px-2 py-1 rounded-lg bg-card border border-border hover:bg-secondary text-xs"
                      >
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

                {/* 본문 에디터 */}
                {isOwner || page.visibility !== 'private' ? (
                  <RichTextEditor
                    value={draftContent}
                    onChange={setDraftContent}
                    placeholder="문서 내용을 작성하세요 — '/' 또는 툴바 템플릿 사용"
                    minHeight="480px"
                    defaultBg="#ffffff"
                  />
                ) : (
                  <RichContent content={page.content ?? ''} />
                )}
              </MacCard>
            )}
          </div>
        </div>
      </div>

      {/* 버전 미리보기 모달 */}
      {previewVersion && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setPreviewVersion(null)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-3xl max-h-[80vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2 border-b border-border">
              <p className="text-sm font-medium">버전 v{previewVersion.no} 미리보기</p>
              <button onClick={() => setPreviewVersion(null)} className="p-1 rounded hover:bg-secondary"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 overflow-y-auto">
              <RichContent content={previewVersion.content} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
