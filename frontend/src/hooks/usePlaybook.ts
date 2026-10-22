import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { playbooksApi } from '@/services/api';
import { usePlaybookStore } from '@/stores/playbookStore';
import { useToastSafe } from '@/components/common/Toast';
import { formatApiError } from '@/lib/utils';
import type { Playbook, PlaybookRunResult, PlaybookUpdatePayload } from '@/types';
import { toRunLogLevel, type RunLogHandle } from '@/hooks/useRunLog';

/*
 * 실패 피드백 분담(D-143) — 호출부와 토스트가 겹치지 않게 hook 별로 한 곳에서만 알린다.
 *  - 생성·수정: 호출부(AddPlaybookModal)가 결과를 기다려 모달 안에 사유를 띄운다 → hook 토스트 없음.
 *  - 실행: `runLogged` 가 실행 로그에 실패 사유를 남긴다 → hook 토스트 없음.
 *  - 삭제·대시보드 토글: 화면마다 호출부가 따로 알리지 않는다 → hook 의 onError 가 토스트.
 */

export const playbookKeys = {
  all: ['playbooks'] as const,
  byCluster: (clusterId: string) => ['playbooks', clusterId] as const,
  dashboard: (clusterId: string) => ['playbooks', 'dashboard', clusterId] as const,
  detail: (id: string) => ['playbooks', 'detail', id] as const,
  runs: (id: string) => ['playbooks', 'runs', id] as const,
};

export function usePlaybooks(clusterId?: string) {
  const { setPlaybooks } = usePlaybookStore();

  return useQuery({
    queryKey: clusterId ? playbookKeys.byCluster(clusterId) : playbookKeys.all,
    queryFn: async () => {
      const { data } = await playbooksApi.getAll(clusterId);
      const playbooks = data?.data ?? [];
      setPlaybooks(playbooks);
      return playbooks;
    },
    refetchInterval: 15000,
  });
}

export function useCreatePlaybook() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Partial<Playbook>) => playbooksApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: playbookKeys.all });
    },
  });
}

export function useUpdatePlaybook() {
  const queryClient = useQueryClient();

  return useMutation({
    // 비운 설명·태그는 null 로 그대로 JSON 에 실린다(D-144).
    mutationFn: ({ id, data }: { id: string; data: PlaybookUpdatePayload }) =>
      playbooksApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: playbookKeys.all });
    },
  });
}

export function useDeletePlaybook() {
  const queryClient = useQueryClient();
  const toast = useToastSafe();

  return useMutation({
    mutationFn: (id: string) => playbooksApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: playbookKeys.all });
    },
    onError: (e) => toast.error('플레이북 삭제 실패', formatApiError(e)),
  });
}

export function useDashboardPlaybooks(clusterId: string) {
  return useQuery({
    queryKey: playbookKeys.dashboard(clusterId),
    queryFn: async () => {
      const { data } = await playbooksApi.getDashboard(clusterId);
      return data?.data ?? [];
    },
    enabled: !!clusterId,
    refetchInterval: 15000,
  });
}

export function useToggleDashboard() {
  const queryClient = useQueryClient();
  const toast = useToastSafe();

  return useMutation({
    mutationFn: (id: string) => playbooksApi.toggleDashboard(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: playbookKeys.all });
      // 모든 dashboard 쿼리도 invalidate
      queryClient.invalidateQueries({ queryKey: ['playbooks', 'dashboard'] });
    },
    onError: (e) => toast.error('대시보드 표시 변경 실패', formatApiError(e)),
  });
}

const POLL_MS = 1000;

/**
 * 플레이북 실행(R1·R2) — 백그라운드 실행을 시작하고 끝날 때까지 1초마다 진행을 읽어, 새 로그 줄을
 * `run`(실행 로그 핸들)에 흘린다. 끝나면 결과 요약(`PlaybookRunResult` 모양)으로 resolve 한다.
 * 진행 중 runId 는 store 의 `activeRuns` 에 있어 취소 버튼(`useCancelPlaybookRun`)이 쓴다.
 * 조회가 실패해도 경고 한 줄만 남기고 계속 읽는다(서버 일시 오류로 추적이 끊기지 않게).
 */
export function useRunPlaybook() {
  const queryClient = useQueryClient();
  const { setRunning, clearRunning, setActiveRun } = usePlaybookStore();

  return useMutation({
    mutationFn: async ({ id, creds, run, prefix = '' }: {
      id: string;
      creds?: import('@/types').PlaybookSshCreds;
      run?: Pick<RunLogHandle, 'log'>;
      /** 여러 플레이북을 한 로그에 쌓을 때 줄 앞에 붙일 이름. */
      prefix?: string;
    }): Promise<{ data: PlaybookRunResult }> => {
      setRunning(id);
      const p = prefix ? `[${prefix}] ` : '';
      const { data: started } = await playbooksApi.startRun(id, creds);
      setActiveRun(id, started.runId);
      run?.log('info', `${p}서버 실행 시작 · run ${started.runId.slice(0, 8)}`);
      let since = 0;
      let warned = false;
      for (;;) {
        try {
          const { data: prog } = await playbooksApi.getRunProgress(started.runId, since);
          for (const [, level, message] of prog.logLines) run?.log(toRunLogLevel(level), `${p}${message}`);
          since = prog.next;
          if (prog.finished) {
            return {
              data: {
                id,
                status: prog.status,
                message: prog.cancelledBy && prog.status === 'cancelled'
                  ? `${prog.message ?? ''} (취소: ${prog.cancelledBy})`
                  : prog.message ?? '',
                stats: prog.stats ?? undefined,
                durationMs: prog.durationMs,
              },
            };
          }
        } catch (e) {
          if (!warned) { run?.log('warn', `${p}진행 조회 실패(재시도) — ${formatApiError(e)}`); warned = true; }
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: playbookKeys.all });
      queryClient.invalidateQueries({ queryKey: playbookKeys.runs(vars.id) });
    },
    onSettled: (_, __, vars) => {
      clearRunning(vars.id);
      setActiveRun(vars.id, null);
    },
  });
}

/** R2 — 진행 중 실행 취소. 여러 개면 한 번에(전체 실행 중 "실행 취소"). */
export function useCancelPlaybookRun() {
  return useMutation({
    mutationFn: (runIds: string[]) => Promise.allSettled(runIds.map((r) => playbooksApi.cancelRun(r))),
  });
}

/** D-066 — 실행 이력(append-only). 로그 다이얼로그가 열려 있을 때만 조회한다. */
export function usePlaybookRuns(playbookId: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: playbookKeys.runs(playbookId ?? ''),
    queryFn: async () => {
      const { data } = await playbooksApi.getRuns(playbookId as string);
      return data?.data ?? [];
    },
    enabled: enabled && !!playbookId,
  });
}
