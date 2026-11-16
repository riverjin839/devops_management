// DC 인벤토리 ▸ 기존 데이터 연결 — 노드 서버스펙·인프라 토폴로지 행을 DC 인벤토리 장비(단일 원본)에 잇는다.
// 미리보기로 4종(바로 연결 · 장비 생성 · 값이 다름 · 호스트명 중복)을 보여주고, 고른 호스트명만 적용한다.
// 값이 다르면 어느 쪽 값을 쓸지 행마다 고른다(자동 덮어쓰기 없음). 적용은 admin 전용 + 실시간 로그.
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link2, RefreshCw } from 'lucide-react';
import { EmptyState, ErrorState, LoadingState, RunLogPanel, SegTabs, useToast } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { dcKeys, useDcLinkPreview } from '@/hooks/useDcInventory';
import { useLogPref } from '@/hooks/useLogPref';
import { applyRunEvent, useRunLog } from '@/hooks/useRunLog';
import { postSse } from '@/lib/sse';
import { camelizeKeys, dcApi } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { DcLinkCategory, DcLinkItem, DcLinkResult } from '@/types';
import { BTN, BTN_PRIMARY, TD, TH, fmt } from './shared';

const CATEGORY_LABEL: Record<DcLinkCategory, string> = {
  linkable: '바로 연결', create: '장비 생성 후 연결', mismatch: '값이 다름', duplicate_hostname: '호스트명 중복',
};
const CATEGORY_HELP: Record<DcLinkCategory, string> = {
  linkable: '같은 호스트명의 장비가 있고 값이 어긋나지 않습니다.',
  create: 'DC 인벤토리에 장비가 없습니다 — 기존 값으로 장비를 만들고 연결합니다(랙 미배정으로 시작할 수 있음).',
  mismatch: '장비는 있는데 시리얼·랙·U 가 서로 다릅니다. 어느 쪽 값을 쓸지 고르세요.',
  duplicate_hostname: '같은 호스트명이 여러 클러스터에 있어 자동으로 묶지 않습니다. 호스트명을 정리한 뒤 다시 시도하세요.',
};
const ORDER: DcLinkCategory[] = ['mismatch', 'create', 'linkable', 'duplicate_hostname'];

