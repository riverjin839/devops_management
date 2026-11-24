// 맵 용량 — 노드 × 맵 사용률 히트맵 + 선택한 칸의 상세(맵 정보·사용률 막대·설정 추천).
// 정상은 중립색, 주의·위험만 상태색(DESIGN_SYSTEM §12.12-3). 판정 기준(임계치)은 서버 설정을 그대로 표시한다.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Binary, Grid3x3 } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { SegTabs, StatusBadge } from '@/components/common';
import type { CiliumBpfAgent, CiliumBpfMap, CiliumDatapathView, CiliumMapLevel } from '@/types';

type ColumnFilter = 'known' | 'all';

const LEVEL_TEXT: Record<CiliumMapLevel, string> = { critical: '위험', warning: '주의', ok: '정상', unknown: '세지 못함' };

function cellCls(level: CiliumMapLevel, selected: boolean): string {
  const base = 'w-full min-w-[64px] h-9 rounded-md text-xs font-medium tabular-nums border focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const ring = selected ? ' ring-2 ring-primary ring-offset-1 ring-offset-card' : '';
  if (level === 'critical') return `${base} bg-status-critical/10 border-status-critical/40 text-status-critical${ring}`;
  if (level === 'warning') return `${base} bg-status-warning/15 border-status-warning/40 text-status-warning${ring}`;
  if (level === 'unknown') return `${base} bg-transparent border-dashed border-border text-muted-foreground${ring}`;
  return `${base} bg-secondary border-transparent text-foreground hover:bg-muted${ring}`;
}

function cellText(m: CiliumBpfMap | undefined): string {
  if (!m) return '';
  if (m.pct === null) return '—';
  return `${m.partial ? '≥' : ''}${m.pct}%`;
}

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('ko-KR'));

function worst(agents: CiliumBpfAgent[]): { node: string; group: string } | null {
  let best: { node: string; group: string; pct: number } | null = null;
  for (const a of agents) {
    for (const m of a.maps) {
      const pct = m.pct ?? -1;
      if (!best || pct > best.pct) best = { node: a.node, group: m.group, pct };
    }
  }
  return best ? { node: best.node, group: best.group } : null;
}

function Detail({ agent, map, clusterId, warnPct, critPct }: {
  agent: CiliumBpfAgent; map: CiliumBpfMap; clusterId: string; warnPct: number; critPct: number;
}) {
  const barCls = map.level === 'critical' ? 'bg-status-critical' : map.level === 'warning' ? 'bg-status-warning' : 'bg-muted-foreground';
  const badge = map.level === 'critical' || map.level === 'warning'
    ? <StatusBadge variant={map.level} label={LEVEL_TEXT[map.level]} size="sm" />
    : <span className="text-xs text-muted-foreground">{LEVEL_TEXT[map.level]}</span>;
  return (
    <MacCard title={`${agent.node} · ${map.label}`} icon={Binary} actions={badge}>
      <dl className="grid grid-cols-[104px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted-foreground">맵</dt>
        <dd className="font-mono text-xs break-all">{map.name}{map.pinned ? '' : ' (고정 안 됨 — 이름 15자에서 잘림)'}</dd>
        <dt className="text-muted-foreground">유형</dt>
        <dd>{map.mapType} · 키 {map.keySize}B · 값 {map.valueSize}B</dd>
        <dt className="text-muted-foreground">항목 / 최대</dt>
        <dd className="tabular-nums">{map.partial ? '≥ ' : ''}{fmt(map.entries)} / {fmt(map.maxEntries)}</dd>
        <dt className="text-muted-foreground">사용률</dt>
        <dd className="tabular-nums font-semibold">{map.pct === null ? '—' : `${map.partial ? '≥ ' : ''}${map.pct}%`}</dd>
        <dt className="text-muted-foreground">집계</dt>
        <dd>
          키 순회 {map.elapsedMs}ms
          {map.partial && <span className="block text-xs text-status-warning">시간 예산을 넘겨 끝까지 세지 못함 — 위 값은 하한</span>}
        </dd>
        {map.members > 1 && (
          <>
            <dt className="text-muted-foreground">그룹</dt>
            <dd>{map.group}_* {map.members}개 중 가장 찬 맵</dd>
          </>
        )}
        {map.error && (
          <>
            <dt className="text-muted-foreground">오류</dt>
            <dd className="text-status-critical text-xs break-all">{map.error}</dd>
          </>
        )}
      </dl>
      {map.pct !== null && (
        <div className="mt-3 h-2 rounded bg-secondary overflow-hidden" role="img" aria-label={`사용률 ${map.pct}%`}>
          <div className={`h-full ${barCls}`} style={{ width: `${Math.min(100, map.pct)}%` }} />
        </div>
      )}
      <p className="mt-2 text-xs text-muted-foreground">판정 기준: 주의 {warnPct}% · 위험 {critPct}% (에이전트 설치 탭 ▸ 설정)</p>
      {map.note && <p className="mt-2 text-xs text-foreground leading-relaxed">{map.note}</p>}
      {map.recommendation ? (
        <div className="mt-3 rounded-md bg-muted/40 p-3 space-y-2">
          <p className="text-xs font-medium text-muted-foreground">설정 추천</p>
          <p className="text-xs break-words leading-relaxed">{map.recommendation}</p>
          <Link to={`/k8s/${clusterId}/services`} className="inline-flex text-sm text-primary hover:underline">
            서비스 구성 ▸ Cilium 에서 편집
          </Link>
        </div>
      ) : map.level === 'ok' ? (
        <p className="mt-3 text-xs text-muted-foreground">임계치 아래입니다.</p>
      ) : null}
    </MacCard>
  );
}

