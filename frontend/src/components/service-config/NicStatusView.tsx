// 서비스 구성 ▸ NIC — 노드 파라미터 에이전트(1.2.0+)가 보고한 인터페이스 상태(읽기 전용).
// 경고(본딩/LACP·링크·MTU·ring buffer·드롭·CRC·offload, 노드 간 값 차이) + 노드 × 인터페이스 표. 행을 펼치면 전체 offload·카운터·본딩 하위 상태.
// 정상은 중립색, 상태색은 비정상에만(DESIGN_SYSTEM §12.12). 판정 기준은 설정 대화상자(admin)에서 고친다(UI-First).
import { Fragment, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, Network, Settings2 } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, InfoHint, LoadingState, StatusBadge } from '@/components/common';
import { useNicWatch } from '@/hooks/useNicWatch';
import { formatRelativeTime } from '@/lib/utils';
import type { NicFinding, NicInterfaceRow, NicLevel } from '@/types';
import { NicSettingsDialog } from './NicSettingsDialog';

const TH = 'text-left px-3 py-2 text-xs font-medium text-muted-foreground border-b border-border whitespace-nowrap';
const TD = 'px-3 py-2 border-b border-border align-top text-sm';
const INPUT = 'px-2 py-1 text-sm rounded-xl border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary';

const KIND_LABEL: Record<string, string> = { physical: '물리', bond: '본딩', vlan: 'VLAN', tunnel: '터널', bridge: '브리지', virtual: '가상' };
const LEVEL_LABEL: Record<Exclude<NicLevel, 'ok'>, string> = { critical: '위험', warning: '확인 필요', info: '참고' };
/** 표의 offload 짧은 이름. */
const OFFLOAD_SHORT: Record<string, string> = {
  'rx-checksum': 'RX csum', 'tx-checksum-ip-generic': 'TX csum', 'tx-tcp-segmentation': 'TSO', 'rx-gro': 'GRO',
  'rx-lro': 'LRO', 'tx-udp_tnl-segmentation': '터널 TSO',
};

function speedText(mbps: number | null): string {
  if (!mbps) return '-';
  return mbps >= 1000 ? `${mbps % 1000 === 0 ? mbps / 1000 : (mbps / 1000).toFixed(1)}G` : `${mbps}M`;
}

function levelBadge(level: NicLevel) {
  if (level === 'ok') return null;
  return <StatusBadge variant={level} label={LEVEL_LABEL[level]} />;
}

function FindingItem({ f }: { f: NicFinding }) {
  return (
    <li className="px-3 py-2 border-b border-border last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        {levelBadge(f.level)}
        <span className="text-xs text-muted-foreground">{f.node}{f.iface ? <> · <span className="font-mono">{f.iface}</span></> : null}</span>
        <span className="text-sm font-medium text-foreground">{f.title}</span>
      </div>
      {f.detail && <p className="mt-1 text-xs text-foreground break-words">{f.detail}</p>}
      {f.hint && <p className="mt-0.5 text-xs text-muted-foreground break-words">{f.hint}</p>}
    </li>
  );
}

function BondCell({ r }: { r: NicInterfaceRow }) {
  if (r.bond) {
    const b = r.bond;
    return (
      <div className="text-xs space-y-0.5">
        <div className="font-mono text-foreground">{[b.mode, b.xmitHashPolicy, b.mode === '802.3ad' ? b.lacpRate : null].filter(Boolean).join(' · ') || '-'}</div>
        {b.active.aggregatorId != null && (
          <div className="text-muted-foreground">Aggregator {b.active.aggregatorId} · {b.active.ports ?? '?'}/{b.slaves.length} 포트</div>
        )}
      </div>
    );
  }
  if (r.lacp) {
    return (
      <div className="text-xs space-y-0.5 text-muted-foreground">
        {r.lacp.aggregatorId != null && <div>Aggregator {r.lacp.aggregatorId}</div>}
        {r.lacp.partnerMac && <div className="font-mono" title="LACP 상대(스위치) 시스템 MAC">{r.lacp.partnerMac}</div>}
      </div>
    );
  }
  return <span className="text-muted-foreground">-</span>;
}

