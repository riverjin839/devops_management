import { SearchableSelect } from '@/components/common/SearchableSelect';
import { useAnalyzeNamespaces } from '@/hooks/useIncidentAnalysis';

interface Props {
  clusterId: string;
  value: string;
  onChange: (ns: string) => void;
  placeholder?: string;
  className?: string;
  clearable?: boolean;
}

/** 네임스페이스 단일 선택 — 텍스트 검색 + 리스트(콤보박스). analyzeApi 로 NS 목록 fetch.
 *  SearchableSelect 재사용. 여러 페이지에서 NS 선택 UI 통일용. */
export function NamespaceSingleSelect({ clusterId, value, onChange, placeholder = 'namespace 검색…', className, clearable }: Props) {
  const nsQ = useAnalyzeNamespaces(clusterId);
  return (
    <SearchableSelect
      value={value}
      onChange={onChange}
      options={nsQ.data?.namespaces ?? []}
      getKey={(n) => n.name}
      getLabel={(n) => n.name + (typeof n.podCount === 'number' ? ` (${n.podCount})` : '')}
      placeholder={placeholder}
      disabled={!clusterId || nsQ.isLoading}
      loading={nsQ.isLoading}
      emptyText="namespace 없음"
      clearable={clearable}
      className={className}
    />
  );
}
