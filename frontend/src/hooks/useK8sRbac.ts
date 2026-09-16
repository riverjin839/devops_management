/**
 * K8S 접근 권한(RBAC) 서버 상태 — `/k8s-rbac` 화면 전용.
 *
 * 조회는 TanStack Query 로, 실행(액세스 발급)은 SSE 로 간다. 실행이 쿼리가 아닌 이유는
 * 단계별 로그를 실시간으로 받아야 하기 때문 — `useProvisionStream` 이 그 스트림을
 * 로그 배열/단계 상태/결과로 풀어준다.
 */
import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { k8sRbacApi, k8sRbacStreamUrl } from '@/services/api';
import { getAuthToken } from '@/stores/authStore';
import type {
  RbacAccessReviewEntry,
  RbacBinding,
  RbacCreatedObject,
  RbacNamespace,
  RbacPolicyRule,
  RbacPresetCatalog,
  RbacProvisionRequest,
  RbacRole,
  RbacServiceAccount,
} from '@/types';

export const rbacKeys = {
  presets: (c: string) => ['rbac', 'presets', c] as const,
  namespaces: (c: string) => ['rbac', 'namespaces', c] as const,
  serviceAccounts: (c: string, ns?: string) => ['rbac', 'sa', c, ns ?? '*'] as const,
  roles: (c: string, ns?: string) => ['rbac', 'roles', c, ns ?? '*'] as const,
  clusterRoles: (c: string, sys: boolean) => ['rbac', 'clusterRoles', c, sys] as const,
  bindings: (c: string, ns?: string, sys?: boolean) => ['rbac', 'bindings', c, ns ?? '*', !!sys] as const,
};

export function useRbacPresets(clusterId: string) {
  return useQuery({
    queryKey: rbacKeys.presets(clusterId),
    queryFn: async () => (await k8sRbacApi.getPresets(clusterId)).data as RbacPresetCatalog,
    enabled: !!clusterId,
    staleTime: 10 * 60_000, // 카탈로그는 배포 전까지 안 바뀐다
  });
}

