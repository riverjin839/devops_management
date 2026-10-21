import { SearchableSelect } from '@/components/common/SearchableSelect';
import { useAnalyzePods } from '@/hooks/useIncidentAnalysis';

interface Props {
  clusterId: string;
  namespace: string;
  value: string;
  onChange: (pod: string) => void;
  placeholder?: string;
  className?: string;
  clearable?: boolean;
  /** 바깥 <label htmlFor> 와 연결할 입력 id. */
  id?: string;
}

/** 파드 단일 선택 — 텍스트 검색 + 리스트(콤보박스). 선택된 namespace 의 pod 목록 fetch.
 *  namespace 가 비면 비활성. SearchableSelect 재사용. */
export function PodSingleSelect({ clusterId, namespace, value, onChange, placeholder = '파드 검색…', className, clearable, id }: Props) {
  const podsQ = useAnalyzePods(clusterId, namespace);
  return (
    <SearchableSelect
      value={value}
      onChange={onChange}
      options={podsQ.data?.pods ?? []}
      getKey={(p) => p.name}
      getLabel={(p) => p.name}
      placeholder={placeholder}
      disabled={!clusterId || !namespace || podsQ.isLoading}
      loading={podsQ.isLoading || (podsQ.isError && podsQ.isFetching)}
      // 조회 실패(kubeconfig·RBAC·타임아웃 502/504)를 "파드 없음"으로 보이지 않게 — D-188
      error={podsQ.isError ? podsQ.error : undefined}
      onRetry={() => { void podsQ.refetch(); }}
      emptyText="파드 없음"
      clearable={clearable}
      className={className ?? 'font-mono text-sm'}
      id={id}
    />
  );
}
