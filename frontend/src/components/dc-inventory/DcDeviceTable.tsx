// DC 인벤토리 ▸ 장비 — 읽기 표(2단계). 랙 배치도·장비 상세·생성/수정 폼은 3단계에서 붙는다.
import { useState } from 'react';
import { Search, Server } from 'lucide-react';
import { EmptyState, ErrorState, LoadingState, SegTabs } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { useDcDevices } from '@/hooks/useDcInventory';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { DcDeviceRole } from '@/types';
import { INPUT, ROLE_LABEL, ROLE_OPTIONS, STATUS_LABEL, TD, TH, fmt } from './shared';

type RoleFilter = 'all' | DcDeviceRole;

export function DcDeviceTable({ onGoImport }: { onGoImport: () => void }) {
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<RoleFilter>('all');
  const [unracked, setUnracked] = useState(false);
  const q = useDebouncedValue(search, 250);
  const query = useDcDevices({ q, role: role === 'all' ? '' : role, status: '', unracked });
  const items = query.data?.items ?? [];
  const filtered = Boolean(q) || role !== 'all' || unracked;

  return (
    <MacCard
      title="장비"
      icon={Server}
      titleExtra={query.data ? <span className="text-xs text-muted-foreground">{fmt(query.data.total)}대</span> : undefined}
      bodyPadding="p-0"
    >
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
        <label className="relative">
          <span className="sr-only">호스트명·시리얼 검색</span>
          <Search className="w-4 h-4 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="호스트명·시리얼 검색" className={`${INPUT} pl-8 w-64`} />
        </label>
        <SegTabs<RoleFilter>
          label="역할"
          value={role}
          onChange={setRole}
          options={[['all', '전체'], ...ROLE_OPTIONS.map((r) => [r, ROLE_LABEL[r]] as const)]}
        />
        <label className="inline-flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={unracked} onChange={(e) => setUnracked(e.target.checked)} className="w-4 h-4" />
          랙 미배정만
        </label>
      </div>
      {query.isLoading ? (
        <LoadingState label="장비 목록을 읽는 중" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        filtered ? (
          <EmptyState icon={Server} title="조건에 맞는 장비가 없습니다" description="검색어나 역할 필터를 바꿔 보세요." compact />
        ) : (
          <EmptyState icon={Server} title="등록된 장비가 없습니다"
            description="Excel 양식을 받아 랙·장비·케이블을 한 번에 올리거나, 기존 노드 서버스펙을 연결해 시작합니다."
            action={{ label: '일괄 등록으로 이동', onClick: onGoImport }} />
        )
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={TH}>호스트명</th>
                <th className={TH}>역할</th>
                <th className={TH}>장비 종류</th>
                <th className={TH}>랙</th>
                <th className={TH}>U</th>
                <th className={TH}>시리얼</th>
                <th className={TH}>클러스터</th>
                <th className={TH}>상태</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id} className="hover:bg-secondary/40">
                  <td className={`${TD} font-medium whitespace-nowrap`}>{d.hostname}</td>
                  <td className={`${TD} whitespace-nowrap`}>{ROLE_LABEL[d.role] ?? d.role}</td>
                  <td className={`${TD} whitespace-nowrap`}>{d.deviceTypeModel ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className={`${TD} whitespace-nowrap`}>{d.rackName ?? <span className="text-muted-foreground">미배정</span>}</td>
                  <td className={`${TD} whitespace-nowrap tabular-nums`}>
                    {d.uRange ?? <span className="text-muted-foreground">—</span>}
                    {d.uRange && d.face === 'rear' && <span className="text-muted-foreground"> · 뒷면</span>}
                  </td>
                  <td className={`${TD} whitespace-nowrap font-mono text-xs`}>{d.serial ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className={`${TD} whitespace-nowrap`}>{d.clusterName ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className={`${TD} whitespace-nowrap ${d.status === 'active' ? '' : 'text-status-warning font-medium'}`}>
                    {STATUS_LABEL[d.status] ?? d.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {query.data && query.data.total > items.length && (
            <p className="px-4 py-2 text-xs text-muted-foreground">
              {fmt(query.data.total)}대 중 {fmt(items.length)}대 표시 — 검색으로 좁혀 보세요.
            </p>
          )}
        </div>
      )}
    </MacCard>
  );
}
