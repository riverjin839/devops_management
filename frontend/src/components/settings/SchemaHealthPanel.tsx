import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ShieldCheck, AlertTriangle, Wrench, RefreshCw, Loader2, Database, Info,
} from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { useToast, ConfirmDialog, Skeleton, LogViewer } from '@/components/common';
import { schemaHealthApi } from '@/services/api';
import { formatApiError } from '@/lib/utils';
import type { SchemaDriftIssue, SchemaRepairResult } from '@/types';

const KIND_META: Record<SchemaDriftIssue['kind'], { label: string; cls: string }> = {
  missing_column: { label: '컬럼 없음', cls: 'text-status-critical border-status-critical/50' },
  not_null_drift: { label: 'NOT NULL 잔존', cls: 'text-status-warning border-status-warning/50' },
  // 모델에 없는 DB 전용 컬럼(orphan)이 NOT NULL + 기본값 없음 — ORM 이 값을 채울 방법이
  // 없어 그 테이블의 모든 저장이 실패한다. missing_column/not_null_drift 와 달리
  // "모델 → DB" 비교로는 못 잡는 케이스(예: deep_check_results.ai_status).
  orphan_not_null_column: { label: '고아 컬럼 NOT NULL', cls: 'text-status-critical border-status-critical/50' },
  missing_table: { label: '테이블 없음', cls: 'text-status-critical border-status-critical/50' },
  inspect_failed: { label: '점검 실패', cls: 'text-muted-foreground border-border' },
};

/**
 * 스키마 점검 — 모델(코드)과 실제 DB 가 어긋난 곳을 보여주고 안전한 것만 복구한다.
 *
 * 이 프로젝트는 Alembic 없이 create_all + 경량 마이그레이션으로 운영하는데,
 * create_all 은 이미 있는 테이블의 컬럼/제약을 바꾸지 않는다. 그래서 오래된 DB 는
 * 모델과 조금씩 어긋난 채 남고, 그 어긋남은 해당 컬럼을 쓰는 기능에서만 500 으로
 * 드러난다. 서버 로그를 뒤지는 대신 여기서 바로 확인·복구한다.
 */
