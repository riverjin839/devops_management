import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Route, Play, ArrowRight, Globe, Network, Share2, Server, Box,
  AlertTriangle, Info, Square, Activity, XCircle,
} from 'lucide-react';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import { useClusters } from '@/hooks/useCluster';
import { useTerminalEnvSync } from '@/hooks/useTerminalEnvSync';
import { useRunLog, runLogged, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { ClusterSidebar, DebugLogPanel, SelectClusterEmptyState, EmptyState, ErrorState, PageShell, RunLogPanel } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { MacCard } from '@/components/ui/MacCard';
import { topologyTraceApi } from '@/services/api';
import { formatApiError } from '@/lib/utils';
import type {
  Cluster, PacketFlowResponseV2, TopologyTraceHopV2, PacketDirection,
} from '@/types';
import { FlowGraph3D } from '@/components/packet-flow/FlowGraph3D';
import { HopDetailPanel } from '@/components/packet-flow/HopDetailPanel';
import { HubbleTimeline } from '@/components/packet-flow/HubbleTimeline';
import { TcpdumpPanel } from '@/components/packet-flow/TcpdumpPanel';

type Tab = 'graph' | 'hubble' | 'tcpdump';

const ENTITY_LABEL: Record<string, { icon: typeof Globe; label: string; color: string }> = {
  external:           { icon: Globe,   label: '외부',         color: 'text-chart-1-text' },
  dns:                { icon: Globe,   label: 'DNS',          color: 'text-chart-6-text' },
  ingress_controller: { icon: Share2,  label: 'Ingress 파드', color: 'text-chart-4-text' },
  ingress:            { icon: Route,   label: 'Ingress',      color: 'text-chart-5-text' },
  service:            { icon: Share2,  label: '서비스',       color: 'text-chart-2-text' },
  pod:                { icon: Box,     label: '파드',         color: 'text-chart-3-text' },
  node:               { icon: Server,  label: '노드',         color: 'text-chart-7-text' },
  switch:             { icon: Network, label: '스위치',       color: 'text-chart-8-text' },
  error:              { icon: AlertTriangle, label: '오류', color: 'text-status-critical' },
};

const VERDICT_TEXT: Record<string, string> = { deny: '차단', warn: '경고' };
const EMPTY_CLUSTERS: Cluster[] = [];
const TABS: { id: Tab; label: string }[] = [
  { id: 'graph',   label: '경로 그래프' },
  { id: 'hubble',  label: 'Hubble 흐름' },
  { id: 'tcpdump', label: '원격 tcpdump' },
];

/** 추적 응답 → 실행 로그 요약: 홉 수·경로 한 줄 + deny/warn/error 홉의 첫 메모. */
function summarizeTrace(res: PacketFlowResponseV2): RunLogEntry[] {
  const out: RunLogEntry[] = [];
  const path = res.hops.map((h) => h.name.split('/').pop() || h.name).join(' → ');
  out.push(['info', `홉 ${res.hops.length}개 · ${res.direction} · ${res.protocol}${res.port ? `:${res.port}` : ''}${path ? ` — ${path}` : ''}`]);
  res.hops.forEach((h, i) => {
    const bad = h.entityType === 'error' || h.verdict === 'deny' || h.verdict === 'warn';
    if (!bad) return;
    const level = h.entityType === 'error' || h.verdict === 'deny' ? 'error' : 'warn';
    out.push([level, `홉 ${i + 1} ${h.name} · ${h.verdict}${h.notes[0] ? ` — ${h.notes[0]}` : ''}`]);
  });
  const denied = res.hops.filter((h) => h.verdict === 'deny').length;
  const warned = res.hops.filter((h) => h.verdict === 'warn').length;
  if (denied || warned) out.push([denied ? 'warn' : 'info', `차단 ${denied} · 경고 ${warned} — 홉을 눌러 정책 상세 확인`]);
  return out;
}

function HopBreadcrumb({
  hops, selectedIndex, onSelect,
}: { hops: TopologyTraceHopV2[]; selectedIndex: number | null; onSelect: (i: number) => void }) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto pb-2">
      {hops.map((h, i) => {
        const meta = ENTITY_LABEL[h.entityType] ?? ENTITY_LABEL.external;
        const Icon = meta.icon;
        // allow(정상)는 기본 보더 — 상태색은 비정상(deny/warn)에만 (§12.12 #3).
        // 판정은 테두리색만으로 전달하지 않고 아이콘·스크린리더 문구를 함께 붙인다(D-178).
        const verdictCls =
          h.verdict === 'deny' ? 'border-status-critical/50'
          : h.verdict === 'warn' ? 'border-status-warning/50'
          : 'border-border';
        const VerdictIcon = h.verdict === 'deny' ? XCircle : h.verdict === 'warn' ? AlertTriangle : null;
        const verdictText = VERDICT_TEXT[h.verdict];
        const active = selectedIndex === i;
        return (
          <div key={i} className="flex items-center gap-1 flex-shrink-0">
            <button
              type="button"
              onClick={() => onSelect(i)}
              aria-pressed={active}
              aria-label={`홉 ${i + 1} ${meta.label} ${h.name}${verdictText ? ` — ${verdictText}` : ''}`}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-xl border text-xs transition-colors ${
                active ? 'bg-primary/10 text-primary border-primary/40' : `bg-card ${verdictCls} hover:bg-muted/30`
              }`}
              title={`${meta.label} · ${h.name}${verdictText ? ` · ${verdictText}` : ''}`}
            >
              <Icon className={`w-3 h-3 ${meta.color}`} aria-hidden />
              <span className="font-medium">{i + 1}</span>
              <span className="text-muted-foreground" aria-hidden>·</span>
              <span className="font-mono max-w-[120px] truncate">{h.name.split('/').pop()}</span>
              {VerdictIcon && (
                <VerdictIcon
                  className={`w-3 h-3 ${h.verdict === 'deny' ? 'text-status-critical' : 'text-status-warning'}`}
                  aria-hidden
                />
              )}
            </button>
            {i < hops.length - 1 && <ArrowRight className="w-3 h-3 text-muted-foreground" aria-hidden />}
          </div>
        );
      })}
    </div>
  );
}

export function PacketFlowPage() {
  const clustersQ = useClusters();
  const clusters = clustersQ.data ?? EMPTY_CLUSTERS;
  const [clusterId, setClusterId] = useState('');
  useEffect(() => {
    if (!clusterId && clusters.length > 0) setClusterId(clusters[0].id);
  }, [clusters, clusterId]);
  // 선택 클러스터 운영등급 → 터미널 Appearance(개발/운영) 자동 적용 — tcpdump stderr LogViewer 등(§12.6, D-175 ②).
  useTerminalEnvSync(clusters, clusterId || null);

  // Target 구성 — 방향 + source + destination
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const [direction, setDirection] = useState<PacketDirection>('north-south');
  const [source, setSource] = useState('internet');
  const [destination, setDestination] = useState('');
  const [protocol, setProtocol] = useState<'tcp' | 'http' | 'https' | 'grpc'>('https');
  const [port, setPort] = useState<string>('');
  const [path, setPath] = useState('/');

  // direction 전환 시 placeholder 자동 갱신
  useEffect(() => {
    if (direction === 'north-south') {
      if (!source || source.startsWith('default/')) setSource('internet');
      if (destination && destination.startsWith('default/') && !destination.includes('.')) {
        // 유지 — 사용자 입력 그대로
      }
    } else {
      if (source === 'internet') setSource('default/client-pod');
      if (!destination) setDestination('default/backend:8080');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direction]);

  const [tab, setTab] = useState<Tab>('graph');
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [response, setResponse] = useState<PacketFlowResponseV2 | null>(null);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  const runMut = useAbortableMutation({
    mutationFn: async (_: void, signal) => {
      const r = await topologyTraceApi.packetFlowV2({
        clusterId,
        direction,
        source: source.trim(),
        destination: destination.trim(),
        protocol,
        port: port ? Number(port) : undefined,
        path: path.trim() || '/',
      }, signal);
      return r.data;
    },
  });

  // 실행 수명주기 로그(추적·Hubble 조회·tcpdump 공유) — 결과는 그래프/표, 여기는 요청·대기·요약·실패 사유.
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('packet-flow');
  const doTrace = async () => {
    const cname = clusters.find((c) => c.id === clusterId)?.name ?? clusterId;
    const r = await runLogged(runLog, {
      title: '패킷 경로 추적',
      first: `${cname} — ${direction === 'north-south' ? 'N-S' : 'E-W'} ${source.trim()} → ${destination.trim()} (${protocol}${port ? `:${port}` : ''}${direction === 'north-south' ? ` ${path.trim() || '/'}` : ''}) 추적 요청`,
      fn: () => runMut.mutateAsync(),
      summarize: summarizeTrace,
    });
    if (r.ok) { setResponse(r.data); setSelectedIdx(null); }
  };

  const canRun = !!clusterId && !!source.trim() && !!destination.trim();

  const runError = runMut.error as { response?: { data?: { detail?: string } }; message?: string } | null;

  // 그래프 컨테이너 사이즈 측정
  const graphBoxRef = useRef<HTMLDivElement>(null);
  const [graphDim, setGraphDim] = useState({ w: 800, h: 520 });
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      if (graphBoxRef.current) {
        setGraphDim({
          w: graphBoxRef.current.clientWidth,
          h: graphBoxRef.current.clientHeight,
        });
      }
    });
    if (graphBoxRef.current) ro.observe(graphBoxRef.current);
    return () => ro.disconnect();
    // 그래프 상자는 추적 결과가 있고 그래프 탭일 때만 마운트되므로 그때 다시 관찰한다.
  }, [response, tab]);

  const selectedHop = useMemo(() => {
    if (response && selectedIdx != null && selectedIdx >= 0 && selectedIdx < response.hops.length) {
      return response.hops[selectedIdx];
    }
    return null;
  }, [response, selectedIdx]);

  // Pod-bottleneck cross-link — east-west + src 가 ns/pod 형식일 때만 활성화
  const navigate = useNavigate();
  const bottleneckPrefill = useMemo(() => {
    if (direction !== 'east-west' || !clusterId) return null;
    const podRe = /^([a-z0-9-]+)\/([a-z0-9.-]+)$/i;
    const svcRe = /^([a-z0-9-]+)\/([a-z0-9-]+):\d+$/i;
    const srcM = source.trim().match(podRe);
    if (!srcM) return null;
    const ns = srcM[1];
    const src = srcM[2];
    const dst = destination.trim();
    const dstSvcM = dst.match(svcRe);
    const dstPodM = dst.match(podRe);
    if (!dstSvcM && !dstPodM) return null;
    return {
      ns, src,
      dst: dstPodM ? dstPodM[2] : '',
      svc: dstSvcM ? dstSvcM[2] : '',
    };
  }, [direction, source, destination, clusterId]);

  const handleGoBottleneck = () => {
    if (!bottleneckPrefill || !clusterId) return;
    const p = new URLSearchParams();
    p.set('cluster', clusterId);
    p.set('ns', bottleneckPrefill.ns);
    p.set('src', bottleneckPrefill.src);
    if (bottleneckPrefill.dst) p.set('dst', bottleneckPrefill.dst);
    if (bottleneckPrefill.svc) p.set('svc', bottleneckPrefill.svc);
    navigate(`/pod-bottleneck?${p.toString()}`);
  };

  // Hubble 탭 자동 프리필 — Phase A 의 source/destination 에서 파생
  const hubblePrefill = useMemo(() => {
    const podRe = /^[a-z0-9-]+\/[a-z0-9-]+$/i;
    const svcRe = /^([a-z0-9-]+\/[a-z0-9-]+):(\d+)$/i;
    let fromPod: string | undefined;
    let toPod: string | undefined;
    let toService: string | undefined;

    if (direction === 'east-west' && podRe.test(source.trim())) {
      fromPod = source.trim();
    }
    const dst = destination.trim();
    const svcMatch = dst.match(svcRe);
    if (svcMatch) {
      toService = svcMatch[1];
    } else if (podRe.test(dst)) {
      toPod = dst;
    }
    return { fromPod, toPod, toService };
  }, [direction, source, destination]);

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" className="flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={clusterId || null}
          onSelect={(id) => { setClusterId(id ?? ''); setResponse(null); setSelectedIdx(null); }}
          iconOnly
        />

        <div className="flex-1 min-w-0">
          <DebugLogPanel pageKey="packet-flow" extra={{ clusterId, direction, source, destination, tab, pending: runMut.isPending }} />
          <PageHeader
            className="mb-5"
            icon={Route}
            title="패킷 흐름 분석"
            description="외부 → Ingress → Service → Pod / Pod ↔ Pod"
          />

          {/* Target 구성 바 */}
          {clustersQ.isError && clusters.length === 0 ? (
            <ErrorState
              error={clustersQ.error}
              title="클러스터 목록을 불러오지 못했습니다"
              onRetry={() => { void clustersQ.refetch(); }}
            />
          ) : (<>
          <MacCard
            title="추적 대상"
            rootClassName="mb-4"
            className="space-y-3"
            actions={<>
              <div role="group" aria-label="추적 방향" className="flex items-center bg-secondary/60 rounded-xl p-[3px] gap-px">
                {(['north-south', 'east-west'] as PacketDirection[]).map((d) => (
                  <button key={d} type="button" onClick={() => setDirection(d)}
                    aria-pressed={direction === d}
                    className={`px-3 py-1.5 text-sm font-medium rounded-xl transition-colors ${
                      direction === d ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    }`}>
                    {d === 'north-south' ? '외부 → Pod (N-S)' : 'Pod ↔ Pod (E-W)'}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                {/* Pod-bottleneck cross-link (pod-bottleneck-analyzer PDCA) */}
                {bottleneckPrefill && (
                  <button
                    type="button"
                    onClick={handleGoBottleneck}
                    aria-label="이 pod-pair 의 병목 진단으로 이동"
                    title="병목 진단 페이지로 prefill 이동"
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-secondary border border-border rounded-xl hover:bg-secondary/80"
                  >
                    <Activity className="w-3.5 h-3.5" aria-hidden />
                    병목 진단
                  </button>
                )}
                {runMut.isPending ? (
                  <button
                    onClick={runMut.abort}
                    className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-destructive text-destructive-foreground rounded-xl hover:bg-destructive/90"
                  >
                    <Square className="w-4 h-4 fill-current" aria-hidden />
                    중지
                  </button>
                ) : (
                  <button
                    onClick={() => void doTrace()}
                    disabled={!canRun}
                    className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50"
                  >
                    <Play className="w-4 h-4" aria-hidden />
                    추적
                  </button>
                )}
              </div>
            </>}
          >

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label htmlFor={f('source')} className="text-xs text-muted-foreground mb-1 block">
                  {direction === 'north-south' ? '출발지 (외부)' : '출발 파드'}
                </label>
                <input
                  id={f('source')}
                  type="text" value={source} onChange={(e) => setSource(e.target.value)}
                  placeholder={direction === 'north-south' ? 'internet 또는 203.0.113.5' : 'default/client-pod'}
                  className="w-full px-3 py-1.5 text-sm font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label htmlFor={f('destination')} className="text-xs text-muted-foreground mb-1 block">
                  목적지 {direction === 'north-south' ? '(Ingress 호스트 / ns/서비스 / ns/파드)' : '(ns/파드 또는 ns/서비스:포트)'}
                </label>
                <input
                  id={f('destination')}
                  type="text" value={destination} onChange={(e) => setDestination(e.target.value)}
                  placeholder={direction === 'north-south' ? 'api.example.com 또는 default/api:80' : 'default/backend:8080'}
                  className="w-full px-3 py-1.5 text-sm font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label htmlFor={f('protocol')} className="text-xs text-muted-foreground mb-1 block">프로토콜</label>
                <select id={f('protocol')} value={protocol} onChange={(e) => setProtocol(e.target.value as typeof protocol)}
                  className="w-full px-3 py-1.5 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary">
                  <option value="http">http</option>
                  <option value="https">https</option>
                  <option value="grpc">grpc</option>
                  <option value="tcp">tcp</option>
                </select>
              </div>
              <div>
                <label htmlFor={f('port')} className="text-xs text-muted-foreground mb-1 block">포트 (선택)</label>
                <input
                  id={f('port')}
                  type="number" value={port} onChange={(e) => setPort(e.target.value)}
                  placeholder="443"
                  className="w-full px-3 py-1.5 text-sm font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              {direction === 'north-south' && (
                <div>
                  <label htmlFor={f('path')} className="text-xs text-muted-foreground mb-1 block">경로</label>
                  <input
                    id={f('path')}
                    type="text" value={path} onChange={(e) => setPath(e.target.value)}
                    placeholder="/"
                    className="w-full px-3 py-1.5 text-sm font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              )}
            </div>

            {runError && (
              <div role="alert" className="px-3 py-2 text-sm rounded-md bg-status-critical/10 text-status-critical border border-status-critical/30">
                {formatApiError(runError)}
              </div>
            )}
          </MacCard>

          {/* 탭 — WAI-ARIA tablist(←/→ 이동, D-178) */}
          <div role="tablist" aria-label="패킷 흐름 분석 보기" className="flex items-center gap-1 mb-3 border-b border-border">
            {TABS.map((t, ti) => (
              <button
                key={t.id}
                ref={(el) => { tabRefs.current[ti] = el; }}
                type="button"
                role="tab"
                id={`${fid}-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`${fid}-tabpanel`}
                tabIndex={tab === t.id ? 0 : -1}
                onClick={() => setTab(t.id)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                  e.preventDefault();
                  const ni = (ti + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
                  setTab(TABS[ni].id);
                  tabRefs.current[ni]?.focus();
                }}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  tab === t.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* 실행 로그 — 탭과 무관하게 이 화면의 마지막 실행(추적·Hubble·tcpdump) */}
          <div className="mb-3 empty:hidden">
            <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
          </div>

          {/* 탭 콘텐츠 */}
          <div role="tabpanel" id={`${fid}-tabpanel`} aria-labelledby={`${fid}-tab-${tab}`}>
          {tab === 'graph' && (
            <>
              {!response ? (
                <EmptyState
                  icon={Info}
                  title="아직 추적한 경로가 없습니다."
                  description={'출발지·목적지를 입력하고 "추적"을 누르면 경로를 그래프로 확인할 수 있습니다.'}
                />
              ) : (
                <>
                  <HopBreadcrumb hops={response.hops} selectedIndex={selectedIdx} onSelect={setSelectedIdx} />
                  <MacCard
                    title="경로 그래프"
                    description="노드 클릭 → 해당 홉의 적용 정책(CNP/KNP), Cilium Identity, 관련 리소스 확인"
                    bodyPadding="p-0"
                  >
                    <div
                      ref={graphBoxRef}
                      className="relative overflow-hidden h-[560px]"
                    >
                      <FlowGraph3D
                        hops={response.hops}
                        onSelectHop={setSelectedIdx}
                        selectedIndex={selectedIdx}
                        width={graphDim.w}
                        height={graphDim.h}
                      />
                      {selectedHop && (
                        <HopDetailPanel
                          hop={selectedHop}
                          index={selectedIdx!}
                          totalHops={response.hops.length}
                          onClose={() => setSelectedIdx(null)}
                        />
                      )}
                    </div>
                  </MacCard>
                </>
              )}
            </>
          )}

          {tab === 'hubble' && (
            clusterId ? (
              <HubbleTimeline
                clusterId={clusterId}
                runLog={runLog}
                initialFromPod={hubblePrefill.fromPod}
                initialToPod={hubblePrefill.toPod}
                initialToService={hubblePrefill.toService}
              />
            ) : (
              <SelectClusterEmptyState />
            )
          )}

          {tab === 'tcpdump' && (
            clusterId ? (
              <TcpdumpPanel clusterId={clusterId} runLog={runLog} />
            ) : (
              <SelectClusterEmptyState />
            )
          )}
          </div>
          </>)}
        </div>
      </PageShell>
    </div>
  );
}
