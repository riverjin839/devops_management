import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ontologyApi } from '@/services/api';
import type { OntologyEntityCreate, OntologyImpactRequest, OntologyRelationshipCreate } from '@/types';

export function useOntologyGraph(clusterId: string | null) {
  return useQuery({
    queryKey: ['ontology', 'graph', clusterId],
    queryFn: () => ontologyApi.getGraph(clusterId!).then((r) => r.data),
    enabled: !!clusterId,
    staleTime: 1000 * 30,
  });
}

/**
 * 변경 영향 분석 — 그래프(엔티티·관계)를 바꾸지 않으므로 그래프 쿼리를 무효화하지 않는다.
 * 무효화하면 refetch → 3D 시뮬레이션 재시작 → 노드 재배치·카메라 포커스 상실이 생긴다(A-21).
 */
export function useAnalyzeImpact() {
  return useMutation({
    mutationFn: (data: OntologyImpactRequest) =>
      ontologyApi.analyzeImpact(data).then((r) => r.data),
  });
}

/** 엔티티 등록 — 서버가 operator + 클러스터 operate 를 요구한다(아니면 403). */
export function useCreateOntologyEntity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: OntologyEntityCreate) => ontologyApi.createEntity(data).then((r) => r.data),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['ontology', 'graph', vars.clusterId] });
    },
  });
}

/** 관계 등록 — 서버가 operator + 클러스터 operate 를 요구한다(아니면 403). */
export function useCreateOntologyRelationship() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: OntologyRelationshipCreate) => ontologyApi.createRelationship(data).then((r) => r.data),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['ontology', 'graph', vars.clusterId] });
    },
  });
}
