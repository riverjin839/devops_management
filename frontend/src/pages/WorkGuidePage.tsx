import { useId, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useLocation, useSearchParams } from 'react-router-dom';
import {
  BookMarked, Plus, GitFork,
  ChevronRight, ChevronDown, FolderOpen, Folder,
  FileText, CheckCircle, Archive, Pencil, Check, X,
} from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { workGuidesApi, workflowsApi } from '@/services/api';
import type { WorkGuide } from '@/types';
import { useToast, SidePane } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import { GuideForm, GuidePageView } from '@/components/work-guides';

// ── Constants ─────────────────────────────────────────────────────────────────
const STATUS_CFG: Record<string, { label: string; icon: React.ReactNode; cls: string }> = {
  draft:    { label: '초안', icon: <FileText className="w-3 h-3" />,    cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30' },
  active:   { label: '활성', icon: <CheckCircle className="w-3 h-3" />, cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
  archived: { label: '보관', icon: <Archive className="w-3 h-3" />,     cls: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/30' },
};

const REF_TYPE = 'work_guide';

// ── Tree node ─────────────────────────────────────────────────────────────────
interface TreeNodeProps {
  guide: WorkGuide;
  childGuides: WorkGuide[];
  allGuides: WorkGuide[];
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
  onCreateChild: (parentId: string, title: string) => void;
}

/** 인라인 텍스트 인풋 — Enter 저장 / Esc 취소 / blur 저장. */
function InlineTitleInput({
  initial, onSave, onCancel, placeholder,
}: {
  initial: string;
  onSave: (v: string) => void;
  onCancel: () => void;
  placeholder?: string;
}) {
  const [v, setV] = useState(initial);
  const committed = useRef(false);
  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    const t = v.trim();
    if (!t || t === initial.trim()) onCancel();
    else onSave(t);
  };
  return (
    <div className="flex items-center gap-1 flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        type="text"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { committed.current = true; onCancel(); }
        }}
        onBlur={commit}
        placeholder={placeholder}
        className="flex-1 min-w-0 px-1.5 py-0.5 text-sm bg-background border border-primary/40 rounded focus:outline-none focus:border-primary"
      />
      <button
        type="button"
        onMouseDown={(e) => { e.preventDefault(); commit(); }}
        className="p-0.5 text-primary hover:text-primary/80"
        title="저장"
      >
        <Check className="w-3 h-3" />
      </button>
      <button
        type="button"
        onMouseDown={(e) => { e.preventDefault(); committed.current = true; onCancel(); }}
        className="p-0.5 text-muted-foreground hover:text-foreground"
        title="취소"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

function TreeNode({ guide, childGuides, allGuides, depth, selectedId, onSelect, onRename, onCreateChild }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [addingChild, setAddingChild] = useState(false);
  const hasChildren = childGuides.length > 0;
  const isSelected = selectedId === guide.id;
  const sc = STATUS_CFG[guide.status] ?? STATUS_CFG.draft;

  return (
    <div>
      <div
        className={`group flex items-center gap-1 py-1.5 pr-2 rounded-lg transition-colors text-sm ${
          renaming ? '' : 'cursor-pointer'
        } ${
          isSelected
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
        }`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => { if (!renaming) onSelect(guide.id); }}
      >
        {hasChildren ? (
          <span
            className="p-0.5 rounded flex-shrink-0"
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
          >
            {expanded
              ? <ChevronDown className="w-3.5 h-3.5" />
              : <ChevronRight className="w-3.5 h-3.5" />}
          </span>
        ) : (
          <span className="w-5 flex-shrink-0" />
        )}
        {hasChildren
          ? (expanded
              ? <FolderOpen className="w-3.5 h-3.5 flex-shrink-0 text-primary/60" />
              : <Folder className="w-3.5 h-3.5 flex-shrink-0 text-primary/60" />)
          : <FileText className="w-3.5 h-3.5 flex-shrink-0" />}

        {renaming ? (
          <InlineTitleInput
            initial={guide.title}
            onSave={(v) => { onRename(guide.id, v); setRenaming(false); }}
            onCancel={() => setRenaming(false)}
            placeholder="페이지 이름"
          />
        ) : (
          <>
            <span className="flex-1 min-w-0 truncate" title="더블클릭하여 이름 변경"
              onDoubleClick={(e) => { e.stopPropagation(); setRenaming(true); }}>
              {guide.title}
            </span>
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setRenaming(true); }}
                className="p-0.5 rounded text-muted-foreground/70 hover:text-primary hover:bg-secondary/80"
                title="이름 변경"
              >
                <Pencil className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setAddingChild(true); setExpanded(true); }}
                className="p-0.5 rounded text-muted-foreground/70 hover:text-primary hover:bg-secondary/80"
                title="하위 페이지 추가"
              >
                <Plus className="w-3 h-3" />
              </button>
            </div>
            <span className={`inline-flex items-center text-xs px-1 py-0.5 rounded-full border flex-shrink-0 ${sc.cls}`}>
              {sc.icon}
            </span>
          </>
        )}
      </div>

      {expanded && (hasChildren || addingChild) && (
        <div>
          {childGuides.map((child) => (
            <TreeNode
              key={child.id}
              guide={child}
              childGuides={allGuides.filter((g) => g.parentId === child.id)}
              allGuides={allGuides}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              onRename={onRename}
              onCreateChild={onCreateChild}
            />
          ))}
          {addingChild && (
            <div
              className="flex items-center gap-1 py-1.5 pr-2"
              style={{ paddingLeft: `${8 + (depth + 1) * 16}px` }}
            >
              <span className="w-5 flex-shrink-0" />
              <FileText className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground/50" />
              <InlineTitleInput
                initial=""
                onSave={(v) => { onCreateChild(guide.id, v); setAddingChild(false); }}
                onCancel={() => setAddingChild(false)}
                placeholder="새 하위 페이지 제목"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Add to workflow modal ─────────────────────────────────────────────────────
interface AddToWorkflowModalProps {
  guide: WorkGuide;
  onClose: () => void;
}

function AddToWorkflowModal({ guide, onClose }: AddToWorkflowModalProps) {
  const [selectedWfId, setSelectedWfId] = useState('');
  const [adding, setAdding]             = useState(false);
  const [done, setDone]                 = useState(false);
  const [error, setError]               = useState('');
  const wfId = useId();

  const { data: wfData } = useQuery({
    queryKey: ['workflows'],
    queryFn: () => workflowsApi.getAll().then((r) => r.data),
    staleTime: 1000 * 10,
  });
  const workflows = wfData?.data ?? [];

  const handleAdd = async () => {
    if (!selectedWfId) { setError('워크플로를 선택해 주세요.'); return; }
    setAdding(true); setError('');
    try {
      const wf = workflows.find((w) => w.id === selectedWfId);
      await workflowsApi.createStep(selectedWfId, {
        title: guide.title,
        description: guide.content?.slice(0, 120) || undefined,
        referenceType: REF_TYPE,
        referenceId: guide.id,
        stepType: 'action',
        orderIndex: wf ? wf.steps.length : 0,
      });
      setDone(true);
      setTimeout(onClose, 1200);
    } catch {
      setError('추가에 실패했습니다.');
    } finally {
      setAdding(false);
    }
  };

  const paneTitle = (
    <div className="flex items-center gap-2 min-w-0">
      <GitFork className="w-4 h-4 text-primary flex-shrink-0" />
      <h2 className="text-sm font-semibold truncate">워크플로에 노드로 추가</h2>
    </div>
  );

  return (
    <SidePane open onClose={onClose} title={paneTitle} bodyClassName="p-6" width="40%">
      <p className="text-sm text-muted-foreground mb-4 bg-secondary/50 rounded-lg p-2.5 border border-border">
        <span className="font-medium text-foreground">{guide.title}</span>{' '}가이드를 워크플로 노드로 연결합니다.
      </p>
      {done ? (
        <div className="flex items-center gap-2 text-sm text-emerald-500 py-2">
          <CheckCircle className="w-4 h-4" /> 워크플로에 추가되었습니다!
        </div>
      ) : (
        <>
          {error && <p className="text-sm text-destructive mb-3">{error}</p>}
          <div className="mb-4">
            <label htmlFor={wfId} className="block text-sm font-medium mb-1.5">워크플로 선택</label>
            {workflows.length === 0 ? (
              <p className="text-sm text-muted-foreground">등록된 워크플로가 없습니다.</p>
            ) : (
              <select
                id={wfId}
                value={selectedWfId}
                onChange={(e) => setSelectedWfId(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="">— 선택 —</option>
                {workflows.map((wf) => (
                  <option key={wf.id} value={wf.id}>{wf.title} ({wf.steps.length}단계)</option>
                ))}
              </select>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={onClose}
              className="px-3 py-1.5 text-sm bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors">
              취소
            </button>
            <button onClick={handleAdd} disabled={adding || workflows.length === 0}
              className="px-3 py-1.5 text-sm bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors disabled:opacity-60 flex items-center gap-1.5">
              <GitFork className="w-3.5 h-3.5" />
              {adding ? '추가 중...' : '워크플로에 추가'}
            </button>
          </div>
        </>
      )}
    </SidePane>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export function WorkGuidePage() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { id: routeId } = useParams<{ id: string }>();

  // URL 기반 모드 판정.
  // /work-guides           → list (no selection)
  // /work-guides/new       → form (new, optional ?parentId=...)
  // /work-guides/:id       → read
  // /work-guides/:id/edit  → form (edit)
  const isNewMode  = location.pathname === '/work-guides/new';
  const isEditMode = !!routeId && location.pathname.endsWith('/edit');
  const isReadMode = !!routeId && !isEditMode;

  const { data, isLoading } = useQuery({
    queryKey: ['work-guides'],
    queryFn: () => workGuidesApi.getAll().then((r) => r.data),
    staleTime: 1000 * 30,
  });

  const allGuides = useMemo(
    () => (data?.data ?? []).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
    [data],
  );

  const selectedId = routeId ?? null;
  const selectedGuide = allGuides.find((g) => g.id === selectedId) ?? null;
  const rootGuides = allGuides.filter((g) => !g.parentId);

  const [addToWf, setAddToWf] = useState<WorkGuide | null>(null);

  const handleDelete = async (guide: WorkGuide) => {
    if (!confirm(`"${guide.title}" 페이지를 삭제하시겠습니까?`)) return;
    try {
      await workGuidesApi.delete(guide.id);
      qc.invalidateQueries({ queryKey: ['work-guides'] });
      toast.success('페이지 삭제됨', guide.title);
      navigate('/work-guides');
    } catch (e) {
      toast.error('삭제 실패', formatApiError(e));
    }
  };

  /** 트리에서 ✏ 또는 더블클릭으로 이름 인라인 변경. */
  const handleRename = async (id: string, newTitle: string) => {
    try {
      await workGuidesApi.update(id, { title: newTitle });
      qc.invalidateQueries({ queryKey: ['work-guides'] });
    } catch (e) {
      toast.error('이름 변경 실패', formatApiError(e));
    }
  };

  /** 트리에서 + 버튼 누르면 빈 자식 페이지 생성 후 편집 화면으로 진입. */
  const handleCreateChild = async (parentId: string, title: string) => {
    try {
      const res = await workGuidesApi.create({ title, parentId, status: 'draft' });
      qc.invalidateQueries({ queryKey: ['work-guides'] });
      toast.success('하위 페이지 생성됨', title);
      // 본문 작성하도록 바로 편집 진입
      navigate(`/work-guides/${res.data.id}/edit`);
    } catch (e) {
      toast.error('생성 실패', formatApiError(e));
    }
  };

  // form 모드일 때 사용할 초기값
  const formInitial = isEditMode && selectedGuide ? selectedGuide : null;
  // /new?parentId=... 또는 read 페이지에서 "하위 페이지 추가" 클릭 시 부모 id
  const formDefaultParentId = isNewMode
    ? searchParams.get('parentId')
    : null;

  const formCancelTarget = () => {
    if (isEditMode && selectedId) navigate(`/work-guides/${selectedId}`);
    else navigate('/work-guides');
  };

  return (
    <div className="flex bg-background h-[100dvh]">
      {/* Sidebar tree */}
      <aside className="w-64 flex-shrink-0 border-r border-border bg-card flex flex-col overflow-hidden">
        <div className="px-4 py-4 border-b border-border flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <BookMarked className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold">작업 가이드</span>
          </div>
          <button
            onClick={() => navigate('/work-guides/new')}
            className="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-primary transition-colors"
            title="새 페이지"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-2 px-2">
          {isLoading ? (
            <div className="text-sm text-muted-foreground text-center py-6">불러오는 중...</div>
          ) : rootGuides.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-6">
              페이지가 없습니다
            </div>
          ) : (
            rootGuides.map((guide) => (
              <TreeNode
                key={guide.id}
                guide={guide}
                childGuides={allGuides.filter((g) => g.parentId === guide.id)}
                allGuides={allGuides}
                depth={0}
                selectedId={selectedId}
                onSelect={(id) => navigate(`/work-guides/${id}`)}
                onRename={handleRename}
                onCreateChild={handleCreateChild}
              />
            ))
          )}
        </div>

        <div className="px-3 py-2 border-t border-border flex-shrink-0">
          <p className="text-xs text-muted-foreground">전체 {allGuides.length}개 페이지</p>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {isNewMode ? (
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-4xl mx-auto px-10 py-8">
              <div className="mb-6">
                <h1 className="text-2xl font-bold leading-tight">새 페이지</h1>
                <p className="text-sm text-muted-foreground mt-1">
                  제목과 본문을 입력하고 저장하면 트리에 추가됩니다.
                </p>
              </div>
              <GuideForm
                initial={null}
                allGuides={allGuides}
                defaultParentId={formDefaultParentId}
                onCancel={() => navigate('/work-guides')}
                onSaved={(newId) => {
                  if (newId) navigate(`/work-guides/${newId}`);
                  else navigate('/work-guides');
                }}
              />
            </div>
          </div>
        ) : isEditMode && selectedGuide ? (
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-4xl mx-auto px-10 py-8">
              <div className="mb-6">
                <h1 className="text-2xl font-bold leading-tight">페이지 수정</h1>
                <p className="text-sm text-muted-foreground mt-1">
                  필요한 항목을 수정한 뒤 저장 버튼을 누르세요.
                </p>
              </div>
              <GuideForm
                initial={formInitial}
                allGuides={allGuides}
                onCancel={formCancelTarget}
                onSaved={(savedId) => {
                  if (savedId) navigate(`/work-guides/${savedId}`);
                  else formCancelTarget();
                }}
              />
            </div>
          </div>
        ) : isReadMode && selectedGuide ? (
          <GuidePageView
            guide={selectedGuide}
            allGuides={allGuides}
            onSelect={(id) => navigate(`/work-guides/${id}`)}
            onEdit={() => navigate(`/work-guides/${selectedGuide.id}/edit`)}
            onAddChild={() => navigate(`/work-guides/new?parentId=${selectedGuide.id}`)}
            onAddToWorkflow={() => setAddToWf(selectedGuide)}
            onDelete={() => handleDelete(selectedGuide)}
          />
        ) : isReadMode && !selectedGuide && !isLoading ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
            <BookMarked className="w-16 h-16 text-muted-foreground/20 mb-4" />
            <h2 className="text-xl font-semibold mb-2">페이지를 찾을 수 없습니다</h2>
            <p className="text-muted-foreground mb-6 max-w-md text-sm leading-relaxed">
              요청하신 페이지가 삭제되었거나 존재하지 않습니다.
            </p>
            <button
              onClick={() => navigate('/work-guides')}
              className="inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors text-sm"
            >
              목록으로
            </button>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
            <BookMarked className="w-16 h-16 text-muted-foreground/20 mb-4" />
            <h2 className="text-xl font-semibold mb-2">작업 가이드</h2>
            <p className="text-muted-foreground mb-6 max-w-md text-sm leading-relaxed">
              운영 절차, 배포 가이드, 트러블슈팅 등 팀의 지식을 계층적으로 관리하세요.
              왼쪽 트리에서 페이지를 선택하거나 새 페이지를 만드세요.
            </p>
            <button
              onClick={() => navigate('/work-guides/new')}
              className="inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors text-sm"
            >
              <Plus className="w-4 h-4" /> 첫 번째 페이지 만들기
            </button>
          </div>
        )}
      </main>

      {addToWf && (
        <AddToWorkflowModal
          guide={addToWf}
          onClose={() => setAddToWf(null)}
        />
      )}
    </div>
  );
}
