// DC 인벤토리 서버 상태 — TanStack Query. 실행(일괄 등록 확정·연결 적용)은 SSE 라 컴포넌트가 직접 다룬다.
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { dcApi } from '@/services/api';

export const dcKeys = {
  all: ['dc-inventory'] as const,
  overview: ['dc-inventory', 'overview'] as const,
  devices: (filters: Record<string, unknown>) => ['dc-inventory', 'devices', filters] as const,
  linkPreview: ['dc-inventory', 'link-preview'] as const,
};

export function useDcOverview() {
  return useQuery({
    queryKey: dcKeys.overview,
    queryFn: async () => (await dcApi.overview()).data,
  });
}

export function useDcDevices(filters: { q: string; role: string; status: string; unracked: boolean }) {
  return useQuery({
    queryKey: dcKeys.devices(filters),
    queryFn: async ({ signal }) => (await dcApi.devices(filters, signal)).data,
    placeholderData: keepPreviousData,
  });
}

export function useDcLinkPreview(enabled: boolean) {
  return useQuery({
    queryKey: dcKeys.linkPreview,
    queryFn: async () => (await dcApi.linkPreview()).data,
    enabled,
  });
}