export function SchemaHealthPanel() {
  const toast = useToast();
  const qc = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lastResult, setLastResult] = useState<SchemaRepairResult | null>(null);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['schemaHealth'],
    queryFn: async () => (await schemaHealthApi.get()).data,
  });

  const repairMut = useMutation({
    mutationFn: (dryRun: boolean) => schemaHealthApi.repair(dryRun).then((r) => r.data),
    onSuccess: (res) => {
      setLastResult(res);
      if (!res.dryRun) qc.invalidateQueries({ queryKey: ['schemaHealth'] });
    },
  });

  const runRepair = async (dryRun: boolean) => {
    try {
      const res = await repairMut.mutateAsync(dryRun);
      if (dryRun) {
        toast.info('실행 계획만 확인했습니다.', `${res.applied.length}건이 실행 대상입니다.`);
      } else if (res.errors.length) {
        toast.warning(
          `${res.applied.length}건 복구, ${res.errors.length}건 실패`,
          '실패 항목은 아래 결과에서 확인하세요.',
        );
      } else {
        toast.success(`${res.applied.length}건을 복구했습니다.`, `남은 드리프트 ${res.remaining ?? 0}건`);
      }
    } catch (e) {
      toast.error('스키마 복구 실패', formatApiError(e));
    } finally {
      setConfirmOpen(false);
    }
  };

  const repairable = (data?.issues ?? []).filter((i) => i.repairable).length;

  return (
    <div className="space-y-3">
      <MacCard title="스키마 점검 (모델 ↔ DB)">
        <p className="text-xs text-muted-foreground mb-3">
          코드의 모델 정의와 실제 데이터베이스를 비교합니다. 이 프로젝트는 이미 존재하는 테이블의
          컬럼·제약을 자동으로 바꾸지 않기 때문에, 오래 운영된 DB 는 모델과 어긋날 수 있고 그
          어긋남은 해당 컬럼을 쓰는 기능에서만 오류로 드러납니다.
        </p>

        {isLoading ? (
          <div className="space-y-2"><Skeleton height={20} /><Skeleton height={20} /></div>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">점검 결과를 불러오지 못했습니다.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 mb-3">
              {data.healthy ? (
                <span className="inline-flex items-center gap-1.5 text-sm text-status-healthy font-medium">
                  <ShieldCheck className="w-4 h-4" /> 모델과 DB 가 일치합니다
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-sm text-status-critical font-medium">
                  <AlertTriangle className="w-4 h-4" /> 드리프트 {data.issueCount}건
                </span>
              )}
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Database className="w-3.5 h-3.5" />
                테이블 {data.checkedTables} · 컬럼 {data.checkedColumns} 검사
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  onClick={() => refetch()}
                  disabled={isFetching}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-xl border border-border hover:bg-secondary disabled:opacity-50"
                  title="다시 점검"
                  aria-label="다시 점검"
                >
                  {isFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  다시 점검
                </button>
                {repairable > 0 && (
                  <>
                    <button
                      onClick={() => runRepair(true)}
                      disabled={repairMut.isPending}
                      className="px-2.5 py-1.5 text-xs rounded-xl border border-border hover:bg-secondary disabled:opacity-50"
                    >
                      실행 계획 보기
                    </button>
                    <button
                      onClick={() => setConfirmOpen(true)}
                      disabled={repairMut.isPending}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50"
                    >
                      <Wrench className="w-3.5 h-3.5" /> {repairable}건 복구
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* 부팅 자동 복구 결과 — "재시작하면 자동으로 고쳐진다"가 실제로 지켜졌는지.
                실패했다면(주로 DDL 락 경합) 조용히 넘어가지 않고 여기서 사유를 보여준다. */}
            {data.bootRepair?.ran && (
              <div className="mb-3 text-xs">
                {(data.bootRepair.failures?.length ?? 0) > 0 ? (
                  <div className="rounded-md border border-status-critical/40 bg-status-critical-soft p-2.5 space-y-1">
                    <p className="font-medium text-status-critical">
                      부팅 시 자동 복구가 일부 실패했습니다 — 아래 &quot;복구&quot; 버튼으로 다시 시도하세요.
                    </p>
                    {data.bootRepair.failures!.map((f) => (
                      <p key={f.target} className="text-muted-foreground break-all">
                        <span className="font-mono">{f.target}</span> — {f.error}
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground">
                    최근 부팅 시 자동 복구 완료 — NOT NULL {data.bootRepair.relaxed ?? 0}건 완화
                    {(data.bootRepair.detected?.length ?? 0) > 0 && (
                      <span className="font-mono"> ({data.bootRepair.detected!.join(', ')})</span>
                    )}
                  </p>
                )}
              </div>
            )}

            {data.issues.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b border-border">
                      <th className="py-1.5 pr-3 font-medium">유형</th>
                      <th className="py-1.5 pr-3 font-medium">테이블 · 컬럼</th>
                      <th className="py-1.5 pr-3 font-medium">설명</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.issues.map((i, idx) => {
                      const meta = KIND_META[i.kind] ?? KIND_META.inspect_failed;
                      return (
                        <tr key={`${i.table}.${i.column}.${idx}`} className="border-b border-border/60">
                          <td className="py-1.5 pr-3 align-top">
                            <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium whitespace-nowrap ${meta.cls}`}>
                              {meta.label}
                            </span>
                          </td>
                          <td className="py-1.5 pr-3 align-top font-mono text-xs whitespace-nowrap">
                            {i.table}{i.column ? `.${i.column}` : ''}
                          </td>
                          <td className="py-1.5 pr-3 align-top text-xs text-muted-foreground">
                            {i.detail}
                            {!i.repairable && (
                              <span className="ml-1 text-status-warning">— 자동 복구 대상 아님</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <p className="flex items-start gap-2 text-[11px] text-muted-foreground mt-3">
              <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>
                복구는 <b>컬럼 추가(항상 NULL 허용)</b> 와 <b>레거시 NOT NULL 해제</b>만 합니다 —
                컬럼 삭제·타입 변경처럼 데이터를 잃을 수 있는 작업은 하지 않습니다. NOT NULL
                드리프트는 백엔드 재시작 시에도 자동으로 완화됩니다.
              </span>
            </p>
          </>
        )}
      </MacCard>

      {lastResult && (
        <MacCard title={lastResult.dryRun ? '실행 계획 (미실행)' : '복구 결과'}>
          <LogViewer
            text={[
              ...lastResult.applied.map((a) => `${lastResult.dryRun ? '[계획] ' : '[적용] '}${a.sql}`),
              ...lastResult.skipped.map((s) => `[건너뜀] ${s.table}${s.column ? `.${s.column}` : ''} — ${s.reason ?? ''}`),
              ...lastResult.errors.map((e) => `[실패] ${e.sql} — ${e.error ?? ''}`),
            ].join('\n') || '해당 항목이 없습니다.'}
            maxHeight="max-h-64"
            asError={lastResult.errors.length > 0}
          />
        </MacCard>
      )}

      {confirmOpen && (
        <ConfirmDialog
          open={confirmOpen}
          title="스키마 복구"
          description={`${repairable}건의 드리프트를 복구합니다. 컬럼 추가(NULL 허용)와 NOT NULL 해제만 수행하며 데이터는 삭제되지 않습니다.`}
          confirmLabel="복구"
          onConfirm={() => runRepair(false)}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}