function RingCell({ r }: { r: NicInterfaceRow }) {
  if (!r.ring) return <span className="text-muted-foreground">-</span>;
  const { rx, rxMax, tx, txMax } = r.ring;
  return (
    <div className="text-xs font-mono tabular-nums whitespace-nowrap" title="현재 / 최대 (ethtool -g)">
      <div>RX {rx ?? '-'}<span className="text-muted-foreground">/{rxMax ?? '-'}</span></div>
      <div>TX {tx ?? '-'}<span className="text-muted-foreground">/{txMax ?? '-'}</span></div>
    </div>
  );
}

function RowDetail({ r }: { r: NicInterfaceRow }) {
  return (
    <div className="grid gap-3 md:grid-cols-3 text-xs">
      <div className="space-y-1">
        <p className="font-semibold text-foreground">드라이버</p>
        {r.driver ? (
          <ul className="space-y-0.5 text-muted-foreground">
            <li>드라이버 <span className="font-mono text-foreground">{r.driver.driver || '-'}</span> {r.driver.version}</li>
            <li>펌웨어 <span className="font-mono text-foreground">{r.driver.firmware || '-'}</span></li>
            <li>버스 <span className="font-mono">{r.driver.bus || '-'}</span></li>
            <li>autoneg {r.autoneg == null ? '-' : r.autoneg ? 'on' : 'off'}</li>
          </ul>
        ) : <p className="text-muted-foreground">정보 없음(가상 인터페이스·드라이버 미지원)</p>}
        {r.lowers.length > 0 && <p className="text-muted-foreground">하위: <span className="font-mono">{r.lowers.join(', ')}</span></p>}
        {r.bond && r.bond.slaveState.length > 0 && (
          <table className="w-full mt-2">
            <thead><tr><th className={TH}>하위</th><th className={TH}>MII</th><th className={TH}>속도</th><th className={TH}>Agg</th><th className={TH}>실패</th></tr></thead>
            <tbody>
              {r.bond.slaveState.map((s) => (
                <tr key={s.name}>
                  <td className="px-3 py-1 font-mono">{s.name}</td>
                  <td className={`px-3 py-1 ${s.miiStatus && s.miiStatus !== 'up' ? 'text-status-critical' : ''}`}>{s.miiStatus ?? '-'}</td>
                  <td className="px-3 py-1">{speedText(s.speed)}</td>
                  <td className="px-3 py-1">{s.aggregatorId ?? '-'}</td>
                  <td className="px-3 py-1 tabular-nums">{s.linkFailures ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="space-y-1">
        <p className="font-semibold text-foreground">offload <span className="font-normal text-muted-foreground">(ethtool -k)</span></p>
        {r.features.length === 0 ? <p className="text-muted-foreground">정보 없음</p> : (
          <ul className="space-y-0.5">
            {r.features.map((f) => (
              <li key={f.name} className="flex gap-2 font-mono">
                <span className="text-muted-foreground flex-1 truncate" title={f.name}>{f.label}</span>
                <span className="text-foreground">{f.on ? 'on' : 'off'}{f.fixed ? <span className="text-muted-foreground"> [fixed]</span> : null}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-1">
        <p className="font-semibold text-foreground">카운터 <span className="font-normal text-muted-foreground">(누적, drv: = ethtool -S)</span></p>
        {r.rates && (
          <p className="text-muted-foreground">최근 {r.rates.windowMinutes}분: 드롭 {r.rates.drops}{r.rates.dropCounter ? ` (${r.rates.dropCounter})` : ''} · CRC {r.rates.crc} · 끊김 {r.rates.flaps} · rx_dropped {r.rates.rxDropped}</p>
        )}
        <ul className="space-y-0.5 max-h-56 overflow-y-auto">
          {r.counters.map((c) => (
            <li key={c.name} className="flex gap-2 font-mono">
              <span className="text-muted-foreground flex-1 truncate" title={c.name}>{c.name}</span>
              <span className="tabular-nums text-foreground">{c.value.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function NicStatusView({ clusterId, isAdmin }: { clusterId: string; isAdmin: boolean }) {
  const navigate = useNavigate();
  const q = useNicWatch(clusterId);
  const data = q.data;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const findings = useMemo(() => (data?.findings ?? []).filter((f) => showInfo || f.level !== 'info'), [data, showInfo]);
  const rows = useMemo(() => {
    const s = query.trim().toLowerCase();
    return (data?.interfaces ?? []).filter((r) => (!kind || r.kind === kind)
      && (!onlyFlagged || r.level === 'critical' || r.level === 'warning')
      && (!s || r.node.toLowerCase().includes(s) || r.name.toLowerCase().includes(s)));
  }, [data, query, kind, onlyFlagged]);
  const latest = useMemo(() => (data?.nodes ?? []).reduce<string | null>((m, n) => (n.receivedAt && (!m || n.receivedAt > m) ? n.receivedAt : m), null), [data]);
  const toggle = (k: string) => setOpen((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  return (
    <div className="space-y-3 pb-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="inline-flex items-center gap-1 text-lg font-semibold text-foreground">
          NIC
          <InfoHint label="NIC 설명" side="bottom"
            text="노드 파라미터 에이전트(1.2.0 이상)가 보고 주기마다 읽는 인터페이스 상태 — 본딩/LACP, 링크 속도·MTU·끊김, ring buffer 와 드롭 카운터, offload. 읽기 전용이며 노드 설정은 바꾸지 않는다." />
        </h2>
        {data && (
          <span className="text-xs text-muted-foreground">
            노드 {data.summary.nodes}개{latest ? ` · 마지막 보고 ${formatRelativeTime(latest)}` : ''}
            {data.settings.enabled ? '' : ' · 수집 꺼짐'}
            {data.overridden.length > 0 ? ` · 이 클러스터 기준 ${data.overridden.length}개 재정의` : ''}
          </span>
        )}
        <div className="ml-auto">
          <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)} title="수집 대상·판정 기준" aria-label="NIC 설정">
            <Settings2 /> NIC 설정
          </Button>
        </div>
      </div>

      {q.isLoading && !data ? <LoadingState /> : q.isError ? (
        <ErrorState error={q.error} title="NIC 상태를 불러오지 못했습니다" onRetry={() => { void q.refetch(); }} />
      ) : !data ? null : data.nodes.length === 0 ? (
        <MacCard>
          <EmptyState icon={Network} title="NIC 상태를 보고한 노드가 없음"
            description={data.agentCount === 0
              ? '노드 파라미터 에이전트(1.2.0 이상)를 설치하면 보고 주기마다 인터페이스 상태가 들어온다.'
              : (data.pendingAgents[0]?.reason ?? '다음 보고를 기다리는 중')}
            action={{ label: '에이전트 설치 화면으로', onClick: () => navigate(`/k8s/${clusterId}/os-param-watch`) }} />
        </MacCard>
      ) : (
        <>
          {data.pendingAgents.length > 0 && (
            <MacCard title="NIC 를 보고하지 않는 노드" titleExtra={<span className="text-xs text-muted-foreground">{data.pendingAgents.length}개</span>}>
              <ul className="space-y-1 text-sm">
                {data.pendingAgents.map((a) => (
                  <li key={a.node}><span className="font-medium text-foreground">{a.node}</span> <span className="text-muted-foreground">— {a.reason}</span></li>
                ))}
              </ul>
            </MacCard>
          )}

          <MacCard title="경고" bodyPadding="p-0"
            titleExtra={<span className="text-xs text-muted-foreground">위험 {data.summary.critical} · 확인 필요 {data.summary.warning} · 참고 {data.summary.info}</span>}
            actions={(
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" checked={showInfo} onChange={(e) => setShowInfo(e.target.checked)} /> 참고 포함
              </label>
            )}>
            {findings.length === 0 ? <EmptyState compact title="경고 없음" /> : (
              <ul className="max-h-80 overflow-y-auto">{findings.map((f, i) => <FindingItem key={`${f.code}|${f.node}|${f.iface}|${i}`} f={f} />)}</ul>
            )}
          </MacCard>

          <MacCard title="인터페이스" bodyPadding="p-0"
            titleExtra={<span className="text-xs text-muted-foreground">{rows.length}개</span>}
            actions={(
              <div className="flex flex-wrap items-center gap-2">
                <input className={`${INPUT} w-40`} placeholder="노드·인터페이스" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="노드·인터페이스 검색" />
                <select className={INPUT} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="인터페이스 종류">
                  <option value="">전체 종류</option>
                  {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} /> 경고만
                </label>
              </div>
            )}>
            {rows.length === 0 ? <EmptyState compact title="조건에 맞는 인터페이스 없음" /> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1080px]">
                  <thead>
                    <tr>
                      <th className={TH}>노드</th><th className={TH}>인터페이스</th><th className={TH}>상태</th><th className={TH}>속도</th>
                      <th className={TH}>MTU</th><th className={TH}>본딩 / LACP</th><th className={TH}>Ring</th>
                      <th className={TH}>드롭/분</th><th className={TH}>CRC · 끊김</th><th className={TH}>offload</th><th className={TH}>판정</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const k = `${r.node}|${r.name}`;
                      const expanded = open.has(k);
                      const down = r.operstate === 'down' && r.level !== 'ok' && r.level !== 'info';
                      return (
                        <Fragment key={k}>
                          <tr className="hover:bg-secondary/50">
                            <td className={`${TD} text-xs whitespace-nowrap`}>{r.node}</td>
                            <td className={TD}>
                              <button type="button" onClick={() => toggle(k)} aria-expanded={expanded}
                                aria-label={`${r.node} ${r.name} 상세 ${expanded ? '접기' : '펼치기'}`}
                                className="inline-flex items-start gap-1 text-left rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                {expanded ? <ChevronDown className="w-4 h-4 mt-0.5 shrink-0" /> : <ChevronRight className="w-4 h-4 mt-0.5 shrink-0" />}
                                <span>
                                  <span className="font-mono text-foreground">{r.name}</span>
                                  <span className="block text-xs text-muted-foreground">
                                    {KIND_LABEL[r.kind] ?? r.kind}{r.vlanId != null ? ` ${r.vlanId}` : ''}{r.master ? ` · ${r.master} 하위` : ''}
                                    {r.driver?.driver ? ` · ${r.driver.driver}` : ''}
                                  </span>
                                </span>
                              </button>
                            </td>
                            <td className={`${TD} text-xs ${down ? 'text-status-critical' : ''}`}>{r.operstate ?? '-'}</td>
                            <td className={`${TD} text-xs whitespace-nowrap`}>{speedText(r.speed)}{r.duplex && r.duplex !== 'full' ? ` ${r.duplex}` : ''}</td>
                            <td className={`${TD} text-xs tabular-nums`}>{r.mtu ?? '-'}</td>
                            <td className={TD}><BondCell r={r} /></td>
                            <td className={TD}><RingCell r={r} /></td>
                            <td className={`${TD} text-xs tabular-nums`}>
                              {r.rates ? r.rates.dropsPerMin.toLocaleString() : <span className="text-muted-foreground" title="카운터 표본이 쌓이면 계산한다(최대 몇 분)">측정 중</span>}
                            </td>
                            <td className={`${TD} text-xs tabular-nums`}>{r.rates ? `${r.rates.crc} · ${r.rates.flaps}` : '-'}</td>
                            <td className={`${TD} text-xs`}>
                              {r.offload.length === 0 ? <span className="text-muted-foreground">-</span> : (
                                <span className="flex flex-wrap gap-x-2 gap-y-0.5">
                                  {r.offload.map((o) => (
                                    <span key={o.name} title={`${o.label} ${o.on ? 'on' : 'off'}`}
                                      className={o.on ? 'text-foreground' : 'text-muted-foreground line-through'}>{OFFLOAD_SHORT[o.name] ?? o.label}</span>
                                  ))}
                                </span>
                              )}
                            </td>
                            <td className={TD}>
                              {r.level === 'ok' || r.level === 'info' ? <span className="text-xs text-muted-foreground">{r.level === 'info' ? '참고' : '정상'}</span> : (
                                <span className="inline-flex items-center gap-1 whitespace-nowrap">{levelBadge(r.level)}<span className="text-xs text-muted-foreground">{r.findings.filter((f) => f.level !== 'info').length}</span></span>
                              )}
                            </td>
                          </tr>
                          {expanded && (
                            <tr>
                              <td colSpan={11} className="px-4 py-3 border-b border-border bg-secondary/30">
                                {r.findings.length > 0 && (
                                  <ul className="mb-3 rounded-md border border-border bg-card">{r.findings.map((f, i) => <FindingItem key={`${f.code}|${i}`} f={f} />)}</ul>
                                )}
                                <RowDetail r={r} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </MacCard>
        </>
      )}
      <NicSettingsDialog open={settingsOpen} isAdmin={isAdmin} clusterId={clusterId} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
