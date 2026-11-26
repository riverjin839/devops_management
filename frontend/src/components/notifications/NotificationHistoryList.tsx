import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Check, Circle, Mail, MessageSquareShare, Search, Trash2 } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { SegTabs } from '@/components/common/SegTabs';
import { EmptyState, ErrorState, LoadingState } from '@/components/common/EmptyState';
import { SwitchToggle } from '@/components/common/SwitchToggle';
import { notificationsApi } from '@/services/api';
import { useInvalidateMyNotifications, useMyNotificationHistory } from '@/hooks/useNotifications';
import { cn, formatRelativeTime } from '@/lib/utils';
import type { NotificationCategory, UserNotification } from '@/types';

const PAGE = 50;

const EXTERNAL_LABEL: Record<string, string> = {
  pending: '외부 발송 대기', sent: '외부 발송됨', failed: '외부 발송 실패', skipped: '외부 발송 안 함',
};

function ExternalBadge({ n }: { n: UserNotification }) {
  if (!n.externalStatus) return null;
  const Icon = (n.externalChannels ?? []).includes('email') ? Mail : MessageSquareShare;
  return (
    <span
      title={n.externalError ? `${EXTERNAL_LABEL[n.externalStatus]} — ${n.externalError}` : EXTERNAL_LABEL[n.externalStatus]}
      className={cn(
        'inline-flex items-center gap-1 text-xs',
        n.externalStatus === 'failed' ? 'text-status-critical' : 'text-muted-foreground',
      )}
    >
      <Icon className="w-3 h-3" aria-hidden /> {EXTERNAL_LABEL[n.externalStatus]}
    </span>
  );
}

/** 받은 알림 전체 이력 — 읽은 알림 포함. 종류(업무/운영)·안 읽음·검색 필터, 읽음/안 읽음 전환, 삭제. */
export function NotificationHistoryList({
  category, onCategory,
}: { category: 'all' | NotificationCategory; onCategory: (c: 'all' | NotificationCategory) => void }) {
  const navigate = useNavigate();
  const invalidate = useInvalidateMyNotifications();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const { data, isLoading, error, refetch, isFetching } = useMyNotificationHistory({
    offset: 0, limit, category: category === 'all' ? undefined : category, unreadOnly, q: q.trim() || undefined,
  });
  const rows = data?.data ?? [];
  const unreadHere = category === 'work' ? data?.unreadWork : category === 'ops' ? data?.unreadOps : data?.unread;

  const act = (p: Promise<unknown>) => p.then(invalidate).catch(() => {});
  const open = (n: UserNotification) => {
    if (!n.isRead) act(notificationsApi.markRead(n.id));
    if (n.link) navigate(n.link);
  };

  return (
    <MacCard
      title="받은 알림"
      icon={Bell}
      titleExtra={data ? <span className="text-xs text-muted-foreground">{data.total}건 · 안 읽음 {unreadHere ?? 0}</span> : null}
      actions={
        (unreadHere ?? 0) > 0 ? (
          <button
            type="button"
            onClick={() => act(notificationsApi.markAllRead(category === 'all' ? undefined : category))}
            className="px-2.5 py-1 rounded-xl text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            모두 읽음
          </button>
        ) : null
      }
      bodyPadding="p-0"
    >
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
        <SegTabs
          label="알림 종류"
          value={category}
          onChange={(v) => { setLimit(PAGE); onCategory(v); }}
          options={[['all', '전체'], ['work', '업무'], ['ops', '운영']] as const}
        />
        <SwitchToggle checked={unreadOnly} onChange={(v) => { setLimit(PAGE); setUnreadOnly(v); }} label="안 읽은 알림만" />
        <label className="relative ml-auto">
          <span className="sr-only">알림 검색</span>
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            value={q}
            onChange={(e) => { setLimit(PAGE); setQ(e.target.value); }}
            placeholder="제목·내용 검색"
            className="h-8 w-56 pl-8 pr-2 rounded-xl border border-border bg-background text-sm"
          />
        </label>
      </div>

      {isLoading ? (
        <LoadingState compact />
      ) : error ? (
        <ErrorState compact error={error} onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState compact icon={Bell} title="알림이 없습니다." description="조건에 맞는 알림이 없습니다. 읽은 알림은 90일, 안 읽은 알림은 1년 보관됩니다." />
      ) : (
        <ul>
          {rows.map((n) => (
            <li key={n.id} className="flex items-stretch border-b border-border/60 last:border-b-0">
              <button
                type="button"
                onClick={() => open(n)}
                className="flex-1 min-w-0 text-left px-4 py-2.5 hover:bg-muted/40 focus-visible:bg-muted/40 outline-none"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', n.isRead ? 'bg-transparent' : 'bg-primary')} aria-hidden />
                  <span className={cn('text-sm truncate flex-1 min-w-0', n.isRead ? 'text-muted-foreground' : 'font-medium text-foreground')}>
                    {n.title}
                  </span>
                  <span className="text-xs text-muted-foreground flex-shrink-0">{n.typeLabel ?? n.type}</span>
                  <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0" title={n.createdAt}>
                    {n.createdAt ? formatRelativeTime(n.createdAt) : ''}
                  </span>
                </div>
                <div className="flex items-center gap-3 pl-3.5 mt-0.5">
                  {n.body && <p className="text-xs text-muted-foreground truncate flex-1 min-w-0">{n.body}</p>}
                  <ExternalBadge n={n} />
                </div>
              </button>
              <button
                type="button"
                onClick={() => act(n.isRead ? notificationsApi.markUnread(n.id) : notificationsApi.markRead(n.id))}
                title={n.isRead ? '안 읽음으로 표시' : '읽음 처리'}
                aria-label={`${n.title} ${n.isRead ? '안 읽음으로 표시' : '읽음 처리'}`}
                className="px-2.5 text-muted-foreground hover:text-foreground hover:bg-secondary focus-visible:bg-secondary outline-none"
              >
                {n.isRead ? <Circle className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => act(notificationsApi.removeMy(n.id))}
                title="삭제"
                aria-label={`${n.title} 삭제`}
                className="px-2.5 text-muted-foreground hover:text-status-critical hover:bg-secondary focus-visible:bg-secondary outline-none"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {data?.hasMore && (
        <div className="px-4 py-2 border-t border-border">
          <button
            type="button"
            disabled={isFetching}
            onClick={() => setLimit((l) => l + PAGE)}
            className="px-3 py-1 rounded-xl text-sm text-primary hover:bg-primary/5 disabled:opacity-50"
          >
            {isFetching ? '불러오는 중…' : `더 보기 (${data.total - rows.length}건 남음)`}
          </button>
        </div>
      )}
    </MacCard>
  );
}
