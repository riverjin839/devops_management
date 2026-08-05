import { useState } from 'react';
import { AlertCircle, AlertTriangle, Info, RefreshCw, Trash2 } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { useClusters } from '@/hooks/useCluster';
import { useK8sEvents, useDeleteK8sEvent } from '@/hooks/useK8sEvents';
import { K8sEventAnalysisPanel } from '@/components/k8s/K8sEventAnalysisPanel';
import type { K8sEvent, K8sEventSeverity } from '@/types';
import { parseUTC } from '@/lib/utils';

const SEVERITY_TABS: Array<{ value: string; label: string }> = [
  { value: 'all', label: '전체' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' },
];

function SeverityBadge({ severity }: { severity: K8sEventSeverity }) {
  if (severity === 'critical') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">
        <AlertCircle className="w-3 h-3" /> Critical
      </span>
    );
  }
  if (severity === 'warning') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-700">
        <AlertTriangle className="w-3 h-3" /> Warning
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-600">
      <Info className="w-3 h-3" /> Info
    </span>
  );
}

function formatTime(iso: string) {
  try {
    return parseUTC(iso).toLocaleString('ko-KR', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function K8sEventsPage() {
  const { data: clusters = [] } = useClusters();
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [severityTab, setSeverityTab] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading, refetch, isFetching } = useK8sEvents({
    clusterId: selectedClusterId ?? undefined,
    severity: severityTab === 'all' ? undefined : severityTab,
    limit: 200,
  });

  const deleteEvent = useDeleteK8sEvent();

  const events: K8sEvent[] = data?.data ?? [];

  return (
    <div className="app-min-h-screen bg-background py-3 pr-3">
      <div className="flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={selectedClusterId}
          onSelect={(id) => setSelectedClusterId(id ?? null)}
          allowAll
          allLabel="전체 클러스터"
          iconOnly
        />

        <div className="flex-1 min-w-0">
          <MacCard title="K8s 실시간 이벤트">
            {/* 필터 탭 + 새로고침 */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex gap-1">
                {SEVERITY_TABS.map((tab) => (
                  <button
                    key={tab.value}
                    onClick={() => setSeverityTab(tab.value)}
                    className={`px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${
                      severityTab === tab.value
                        ? 'bg-primary text-white'
                        : 'bg-secondary text-muted-foreground hover:bg-secondary/80'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <button
                onClick={() => refetch()}
                disabled={isFetching}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm bg-secondary text-muted-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
                새로고침
              </button>
            </div>

            {/* 요약 카운터 */}
            {data && (
              <div className="flex gap-3 mb-4">
                {(['critical', 'warning', 'info'] as K8sEventSeverity[]).map((sev) => {
                  const count = events.filter((e) => e.severity === sev).length;
                  const colors = {
                    critical: 'bg-red-50 border-red-200 text-red-700',
                    warning: 'bg-yellow-50 border-yellow-200 text-yellow-700',
                    info: 'bg-blue-50 border-blue-200 text-blue-600',
                  };
                  return (
                    <div key={sev} className={`px-3 py-1.5 rounded-xl border text-sm font-medium ${colors[sev]}`}>
                      {sev.charAt(0).toUpperCase() + sev.slice(1)}: {count}
                    </div>
                  );
                })}
                <div className="ml-auto text-sm text-muted-foreground self-center">
                  총 {data.total}건 중 {events.length}건 표시
                </div>
              </div>
            )}

            {/* 이벤트 테이블 */}
            {isLoading ? (
              <div className="text-center py-12 text-muted-foreground text-sm">로딩 중…</div>
            ) : events.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground text-sm">이벤트 없음</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground text-xs">
                      <th className="text-left py-2 pr-3 font-medium w-36">시각</th>
                      <th className="text-left py-2 pr-3 font-medium w-20">심각도</th>
                      <th className="text-left py-2 pr-3 font-medium w-24">Kind</th>
                      <th className="text-left py-2 pr-3 font-medium">이름</th>
                      <th className="text-left py-2 pr-3 font-medium w-32">네임스페이스</th>
                      <th className="text-left py-2 pr-3 font-medium w-36">Reason</th>
                      <th className="text-left py-2 font-medium">메시지</th>
                      <th className="w-8"><span className="sr-only">펼치기</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((ev) => (
                      <>
                        <tr
                          key={ev.id}
                          onClick={() => setExpandedId(expandedId === ev.id ? null : ev.id)}
                          className="border-b border-border/50 hover:bg-muted/30 cursor-pointer transition-colors"
                        >
                          <td className="py-2 pr-3 text-muted-foreground text-xs whitespace-nowrap">
                            {formatTime(ev.receivedAt)}
                          </td>
                          <td className="py-2 pr-3">
                            <SeverityBadge severity={ev.severity} />
                          </td>
                          <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">
                            {ev.resourceKind}
                          </td>
                          <td className="py-2 pr-3 font-medium truncate max-w-[180px]">
                            {ev.resourceName}
                          </td>
                          <td className="py-2 pr-3 text-muted-foreground text-xs truncate">
                            {ev.namespace ?? '-'}
                          </td>
                          <td className="py-2 pr-3 text-xs text-muted-foreground">
                            {ev.reason ?? '-'}
                          </td>
                          <td className="py-2 text-xs text-muted-foreground truncate max-w-[200px]">
                            {ev.message ?? '-'}
                          </td>
                          <td className="py-2 pl-2">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteEvent.mutate(ev.id);
                              }}
                              aria-label="이벤트 삭제"
                              className="p-1 rounded hover:bg-red-100 hover:text-red-600 text-muted-foreground transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                        {expandedId === ev.id && (
                          <tr key={`${ev.id}-detail`} className="bg-muted/20">
                            <td colSpan={8} className="px-4 py-3 space-y-3">
                              <K8sEventAnalysisPanel event={ev} />
                              <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">
                                {JSON.stringify(ev.raw ?? {}, null, 2)}
                              </pre>
                            </td>
                          </tr>
                        )}
                      </>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </MacCard>
        </div>
      </div>
    </div>
  );
}
