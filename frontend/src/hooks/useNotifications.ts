import { useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notificationsApi, workItemsApi } from '@/services/api';
import { getSse } from '@/lib/sse';
import type {
  MyWorkAlarms,
  NotificationCategory,
  NotificationChannelInput,
  NotificationDeliverySettings,
  NotificationPrefsInput,
  UserNotification,
} from '@/types';

export const notificationKeys = {
  channels: ['notificationChannels'] as const,
  log: ['notificationLog'] as const,
};

/** 채널 목록 — 서버가 operator 이상만 허용한다(비밀 값은 가려서 온다). viewer 는 부르지 않는다. */
export function useNotificationChannels(enabled = true) {
  return useQuery({
    queryKey: notificationKeys.channels,
    queryFn: async () => {
      const { data } = await notificationsApi.list();
      return data;
    },
    enabled,
  });
}

export function useCreateChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NotificationChannelInput) => notificationsApi.create(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: notificationKeys.channels });
    },
  });
}

export function useUpdateChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: NotificationChannelInput }) =>
      notificationsApi.update(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: notificationKeys.channels });
    },
  });
}

export function useDeleteChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => notificationsApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: notificationKeys.channels });
    },
  });
}

export function useTestChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => notificationsApi.test(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: notificationKeys.log });
    },
  });
}


// ── 개인 알림 (알림 종 · 알림 화면) ─────────────────────────────────────────

export const myNotificationKeys = {
  bell: ['myNotifications'] as const,
  history: (params: Record<string, unknown>) => ['myNotificationHistory', params] as const,
  historyAll: ['myNotificationHistory'] as const,
  alarms: ['myWorkAlarms'] as const,
  prefs: ['myNotificationPrefs'] as const,
  delivery: ['notificationDelivery'] as const,
};

/** 개인 알림을 바꾼 뒤 종·이력을 함께 새로 고친다. */
export function useInvalidateMyNotifications() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: myNotificationKeys.bell });
    qc.invalidateQueries({ queryKey: myNotificationKeys.historyAll });
  };
}

/** 종 패널 — 안 읽은 알림. 실시간 스트림이 끊겨도 2분마다 다시 가져온다(폴백). */
export function useMyNotifications(enabled: boolean) {
  return useQuery({
    queryKey: myNotificationKeys.bell,
    queryFn: () => notificationsApi.listMy(50).then((r) => r.data),
    refetchInterval: 120_000,
    enabled,
  });
}

export function useMyNotificationHistory(params: {
  offset: number; limit: number; category?: NotificationCategory; type?: string; unreadOnly?: boolean; q?: string;
}) {
  return useQuery({
    queryKey: myNotificationKeys.history(params),
    queryFn: () => notificationsApi.history({
      offset: params.offset, limit: params.limit,
      ...(params.category ? { category: params.category } : {}),
      ...(params.type ? { type: params.type } : {}),
      ...(params.unreadOnly ? { unread_only: true } : {}),
      ...(params.q ? { q: params.q } : {}),
    }).then((r) => r.data),
    placeholderData: (prev) => prev,
  });
}

/** 업무 일정 알람(지연·오늘·내일 마감) — 5분마다 + 창으로 돌아올 때. */
export function useMyWorkAlarms(enabled: boolean) {
  return useQuery({
    queryKey: myNotificationKeys.alarms,
    queryFn: () => workItemsApi.myAlarms().then((r) => r.data),
    refetchInterval: 300_000,
    refetchOnWindowFocus: true,
    enabled,
  });
}

