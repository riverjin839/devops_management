import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, ServerCog } from 'lucide-react';

import { etcdctlApi, type EtcdMasterCandidate } from '@/services/api';

interface MasterHostPickerProps {
  clusterId: string;
  /** Currently entered host (free-form override). Empty when a candidate is selected. */
  customHost: string;
  /** Currently selected master node name. */
  selectedName: string;
  onChange: (next: { selectedName: string; customHost: string; effectiveHost: string }) => void;
  /** Optional label override. Default "기본 호스트". */
  label?: string;
  /** When true, render a compact single-line layout (e.g. inside a small modal column). */
  compact?: boolean;
}

/**
 * Cluster master(control-plane) 노드 후보를 자동으로 채워주는 호스트 선택 위젯.
 * etcdctl 콘솔과 동일한 백엔드(GET /clusters/{id}/etcdctl/master-candidates)를 사용한다.
 *
 * - 후보가 있으면 첫 노드를 기본 선택.
 * - 사용자가 직접 입력하면 그 값이 우선(override).
 * - 부모는 effectiveHost 만 받아서 host 필드에 사용하면 됨.
 */
export function MasterHostPicker({
  clusterId,
  customHost,
  selectedName,
  onChange,
  label = '기본 호스트',
  compact = false,
}: MasterHostPickerProps) {
  const mastersQ = useQuery({
    queryKey: ['batchjobs', 'masters', clusterId],
    queryFn: () => etcdctlApi.masters(clusterId).then((r) => r.data),
    enabled: !!clusterId,
    staleTime: 60_000,
    retry: 1,
  });

  // `?? []` 가 매 렌더마다 새 배열을 만들어 아래 useMemo deps 가 매번 무효화되던
  // 문제 — react-hooks/exhaustive-deps 경고 회피 + 안정 참조.
  const candidates = useMemo<EtcdMasterCandidate[]>(
    () => mastersQ.data?.candidates ?? [],
    [mastersQ.data],
  );

  const computeHost = (c: EtcdMasterCandidate | undefined) =>
    c?.internalIp || c?.externalIp || c?.name || '';

  // 자동 첫 후보 선택 — 사용자가 아직 직접 입력하지 않았고 선택도 안 했을 때만
  useEffect(() => {
    if (!candidates.length) return;
    if (selectedName || customHost) return;
    const first = candidates[0];
    onChange({
      selectedName: first.name,
      customHost: '',
      effectiveHost: computeHost(first),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates.length]);

  const effectiveHost = useMemo(() => {
    if (customHost.trim()) return customHost.trim();
    const m = candidates.find((c) => c.name === selectedName);
    return computeHost(m);
  }, [customHost, candidates, selectedName]);

  const handleSelect = (name: string) => {
    const m = candidates.find((c) => c.name === name);
    onChange({
      selectedName: name,
      customHost: '',
      effectiveHost: computeHost(m),
    });
  };

  const handleCustom = (value: string) => {
    onChange({
      selectedName: value.trim() ? '' : selectedName,
      customHost: value,
      effectiveHost: value.trim() || computeHost(candidates.find((c) => c.name === selectedName)),
    });
  };

  return (
    <div className={compact ? 'space-y-1.5' : 'space-y-2'}>
      <div className="flex items-center justify-between">
        <label className="text-sm text-muted-foreground flex items-center gap-1">
          <ServerCog className="w-3 h-3" />
          {label}
        </label>
        {mastersQ.isLoading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
        {mastersQ.isError && (
          <span className="text-xs text-amber-500" title={(mastersQ.error as Error).message}>
            후보 조회 실패 — 직접 입력
          </span>
        )}
      </div>

      <select
        value={selectedName}
        onChange={(e) => handleSelect(e.target.value)}
        disabled={!clusterId || candidates.length === 0}
        className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl disabled:opacity-50"
      >
        {candidates.length === 0 && (
          <option value="">
            {mastersQ.isLoading ? '불러오는 중…' : '— master 후보 없음, 아래 직접 입력 —'}
          </option>
        )}
        {candidates.length > 0 && !selectedName && <option value="">— 선택하세요 —</option>}
        {candidates.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
            {c.internalIp ? ` (${c.internalIp})` : c.externalIp ? ` (${c.externalIp})` : ''}
          </option>
        ))}
      </select>

      <input
        type="text"
        value={customHost}
        onChange={(e) => handleCustom(e.target.value)}
        placeholder="직접 입력 (선택). 비우면 위 드롭다운 사용 — 예: 192.168.10.11"
        className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-xl"
      />

      {effectiveHost && (
        <p className="text-xs text-muted-foreground font-mono">
          → {effectiveHost}
        </p>
      )}
    </div>
  );
}
