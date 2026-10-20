import { useId, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useLocation, useSearchParams } from 'react-router-dom';
import {
  BookMarked, Plus, GitFork,
  ChevronRight, ChevronDown, FolderOpen, Folder,
  FileText, CheckCircle, Pencil, Check, X,
} from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { workGuidesApi, workflowsApi } from '@/services/api';
import type { WorkGuide } from '@/types';
import {
  useToast, SidePane, EmptyState, LoadingState, ErrorState, PageShell, ConfirmDialog,
} from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { formatApiError, stripHtml } from '@/lib/utils';
import { useCanOperate } from '@/hooks/useCanOperate';
import { GuideForm, GuidePageView, guideStatusCfg } from '@/components/work-guides';

// ── Constants ─────────────────────────────────────────────────────────────────
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
        aria-label="저장"
      >
        <Check className="w-3 h-3" />
      </button>
      <button
        type="button"
        onMouseDown={(e) => { e.preventDefault(); committed.current = true; onCancel(); }}
        className="p-0.5 text-muted-foreground hover:text-foreground"
        title="취소"
        aria-label="취소"
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
  const sc = guideStatusCfg(guide.status);

  // D-165 — 행 전체 div onClick 대신 행 안의 제목·펼침을 <button> 으로 둬 키보드로 열 수 있게 한다.
  return (
    <li>
      <div
        className={`group flex items-center gap-1 py-1.5 pr-2 rounded-lg transition-colors text-sm ${
          isSelected
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
        }`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="p-0.5 rounded flex-shrink-0 hover:bg-secondary/80"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={`${guide.title} 하위 페이지 ${expanded ? '접기' : '펼치기'}`}
            title={expanded ? '접기' : '펼치기'}
          >
            {expanded
              ? <ChevronDown className="w-3.5 h-3.5" aria-hidden />
              : <ChevronRight className="w-3.5 h-3.5" aria-hidden />}
          </button>
        ) : (
          <span className="w-5 flex-shrink-0" />
        )}

        {renaming ? (
          <InlineTitleInput
            initial={guide.title}
            onSave={(v) => { onRename(guide.id, v); setRenaming(false); }}
            onCancel={() => setRenaming(false)}
            placeholder="페이지 이름"
          />
        ) : (
          <>
            <button
              type="button"
              className="flex-1 min-w-0 flex items-center gap-1 text-left rounded"
              onClick={() => onSelect(guide.id)}
              onDoubleClick={() => setRenaming(true)}
              aria-current={isSelected ? 'page' : undefined}
              title="더블클릭하여 이름 변경"
            >
              {hasChildren
                ? (expanded
                    ? <FolderOpen className="w-3.5 h-3.5 flex-shrink-0 text-primary/60" aria-hidden />
                    : <Folder className="w-3.5 h-3.5 flex-shrink-0 text-primary/60" aria-hidden />)
                : <FileText className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />}
              <span className="flex-1 min-w-0 truncate">{guide.title}</span>
            </button>
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity flex-shrink-0">
              <button
                type="button"
                onClick={() => setRenaming(true)}
                className="p-0.5 rounded text-muted-foreground hover:text-primary hover:bg-secondary/80"
                title="이름 변경"
                aria-label={`${guide.title} 이름 변경`}
              >
                <Pencil className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => { setAddingChild(true); setExpanded(true); }}
                className="p-0.5 rounded text-muted-foreground hover:text-primary hover:bg-secondary/80"
                title="하위 페이지 추가"
                aria-label={`${guide.title} 하위 페이지 추가`}
              >
                <Plus className="w-3 h-3" />
              </button>
            </div>
            <span
              className={`inline-flex items-center text-xs px-1 py-0.5 rounded-full border flex-shrink-0 ${sc.cls}`}
              title={`상태: ${sc.label}`}
            >
              {sc.icon}
              <span className="sr-only">상태: {sc.label}</span>
            </span>
          </>
        )}
      </div>

      {expanded && (hasChildren || addingChild) && (
        <ul>
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
            <li
              className="flex items-center gap-1 py-1.5 pr-2"
              style={{ paddingLeft: `${8 + (depth + 1) * 16}px` }}
            >
              <span className="w-5 flex-shrink-0" />
              <FileText className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" aria-hidden />
              <InlineTitleInput
                initial=""
                onSave={(v) => { onCreateChild(guide.id, v); setAddingChild(false); }}
                onCancel={() => setAddingChild(false)}
                placeholder="새 하위 페이지 제목"
              />
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

// ── Add to workflow modal ─────────────────────────────────────────────────────
interface AddToWorkflowModalProps {
  guide: WorkGuide;
  onClose: () => void;
}

function AddToWorkflowModal({ guide, onClose }: AddToWorkflowModalProps) {
  const qc = useQueryClient();
  const { canOperate, withHint, ariaWithHint } = useCanOperate();
  const [selectedWfId, setSelectedWfId] = useState('');
  const [adding, setAdding]             = useState(false);
  const [done, setDone]                 = useState(false);
  const [error, setError]               = useState('');
  const wfId = useId();

  const { data: wfData, isLoading, isError, error: loadError, refetch } = useQuery({
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
      // 본문은 리치텍스트 HTML 이라 그대로 자르면 태그 조각이 단계 설명에 남는다(D-163③).
      const summary = stripHtml(guide.content).slice(0, 120);
      await workflowsApi.createStep(selectedWfId, {
        title: guide.title,
        description: summary || undefined,
        referenceType: REF_TYPE,
        referenceId: guide.id,
        stepType: 'action',
        orderIndex: wf ? wf.steps.length : 0,
      });
      await qc.invalidateQueries({ queryKey: ['workflows'] });
      setDone(true);
      setTimeout(onClose, 1200);
    } catch (e) {
      // 403(viewer)·404 등 서버 사유를 그대로 보여 준다(D-159).
      setError(`추가에 실패했습니다 — ${formatApiError(e)}`);
    } finally {
      setAdding(false);
    }
  };

  const paneTitle = (
    <div className="flex items-center gap-2 min-w-0">
      <GitFork className="w-4 h-4 text-primary flex-shrink-0" aria-hidden />
      <h2 className="text-sm font-semibold truncate">워크플로에 노드로 추가</h2>
    </div>
  );

  return (
    <SidePane open onClose={onClose} title={paneTitle} bodyClassName="p-6" width="40%">
      <p className="text-sm text-muted-foreground mb-4 bg-secondary/50 rounded-lg p-2.5 border border-border">
        <span className="font-medium text-foreground">{guide.title}</span>{' '}가이드를 워크플로 노드로 연결합니다.
      </p>
      {done ? (
        <div role="status" className="flex items-center gap-2 text-sm text-foreground py-2">
          <CheckCircle className="w-4 h-4 text-muted-foreground" aria-hidden /> 워크플로에 추가했습니다.
        </div>
      ) : (
        <>
          {error && <p role="alert" className="text-sm text-status-critical mb-3">{error}</p>}
          <div className="mb-4">
            <label htmlFor={wfId} className="block text-sm font-medium mb-1.5">워크플로 선택</label>
            {isLoading ? (
              <LoadingState compact label="워크플로를 불러오는 중…" />
            ) : isError ? (
              <ErrorState compact error={loadError} title="워크플로 목록을 불러오지 못했습니다." onRetry={() => { void refetch(); }} />
            ) : workflows.length === 0 ? (
              <EmptyState compact icon={GitFork} title="등록된 워크플로가 없습니다." description="워크플로 화면에서 먼저 워크플로를 만드세요." />
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
            <button onClick={handleAdd} disabled={adding || workflows.length === 0 || !canOperate}
              title={withHint('워크플로에 추가')}
              aria-label={ariaWithHint('워크플로에 추가')}
              className="px-3 py-1.5 text-sm bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-1.5">
              <GitFork className="w-3.5 h-3.5" aria-hidden />
              {adding ? '추가 중…' : '워크플로에 추가'}
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

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['work-guides'],
    queryFn: () => workGuidesApi.getAll().then((r) => r.data),
    staleTime: 1000 * 30,
  });

  const allGuides = useMemo(
    () => [...(data?.data ?? [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
    [data],
  );

  const selectedId = routeId ?? null;
  const selectedGuide = allGuides.find((g) => g.id === selectedId) ?? null;
  // 부모가 목록에 없는 페이지(예전 삭제로 생긴 고아·안 보이는 테넌트의 하위)는 루트로 보여 준다(D-158) —
  // 그래야 트리에서 다시 찾아 상위를 연결할 수 있고, 하단 "전체 N개"와 트리 숫자가 맞는다.
  const rootGuides = useMemo(() => {
    const ids = new Set(allGuides.map((g) => g.id));
    return allGuides.filter((g) => !g.parentId || !ids.has(g.parentId));
  }, [allGuides]);

  const [addToWf, setAddToWf] = useState<WorkGuide | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkGuide | null>(null);
  const [deleting, setDeleting] = useState(false);

  const confirmDelete = async () => {
    const guide = deleteTarget;
    if (!guide) return;
    setDeleting(true);
    try {
      await workGuidesApi.delete(guide.id);
      await qc.invalidateQueries({ queryKey: ['work-guides'] });
      toast.success('페이지 삭제됨', guide.title);
      setDeleteTarget(null);
      navigate('/work-guides');
    } catch (e) {
      // 하위 페이지가 있으면 서버가 409 + 사유("하위 페이지 N개…")를 돌려준다(D-158).
      toast.error('삭제 실패', formatApiError(e));
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  /** 트리에서 연필 버튼 또는 더블클릭으로 이름 인라인 변경. */
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

  const retry = () => { void refetch(); };

  /** 본문 영역 — 상세·편집 URL 은 목록 조회가 성공한 뒤에만 "찾을 수 없음"을 띄운다(D-153). */
  const renderMain = () => {
    if (isNewMode) {
      return (
        <div className="flex-1 overflow-y-auto">
          <PageShell density="doc" as="div">
            <PageHeader
              title="새 페이지"
              description="제목과 본문을 입력하고 저장하면 트리에 추가됩니다."
              className="mb-6"
            />
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
          </PageShell>
        </div>
      );
    }
    if (isEditMode && selectedGuide) {
      return (
        <div className="flex-1 overflow-y-auto">
          <PageShell density="doc" as="div">
            <PageHeader
              title="페이지 수정"
              description="필요한 항목을 수정한 뒤 저장 버튼을 누르세요."
              className="mb-6"
            />
            <GuideForm
              key={selectedGuide.id}
              initial={formInitial}
              allGuides={allGuides}
              onCancel={formCancelTarget}
              onSaved={(savedId) => {
                if (savedId) navigate(`/work-guides/${savedId}`);
                else formCancelTarget();
              }}
            />
          </PageShell>
        </div>
      );
    }
    if (isReadMode && selectedGuide) {
      return (
        <GuidePageView
          guide={selectedGuide}
          allGuides={allGuides}
          onSelect={(id) => navigate(`/work-guides/${id}`)}
          onEdit={() => navigate(`/work-guides/${selectedGuide.id}/edit`)}
          onAddChild={() => navigate(`/work-guides/new?parentId=${selectedGuide.id}`)}
          onAddToWorkflow={() => setAddToWf(selectedGuide)}
          onDelete={() => setDeleteTarget(selectedGuide)}
        />
      );
    }
    if (routeId && isLoading) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center px-8">
          <h1 className="sr-only">작업 가이드</h1>
          <LoadingState label="페이지를 불러오는 중…" />
        </div>
      );
    }
    if (isError) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center px-8">
          <h1 className="sr-only">작업 가이드</h1>
          <ErrorState error={error} title="작업 가이드를 불러오지 못했습니다." onRetry={retry} />
        </div>
      );
    }
    if (routeId) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center px-8">
          <h1 className="sr-only">작업 가이드</h1>
          <EmptyState
            icon={BookMarked}
            title="페이지를 찾을 수 없습니다."
            description="요청한 페이지가 삭제되었거나 존재하지 않습니다. 목록에서 다른 페이지를 고르세요."
            action={{ label: '목록으로', onClick: () => navigate('/work-guides') }}
          />
        </div>
      );
    }
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-8">
        <h1 className="sr-only">작업 가이드</h1>
        <EmptyState
          icon={BookMarked}
          title="선택된 페이지가 없습니다."
          description="운영 절차·배포 가이드·트러블슈팅을 계층으로 관리합니다. 왼쪽 트리에서 페이지를 고르거나 새 페이지를 만드세요."
          action={isLoading ? undefined : { label: '새 페이지 만들기', onClick: () => navigate('/work-guides/new') }}
        />
      </div>
    );
  };

  const deleteChildCount = deleteTarget ? allGuides.filter((g) => g.parentId === deleteTarget.id).length : 0;

  return (
    <div className="flex bg-background h-[100dvh]">
      {/* Sidebar tree */}
      <aside className="w-64 flex-shrink-0 border-r border-border bg-card flex flex-col overflow-hidden">
        <div className="px-4 py-4 border-b border-border flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <BookMarked className="w-4 h-4 text-primary" aria-hidden />
            <span className="text-sm font-semibold">작업 가이드</span>
          </div>
          <button
            onClick={() => navigate('/work-guides/new')}
            className="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-primary transition-colors"
            title="새 페이지"
            aria-label="새 페이지"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        <nav aria-label="작업 가이드 페이지 트리" className="flex-1 overflow-y-auto py-2 px-2">
          {isLoading ? (
            <LoadingState compact />
          ) : isError ? (
            <ErrorState compact error={error} title="페이지 목록을 불러오지 못했습니다." onRetry={retry} />
          ) : rootGuides.length === 0 ? (
            <EmptyState compact icon={FileText} title="페이지가 없습니다." description="위 + 버튼으로 첫 페이지를 만드세요." />
          ) : (
            <ul>
              {rootGuides.map((guide) => (
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
              ))}
            </ul>
          )}
        </nav>

        {!isLoading && !isError && (
          <div className="px-3 py-2 border-t border-border flex-shrink-0">
            <p className="text-xs text-muted-foreground">전체 {allGuides.length}개 페이지</p>
          </div>
        )}
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {renderMain()}
      </main>

      {addToWf && (
        <AddToWorkflowModal
          guide={addToWf}
          onClose={() => setAddToWf(null)}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        danger
        busy={deleting}
        title="페이지 삭제"
        confirmLabel="삭제"
        description={deleteTarget ? `「${deleteTarget.title}」 페이지를 삭제합니다. 삭제하면 되돌릴 수 없습니다.` : undefined}
        onConfirm={() => { void confirmDelete(); }}
        onCancel={() => setDeleteTarget(null)}
      >
        {deleteChildCount > 0 && (
          <p className="text-sm text-status-critical">
            하위 페이지 {deleteChildCount}개가 있어 삭제할 수 없습니다. 하위 페이지를 다른 상위로 옮기거나 먼저 삭제하세요.
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
