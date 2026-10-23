import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notificationsApi } from '@/services/api';
import type { NotificationChannelInput } from '@/types';

export const notificationKeys = {
  channels: ['notificationChannels'] as const,
  log: ['notificationLog'] as const,
};

export function useNotificationChannels() {
  return useQuery({
    queryKey: notificationKeys.channels,
    queryFn: async () => {
      const { data } = await notificationsApi.list();
      return data;
    },
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