export function useRbacNamespaces(clusterId: string) {
  return useQuery({
    queryKey: rbacKeys.namespaces(clusterId),
    queryFn: async () => (await k8sRbacApi.getNamespaces(clusterId)).data.data as RbacNamespace[],
    enabled: !!clusterId,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useRbacServiceAccounts(clusterId: string, namespace?: string) {
  return useQuery({
    queryKey: rbacKeys.serviceAccounts(clusterId, namespace),
    queryFn: async () =>
      (await k8sRbacApi.getServiceAccounts(clusterId, namespace)).data.data as RbacServiceAccount[],
    enabled: !!clusterId,
    placeholderData: keepPreviousData,
  });
}

export function useRbacRoles(clusterId: string, namespace?: string) {
  return useQuery({
    queryKey: rbacKeys.roles(clusterId, namespace),
    queryFn: async () => (await k8sRbacApi.getRoles(clusterId, namespace)).data.data as RbacRole[],
    enabled: !!clusterId,
    placeholderData: keepPreviousData,
  });
}

export function useRbacClusterRoles(clusterId: string, includeSystem = false) {
  return useQuery({
    queryKey: rbacKeys.clusterRoles(clusterId, includeSystem),
    queryFn: async () =>
      (await k8sRbacApi.getClusterRoles(clusterId, includeSystem)).data.data as RbacRole[],
    enabled: !!clusterId,
    placeholderData: keepPreviousData,
  });
}

export function useRbacBindings(clusterId: string, namespace?: string, includeSystem = false) {
  return useQuery({
    queryKey: rbacKeys.bindings(clusterId, namespace, includeSystem),
    queryFn: async () =>
      (await k8sRbacApi.getBindings(clusterId, namespace, includeSystem)).data.data as RbacBinding[],
    enabled: !!clusterId,
    placeholderData: keepPreviousData,
  });
}

/** 생성·삭제 후 RBAC 관련 쿼리를 통째로 새로 고친다 — 오브젝트끼리 서로를 참조해서다. */
function useInvalidateRbac(clusterId: string) {
  const qc = useQueryClient();
  return useCallback(() => {
    qc.invalidateQueries({ queryKey: ['rbac'] });
    void clusterId;
  }, [qc, clusterId]);
}

export function useCreateServiceAccount(clusterId: string) {
  const invalidate = useInvalidateRbac(clusterId);
  return useMutation({
    mutationFn: (payload: { namespace: string; name: string }) =>
      k8sRbacApi.createServiceAccount(clusterId, payload),
    onSuccess: invalidate,
  });
}

export function useDeleteServiceAccount(clusterId: string) {
  const invalidate = useInvalidateRbac(clusterId);
  return useMutation({
    mutationFn: ({ namespace, name }: { namespace: string; name: string }) =>
      k8sRbacApi.deleteServiceAccount(clusterId, namespace, name),
    onSuccess: invalidate,
  });
}

export function useUpsertRole(clusterId: string) {
  const invalidate = useInvalidateRbac(clusterId);
  return useMutation({
    mutationFn: ({
      scope,
      namespace,
      name,
      rules,
    }: {
      scope: 'namespace' | 'cluster';
      namespace: string | null;
      name: string;
      rules: RbacPolicyRule[];
    }) =>
      scope === 'cluster'
        ? k8sRbacApi.upsertClusterRole(clusterId, name, { rules })
        : k8sRbacApi.upsertRole(clusterId, namespace ?? '', name, { rules }),
    onSuccess: invalidate,
  });
}

export function useDeleteRole(clusterId: string) {
  const invalidate = useInvalidateRbac(clusterId);
  return useMutation({
    mutationFn: ({
      scope,
      namespace,
      name,
    }: {
      scope: 'namespace' | 'cluster';
      namespace: string | null;
      name: string;
    }) =>
      scope === 'cluster'
        ? k8sRbacApi.deleteClusterRole(clusterId, name)
        : k8sRbacApi.deleteRole(clusterId, namespace ?? '', name),
    onSuccess: invalidate,
  });
}

export function useDeleteBinding(clusterId: string) {
  const invalidate = useInvalidateRbac(clusterId);
  return useMutation({
    mutationFn: ({
      kind,
      name,
      namespace,
    }: {
      kind: string;
      name: string;
      namespace: string | null;
    }) => k8sRbacApi.deleteBinding(clusterId, kind, name, namespace),
    onSuccess: invalidate,
  });
}

export function useAccessReview(clusterId: string) {
  return useMutation({
    mutationFn: async (payload: {
      namespace: string;
      serviceAccount: string;
      namespaces?: string[];
    }) => (await k8sRbacApi.accessReview(clusterId, payload)).data.data as RbacAccessReviewEntry[],
  });
}

export function useIssueKubeconfig(clusterId: string) {
  return useMutation({
    mutationFn: async (payload: {
      namespace: string;
      serviceAccount: string;
      longLivedToken?: boolean;
      tokenTtlSeconds?: number;
    }) => (await k8sRbacApi.issueKubeconfig(clusterId, payload)).data,
  });
}

// ── 실행(액세스 발급) SSE ────────────────────────────────────────────────────

export interface ProvisionLogLine {
  level: 'info' | 'warn' | 'error';
  ts: string;
  message: string;
}

export interface ProvisionResult {
  namespace: string;
  serviceAccount: string;
  namespaces: string[];
  roleName: string;
  bindingName: string;
  created: RbacCreatedObject[];
  accessReview: RbacAccessReviewEntry[];
  kubeconfig: string | null;
  tokenExpiresAt: string | null;
  dryRun: boolean;
  elapsedSeconds: number;
}

/** 실행 단계 — 화면의 진행 칩과 1:1. 서버가 보내는 step 이름과 같아야 한다. */
export const PROVISION_STEPS: { key: string; label: string }[] = [
  { key: 'namespace-check', label: '네임스페이스 확인' },
  { key: 'service-account', label: 'ServiceAccount' },
  { key: 'role', label: '권한 오브젝트' },
  { key: 'binding', label: '바인딩' },
  { key: 'verify', label: '권한 검증' },
  { key: 'kubeconfig', label: 'kubeconfig' },
];

export type StepStatus = 'pending' | 'running' | 'done';

/** camelCase 변환기를 거치지 않는 SSE 원문(snake_case)을 화면 타입으로 옮긴다. */
function toResult(raw: Record<string, unknown>): ProvisionResult {
  return {
    namespace: String(raw.namespace ?? ''),
    serviceAccount: String(raw.service_account ?? ''),
    namespaces: (raw.namespaces as string[]) ?? [],
    roleName: String(raw.role_name ?? ''),
    bindingName: String(raw.binding_name ?? ''),
    created: ((raw.created as Record<string, unknown>[]) ?? []).map((c) => ({
      kind: String(c.kind ?? ''),
      name: String(c.name ?? ''),
      namespace: (c.namespace as string | null) ?? null,
    })),
    accessReview: ((raw.access_review as Record<string, unknown>[]) ?? []).map((r) => ({
      label: String(r.label ?? ''),
      namespace: (r.namespace as string | null) ?? null,
      verb: (r.verb as string | null) ?? null,
      resource: (r.resource as string | null) ?? null,
      subresource: (r.subresource as string | null) ?? null,
      allowed: !!r.allowed,
      reason: (r.reason as string | null) ?? null,
    })),
    kubeconfig: (raw.kubeconfig as string | null) ?? null,
    tokenExpiresAt: (raw.token_expires_at as string | null) ?? null,
    dryRun: !!raw.dry_run,
    elapsedSeconds: Number(raw.elapsed_seconds ?? 0),
  };
}

/** camelCase 요청 본문을 백엔드가 받는 snake_case 로 — SSE 는 axios 인터셉터를 안 탄다. */
function toSnakePayload(req: RbacProvisionRequest): Record<string, unknown> {
  return {
    namespace: req.namespace,
    service_account: req.serviceAccount,
    extra_namespaces: req.extraNamespaces,
    binding_mode: req.bindingMode,
    rules: req.rules.map((r) => ({
      api_groups: r.apiGroups,
      resources: r.resources,
      verbs: r.verbs,
      resource_names: r.resourceNames,
      non_resource_urls: r.nonResourceUrls,
    })),
    role_name: req.roleName || null,
    binding_name: req.bindingName || null,
    preset_key: req.presetKey || null,
    create_namespace: req.createNamespace,
    verify: req.verify,
    issue_kubeconfig: req.issueKubeconfig,
    long_lived_token: req.longLivedToken,
    token_ttl_seconds: req.tokenTtlSeconds,
    dry_run: req.dryRun,
  };
}

export interface ProvisionStream {
  running: boolean;
  logs: ProvisionLogLine[];
  steps: Record<string, StepStatus>;
  result: ProvisionResult | null;
  error: string | null;
  start: (req: RbacProvisionRequest) => void;
  abort: () => void;
  clear: () => void;
}

export function useProvisionStream(clusterId: string): ProvisionStream {
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<ProvisionLogLine[]>([]);
  const [steps, setSteps] = useState<Record<string, StepStatus>>({});
  const [result, setResult] = useState<ProvisionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const qc = useQueryClient();

  const clear = useCallback(() => {
    setLogs([]);
    setSteps({});
    setResult(null);
    setError(null);
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }, []);

  const start = useCallback(
    (req: RbacProvisionRequest) => {
      if (!clusterId) return;
      abortRef.current?.abort();
      clear();
      setRunning(true);
      const ac = new AbortController();
      abortRef.current = ac;
      const token = getAuthToken();

      const handle = (evt: Record<string, unknown>) => {
        const type = String(evt.type ?? '');
        if (type === 'log') {
          setLogs((prev) => [
            ...prev,
            {
              level: (evt.level as ProvisionLogLine['level']) ?? 'info',
              ts: String(evt.ts ?? ''),
              message: String(evt.message ?? ''),
            },
          ]);
        } else if (type === 'step') {
          setSteps((prev) => ({
            ...prev,
            [String(evt.name ?? '')]: (evt.status as StepStatus) ?? 'running',
          }));
        } else if (type === 'result') {
          setResult(toResult(evt));
        } else if (type === 'error') {
          setError(String(evt.message ?? '실행에 실패했습니다.'));
        }
      };

      fetch(k8sRbacStreamUrl(clusterId), {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(toSnakePayload(req)),
      })
        .then(async (resp) => {
          if (!resp.ok) {
            // 스트림이 시작되기 전 거절(403/422 등)은 본문이 JSON 에러다.
            let detail = `서버 오류 ${resp.status}`;
            try {
              const body = await resp.json();
              if (body?.detail) detail = String(body.detail);
            } catch {
              /* 본문이 JSON 이 아니면 상태코드만 */
            }
            setError(detail);
            return;
          }
          if (!resp.body) {
            setError('스트림 본문이 비어 있습니다.');
            return;
          }
          const reader = resp.body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              for (const ln of block.split('\n')) {
                if (!ln.startsWith('data:')) continue;
                try {
                  handle(JSON.parse(ln.slice(5).replace(/^ /, '')));
                } catch {
                  /* 깨진 줄은 건너뛴다 — 스트림 전체를 죽이지 않는다 */
                }
              }
            }
          }
        })
        .catch((e) => {
          if (!ac.signal.aborted) setError(String(e).slice(0, 300));
        })
        .finally(() => {
          setRunning(false);
          abortRef.current = null;
          // 클러스터 상태가 바뀌었으니 목록 탭들을 새로 고친다.
          qc.invalidateQueries({ queryKey: ['rbac'] });
        });
    },
    [clusterId, clear, qc],
  );

  return { running, logs, steps, result, error, start, abort, clear };
}
