import { useQuery } from '@tanstack/react-query';
import { releaseNotesApi } from '@/services/api';

export function useReleaseNotes(enabled: boolean) {
  return useQuery({
    queryKey: ['release-notes'],
    queryFn: async () => (await releaseNotesApi.list()).data.entries,
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}
