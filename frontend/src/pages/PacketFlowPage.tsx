import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Route, Play, ArrowRight, Globe, Network, Share2, Server, Box,
  AlertTriangle, Info, Square, Activity,
} from 'lucide-react';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import { useClusters } from '@/hooks/useCluster';
import { ClusterSidebar, DebugLogPanel } from '@/components/common';
import { topologyTraceApi } from '@/services/api';
import { formatApiError } from '@/lib/utils';
import type {
  PacketFlowResponseV2, TopologyTraceHopV2, PacketDirection,
} from '@/types';
import { FlowGraph3D } from '@/components/packet-flow/FlowGraph3D';
import { HopDetailPanel } from '@/components/packet-flow/HopDetailPanel';
import { HubbleTimeline } from '@/components/packet-flow/HubbleTimeline';
import { TcpdumpPanel } from '@/components/packet-flow/TcpdumpPanel';

type Tab = 'graph' | 'hubble' | 'tcpdump';

const ENTITY_LABEL: Record<string, { icon: typeof Globe; label: string; color: string }> = {
  external:           { icon: Globe,   label: 'External',  color: 'text-sky-400' },
  dns:                { icon: Globe,   label: 'DNS',       color: 'text-indigo-400' },
  ingress_controller: { icon: Share2,  label: 'Ingress Pod', color: 'text-violet-400' },
  ingress:            { icon: Route,   label: 'Ingress',   color: 'text-purple-400' },
  service:            { icon: Share2,  label: 'Service',   color: 'text-emerald-400' },
  pod:                { icon: Box,     label: 'Pod',       color: 'text-amber-400' },
  node:               { icon: Server,  label: 'Node',      color: 'text-orange-400' },
  switch:             { icon: Network, label: 'Switch',    color: 'text-rose-400' },
  error:              { icon: AlertTriangle, label: 'Error', color: 'text-red-400' },
};

