// K8S 자원 효율화 — 추천/이력/정책/실행 로그 서버 상태(TanStack Query).
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { k8sEfficiencyApi } from '@/services/api';
import type { EffNamespacePolicyBody, EffPolicyDefaults, EffRun } from '@/types';

const ACTIVE: EffRun['runState'][] = ['queued', 'running'];
const errMsg = (e: unknown) => {
  const err = e as { response?: { data?: { detail?: unknown } }; message?: string };
  const d = err?.response?.data?.detail;
  return typeof d === 'string' ? d : (err?.message ?? String(e));
};
export { errMsg as effErrMsg };

export function useEffRecommendations(clusterId: string, status = 'open', namespace?: string) {
  return useQuery({
    queryKey: ['eff-recs', clusterId, status, namespace ?? ''],
    queryFn: async () => (await k8sEfficiencyApi.recommendations(clusterId, status, namespace)).data,
    enabled: !!clusterId,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  });
}

export function useEffNsSeries(clusterId: string, namespace: string, range: string) {
  return useQuery({
    queryKey: ['eff-series', clusterId, namespace, range],
    queryFn: async () => (await k8sEfficiencyApi.nsSeries(clusterId, namespace, range)).data,
    enabled: !!clusterId && !!namespace,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  });
}

export function useEffRanking(clusterId: string, range: string, metric: 'cpu' | 'mem', top = 8) {
  return useQuery({
    queryKey: ['eff-ranking', clusterId, range, metric, top],
    queryFn: async () => (await k8sEfficiencyApi.ranking(clusterId, range, metric, top)).data,
    enabled: !!clusterId,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  });
}

export function useEffSummary(clusterId: string) {
  return useQuery({
    queryKey: ['eff-summary', clusterId],
    queryFn: async () => (await k8sEfficiencyApi.summary(clusterId)).data,
    enabled: !!clusterId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useEffQuotas(clusterId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['eff-quotas', clusterId],
    queryFn: async () => (await k8sEfficiencyApi.quotas(clusterId)).data,
    enabled: !!clusterId && enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useEffPolicies(clusterId: string) {
  return useQuery({
    queryKey: ['eff-policies', clusterId],
    queryFn: async () => (await k8sEfficiencyApi.policies(clusterId)).data,
    enabled: !!clusterId,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useEffPolicyDefaults() {
  return useQuery({
    queryKey: ['eff-defaults'],
    queryFn: async () => (await k8sEfficiencyApi.policyDefaults()).data,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useEffSchedule() {
  return useQuery({
    queryKey: ['eff-schedule'],
    queryFn: async () => (await k8sEfficiencyApi.schedule()).data,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useEffRuns(clusterId: string, runType?: string) {
  return useQuery({
    queryKey: ['eff-runs', clusterId, runType ?? ''],
    queryFn: async () => (await k8sEfficiencyApi.runs(clusterId, runType)).data,
    enabled: !!clusterId,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
}

/** 실행 로그 폴링 — queued/running 동안 1.5초, 종료 시 중단. */
export function useEffRun(runId: string | null) {
  return useQuery({
    queryKey: ['eff-run', runId],
    queryFn: async () => (await k8sEfficiencyApi.run(runId as string)).data,
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data && ACTIVE.includes(q.state.data.runState) ? 1500 : false),
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

/** 뮤테이션 모음 — 성공 시 관련 캐시 무효화. onRun(runId) 로 실행 로그 패널을 띄운다. */
export function useEffMutations(clusterId: string, onRun?: (runId: string) => void) {
  const qc = useQueryClient();
  const inv = (...keys: string[]) => keys.forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));
  const collect = useMutation({
    mutationFn: async () => (await k8sEfficiencyApi.collect(clusterId)).data,
    onSuccess: (d) => { onRun?.(d.runId); inv('eff-runs'); },
  });
  const generate = useMutation({
    mutationFn: async () => (await k8sEfficiencyApi.generate(clusterId)).data,
    onSuccess: (d) => { onRun?.(d.runId); inv('eff-runs'); },
  });
  const apply = useMutation({
    mutationFn: async (b: { recommendationIds: string[]; dryRun: boolean }) => (await k8sEfficiencyApi.apply(clusterId, b)).data,
    onSuccess: (d) => { onRun?.(d.runId); inv('eff-runs', 'eff-recs'); },
  });
  const dismiss = useMutation({
    mutationFn: async (id: string) => (await k8sEfficiencyApi.dismiss(clusterId, id)).data,
    onSuccess: () => inv('eff-recs'),
  });
  const rollback = useMutation({
    mutationFn: async (runId: string) => (await k8sEfficiencyApi.rollback(runId)).data,
    onSuccess: (d) => { onRun?.(d.runId); inv('eff-runs', 'eff-recs'); },
  });
  const quotaAdjust = useMutation({
    mutationFn: async (b: { namespace: string; cpuM?: number | null; memB?: number | null; dryRun: boolean }) =>
      (await k8sEfficiencyApi.quotaAdjust(clusterId, b)).data,
    onSuccess: (d) => { onRun?.(d.runId); inv('eff-runs'); },
  });
  const customScale = useMutation({
    mutationFn: async (b: { namespace: string; targetIndex: number; value: number; dryRun: boolean }) =>
      (await k8sEfficiencyApi.customScale(clusterId, b)).data,
    onSuccess: (d) => { onRun?.(d.runId); inv('eff-runs'); },
  });
  const savePolicy = useMutation({
    mutationFn: async (v: { namespace: string; body: EffNamespacePolicyBody }) =>
      (await k8sEfficiencyApi.putPolicy(clusterId, v.namespace, v.body)).data,
    onSuccess: () => inv('eff-policies'),
  });
  const deletePolicy = useMutation({
    mutationFn: async (namespace: string) => (await k8sEfficiencyApi.deletePolicy(clusterId, namespace)).data,
    onSuccess: () => inv('eff-policies'),
  });
  const saveDefaults = useMutation({
    mutationFn: async (b: Partial<EffPolicyDefaults>) => (await k8sEfficiencyApi.putPolicyDefaults(b)).data,
    onSuccess: () => inv('eff-defaults'),
  });
  const saveSchedule = useMutation({
    mutationFn: async (b: { enabled: boolean; defaultCron: string; clusters?: Record<string, { enabled: boolean; cron: string | null }> }) =>
      (await k8sEfficiencyApi.putSchedule(b)).data,
    onSuccess: () => inv('eff-schedule'),
  });
  return { collect, generate, apply, dismiss, rollback, quotaAdjust, customScale, savePolicy, deletePolicy, saveDefaults, saveSchedule };
}