export function useDismissWorkAlarm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => workItemsApi.dismissAlarm(id),
    onMutate: async (id: string) => {
      // 누르자마자 라인을 뺀다(낙관적) — 실패하면 다시 가져온다.
      await qc.cancelQueries({ queryKey: myNotificationKeys.alarms });
      const prev = qc.getQueryData<MyWorkAlarms>(myNotificationKeys.alarms);
      if (prev) {
        const drop = (rows: MyWorkAlarms['overdue']) => rows.filter((r) => r.id !== id);
        qc.setQueryData<MyWorkAlarms>(myNotificationKeys.alarms, {
          ...prev, overdue: drop(prev.overdue), dueToday: drop(prev.dueToday),
          dueTomorrow: drop(prev.dueTomorrow), dismissed: prev.dismissed + 1,
        });
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: myNotificationKeys.alarms }),
  });
}

export function useRestoreWorkAlarms() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => workItemsApi.restoreAlarms(),
    onSettled: () => qc.invalidateQueries({ queryKey: myNotificationKeys.alarms }),
  });
}

export function useNotificationPrefs() {
  return useQuery({
    queryKey: myNotificationKeys.prefs,
    queryFn: () => notificationsApi.getPrefs().then((r) => r.data),
  });
}

export function useSaveNotificationPrefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: NotificationPrefsInput) => notificationsApi.putPrefs(data).then((r) => r.data),
    onSuccess: (data) => qc.setQueryData(myNotificationKeys.prefs, data),
  });
}

export function useNotificationDelivery(enabled: boolean) {
  return useQuery({
    queryKey: myNotificationKeys.delivery,
    queryFn: () => notificationsApi.getDelivery().then((r) => r.data),
    enabled,
  });
}

export function useSaveNotificationDelivery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: NotificationDeliverySettings) => notificationsApi.putDelivery(data).then((r) => r.data),
    onSuccess: (data) => {
      qc.setQueryData(myNotificationKeys.delivery, data);
      qc.invalidateQueries({ queryKey: myNotificationKeys.prefs });
    },
  });
}

/**
 * 알림 실시간 스트림(`GET /notifications/my/stream`, SSE). 안 읽은 수가 바뀌면 종·이력을 새로 고치고,
 * 새 알림이 오면 `onNew` 를 부른다(첫 이벤트는 현재 상태라 알리지 않는다). 끊기면 점점 늦게 다시 연결한다
 * — 그동안은 `useMyNotifications` 의 2분 폴링이 대신한다.
 */
export function useNotificationStream(enabled: boolean, onNew?: (n: UserNotification) => void) {
  const qc = useQueryClient();
  const onNewRef = useRef(onNew);
  useEffect(() => { onNewRef.current = onNew; }, [onNew]);

  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    let lastLatestId: string | null | undefined;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = async () => {
      try {
        await getSse('/api/v1/notifications/my/stream', (evt) => {
          if (evt.type !== 'unread') return;
          retry = 0;
          const latest = (evt.latest ?? null) as Record<string, unknown> | null;
          const latestId = latest ? String(latest.id) : null;
          if (lastLatestId !== undefined && latestId && latestId !== lastLatestId && latest) {
            onNewRef.current?.({
              id: latestId,
              type: String(latest.type ?? ''),
              typeLabel: latest.type_label ? String(latest.type_label) : undefined,
              category: latest.category === 'work' ? 'work' : 'ops',
              title: String(latest.title ?? ''),
              body: latest.body ? String(latest.body) : null,
              link: latest.link ? String(latest.link) : null,
              isRead: false,
              createdAt: String(latest.created_at ?? ''),
            });
          }
          lastLatestId = latestId;
          qc.invalidateQueries({ queryKey: myNotificationKeys.bell });
          qc.invalidateQueries({ queryKey: myNotificationKeys.historyAll });
        }, ctrl.signal);
      } catch {
        /* 네트워크 오류·서버 거절 — 아래에서 다시 연결 */
      }
      if (ctrl.signal.aborted) return;
      retry += 1;
      const delay = Math.min(60_000, 1_000 * 2 ** Math.min(retry, 6));
      timer = setTimeout(connect, retry === 1 ? 500 : delay);
    };
    connect();
    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [enabled, qc]);
}
