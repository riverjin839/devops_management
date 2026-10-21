// 외부 노출 변경 이력 — 수집마다 직전 수집과 비교해 새로 열리거나 사라진 엔드포인트(공개 화면).
// 새로 열림은 의도하지 않은 외부 노출일 수 있어 warning 색, 사라짐은 중립색.
import { useState } from 'react';
import { History } from 'lucide-react';
import { EmptyState, ErrorState, LoadingState } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { useExternalServiceChanges } from '@/hooks/useExternalServices';
import { cn } from '@/lib/utils';

const CHIP = 'text-xs px-2.5 py-1 rounded-xl border transition-colors';
const CHIP_ON = 'border-primary bg-primary text-primary-foreground';
const CHIP_OFF = 'border-border bg-card text-foreground hover:bg-secondary';
const DAYS = [7, 30, 90];

export function ChangesCard({ clusterId }: { clusterId: string }) {
  const [days, setDays] = useState(30);
  const [open, setOpen] = useState(false);
  const q = useExternalServiceChanges(clusterId, days, open);
  const d = q.data;

  return (
    <MacCard
      title="노출 변경 이력"
      icon={History}
      description={d ? `최근 ${d.days}일 — 새로 열림 ${d.added} · 사라짐 ${d.removed}` : '수집마다 직전 수집과 비교한 결과'}
      actions={(
        <div className="flex items-center gap-1">
          {open && DAYS.map((n) => (
            <button key={n} type="button" aria-pressed={days === n} className={cn(CHIP, days === n ? CHIP_ON : CHIP_OFF)}
              onClick={() => setDays(n)}>{n}일</button>
          ))}
          <button type="button" className={cn(CHIP, CHIP_OFF)} aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? '접기' : '펼치기'}
          </button>
        </div>
      )}
      bodyPadding="p-0"
      className={open ? undefined : 'hidden'}
    >
      {!open ? null : q.isError ? (
        <ErrorState compact error={q.error} onRetry={() => void q.refetch()} />
      ) : !d ? (
        <LoadingState compact />
      ) : d.items.length === 0 ? (
        <EmptyState compact icon={History} title="변경 없음" description={`최근 ${d.days}일 동안 새로 열리거나 사라진 엔드포인트가 없다.`} />
      ) : (
        <div className="overflow-x-auto max-h-96">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">감지 시각</th>
                <th className="px-3 py-2 text-left font-medium">변경</th>
                <th className="px-3 py-2 text-left font-medium">주소</th>
                <th className="px-3 py-2 text-left font-medium">유형</th>
                <th className="px-3 py-2 text-left font-medium">네임스페이스 / 이름</th>
                <th className="px-3 py-2 text-left font-medium">수집</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((c, i) => (
                <tr key={`${c.detectedAt}-${i}`} className="border-b border-border last:border-0">
                  <td className="px-3 py-1.5 text-xs text-muted-foreground whitespace-nowrap tabular-nums">
                    {new Date(`${c.detectedAt}Z`).toLocaleString()}
                  </td>
                  <td className="px-3 py-1.5 text-xs whitespace-nowrap">
                    {c.change === 'added'
                      ? <span className="text-status-warning font-medium">새로 열림</span>
                      : <span className="text-muted-foreground">사라짐</span>}
                  </td>
                  <td className="px-3 py-1.5 font-mono whitespace-nowrap">
                    {c.host ?? c.address ?? '<노드 IP>'}:{c.port ?? ''}
                    {c.host && c.address && <span className="ml-1 text-xs text-muted-foreground">{c.address}</span>}
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{c.kind}</td>
                  <td className="px-3 py-1.5 font-mono whitespace-nowrap">
                    <span className="text-muted-foreground">{c.namespace}/</span>{c.name}
                  </td>
                  <td className="px-3 py-1.5 text-xs text-muted-foreground whitespace-nowrap">{c.by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </MacCard>
  );
}