function HopBreadcrumb({
  hops, selectedIndex, onSelect,
}: { hops: TopologyTraceHopV2[]; selectedIndex: number | null; onSelect: (i: number) => void }) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto pb-2">
      {hops.map((h, i) => {
        const meta = ENTITY_LABEL[h.entityType] ?? ENTITY_LABEL.external;
        const Icon = meta.icon;
        const verdictCls =
          h.verdict === 'allow' ? 'border-emerald-500/40'
          : h.verdict === 'deny' ? 'border-red-500/50'
          : h.verdict === 'warn' ? 'border-amber-500/50'
          : 'border-border';
        const active = selectedIndex === i;
        return (
          <div key={i} className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => onSelect(i)}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[11px] transition-colors ${
                active ? 'bg-primary/10 text-primary border-primary/40' : `bg-card ${verdictCls} hover:bg-muted/30`
              }`}
              title={h.name}
            >
              <Icon className={`w-3 h-3 ${meta.color}`} />
              <span className="font-medium">{i + 1}</span>
              <span className="text-muted-foreground">·</span>
              <span className="font-mono max-w-[120px] truncate">{h.name.split('/').pop()}</span>
            </button>
            {i < hops.length - 1 && <ArrowRight className="w-3 h-3 text-muted-foreground/50" />}
          </div>
        );
      })}
    </div>
  );
}

export function PacketFlowPage() {
  const { data: clusters = [] } = useClusters();
  const [clusterId, setClusterId] = useState('');
  useEffect(() => {
    if (!clusterId && clusters.length > 0) setClusterId(clusters[0].id);
  }, [clusters, clusterId]);

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
    onSuccess: (d) => { setResponse(d); setSelectedIdx(null); },
  });

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
  }, []);

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
    <div className="min-h-screen bg-background">
      <main className="mx-auto px-6 py-6 flex gap-5">
        <ClusterSidebar
          clusters={clusters}
          selectedId={clusterId || null}
          onSelect={(id) => { setClusterId(id ?? ''); setResponse(null); setSelectedIdx(null); }}
          iconOnly
        />

        <div className="flex-1 min-w-0">
          <DebugLogPanel pageKey="packet-flow" extra={{ clusterId, direction, source, destination, tab, pending: runMut.isPending }} />
          <div className="flex items-center gap-3 mb-5">
            <Route className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">패킷 흐름 분석</h1>
            <p className="text-xs text-muted-foreground">외부 → Ingress → Service → Pod / Pod ↔ Pod</p>
          </div>

          {/* Target 구성 바 */}
          <section className="bg-card border border-border rounded-xl p-4 mb-4 space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center bg-secondary/60 rounded-lg p-[3px] gap-px">
                {(['north-south', 'east-west'] as PacketDirection[]).map((d) => (
                  <button key={d} onClick={() => setDirection(d)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                      direction === d ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground/80 hover:text-foreground'
                    }`}>
                    {d === 'north-south' ? '외부 → Pod (N-S)' : 'Pod ↔ Pod (E-W)'}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1 ml-auto">
                {/* Pod-bottleneck cross-link (pod-bottleneck-analyzer PDCA) */}
                {bottleneckPrefill && (
                  <button
                    type="button"
                    onClick={handleGoBottleneck}
                    aria-label="이 pod-pair 의 병목 진단으로 이동"
                    title="병목 진단 페이지로 prefill 이동"
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-secondary border border-border rounded-lg hover:bg-secondary/80"
                  >
                    <Activity className="w-3.5 h-3.5" />
                    병목 진단
                  </button>
                )}
                {runMut.isPending ? (
                  <button
                    onClick={runMut.abort}
                    className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-red-500 text-primary-foreground rounded-lg hover:bg-red-600"
                  >
                    <Square className="w-4 h-4 fill-current" />
                    중지
                  </button>
                ) : (
                  <button
                    onClick={() => runMut.mutate()}
                    disabled={!canRun}
                    className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
                  >
                    <Play className="w-4 h-4" />
                    추적
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] text-muted-foreground mb-1 block">
                  {direction === 'north-south' ? 'Source (외부)' : 'Source Pod'}
                </label>
                <input
                  type="text" value={source} onChange={(e) => setSource(e.target.value)}
                  placeholder={direction === 'north-south' ? 'internet 또는 203.0.113.5' : 'default/client-pod'}
                  className="w-full px-3 py-1.5 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-[11px] text-muted-foreground mb-1 block">
                  Destination {direction === 'north-south' ? '(Ingress-host / ns/service / ns/pod)' : '(ns/pod 또는 ns/service:port)'}
                </label>
                <input
                  type="text" value={destination} onChange={(e) => setDestination(e.target.value)}
                  placeholder={direction === 'north-south' ? 'api.example.com 또는 default/api:80' : 'default/backend:8080'}
                  className="w-full px-3 py-1.5 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label htmlFor={f('protocol')} className="text-[11px] text-muted-foreground mb-1 block">Protocol</label>
                <select id={f('protocol')} value={protocol} onChange={(e) => setProtocol(e.target.value as typeof protocol)}
                  className="w-full px-3 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary">
                  <option value="http">http</option>
                  <option value="https">https</option>
                  <option value="grpc">grpc</option>
                  <option value="tcp">tcp</option>
                </select>
              </div>
              <div>
                <label htmlFor={f('port')} className="text-[11px] text-muted-foreground mb-1 block">Port (선택)</label>
                <input
                  id={f('port')}
                  type="number" value={port} onChange={(e) => setPort(e.target.value)}
                  placeholder="443"
                  className="w-full px-3 py-1.5 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              {direction === 'north-south' && (
                <div>
                  <label htmlFor={f('path')} className="text-[11px] text-muted-foreground mb-1 block">Path</label>
                  <input
                    id={f('path')}
                    type="text" value={path} onChange={(e) => setPath(e.target.value)}
                    placeholder="/"
                    className="w-full px-3 py-1.5 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              )}
            </div>

            {runError && (
              <div className="px-3 py-2 text-xs rounded-lg bg-destructive/10 text-destructive border border-destructive/30">
                {formatApiError(runError)}
              </div>
            )}
          </section>

          {/* 탭 */}
          <div className="flex items-center gap-1 mb-3 border-b border-border">
            {([
              { id: 'graph',   label: '경로 그래프' },
              { id: 'hubble',  label: 'Hubble 플로우' },
              { id: 'tcpdump', label: '원격 tcpdump' },
            ] as { id: Tab; label: string }[]).map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  tab === t.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* 탭 콘텐츠 */}
          {tab === 'graph' && (
            <>
              {!response ? (
                <div className="bg-card border border-border rounded-xl p-10 text-center text-sm text-muted-foreground">
                  <Info className="w-8 h-8 mx-auto mb-2 text-muted-foreground/50" />
                  source/destination 를 입력하고 "추적" 을 눌러 경로를 그래프로 확인하세요.
                </div>
              ) : (
                <>
                  <HopBreadcrumb hops={response.hops} selectedIndex={selectedIdx} onSelect={setSelectedIdx} />
                  <div
                    ref={graphBoxRef}
                    className="relative bg-card border border-border rounded-xl overflow-hidden"
                    style={{ height: 560 }}
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
                  <p className="text-[11px] text-muted-foreground mt-2">
                    노드 클릭 → 해당 홉의 적용 정책(CNP/KNP), Cilium Identity, 관련 리소스 확인.
                  </p>
                </>
              )}
            </>
          )}

          {tab === 'hubble' && (
            clusterId ? (
              <HubbleTimeline
                clusterId={clusterId}
                initialFromPod={hubblePrefill.fromPod}
                initialToPod={hubblePrefill.toPod}
                initialToService={hubblePrefill.toService}
              />
            ) : (
              <div className="bg-card border border-border rounded-xl p-10 text-center text-sm text-muted-foreground">
                <Info className="w-8 h-8 mx-auto mb-2 text-muted-foreground/50" />
                왼쪽에서 클러스터를 선택하세요.
              </div>
            )
          )}

          {tab === 'tcpdump' && (
            clusterId ? (
              <TcpdumpPanel clusterId={clusterId} />
            ) : (
              <div className="bg-card border border-border rounded-xl p-10 text-center text-sm text-muted-foreground">
                <Info className="w-8 h-8 mx-auto mb-2 text-muted-foreground/50" />
                왼쪽에서 클러스터를 선택하세요.
              </div>
            )
          )}
        </div>
      </main>
    </div>
  );
}
