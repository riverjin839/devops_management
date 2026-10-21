// 네임스페이스 비효율 랭킹 표 — NS 별 당일 CPU/메모리(GPU 예정) request·limit·사용량(평균/최소/최대)·사용률.
import type { ReactNode } from 'react';
import { OwnerLine } from '@/components/public-pages/OwnerLine';
import { cn } from '@/lib/utils';
import type { DailyReportItem, DailyReportRankBy, DailyReportResource, DailyReportSearchItem } from '@/types';
import { DASH, cores, gi, pct, rateCls } from './format';

const TH = 'px-2 py-1.5 font-medium text-muted-foreground whitespace-nowrap';
const TD = 'px-2 py-1.5 whitespace-nowrap tabular-nums text-right';
const GROUP_BORDER = 'border-l border-border';

function ResourceCells({ r, fmt, rankBy, res }: {
  r: DailyReportResource; fmt: (v: number | null) => string; rankBy: DailyReportRankBy; res: 'cpu' | 'mem';
}) {
  const rateActive = rankBy === `${res}_rate`;
  const slackActive = rankBy === `${res}_slack`;
  return (
    <>
      <td className={cn(TD, GROUP_BORDER)}>{fmt(r.req)}</td>
      <td className={TD}>{r.lim > 0 ? fmt(r.lim) : DASH}</td>
      <td className={cn(TD, slackActive && 'font-semibold')}>{fmt(r.useAvg)}</td>
      <td className={cn(TD, 'text-muted-foreground')}>{fmt(r.useMin)}</td>
      <td className={cn(TD, 'text-muted-foreground')}>{fmt(r.useMax)}</td>
      <td className={cn(TD, rateCls(r.rateAvg), rateActive && 'underline underline-offset-4')}>{pct(r.rateAvg)}</td>
      <td className={cn(TD, 'text-muted-foreground')}>
        {r.rateMin == null ? DASH : `${pct(r.rateMin)} ~ ${pct(r.rateMax)}`}
      </td>
      <td className={cn(TD, slackActive && 'font-semibold')}>{fmt(r.slack)}</td>
    </>
  );
}

function GroupHead({ label, span, note }: { label: string; span: number; note?: ReactNode }) {
  return (
    <th colSpan={span} className={cn(TH, GROUP_BORDER, 'text-center text-foreground')}>
      {label}{note && <span className="ml-1 font-normal text-muted-foreground">{note}</span>}
    </th>
  );
}

const SUB_HEADS = ['Request', 'Limit', '평균 사용', '최소', '최대', '평균 사용률', '사용률 범위', '유휴량'];

/** 검색 결과면 NS 아래에 걸린 워크로드/파드를 보여준다(본인 모듈 확인용). */
function MatchLine({ match }: { match: DailyReportSearchItem['match'] }) {
  if (match.workloads.length === 0) return null;
  return (
    <ul className="mt-0.5 space-y-0.5 font-sans text-xs text-muted-foreground whitespace-normal">
      {match.workloads.map((w) => (
        <li key={`${w.kind}/${w.name}`}>
          <span className="text-foreground">{w.kind}/{w.name}</span>
          {w.pods.length > 0 && (
            <span className="block font-mono break-all">
              {w.pods.join(', ')}{w.podMatches > w.pods.length ? ` 외 ${w.podMatches - w.pods.length}` : ''}
            </span>
          )}
        </li>
      ))}
      {match.workloadMatches > match.workloads.length && (
        <li>워크로드 {match.workloadMatches - match.workloads.length}개 더</li>
      )}
    </ul>
  );
}

type Row = DailyReportItem | DailyReportSearchItem;
const hasMatch = (it: Row): it is DailyReportSearchItem => 'match' in it;

export function DailyReportTable({ items, rankBy }: { items: Row[]; rankBy: DailyReportRankBy }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-border">
          <tr>
            <th rowSpan={2} className={cn(TH, 'text-right')}>순위</th>
            <th rowSpan={2} className={cn(TH, 'text-left')}>네임스페이스</th>
            <th rowSpan={2} className={cn(TH, 'text-right')} title="당일 평균 파드 수">파드</th>
            <GroupHead label="CPU" span={SUB_HEADS.length} />
            <GroupHead label="메모리" span={SUB_HEADS.length} />
            <GroupHead label="GPU" span={2} note="(예정)" />
          </tr>
          <tr>
            {SUB_HEADS.map((h, i) => (
              <th key={`c-${h}`} className={cn(TH, 'text-right', i === 0 && GROUP_BORDER)}>{h}</th>
            ))}
            {SUB_HEADS.map((h, i) => (
              <th key={`m-${h}`} className={cn(TH, 'text-right', i === 0 && GROUP_BORDER)}>{h}</th>
            ))}
            <th className={cn(TH, 'text-right', GROUP_BORDER)}>Request</th>
            <th className={cn(TH, 'text-right')}>Limit</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.namespace} className="border-b border-border last:border-0 hover:bg-secondary/50">
              <td className={cn(TD, 'text-muted-foreground align-top')}
                title={it.rank == null ? '랭킹 대상 아님(사용량 미수집·최소 request 미만·시스템 NS)' : undefined}>
                {it.rank ?? DASH}
              </td>
              <td className={cn('px-2 py-1.5 font-mono text-foreground align-top', hasMatch(it) ? 'min-w-[22rem]' : 'whitespace-nowrap')}
                title={`샘플 ${it.samples}개 (사용량 ${it.usageSamples}개)`}>
                {it.namespace}
                <OwnerLine owner={it.owner} />
                {hasMatch(it) && <MatchLine match={it.match} />}
              </td>
              <td className={TD}>{it.pods == null ? DASH : it.pods}</td>
              <ResourceCells r={it.cpu} fmt={cores} rankBy={rankBy} res="cpu" />
              <ResourceCells r={it.mem} fmt={gi} rankBy={rankBy} res="mem" />
              <td className={cn(TD, GROUP_BORDER, 'text-muted-foreground')}>{it.gpu.req ?? DASH}</td>
              <td className={cn(TD, 'text-muted-foreground')}>{it.gpu.lim ?? DASH}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
