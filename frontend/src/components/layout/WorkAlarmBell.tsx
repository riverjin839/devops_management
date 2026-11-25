import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, AlertTriangle, CalendarClock, CalendarPlus, MessageSquare, Check, EyeOff } from 'lucide-react';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { SegTabs } from '@/components/common/SegTabs';
import { EmptyState } from '@/components/common/EmptyState';
import { useToastSafe } from '@/components/common/Toast';
import { useAuthStore } from '@/stores/authStore';
import { notificationsApi } from '@/services/api';
import {
  useDismissWorkAlarm,
  useInvalidateMyNotifications,
  useMyNotifications,
  useMyWorkAlarms,
  useNotificationStream,
  useRestoreWorkAlarms,
} from '@/hooks/useNotifications';
import { cn, stripHtml } from '@/lib/utils';
import type { NotificationCategory, UserNotification, WorkAlarm } from '@/types';

/**
 * 알림 종 (전역 상단 바).
 *
 * - **업무** 탭: 일정 알람(지연 · 오늘 마감 · 내일 마감 — 서버 판정 `GET /work-items/my-alarms`, 마감일 우선)
 *   + 업무 알림(배정·멘션·댓글·상태 변경·마감 알림·VOC 답변).
 * - **운영** 탭: 알람 인박스 알림 규칙·K8S 이벤트 알림.
 * - 라인마다 지우기: 일정 알람은 '오늘 그만 보기'(내일도 미완료면 다시 보임), 알림은 읽음 처리.
 * - 실시간: `GET /notifications/my/stream`(SSE) 으로 새 알림이 오면 토스트 + 배지 갱신.
 * 전체 이력·알림 설정은 `/notifications` 화면.
 */

function alarmLabel(a: WorkAlarm): string {
  const t = a.title?.trim();
  if (t) return t;
  const c = stripHtml(a.content ?? '').trim();
  return c || '(제목 없음)';
}

const KIND_META = {
  overdue: { icon: AlertTriangle, label: '지연', tone: 'text-status-critical bg-status-critical/10' },
  due_today: { icon: CalendarClock, label: '오늘 마감', tone: 'text-status-warning bg-status-warning/10' },
  due_tomorrow: { icon: CalendarPlus, label: '내일 마감', tone: 'text-muted-foreground bg-secondary/60' },
} as const;

