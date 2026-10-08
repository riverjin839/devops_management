import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { camelizeKeys, infraNodesApi, infraNodeStream } from '@/services/api';
import { postSse, type SseEvent } from '@/lib/sse';
import type { InfraNodeCreate, InfraNodeUpdate, InfraSyncResult, NodeVerifyResult } from '@/types';

export function useInfraNodes(params?: { clusterId?: string; rackName?: string }) {
  return useQuery({
    queryKey: ['infra-nodes', params],
    queryFn: () => infraNodesApi.getAll(params).then(r => r.data),
    staleTime: 30_000,
  });
}

export function useCreateInfraNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: InfraNodeCreate) => infraNodesApi.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['infra-nodes'] }),
  });
}

export function useUpdateInfraNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: InfraNodeUpdate }) =>
      infraNodesApi.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['infra-nodes'] }),
  });
}

export function useDeleteInfraNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => infraNodesApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['infra-nodes'] }),
  });
}

/** SSE 실행 — `log`·`step` 은 onEvent 로 흘리고, `result` 는 camelCase 로 바꿔 반환, `error` 는 throw. */
async function runInfraStream<T>(url: string, onEvent?: (evt: SseEvent) => void): Promise<T> {
  // 콜백 안에서 채우므로 객체로 둔다(let 은 TS 가 null 로 좁혀 버린다).
  const out: { result: T | null; error: string | null } = { result: null, error: null };
  await postSse(url, undefined, (evt) => {
    if (evt.type === 'result') out.result = camelizeKeys<T>(evt.result);
    else if (evt.type === 'error') out.error = String(evt.message ?? '실행 실패');
    else onEvent?.(evt);
  }, undefined, infraNodeStream.headers);
  if (out.error) throw new Error(out.error);
  if (!out.result) throw new Error('결과 없이 스트림이 끝났습니다.');
  return out.result;
}

// K8s 동기화 — 서버가 kubeconfig·kubectl 재시도·노드별 반영·신규 노드 검증을 실시간으로 흘린다(D-089).
export function useSyncInfraNodes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clusterId, onEvent }: { clusterId: string; onEvent?: (evt: SseEvent) => void }) =>
      runInfraStream<InfraSyncResult>(infraNodeStream.syncUrl(clusterId), onEvent),
    // 실패해도 일부 노드는 반영됐을 수 있다 — 성공·실패 모두 목록을 다시 읽는다.
    onSettled: () => qc.invalidateQueries({ queryKey: ['infra-nodes'] }),
  });
}

// 노드 추가 검증 — 체커 단계를 실시간으로 받는다. 결과는 ephemeral(캐시 무효화 불필요).
export function useVerifyInfraNode() {
  return useMutation({
    mutationFn: ({ id, onEvent }: { id: string; onEvent?: (evt: SseEvent) => void }) =>
      runInfraStream<NodeVerifyResult>(infraNodeStream.verifyUrl(id), onEvent),
  });
}