export function DcLinkPanel() {
  const toast = useToast();
  const qc = useQueryClient();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('dc-inventory-link');
  const query = useDcLinkPreview(true);
  const [category, setCategory] = useState<DcLinkCategory>('mismatch');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [prefer, setPrefer] = useState<Record<string, 'existing' | 'device'>>({});

  const items = useMemo(() => query.data?.items ?? [], [query.data]);
  const counts = query.data?.counts;
  useEffect(() => {
    // 처음 열었을 때 건수가 있는 첫 분류를 보여준다.
    if (!counts) return;
    setCategory((cur) => (counts[cur] > 0 ? cur : ORDER.find((c) => counts[c] > 0) ?? cur));
  }, [counts]);

  const visible = items.filter((i) => i.category === category);
  const selectable = category !== 'duplicate_hostname';
  const allPicked = visible.length > 0 && visible.every((i) => picked.has(i.hostname));
  const pickedHere = visible.filter((i) => picked.has(i.hostname));

  const toggle = (hostname: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(hostname)) next.delete(hostname); else next.add(hostname);
    return next;
  });
  const toggleAll = () => setPicked((prev) => {
    const next = new Set(prev);
    for (const i of visible) { if (allPicked) next.delete(i.hostname); else next.add(i.hostname); }
    return next;
  });

  const apply = async () => {
    const targets = items.filter((i) => picked.has(i.hostname) && i.category !== 'duplicate_hostname');
    if (targets.length === 0) return;
    const run = runLog.begin('기존 데이터 연결', `${fmt(targets.length)}건 연결 요청`);
    let error: string | null = null;
    let result: DcLinkResult | null = null;
    try {
      await postSse(dcApi.linkApplyStreamUrl, {
        items: targets.map((i: DcLinkItem) => ({
          hostname: i.hostname, action: 'link', prefer: prefer[i.hostname] ?? i.defaultPrefer,
        })),
      }, (evt) => {
        if (evt.type === 'result') result = camelizeKeys<DcLinkResult>(evt.result);
        else if (evt.type === 'error') error = String(evt.message ?? '연결 실패');
        else applyRunEvent(run, evt);
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const final = result as DcLinkResult | null;
    if (error) {
      run.log('error', error);
      toast.error('연결 실패', error);
    } else if (final) {
      if (final.failed > 0) toast.error('일부만 연결했습니다', `연결 ${fmt(final.linked)}건 · 실패 ${fmt(final.failed)}건 — 로그에서 사유를 확인하세요.`);
      else toast.success('연결 완료', `${fmt(final.linked)}건`);
    }
    setPicked(new Set());
    void qc.invalidateQueries({ queryKey: dcKeys.all });
    run.end();
  };

  if (query.isLoading) return <LoadingState label="연결 대상을 찾는 중" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  return (
    <div className="space-y-4">
      <MacCard
        title="기존 데이터 연결"
        icon={Link2}
        description={`연결됨 ${fmt(query.data?.linked ?? 0)}건 · 남음 ${fmt(items.length)}건`}
        actions={(
          <button type="button" className={BTN} onClick={() => void query.refetch()} disabled={query.isFetching || runLog.running}>
            <RefreshCw className={`w-4 h-4 ${query.isFetching ? 'animate-spin' : ''}`} aria-hidden /> 다시 찾기
          </button>
        )}
        bodyPadding="p-0"
      >
        {items.length === 0 ? (
          <EmptyState icon={Link2} title="연결할 기존 데이터가 없습니다"
            description="노드 서버스펙·인프라 토폴로지의 모든 서버가 DC 인벤토리 장비에 연결돼 있습니다. 앞으로 그 화면들에서 서버를 등록하면 자동으로 연결됩니다." />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border">
              <SegTabs<DcLinkCategory>
                label="분류" mode="tabs" size="md" value={category} onChange={setCategory}
                options={ORDER.map((c) => [c, `${CATEGORY_LABEL[c]} ${fmt(counts?.[c] ?? 0)}`] as const)}
              />
              <button type="button" className={BTN_PRIMARY}
                disabled={!isAdmin || picked.size === 0 || runLog.running}
                title={isAdmin ? '고른 호스트명만 연결합니다' : 'admin 권한이 필요합니다'}
                aria-label={isAdmin ? `${fmt(picked.size)}건 연결` : `${fmt(picked.size)}건 연결 — admin 권한이 필요합니다`}
                onClick={() => void apply()}>
                {fmt(picked.size)}건 연결
              </button>
            </div>
            <p className="px-4 py-2 text-sm text-muted-foreground border-b border-border">{CATEGORY_HELP[category]}</p>
            {visible.length === 0 ? (
              <EmptyState compact icon={Link2} title="이 분류에 해당하는 서버가 없습니다" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse min-w-[760px]">
                  <thead>
                    <tr>
                      <th className={`${TH} w-10`}>
                        {selectable && (
                          <input type="checkbox" className="w-4 h-4" checked={allPicked} onChange={toggleAll}
                            aria-label={`${CATEGORY_LABEL[category]} 전체 선택 (${fmt(pickedHere.length)}/${fmt(visible.length)})`} />
                        )}
                      </th>
                      <th className={TH}>호스트명</th>
                      <th className={TH}>클러스터</th>
                      <th className={TH}>기존 값 (시리얼 · 랙 · U)</th>
                      <th className={TH}>{category === 'mismatch' ? '다른 값과 선택' : '출처'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((i) => (
                      <tr key={i.hostname}>
                        <td className={TD}>
                          {selectable && (
                            <input type="checkbox" className="w-4 h-4" checked={picked.has(i.hostname)}
                              onChange={() => toggle(i.hostname)} aria-label={`${i.hostname} 선택`} />
                          )}
                        </td>
                        <td className={`${TD} font-medium whitespace-nowrap`}>{i.hostname}</td>
                        <td className={`${TD} whitespace-nowrap`}>{i.clusters.join(', ') || <span className="text-muted-foreground">—</span>}</td>
                        <td className={`${TD} whitespace-nowrap`}>
                          {[i.existing.serial, i.existing.rack, i.existing.rackUnit].filter(Boolean).join(' · ')
                            || <span className="text-muted-foreground">값 없음</span>}
                        </td>
                        <td className={TD}>
                          {category === 'mismatch' ? (
                            <div className="space-y-1.5">
                              <ul className="text-sm">
                                {i.diffs.map((d) => (
                                  <li key={d.field}>
                                    {d.field}: 기존 <span className="font-mono text-xs">{d.existing}</span> ↔ 장비 <span className="font-mono text-xs">{d.device}</span>
                                  </li>
                                ))}
                              </ul>
                              <SegTabs<'existing' | 'device'>
                                label={`${i.hostname} 에 쓸 값`}
                                value={prefer[i.hostname] ?? i.defaultPrefer}
                                onChange={(v) => setPrefer((prev) => ({ ...prev, [i.hostname]: v }))}
                                options={[['existing', '기존 값 사용'], ['device', '장비 값 사용']]}
                              />
                            </div>
                          ) : (
                            <span className="text-sm text-muted-foreground">
                              {[i.specCount > 0 && `서버스펙 ${i.specCount}`, i.infraNodeCount > 0 && `인프라 노드 ${i.infraNodeCount}`]
                                .filter(Boolean).join(' · ')}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </MacCard>
      <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-64" />
    </div>
  );
}
