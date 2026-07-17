import { useState } from 'react';
import {
  Loader2, Plus, ChevronLeft, Pencil, Trash2, MessageSquarePlus, Send,
} from 'lucide-react';
import { StatusBadge, StatusDot, ConfirmDialog, useToast } from '@/components/common';
import type { StatusVariant } from '@/components/common';
import { ReactionBar } from '@/components/common/ReactionBar';
import { useAuthStore, hasRole } from '@/stores/authStore';
import {
  useVocPosts, useCreateVoc, useUpdateVoc, useReplyVoc, useDeleteVoc,
} from '@/hooks/useVoc';
import type { VocPost, VocCategory, VocStatus } from '@/types';

const INP = 'w-full rounded-xl border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40';
const CATEGORIES: VocCategory[] = ['문의', '개선', '불만', '제안'];
const STATUSES: VocStatus[] = ['접수', '검토중', '완료'];

const STATUS_VARIANT: Record<VocStatus, StatusVariant> = {
  '접수': 'info',
  '검토중': 'warning',
  '완료': 'healthy',
};
const CATEGORY_CLS: Record<VocCategory, string> = {
  '문의': 'bg-sky-500/10 text-sky-600',
  '개선': 'bg-violet-500/10 text-violet-600',
  '불만': 'bg-red-500/10 text-red-600',
  '제안': 'bg-emerald-500/10 text-emerald-600',
};

function errMessage(e: unknown, fallback: string): string {
  const resp = (e as { response?: { data?: { detail?: string } } })?.response;
  return resp?.data?.detail ?? fallback;
}

type View = { name: 'list' } | { name: 'detail'; id: string } | { name: 'form'; post?: VocPost };

interface Props {
  open: boolean;
}

