import { useEffect, useId, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Cpu, Network, Server } from 'lucide-react';
import type { Cluster, ClusterManageUpdate } from '@/types';
import { clustersApi } from '@/services/api';
import { useClusters } from '@/hooks/useCluster';
import { useClusterStore } from '@/stores/clusterStore';
import { useQueryClient } from '@tanstack/react-query';
import { useOperationLevels } from '@/hooks/useOperationLevels';

const TABS = [
  { id: 'node',    label: '노드 스펙 / NIC', icon: Cpu },
  { id: 'network', label: 'N/W CIDR',        icon: Network },
  { id: 'extra',   label: '기타',             icon: Server },
] as const;

type TabId = 'node' | 'network' | 'extra';

export function ClusterMetaFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useClusters();
  const { clusters } = useClusterStore();
  const cluster: Cluster | undefined = clusters.find((c) => c.id === id);
  const { data: opsLevels = [] } = useOperationLevels();

  const [region, setRegion]             = useState('');
  const [operationLevel, setLevel]      = useState('');
  const [nodeCount, setNodeCount]       = useState('');
  const [maxPod, setMaxPod]             = useState('');
  const [hostname, setHostname]         = useState('');
  const [cidr, setCidr]                 = useState('');
  const [internalIps, setInternalIps]   = useState('');
  const [firstHost, setFirstHost]       = useState('');
  const [lastHost, setLastHost]         = useState('');
  const [podCidr, setPodCidr]           = useState('');
  const [podFirstHost, setPodFirstHost] = useState('');
  const [podLastHost, setPodLastHost]   = useState('');
  const [svcCidr, setSvcCidr]           = useState('');
  const [svcFirstHost, setSvcFirst]     = useState('');
  const [svcLastHost, setSvcLast]       = useState('');
  const [bond0Ip, setBond0Ip]           = useState('');
  const [bond0Mac, setBond0Mac]         = useState('');
  const [bond1Ip, setBond1Ip]           = useState('');
  const [bond1Mac, setBond1Mac]         = useState('');
  const [ciliumConfig, setCilium]       = useState('');
  const [description, setDescription]   = useState('');
  const [bgpEnabled, setBgpEnabled]     = useState(false);
  const [asNumber, setAsNumber]         = useState('');
  const [saving, setSaving]             = useState(false);
  const [error, setError]               = useState('');
  const [tab, setTab]                   = useState<TabId>('node');
  const [hydrated, setHydrated]         = useState(false);

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  useEffect(() => {
    if (hydrated || !cluster) return;
    setRegion(cluster.region ?? '');
    setLevel(cluster.operationLevel ?? '');
    setNodeCount(cluster.nodeCount?.toString() ?? '');
    setMaxPod(cluster.maxPod?.toString() ?? '');
    setHostname(cluster.hostname ?? '');
    setCidr(cluster.cidr ?? '');
    setInternalIps(cluster.internalIps ?? '');
    setFirstHost(cluster.firstHost ?? '');
    setLastHost(cluster.lastHost ?? '');
    setPodCidr(cluster.podCidr ?? '');
    setPodFirstHost(cluster.podFirstHost ?? '');
    setPodLastHost(cluster.podLastHost ?? '');
    setSvcCidr(cluster.svcCidr ?? '');
    setSvcFirst(cluster.svcFirstHost ?? '');
    setSvcLast(cluster.svcLastHost ?? '');
    setBond0Ip(cluster.bond0Ip ?? '');
    setBond0Mac(cluster.bond0Mac ?? '');
    setBond1Ip(cluster.bond1Ip ?? '');
    setBond1Mac(cluster.bond1Mac ?? '');
    setCilium(cluster.ciliumConfig ?? '');
    setDescription(cluster.description ?? '');
    setBgpEnabled(cluster.bgpEnabled ?? false);
    setAsNumber(cluster.asNumber ?? '');
    setHydrated(true);
  }, [cluster, hydrated]);

  if (!cluster && clusters.length > 0) {
    return (
      <div className="min-h-screen bg-background">
        <main className="max-w-[1200px] mx-auto px-8 py-8">
          <div className="text-center py-20">
            <Server className="w-12 h-12 mx-auto mb-4 text-muted-foreground/30" />
            <p className="text-muted-foreground mb-4">클러스터를 찾을 수 없습니다.</p>
            <button
              onClick={() => navigate('/cluster-manage')}
              className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg"
            >
              클러스터 목록으로
            </button>
          </div>
        </main>
      </div>
    );
  }

  const ic = 'w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary';
  const lc = 'block text-sm font-medium text-muted-foreground mb-1';

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!cluster) return;
    setSaving(true);
    setError('');
    try {
      const payload: ClusterManageUpdate = {
        region: region.trim() || undefined,
        operationLevel: operationLevel || undefined,
        nodeCount: nodeCount ? Number(nodeCount) : undefined,
        maxPod: maxPod ? Number(maxPod) : undefined,
        hostname: hostname.trim() || undefined,
        cidr: cidr.trim() || undefined,
        internalIps: internalIps.trim() || undefined,
        firstHost: firstHost.trim() || undefined,
        lastHost: lastHost.trim() || undefined,
        podCidr: podCidr.trim() || undefined,
        podFirstHost: podFirstHost.trim() || undefined,
        podLastHost: podLastHost.trim() || undefined,
        svcCidr: svcCidr.trim() || undefined,
        svcFirstHost: svcFirstHost.trim() || undefined,
        svcLastHost: svcLastHost.trim() || undefined,
        bond0Ip: bond0Ip.trim() || undefined,
        bond0Mac: bond0Mac.trim() || undefined,
        bond1Ip: bond1Ip.trim() || undefined,
        bond1Mac: bond1Mac.trim() || undefined,
        ciliumConfig: ciliumConfig.trim() || undefined,
        description: description.trim() || undefined,
        bgpEnabled,
        asNumber: asNumber.trim() || undefined,
      };
      await clustersApi.update(cluster.id, payload as Record<string, unknown>);
      queryClient.invalidateQueries({ queryKey: ['clusters'] });
      navigate('/cluster-manage');
    } catch {
      setError('저장에 실패했습니다. 다시 시도해 주세요.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <main className="max-w-[1200px] mx-auto px-8 py-8">
        {/* Page header */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => navigate('/cluster-manage')}
            className="p-2 hover:bg-secondary rounded-lg transition-colors"
            title="목록으로"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <Server className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-xl font-bold">클러스터 정보 수정</h1>
            <p className="text-sm text-muted-foreground mt-0.5">{cluster?.name}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="bg-card border border-border rounded-xl overflow-hidden">
          {/* 공통 상단 필드 */}
          <div className="px-6 pt-5 pb-5 grid grid-cols-1 md:grid-cols-3 gap-4 border-b border-border">
            <div>
              <label htmlFor={f('region')} className={lc}>지역</label>
              <input id={f('region')} type="text" value={region} onChange={(e) => setRegion(e.target.value)}
                placeholder="예: 서울, ap-northeast-2" className={ic} />
            </div>
            <div>
              <label htmlFor={f('opsLevel')} className={lc}>운영레벨</label>
              <select id={f('opsLevel')} value={operationLevel} onChange={(e) => setLevel(e.target.value)} className={ic}>
                <option value="">— 선택 —</option>
                {opsLevels.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={f('hostname')} className={lc}>호스트명</label>
              <input id={f('hostname')} type="text" value={hostname} onChange={(e) => setHostname(e.target.value)}
                placeholder="k8s-prod-master.example.com" className={ic} />
            </div>
          </div>

          {/* 탭 */}
          <div className="flex gap-1 px-6 pt-4 border-b border-border">
            {TABS.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    tab === t.id
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {t.label}
                </button>
              );
            })}
          </div>

          <div className="p-6 space-y-5">
            {error && (
              <div className="px-3 py-2 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
                {error}
              </div>
            )}

            {tab === 'node' && (
              <>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">노드 스펙</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor={f('nodeCount')} className={lc}>노드 수</label>
                      <input id={f('nodeCount')} type="number" min="0" value={nodeCount} onChange={(e) => setNodeCount(e.target.value)}
                        placeholder="예: 5" className={ic} />
                    </div>
                    <div>
                      <label htmlFor={f('maxPod')} className={lc}>Max Pod (노드당)</label>
                      <input id={f('maxPod')} type="number" min="0" value={maxPod} onChange={(e) => setMaxPod(e.target.value)}
                        placeholder="예: 110" className={ic} />
                    </div>
                  </div>
                </div>

                <div>
                  <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">NIC 정보 (ifconfig)</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-3 border border-border rounded-lg p-4 bg-muted/10">
                      <p className="text-sm font-semibold text-primary">bond0</p>
                      <div>
                        <label htmlFor={f('bond0Ip')} className={lc}>IP 주소</label>
                        <input id={f('bond0Ip')} type="text" value={bond0Ip} onChange={(e) => setBond0Ip(e.target.value)}
                          placeholder="192.168.0.10/24" className={ic} />
                      </div>
                      <div>
                        <label htmlFor={f('bond0Mac')} className={lc}>MAC 주소</label>
                        <input id={f('bond0Mac')} type="text" value={bond0Mac} onChange={(e) => setBond0Mac(e.target.value)}
                          placeholder="aa:bb:cc:dd:ee:ff" className={ic} />
                      </div>
                    </div>
                    <div className="space-y-3 border border-border rounded-lg p-4 bg-muted/10">
                      <p className="text-sm font-semibold text-primary">bond1</p>
                      <div>
                        <label htmlFor={f('bond1Ip')} className={lc}>IP 주소</label>
                        <input id={f('bond1Ip')} type="text" value={bond1Ip} onChange={(e) => setBond1Ip(e.target.value)}
                          placeholder="172.16.0.10/24" className={ic} />
                      </div>
                      <div>
                        <label htmlFor={f('bond1Mac')} className={lc}>MAC 주소</label>
                        <input id={f('bond1Mac')} type="text" value={bond1Mac} onChange={(e) => setBond1Mac(e.target.value)}
                          placeholder="aa:bb:cc:dd:ee:f0" className={ic} />
                      </div>
                    </div>
                  </div>
                </div>

                <div>
                  <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">BGP 설정</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="flex items-center gap-3 px-3 py-2.5 bg-background border border-border rounded-lg">
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={bgpEnabled}
                          onChange={(e) => setBgpEnabled(e.target.checked)}
                          className="w-4 h-4 accent-primary rounded"
                        />
                        <span className="text-sm text-foreground">BGP 사용</span>
                      </label>
                    </div>
                    <div>
                      <label htmlFor={f('asNumber')} className={lc}>AS Number</label>
                      <input
                        id={f('asNumber')}
                        type="text"
                        value={asNumber}
                        onChange={(e) => setAsNumber(e.target.value)}
                        disabled={!bgpEnabled}
                        placeholder="예: 64512"
                        className={`${ic} disabled:opacity-40`}
                      />
                    </div>
                  </div>
                </div>
              </>
            )}

            {tab === 'network' && (
              <div className="space-y-5">
                <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-4 space-y-4">
                  <div>
                    <p className="text-sm font-semibold text-sky-600 uppercase tracking-wider">INTERNAL_IP — 수동 입력</p>
                    <p className="text-[10.5px] text-muted-foreground mt-0.5">
                      자동수집(kubectl) nodeIps &gt; 수동 IP 리스트(정규식) &gt; fallback CIDR 순으로 표시됩니다.
                    </p>
                  </div>

                  <div>
                    <label htmlFor={f('internalIps')} className={lc}>
                      IP 리스트 (정규식)
                      <span className="ml-1.5 text-xs text-muted-foreground/70 font-normal normal-case">
                        한 줄에 한 그룹, 마지막 옥텟은 <code className="font-mono">[5-7,10]</code> 형태로 압축
                      </span>
                    </label>
                    <textarea
                      id={f('internalIps')}
                      value={internalIps}
                      onChange={(e) => setInternalIps(e.target.value)}
                      placeholder={`10.0.1.[5-7,10]\n10.0.2.[1-3]`}
                      rows={3}
                      spellCheck={false}
                      className={`${ic} resize-none font-mono text-sm`}
                    />
                  </div>

                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                      Fallback CIDR
                      <span className="ml-1.5 text-xs text-muted-foreground/70 font-normal normal-case">
                        — IP 리스트가 비었을 때 표시 + CIDR Calculator 의 겹침 검사에 사용
                      </span>
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <div><label htmlFor={f('cidr')} className={lc}>Fallback CIDR</label>
                        <input id={f('cidr')} type="text" value={cidr} onChange={(e) => setCidr(e.target.value)} placeholder="192.168.0.0/24" className={ic} /></div>
                      <div><label htmlFor={f('firstHost')} className={lc}>First Host</label>
                        <input id={f('firstHost')} type="text" value={firstHost} onChange={(e) => setFirstHost(e.target.value)} placeholder="192.168.0.1" className={ic} /></div>
                      <div><label htmlFor={f('lastHost')} className={lc}>Last Host</label>
                        <input id={f('lastHost')} type="text" value={lastHost} onChange={(e) => setLastHost(e.target.value)} placeholder="192.168.0.254" className={ic} /></div>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
                  <p className="text-sm font-semibold text-emerald-400 uppercase tracking-wider mb-3">Pod CIDR 대역</p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div><label htmlFor={f('podCidr')} className={lc}>Pod CIDR</label>
                      <input id={f('podCidr')} type="text" value={podCidr} onChange={(e) => setPodCidr(e.target.value)} placeholder="10.244.0.0/16" className={ic} /></div>
                    <div><label htmlFor={f('podFirstHost')} className={lc}>First Host</label>
                      <input id={f('podFirstHost')} type="text" value={podFirstHost} onChange={(e) => setPodFirstHost(e.target.value)} placeholder="10.244.0.1" className={ic} /></div>
                    <div><label htmlFor={f('podLastHost')} className={lc}>Last Host</label>
                      <input id={f('podLastHost')} type="text" value={podLastHost} onChange={(e) => setPodLastHost(e.target.value)} placeholder="10.244.255.254" className={ic} /></div>
                  </div>
                </div>

                <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-4">
                  <p className="text-sm font-semibold text-violet-400 uppercase tracking-wider mb-3">Service CIDR 대역</p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div><label htmlFor={f('svcCidr')} className={lc}>Service CIDR</label>
                      <input id={f('svcCidr')} type="text" value={svcCidr} onChange={(e) => setSvcCidr(e.target.value)} placeholder="10.96.0.0/12" className={ic} /></div>
                    <div><label htmlFor={f('svcFirstHost')} className={lc}>First Host</label>
                      <input id={f('svcFirstHost')} type="text" value={svcFirstHost} onChange={(e) => setSvcFirst(e.target.value)} placeholder="10.96.0.1" className={ic} /></div>
                    <div><label htmlFor={f('svcLastHost')} className={lc}>Last Host</label>
                      <input id={f('svcLastHost')} type="text" value={svcLastHost} onChange={(e) => setSvcLast(e.target.value)} placeholder="10.111.255.254" className={ic} /></div>
                  </div>
                </div>
              </div>
            )}

            {tab === 'extra' && (
              <div className="space-y-4">
                <div>
                  <label htmlFor={f('cilium')} className={lc}>주요 Cilium 설정</label>
                  <textarea id={f('cilium')} value={ciliumConfig} onChange={(e) => setCilium(e.target.value)}
                    placeholder={`tunnel: vxlan\nkubeProxyReplacement: strict\nipv4NativeRoutingCIDR: 10.0.0.0/8`}
                    rows={6} className={`${ic} resize-none font-mono text-sm`} />
                </div>
                <div>
                  <label htmlFor={f('desc')} className={lc}>정보 / 설명</label>
                  <textarea id={f('desc')} value={description} onChange={(e) => setDescription(e.target.value)}
                    placeholder="클러스터에 대한 추가 정보나 메모"
                    rows={5} className={`${ic} resize-none`} />
                </div>

              </div>
            )}
          </div>

          <div className="flex justify-end gap-3 px-6 py-4 border-t border-border">
            <button type="button" onClick={() => navigate('/cluster-manage')}
              className="px-4 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors">
              취소
            </button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors disabled:opacity-60">
              {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