function AlarmRow({ a, onOpen, onDismiss }: { a: WorkAlarm; onOpen: () => void; onDismiss: () => void }) {
  const label = alarmLabel(a);
  return (
    <li className="flex items-stretch border-b border-border/60 last:border-b-0">
      <button
        type="button"
        onClick={onOpen}
        className="flex-1 min-w-0 text-left px-3 py-2 hover:bg-muted/40 focus-visible:bg-muted/40 outline-none transition-colors flex flex-col gap-0.5"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm text-foreground line-clamp-1 flex-1 min-w-0">{label}</span>
          {a.kind === 'overdue' && (
            <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full bg-status-critical/15 text-status-critical whitespace-nowrap flex-shrink-0">
              {a.overdueDays}일 지연
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="px-1.5 py-0.5 rounded-full bg-secondary truncate max-w-[120px]">{a.category}</span>
          {a.dueDate && (
            <span className="tabular-nums">
              {a.basis === 'due_date' ? '마감' : '시작'} {a.dueDate}
            </span>
          )}
        </div>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        title="오늘 그만 보기 — 내일도 미완료면 다시 보입니다"
        aria-label={`${label} 알람 오늘 그만 보기`}
        className="px-2.5 text-muted-foreground hover:text-foreground hover:bg-secondary focus-visible:bg-secondary outline-none transition-colors"
      >
        <EyeOff className="w-3.5 h-3.5" />
      </button>
    </li>
  );
}

function NotifRow({ n, onOpen, onRead }: { n: UserNotification; onOpen: () => void; onRead: () => void }) {
  return (
    <li className="flex items-stretch border-b border-border/60 last:border-b-0">
      <button
        type="button"
        onClick={onOpen}
        className="flex-1 min-w-0 text-left px-3 py-2 hover:bg-muted/40 focus-visible:bg-muted/40 outline-none transition-colors"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" aria-hidden />
          <span className="text-sm font-medium truncate flex-1 min-w-0">{n.title}</span>
          {n.typeLabel && <span className="text-xs text-muted-foreground flex-shrink-0">{n.typeLabel}</span>}
        </div>
        {n.body && <p className="text-xs text-muted-foreground truncate mt-0.5 pl-3">{n.body}</p>}
      </button>
      <button
        type="button"
        onClick={onRead}
        title="읽음 처리"
        aria-label={`${n.title} 읽음 처리`}
        className="px-2.5 text-muted-foreground hover:text-foreground hover:bg-secondary focus-visible:bg-secondary outline-none transition-colors"
      >
        <Check className="w-3.5 h-3.5" />
      </button>
    </li>
  );
}

function SectionHead({ icon: Icon, label, count, tone }: { icon: typeof Bell; label: string; count: number; tone: string }) {
  return (
    <div className={cn('flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold sticky top-0 bg-popover', tone)}>
      <Icon className="w-3.5 h-3.5" aria-hidden /> {label} {count}
    </div>
  );
}

export function WorkAlarmBell() {
  const navigate = useNavigate();
  const toast = useToastSafe();
  const user = useAuthStore((s) => s.user);
  const enabled = !!user;

  const { data: alarms } = useMyWorkAlarms(enabled);
  const { data: notifResp } = useMyNotifications(enabled);
  const invalidate = useInvalidateMyNotifications();
  const dismiss = useDismissWorkAlarm();
  const restore = useRestoreWorkAlarms();

  useNotificationStream(enabled, (n) => {
    toast.show({
      variant: n.category === 'ops' ? 'warning' : 'info',
      title: n.title,
      description: n.body ?? undefined,
      durationMs: 6000,
      ...(n.link ? { action: { label: '열기', onClick: () => navigate(n.link as string) } } : {}),
    });
  });

  const overdue = alarms?.overdue ?? [];
  const dueToday = alarms?.dueToday ?? [];
  const dueTomorrow = alarms?.dueTomorrow ?? [];
  const scheduleCount = overdue.length + dueToday.length + dueTomorrow.length;
  const notifications = useMemo(() => notifResp?.data ?? [], [notifResp]);
  const workNotifs = notifications.filter((n) => n.category === 'work');
  const opsNotifs = notifications.filter((n) => n.category !== 'work');
  const unreadWork = notifResp?.unreadWork ?? workNotifs.length;
  const unreadOps = notifResp?.unreadOps ?? opsNotifs.length;
  // 배지는 지금 처리할 것(지연·오늘 마감 + 안 읽은 알림) — 내일 마감은 예고라 세지 않는다.
  const badge = overdue.length + dueToday.length + unreadWork + unreadOps;

  const [open, setOpen] = useState(false);
  const [tabPick, setTabPick] = useState<NotificationCategory | null>(null);
  const workTotal = scheduleCount + unreadWork;
  const tab: NotificationCategory = tabPick ?? (workTotal === 0 && unreadOps > 0 ? 'ops' : 'work');

  if (!user) return null;

  const close = () => setOpen(false);
  const openAlarm = (a: WorkAlarm) => { close(); navigate(`/tasks-mgmt/${a.id}`); };
  const readOne = (id: string) => notificationsApi.markRead(id).then(invalidate).catch(() => {});
  const openNotif = (n: UserNotification) => {
    close();
    if (n.link) navigate(n.link);
    readOne(n.id);
  };
  const readAll = () => notificationsApi.markAllRead(tab).then(invalidate).catch(() => {});

  const tooltip = badge > 0
    ? `알림 — 처리할 항목 ${badge}건 (지연 ${overdue.length} · 오늘 마감 ${dueToday.length} · 안 읽은 알림 ${unreadWork + unreadOps})`
    : '알림 (처리할 항목 없음)';
  const list = tab === 'work' ? workNotifs : opsNotifs;
  const unreadInTab = tab === 'work' ? unreadWork : unreadOps;

  return (
    <Popover open={open} onOpenChange={(v) => setOpen(v)}>
      <PopoverTrigger
        aria-label={tooltip}
        title={tooltip}
        className={cn(
          'relative flex items-center justify-center w-7 h-7 rounded-md transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
          open ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
        )}
      >
        <Bell className="w-4 h-4" />
        {badge > 0 && (
          <span
            aria-hidden
            className={cn(
              'absolute top-0 right-0 min-w-[16px] h-4 px-1 rounded-full text-xs font-bold leading-[14px] text-center pointer-events-none border',
              overdue.length > 0
                ? 'bg-status-critical text-primary-foreground border-status-critical'
                : 'bg-primary text-primary-foreground border-primary',
            )}
          >
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-[22rem] max-w-[calc(100vw-16px)] max-h-[70vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border flex-shrink-0">
          <PopoverTitle className="text-sm font-semibold">알림</PopoverTitle>
          <SegTabs
            mode="tabs"
            label="알림 종류"
            value={tab}
            onChange={setTabPick}
            options={[
              ['work', `업무${workTotal ? ` ${workTotal}` : ''}`],
              ['ops', `운영${unreadOps ? ` ${unreadOps}` : ''}`],
            ] as const}
          />
        </div>

        <div className="overflow-y-auto flex-1">
          {tab === 'work' && scheduleCount === 0 && workNotifs.length === 0 && (
            <EmptyState compact icon={Bell} title="처리할 업무 알림이 없습니다."
              description="지연·마감 임박 업무나 배정·멘션·댓글 알림이 생기면 여기에 표시됩니다." />
          )}
          {tab === 'ops' && opsNotifs.length === 0 && (
            <EmptyState compact icon={Bell} title="안 읽은 운영 알림이 없습니다."
              description="알람 인박스 알림 규칙이 보낸 알람이 여기에 표시됩니다." />
          )}

          {tab === 'work' && (
            <>
              {(['overdue', 'due_today', 'due_tomorrow'] as const).map((k) => {
                const rows = k === 'overdue' ? overdue : k === 'due_today' ? dueToday : dueTomorrow;
                if (rows.length === 0) return null;
                const meta = KIND_META[k];
                return (
                  <section key={k} aria-label={meta.label}>
                    <SectionHead icon={meta.icon} label={meta.label} count={rows.length} tone={meta.tone} />
                    <ul>
                      {rows.map((a) => (
                        <AlarmRow key={a.id} a={a} onOpen={() => openAlarm(a)} onDismiss={() => dismiss.mutate(a.id)} />
                      ))}
                    </ul>
                  </section>
                );
              })}
            </>
          )}
          {list.length > 0 && (
            <section aria-label={tab === 'work' ? '업무 알림' : '운영 알림'}>
              <SectionHead icon={MessageSquare} label={tab === 'work' ? '업무 알림' : '운영 알림'}
                count={unreadInTab} tone="text-foreground bg-secondary/40" />
              <ul>
                {list.map((n) => (
                  <NotifRow key={n.id} n={n} onOpen={() => openNotif(n)} onRead={() => readOne(n.id)} />
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="flex-shrink-0 border-t border-border flex items-center gap-1 px-1.5 py-1 text-sm">
          <button
            type="button"
            onClick={() => { close(); navigate('/notifications'); }}
            className="px-2 py-1 rounded-md text-primary hover:bg-primary/5"
          >
            알림 전체 보기
          </button>
          {tab === 'work' && (alarms?.dismissed ?? 0) > 0 && (
            <button
              type="button"
              onClick={() => restore.mutate()}
              className="px-2 py-1 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              숨긴 {alarms?.dismissed}건 다시 보기
            </button>
          )}
          {unreadInTab > 0 && (
            <button
              type="button"
              onClick={readAll}
              className="ml-auto px-2 py-1 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              모두 읽음
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
