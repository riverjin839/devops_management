import { useState } from 'react';
import { MessageSquare, Send, Trash2, Loader2 } from 'lucide-react';
import { useWorkItemComments, useAddWorkItemComment, useDeleteWorkItemComment } from '@/hooks/useWorkItems';
import { useAuthStore } from '@/stores/authStore';
import { useToast, ReactionBar } from '@/components/common';
import { formatApiError } from '@/lib/utils';

function fmt(t: string): string {
  const d = new Date(t.endsWith('Z') || t.includes('+') ? t : t + 'Z');
  if (isNaN(d.getTime())) return t.slice(0, 16).replace('T', ' ');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CommentThread({ workItemId }: { workItemId: string }) {
  const { data: comments = [], isLoading } = useWorkItemComments(workItemId);
  const add = useAddWorkItemComment(workItemId);
  const del = useDeleteWorkItemComment(workItemId);
  const toast = useToast();
  const user = useAuthStore((s) => s.user);
  const [body, setBody] = useState('');

  const canDelete = (authorUsername?: string) =>
    user?.role === 'admin' || (!!authorUsername && authorUsername === user?.username);

  const submit = () => {
    const text = body.trim();
    if (!text) return;
    add.mutate(text, {
      onSuccess: () => setBody(''),
      onError: (e) => toast.error('댓글 등록 실패', formatApiError(e)),
    });
  };

  const remove = (id: string) => {
    del.mutate(id, { onError: (e) => toast.error('댓글 삭제 실패', formatApiError(e)) });
  };

  return (
    <div className="border-t border-border pt-4">
      <p className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
        <MessageSquare className="w-3.5 h-3.5" />
        댓글 {comments.length > 0 && <span className="text-primary">{comments.length}</span>}
      </p>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> 불러오는 중…
        </div>
      ) : comments.length === 0 ? (
        <p className="text-sm text-muted-foreground/70 py-1">아직 댓글이 없습니다.</p>
      ) : (
        <ul className="space-y-2 mb-3">
          {comments.map((c) => (
            <li key={c.id} className="group rounded-lg bg-secondary/30 px-3 py-2">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-sm font-semibold">{c.authorName || c.author || '익명'}</span>
                <span className="text-xs text-muted-foreground font-mono">{fmt(c.createdAt)}</span>
                {canDelete(c.author) && (
                  <button
                    type="button"
                    onClick={() => remove(c.id)}
                    title="댓글 삭제"
                    className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-rose-500"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
              <p className="text-sm whitespace-pre-wrap break-words">{c.body}</p>
              <ReactionBar targetType="work_item_comment" targetId={c.id} className="mt-1.5" />
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
          }}
          placeholder="댓글을 입력하세요 (Ctrl+Enter 등록)"
          rows={2}
          className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-sm resize-y focus:outline-none focus:ring-1 focus:ring-primary/40"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!body.trim() || add.isPending}
          className="px-3 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          {add.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          등록
        </button>
      </div>
    </div>
  );
}