export function CiliumMapPressureView({ view, clusterId }: { view: CiliumDatapathView; clusterId: string }) {
  const [filter, setFilter] = useState<ColumnFilter>('known');
  const [picked, setPicked] = useState<{ node: string; group: string } | null>(null);
  const agents = view.agents;
  const hasUnknown = view.columns.some((c) => !c.known);
  const columns = filter === 'known' && view.columns.some((c) => c.known)
    ? view.columns.filter((c) => c.known)
    : view.columns;
  const byNode = useMemo(() => new Map(agents.map((a) => [a.node, new Map(a.maps.map((m) => [m.group, m]))])), [agents]);
  const sel = picked ?? worst(agents);
  const selAgent = sel ? agents.find((a) => a.node === sel.node) : undefined;
  const selMap = sel ? byNode.get(sel.node)?.get(sel.group) : undefined;
  const { warnPct, critPct } = view.settings;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-4 items-start">
      <MacCard
        title="노드 × 맵 사용률"
        icon={Grid3x3}
        titleExtra={(
          <span className="text-xs text-muted-foreground">
            위험 <span className={view.summary.critical ? 'text-status-critical font-semibold' : ''}>{view.summary.critical}</span>
            {' · '}주의 <span className={view.summary.warning ? 'text-status-warning font-semibold' : ''}>{view.summary.warning}</span>
          </span>
        )}
        actions={hasUnknown ? (
          <SegTabs label="표시할 맵" value={filter} onChange={setFilter}
            options={[['known', '주요 맵'], ['all', `전체 ${view.columns.length}종`]] as const} />
        ) : undefined}
        bodyPadding="p-0"
      >
        <div className="overflow-x-auto p-3">
          <table className="w-full border-separate border-spacing-1 text-xs">
            <thead>
              <tr>
                <th scope="col" className="text-left font-medium text-muted-foreground px-1.5 py-1">노드</th>
                {columns.map((c) => (
                  <th key={c.group} scope="col" title={c.group} className="font-medium text-muted-foreground px-1 py-1 whitespace-nowrap">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id}>
                  <th scope="row" className="text-left font-medium font-mono px-1.5 whitespace-nowrap">
                    {a.node}
                    {a.state !== 'reporting' && <span className="ml-1 font-sans text-status-critical">무응답</span>}
                  </th>
                  {columns.map((c) => {
                    const m = byNode.get(a.node)?.get(c.group);
                    if (!m) return <td key={c.group} className="text-center text-muted-foreground" aria-label={`${a.node} ${c.label} 없음`}>·</td>;
                    const isSel = sel?.node === a.node && sel?.group === c.group;
                    return (
                      <td key={c.group} className="p-0">
                        <button type="button" className={`${cellCls(m.level, isSel)} ${m.partial ? 'italic' : ''}`}
                          aria-pressed={isSel}
                          aria-label={`${a.node} ${c.label} 사용률 ${m.pct === null ? '알 수 없음' : `${m.pct}%`} ${LEVEL_TEXT[m.level]}`}
                          title={`${m.name} · ${fmt(m.entries)} / ${fmt(m.maxEntries)}`}
                          onClick={() => setPicked({ node: a.node, group: c.group })}>
                          {cellText(m)}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><span className="w-3.5 h-3.5 rounded bg-secondary" aria-hidden />정상 ({warnPct}% 미만)</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-3.5 h-3.5 rounded bg-status-warning/15 border border-status-warning/40" aria-hidden />주의 ({warnPct}–{critPct - 1}%)</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-3.5 h-3.5 rounded bg-status-critical/10 border border-status-critical/40" aria-hidden />위험 ({critPct}% 이상)</span>
          <span><span className="italic">≥ 기울임</span> = 시간 예산 초과로 일부만 셈(하한)</span>
          <span>· = 그 노드에 없는 맵</span>
        </div>
      </MacCard>
      {selAgent && selMap
        ? <Detail agent={selAgent} map={selMap} clusterId={clusterId} warnPct={warnPct} critPct={critPct} />
        : <MacCard title="상세" icon={Binary}><p className="text-sm text-muted-foreground">칸을 누르면 맵 상세가 여기에 나온다.</p></MacCard>}
    </div>
  );
}
