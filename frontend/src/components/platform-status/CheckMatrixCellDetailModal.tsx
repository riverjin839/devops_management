import { useMemo, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { X, Clock, Save } from 'lucide-react';
import { StatusBadge, useToast } from '@/components/common';
import type { CheckMatrixItem, CheckMatrixGridCluster, Status } from '@/types';
import {
  useCheckMatrixCellHistory, usePostManualEntry, usePutSchedule,
} from '@/hooks/useCheckMatrix';
import { formatApiError } from '@/lib/utils';

interface Props {
  item: CheckMatrixItem;
  cluster: CheckMatrixGridCluster;
  cronExpr: string | null;
  scheduleEnabled: boolean;
  onClose: () => void;
}

const DAY_OPTIONS = [7, 30, 90];
const STATUS_OPTIONS: Status[] = ['healthy', 'warning', 'critical', 'pending'];

export function CheckMatrixCellDetailModal({ item, cluster, cronExpr, scheduleEnabled, onClose }: Props) {
  const toast = useToast();
  const [days, setDays] = useState(30);
  const { data: history, isLoading } = useCheckMatrixCellHistory(item.id, cluster.id, days);

  const [cronDraft, setCronDraft] = useState(cronExpr ?? '');
  const [cronOn, setCronOn] = useState(scheduleEnabled);
  const putSchedule = usePutSchedule();

  const [manualStatus, setManualStatus] = useState<Status>('healthy');
  const [manualValue, setManualValue] = useState('');
  const [manualMessage, setManualMessage] = useState('');
  const postManual = usePostManualEntry();

  const chartData = useMemo(
    () => (history?.points ?? [])
      .filter((p) => p.value != null)
      .map((p) => ({
        time: new Date(p.checkedAt).toLocaleString('ko-KR', {
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        }),
        value: p.value,
      })),
    [history],
  );

  const handleSaveSchedule = async () => {
    try {
      await putSchedule.mutateAsync({
        itemId: item.id, clusterId: cluster.id,
        cronExpr: cronDraft.trim() || null, enabled: cronOn,
      });
      toast.success('cron 설정을 저장했습니다.');
    } catch (e) {
      toast.error('cron 설정 실패', formatApiError(e));
    }
  };

  const handleSaveManualEntry = async () => {
    try {
      await postManual.mutateAsync({
        itemId: item.id, clusterId: cluster.id, status: manualStatus,
        value: manualValue.trim() ? Number(manualValue) : null,
        message: manualMessage.trim() || null,
      });
      toast.success('값을 저장했습니다.');
      setManualMessage('');
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-2xl shadow-xl w-full max-w-2xl mx-4 max-h-[88vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-card rounded-t-2xl z-10">
          <div className="min-w-0">
            <h2 className="text-base font-semibold truncate">{item.name}</h2>
            <p className="text-xs text-muted-foreground truncate">{cluster.name}</p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-secondary rounded-lg transition-colors flex-shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* 트렌드 차트 */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">추이</h3>
              <div className="flex items-center rounded-md border border-border overflow-hidden text-xs">
                {DAY_OPTIONS.map((d) => (
                  <button
                    key={d}
                    onClick={() => setDays(d)}
                    className={`px-2 py-1 transition-colors ${
                      days === d ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground'
                    }`}
                  >
                    {d}일
                  </button>
                ))}
              </div>
            </div>
            {isLoading ? (
              <div className="text-sm text-muted-foreground py-8 text-center">불러오는 중…</div>
            ) : chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="time" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} unit={item.unit ?? ''} />
                  <Tooltip />
                  <Line type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} name={item.name} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-sm text-muted-foreground italic py-8 text-center">
                최근 {days}일간 수치 이력이 없습니다.
              </div>
            )}
          </section>

          {/* 변경 이력 */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">변경 이력</h3>
            {(history?.changes.length ?? 0) === 0 ? (
              <div className="text-sm text-muted-foreground italic">기록이 없습니다.</div>
            ) : (
              <ul className="space-y-1.5 max-h-48 overflow-y-auto">
                {history!.changes.map((c, i) => (
                  <li key={i} className="flex items-center gap-2 text-sm">
                    <StatusBadge variant={c.status} size="sm" />
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {new Date(c.checkedAt).toLocaleString('ko-KR')}
                    </span>
                    {c.message && <span className="text-xs text-muted-foreground truncate">{c.message}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 수동 입력 (manual 타입 전용) */}
          {item.sourceType === 'manual' && (
            <section className="border-t border-border pt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">값 입력</h3>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={manualStatus}
                  onChange={(e) => setManualStatus(e.target.value as Status)}
                  className="text-sm border border-border rounded-lg px-2 py-1.5 bg-background"
                >
                  {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <input
                  type="number"
                  placeholder="값 (선택)"
                  value={manualValue}
                  onChange={(e) => setManualValue(e.target.value)}
                  className="text-sm border border-border rounded-lg px-2 py-1.5 bg-background w-28"
                />
                <input
                  type="text"
                  placeholder="메모 (선택)"
                  value={manualMessage}
                  onChange={(e) => setManualMessage(e.target.value)}
                  className="text-sm border border-border rounded-lg px-2 py-1.5 bg-background flex-1 min-w-[140px]"
                />
                <button
                  onClick={handleSaveManualEntry}
                  disabled={postManual.isPending}
                  className="px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
                >
                  저장
                </button>
              </div>
            </section>
          )}

          {/* cron (core_bundle 이외 항목만 — 핵심 항목은 클러스터 열 헤더에서 설정) */}
          {item.sourceType !== 'core_bundle' && item.sourceType !== 'manual' && (
            <section className="border-t border-border pt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" /> 실행 주기 (이 클러스터)
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  placeholder="예: 15 9,13,18 * * * (5분 미만 간격 불가)"
                  value={cronDraft}
                  onChange={(e) => setCronDraft(e.target.value)}
                  className="text-sm border border-border rounded-lg px-2 py-1.5 bg-background flex-1 min-w-[200px] font-mono"
                />
                <label className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={cronOn} onChange={(e) => setCronOn(e.target.checked)} />
                  활성화
                </label>
                <button
                  onClick={handleSaveSchedule}
                  disabled={putSchedule.isPending}
                  className="px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1"
                >
                  <Save className="w-3.5 h-3.5" /> 저장
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