export function VocBoardPanel({ open }: Props) {
  const user = useAuthStore((s) => s.user);
  const isStaff = hasRole(user, 'admin', 'operator');
  const [catFilter, setCatFilter] = useState<VocCategory | ''>('');
  const [statusFilter, setStatusFilter] = useState<VocStatus | ''>('');
  const [view, setView] = useState<View>({ name: 'list' });

  const filters = {
    ...(catFilter ? { category: catFilter } : {}),
    ...(statusFilter ? { status: statusFilter } : {}),
  };
  const { data: posts, isLoading, error } = useVocPosts(open, filters);

  if (view.name === 'form') {
    return <VocForm post={view.post} onDone={() => setView({ name: 'list' })} onBack={() => setView({ name: 'list' })} />;
  }
  if (view.name === 'detail') {
    return (
      <VocDetail
        id={view.id}
        posts={posts ?? []}
        isStaff={isStaff}
        currentUsername={user?.username}
        onBack={() => setView({ name: 'list' })}
        onEdit={(p) => setView({ name: 'form', post: p })}
        onDeleted={() => setView({ name: 'list' })}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* 필터 + 작성 */}
      <div className="p-3 border-b border-border space-y-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setView({ name: 'form' })}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-xl bg-primary text-primary-foreground hover:opacity-90"
          >
            <Plus className="w-4 h-4" /> 새 VOC
          </button>
          <span className="text-xs text-muted-foreground ml-auto">
            {posts ? `${posts.length}건` : ''}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip label="전체" active={!catFilter} onClick={() => setCatFilter('')} />
          {CATEGORIES.map((c) => (
            <FilterChip key={c} label={c} active={catFilter === c} onClick={() => setCatFilter(catFilter === c ? '' : c)} />
          ))}
          <span className="w-px h-4 bg-border mx-1" />
          {STATUSES.map((s) => (
            <FilterChip key={s} label={s} active={statusFilter === s} onClick={() => setStatusFilter(statusFilter === s ? '' : s)} />
          ))}
        </div>
      </div>

      {/* 목록 */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" /></div>
        ) : error ? (
          <p className="text-sm text-destructive py-6 text-center">VOC 목록을 불러오지 못했습니다.</p>
        ) : !posts || posts.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
            <MessageSquarePlus className="w-8 h-8 opacity-40" />
            <p className="text-sm">아직 등록된 VOC 가 없습니다.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {posts.map((p) => (
              <li key={p.id}>
                <button onClick={() => setView({ name: 'detail', id: p.id })} className="w-full text-left px-4 py-3 hover:bg-secondary/50 transition">
                  <div className="flex items-center gap-2">
                    <CategoryBadge category={p.category} />
                    <StatusBadge variant={STATUS_VARIANT[p.status]} label={p.status} />
                    {p.adminReply && <StatusDot variant="healthy" title="답변 완료" />}
                    <span className="ml-auto text-[11px] text-muted-foreground whitespace-nowrap">
                      {new Date(p.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="text-sm font-medium mt-1 truncate">{p.title}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{p.author ?? '익명'}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── 상세 ──────────────────────────────────────────────────────────────────────
function VocDetail({
  id, posts, isStaff, currentUsername, onBack, onEdit, onDeleted,
}: {
  id: string;
  posts: VocPost[];
  isStaff: boolean;
  currentUsername?: string;
  onBack: () => void;
  onEdit: (p: VocPost) => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const post = posts.find((p) => p.id === id);
  const replyMut = useReplyVoc();
  const deleteMut = useDeleteVoc();
  const [replyText, setReplyText] = useState(post?.adminReply ?? '');
  const [statusVal, setStatusVal] = useState<VocStatus>(post?.status ?? '접수');
  const [confirmDel, setConfirmDel] = useState(false);

  if (!post) {
    return <div className="p-4"><BackBtn onBack={onBack} /><p className="text-sm text-muted-foreground mt-4">글을 찾을 수 없습니다.</p></div>;
  }

  const isOwner = !!currentUsername && post.createdBy === currentUsername;

  const saveReply = async () => {
    try {
      await replyMut.mutateAsync({ id: post.id, data: { adminReply: replyText, status: statusVal } });
      toast.success('답변이 저장되었습니다.');
    } catch (e) {
      toast.error('답변 저장 실패', errMessage(e, '오류'));
    }
  };

  const doDelete = async () => {
    try {
      await deleteMut.mutateAsync(post.id);
      toast.success('삭제되었습니다.');
      onDeleted();
    } catch (e) {
      toast.error('삭제 실패', errMessage(e, '오류'));
    } finally {
      setConfirmDel(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-border flex items-center gap-2">
        <BackBtn onBack={onBack} />
        <div className="ml-auto flex items-center gap-2">
          {(isOwner || isStaff) && (
            <>
              <button onClick={() => onEdit(post)} className="text-muted-foreground hover:text-foreground" aria-label="수정"><Pencil className="w-4 h-4" /></button>
              <button onClick={() => setConfirmDel(true)} className="text-red-500 hover:text-red-600" aria-label="삭제"><Trash2 className="w-4 h-4" /></button>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <CategoryBadge category={post.category} />
            <StatusBadge variant={STATUS_VARIANT[post.status]} label={post.status} />
          </div>
          <h3 className="text-base font-semibold">{post.title}</h3>
          <div className="text-xs text-muted-foreground mt-1">
            {post.author ?? '익명'} · {new Date(post.createdAt).toLocaleString()}
          </div>
        </div>

        {post.content && <p className="text-sm whitespace-pre-wrap leading-relaxed">{post.content}</p>}

        <ReactionBar targetType="voc_post" targetId={post.id} />

        {/* 관리자 답변 */}
        {post.adminReply && !isStaff && (
          <div className="rounded-xl border border-border bg-secondary/40 p-3">
            <div className="text-xs font-semibold text-muted-foreground mb-1">
              관리자 답변 {post.adminReplyBy ? `· ${post.adminReplyBy}` : ''}
            </div>
            <p className="text-sm whitespace-pre-wrap">{post.adminReply}</p>
          </div>
        )}

        {/* 관리자 답변/상태 편집 */}
        {isStaff && (
          <div className="rounded-xl border border-border p-3 space-y-2">
            <div className="text-xs font-semibold text-muted-foreground">관리자 답변 / 상태</div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">상태</span>
              <select className={`${INP} max-w-[130px]`} value={statusVal} onChange={(e) => setStatusVal(e.target.value as VocStatus)}>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <textarea className={`${INP} h-24`} value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="답변을 입력하세요" />
            <div className="flex justify-end">
              <button onClick={saveReply} disabled={replyMut.isPending}
                className="inline-flex items-center gap-1.5 text-sm px-4 py-1.5 rounded-xl bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {replyMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                답변 저장
              </button>
            </div>
          </div>
        )}
      </div>

      {confirmDel && (
        <ConfirmDialog open title="VOC 삭제" description="이 글을 삭제하시겠습니까?" confirmLabel="삭제" danger
          onConfirm={doDelete} onCancel={() => setConfirmDel(false)} />
      )}
    </div>
  );
}

// ── 작성 / 수정 ───────────────────────────────────────────────────────────────
function VocForm({ post, onDone, onBack }: { post?: VocPost; onDone: () => void; onBack: () => void }) {
  const toast = useToast();
  const createMut = useCreateVoc();
  const updateMut = useUpdateVoc();
  const [title, setTitle] = useState(post?.title ?? '');
  const [content, setContent] = useState(post?.content ?? '');
  const [category, setCategory] = useState<VocCategory>(post?.category ?? '문의');
  const saving = createMut.isPending || updateMut.isPending;

  const save = async () => {
    if (!title.trim()) { toast.error('제목을 입력하세요.'); return; }
    try {
      if (post) await updateMut.mutateAsync({ id: post.id, data: { title, content, category } });
      else await createMut.mutateAsync({ title, content, category });
      toast.success('저장되었습니다.');
      onDone();
    } catch (e) {
      toast.error('저장 실패', errMessage(e, '오류'));
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-border flex items-center gap-2">
        <BackBtn onBack={onBack} />
        <span className="text-sm font-semibold">{post ? 'VOC 수정' : '새 VOC 작성'}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <label className="block">
          <span className="block text-xs font-medium text-muted-foreground mb-1">카테고리</span>
          <select className={INP} value={category} onChange={(e) => setCategory(e.target.value as VocCategory)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-muted-foreground mb-1">제목 *</span>
          <input className={INP} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="제목을 입력하세요" />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-muted-foreground mb-1">내용</span>
          <textarea className={`${INP} h-40`} value={content} onChange={(e) => setContent(e.target.value)} placeholder="의견을 자유롭게 남겨주세요" />
        </label>
      </div>
      <div className="p-3 border-t border-border flex justify-end gap-2">
        <button onClick={onBack} className="text-sm px-3 py-1.5 rounded-xl border border-border hover:bg-muted">취소</button>
        <button onClick={save} disabled={saving}
          className="inline-flex items-center gap-1.5 text-sm px-4 py-1.5 rounded-xl bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
          {saving && <Loader2 className="w-4 h-4 animate-spin" />} 저장
        </button>
      </div>
    </div>
  );
}

// ── 작은 조각 ─────────────────────────────────────────────────────────────────
function BackBtn({ onBack }: { onBack: () => void }) {
  return (
    <button onClick={onBack} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ChevronLeft className="w-4 h-4" /> 목록
    </button>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`text-xs px-2 py-0.5 rounded-full border transition ${active ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted'}`}
    >
      {label}
    </button>
  );
}

function CategoryBadge({ category }: { category: VocCategory }) {
  return <span className={`text-[11px] px-1.5 py-0.5 rounded-full font-medium ${CATEGORY_CLS[category]}`}>{category}</span>;
}
