import { useEffect, useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  X, Send, Play, Loader2, Key, CheckCircle, XCircle, Clock, ShieldAlert, Wifi, ChevronDown, ChevronRight,
} from 'lucide-react';
import {
  bulkExecApi,
  nodeImagesApi,
  type NodeSummary,
  type NodeImageDistributeResponse,
  type BulkExecResultItem,
} from '@/services/api';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import { useNodeImageList } from '@/hooks/useNodeImages';
import { DoubleScrollX } from '@/components/common';
import { pickPrimaryName } from './utils';
import { formatApiError } from '@/lib/utils';

interface ClusterOption {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** 배포할 이미지의 대표 이름 (primary tag) */
  image: string;
  /** 이미지를 선택한 출처 클러스터 */
  sourceClusterId: string;
  /** 대상 클러스터로 선택 가능한 전체 클러스터 목록 */
  clusters: ClusterOption[];
}

const STATUS_META: Record<BulkExecResultItem['status'], { label: string; cls: string; icon: React.ComponentType<{ className?: string }> }> = {
  ok:            { label: '완료',     cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30', icon: CheckCircle },
  error:         { label: '실패',     cls: 'bg-red-500/10 text-red-400 border-red-500/30',             icon: XCircle },
  timeout:       { label: '타임아웃', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30',       icon: Clock },
  auth_error:    { label: '인증 실패', cls: 'bg-orange-500/10 text-orange-400 border-orange-500/30',   icon: ShieldAlert },
  connect_error: { label: '연결 실패', cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30',      icon: Wifi },
};

/** 대상 클러스터의 node-images 스냅샷에서 "이 이미지를 이미 보유한 노드" 집합을 계산. */
function computeHavingNodes(
  nodes: { node: string; images: { names: string[] }[] }[] | undefined,
  image: string,
): Set<string> {
  const set = new Set<string>();
  if (!nodes) return set;
  for (const n of nodes) {
    const has = n.images.some(
      (img) => img.names.includes(image) || pickPrimaryName(img.names) === image,
    );
    if (has) set.add(n.node);
  }
  return set;
}

export function ImageDistributeDialog({
  open, onClose, image, sourceClusterId, clusters,
}: Props) {
  const [targetClusterId, setTargetClusterId] = useState(sourceClusterId);

  // 다이얼로그를 새 이미지로 다시 열 때 대상 클러스터를 출처로 리셋.
  useEffect(() => {
    if (open) setTargetClusterId(sourceClusterId);
  }, [open, sourceClusterId, image]);

  const targetClusterName =
    clusters.find((c) => c.id === targetClusterId)?.name ?? targetClusterId;

  // 대상 클러스터의 노드 목록 (host=InternalIP 확보용)
  const nodeQ = useQuery({
    queryKey: ['image-distribute', 'nodes', targetClusterId],
    queryFn: () => bulkExecApi.nodeList(targetClusterId).then((r) => r.data.nodes),
    enabled: open && !!targetClusterId,
    staleTime: 30_000,
  });
  const nodes: NodeSummary[] = useMemo(() => nodeQ.data ?? [], [nodeQ.data]);

  // 대상 클러스터의 이미지 스냅샷 → 노드별 "이미 보유" 여부 계산 (배포 대상 자동 선별)
  const imagesQ = useNodeImageList(open && targetClusterId ? targetClusterId : '');
  const havingNodes = useMemo(
    () => computeHavingNodes(imagesQ.data?.nodes, image),
    [imagesQ.data, image],
  );
  const coverageComputing = imagesQ.data?.status === 'computing' && (imagesQ.data?.nodes?.length ?? 0) === 0;

  // 노드 선택 — 노드명 기준 (대상 클러스터는 한 번에 하나이므로 이름이 고유)
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 노드/보유목록이 준비되면 "미보유 노드"를 기본 선택.
  useEffect(() => {
    if (!open || nodes.length === 0) return;
    setSelected(new Set(nodes.map((n) => n.name).filter((name) => !havingNodes.has(name))));
    // havingNodes 는 스냅샷 로드에 따라 바뀌므로 의존성에 포함.
  }, [open, nodes, havingNodes]);

  // 실행 구성
  const [runtime, setRuntime] = useState<'auto' | 'crictl' | 'nerdctl' | 'ctr'>('auto');
  const [namespace, setNamespace] = useState('k8s.io');
  const [useSudo, setUseSudo] = useState(false);
  const [username, setUsername] = useState('root');
  const [port, setPort] = useState(22);
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [parallelism, setParallelism] = useState(5);
  const [execTimeout, setExecTimeout] = useState(600);

  const [result, setResult] = useState<NodeImageDistributeResponse | null>(null);

  const uid = useId();
  const f = (k: string) => `${uid}-${k}`;

  const selectedTargets = useMemo(() => {
    const byName = new Map(nodes.map((n) => [n.name, n]));
    return Array.from(selected)
      .map((name) => byName.get(name))
      .filter((n): n is NodeSummary => !!n)
      .map((n) => ({
        host: n.internalIp || n.name,
        name: n.name,
        clusterId: targetClusterId,
        clusterName: targetClusterName,
      }));
  }, [selected, nodes, targetClusterId, targetClusterName]);

  const runMut = useAbortableMutation({
    mutationFn: async (_: void, signal) => {
      const res = await nodeImagesApi.distribute(
        sourceClusterId,
        {
          image,
          targets: selectedTargets,
          runtime,
          namespace,
          sudo: useSudo,
          username,
          port,
          password: authMode === 'password' ? password : undefined,
          privateKey: authMode === 'key' ? privateKey : undefined,
          mode: 'parallel',
          parallelism,
          connectTimeout: 8,
          execTimeout,
          chunkSize: 10,
          chunkPauseMs: 200,
        },
        signal,
      );
      return res.data;
    },
    onSuccess: (d) => setResult(d),
  });

  const canRun =
    selectedTargets.length > 0 &&
    (authMode === 'password' ? !!password : !!privateKey.trim());

  const selectMissingOnly = () =>
    setSelected(new Set(nodes.map((n) => n.name).filter((name) => !havingNodes.has(name))));

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={() => !runMut.isPending && onClose()} />
      <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-3xl mx-4 max-h-[92vh] overflow-hidden flex flex-col">
        {/* 헤더 */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border bg-muted/30">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary/10 text-primary">
            <Send className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold">이미지 배포 (다른 노드로 prepull)</h2>
            <p className="text-xs text-muted-foreground mt-0.5 font-mono break-all">{image}</p>
          </div>
          <button onClick={onClose} disabled={runMut.isPending}
            className="p-1 rounded hover:bg-secondary text-muted-foreground disabled:opacity-40" aria-label="닫기">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto space-y-4">
          <p className="text-xs text-muted-foreground">
            대상 노드에 SSH 접속 후 컨테이너 런타임(crictl/nerdctl/ctr)으로 이미지를 레지스트리에서
            pull 합니다. 대상 노드가 이미지 레지스트리에 도달 가능해야 합니다.
          </p>

          {/* 대상 클러스터 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label htmlFor={f('target-cluster')} className="text-xs text-muted-foreground mb-1 block">
                대상 클러스터
              </label>
              <select
                id={f('target-cluster')}
                value={targetClusterId}
                onChange={(e) => setTargetClusterId(e.target.value)}
                className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {clusters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.id === sourceClusterId ? ' (출처)' : ''}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground/70 mt-1">
                {targetClusterId === sourceClusterId
                  ? '출처와 동일한 클러스터의 다른 노드로 배포'
                  : `다른 클러스터(${targetClusterName})의 노드로 배포`}
              </p>
            </div>
            <div>
              <label htmlFor={f('runtime')} className="text-xs text-muted-foreground mb-1 block">런타임</label>
              <div className="flex gap-2">
                <select
                  id={f('runtime')}
                  value={runtime}
                  onChange={(e) => setRuntime(e.target.value as typeof runtime)}
                  className="flex-1 px-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="auto">auto (감지)</option>
                  <option value="crictl">crictl</option>
                  <option value="nerdctl">nerdctl</option>
                  <option value="ctr">ctr</option>
                </select>
                <label className="flex items-center gap-1.5 text-sm text-foreground/80 whitespace-nowrap">
                  <input type="checkbox" checked={useSudo} onChange={(e) => setUseSudo(e.target.checked)} />
                  sudo
                </label>
              </div>
              {runtime !== 'crictl' && (
                <input
                  aria-label="containerd namespace"
                  value={namespace}
                  onChange={(e) => setNamespace(e.target.value)}
                  placeholder="containerd namespace (예: k8s.io)"
                  className="w-full mt-2 px-2 py-1 text-xs font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                />
              )}
            </div>
          </div>

          {/* SSH 자격증명 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label htmlFor={f('user')} className="text-xs text-muted-foreground mb-1 block">SSH User</label>
              <input id={f('user')} value={username} onChange={(e) => setUsername(e.target.value)}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
            <div>
              <label htmlFor={f('port')} className="text-xs text-muted-foreground mb-1 block">Port</label>
              <input id={f('port')} type="number" min={1} max={65535} value={port}
                onChange={(e) => setPort(Number(e.target.value) || 22)}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
            <div>
              <label htmlFor={f('par')} className="text-xs text-muted-foreground mb-1 block" title="동시 pull 세션 수">Parallelism</label>
              <input id={f('par')} type="number" min={1} max={50} value={parallelism}
                onChange={(e) => setParallelism(Number(e.target.value) || 5)}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
            <div>
              <label htmlFor={f('exec')} className="text-xs text-muted-foreground mb-1 block" title="노드당 pull 최대 시간(초)">Timeout(s)</label>
              <input id={f('exec')} type="number" min={10} max={3600} value={execTimeout}
                onChange={(e) => setExecTimeout(Number(e.target.value) || 600)}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-1">
              <div className="flex items-center bg-secondary/60 rounded-lg p-[3px] gap-px">
                {(['password', 'key'] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setAuthMode(m)}
                    className={`px-2 py-0.5 text-xs font-medium rounded-md ${
                      authMode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground/80 hover:text-foreground'
                    }`}>
                    {m === 'password' ? '비밀번호' : '개인키'}
                  </button>
                ))}
              </div>
              <span className="text-xs text-muted-foreground">자격증명은 요청에만 사용되고 저장되지 않습니다.</span>
            </div>
            {authMode === 'password' ? (
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="SSH 비밀번호"
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            ) : (
              <div>
                <label htmlFor={f('pkey')} className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><Key className="w-3 h-3" /> Private Key (PEM)</label>
                <textarea id={f('pkey')} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  rows={3}
                  className="w-full px-2 py-1 text-xs font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary resize-none" />
              </div>
            )}
          </div>

          {/* 노드 선택 */}
          <div>
            <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
              <label className="text-xs text-muted-foreground">
                대상 노드 ({selected.size} / {nodes.length} 선택)
                {!coverageComputing && (
                  <span className="ml-1 text-muted-foreground/70">· 보유 {havingNodes.size} · 미보유 {Math.max(0, nodes.length - havingNodes.size)}</span>
                )}
              </label>
              <div className="flex gap-2">
                <button type="button" onClick={selectMissingOnly}
                  className="text-xs text-primary hover:underline" disabled={coverageComputing}>미보유만</button>
                <button type="button" onClick={() => setSelected(new Set(nodes.map((n) => n.name)))}
                  className="text-xs text-primary hover:underline">모두</button>
                <button type="button" onClick={() => setSelected(new Set())}
                  className="text-xs text-muted-foreground hover:text-foreground">해제</button>
              </div>
            </div>
            {coverageComputing && (
              <p className="text-xs text-amber-500 mb-1 flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> 대상 클러스터 이미지 수집 중 — 보유 여부는 잠시 후 반영됩니다.
              </p>
            )}
            <div className="max-h-56 overflow-y-auto border border-border rounded-lg bg-background p-1">
              {nodes.length === 0 ? (
                <p className="text-center py-3 text-sm text-muted-foreground">
                  {nodeQ.isLoading ? '노드 로딩 중...' : nodeQ.isError ? '노드 조회 실패' : '노드 없음'}
                </p>
              ) : nodes.map((n) => {
                const on = selected.has(n.name);
                const has = havingNodes.has(n.name);
                const isMaster = n.roles.includes('control-plane');
                return (
                  <label key={n.name}
                    className={`flex items-center gap-2 px-2 py-1 rounded cursor-pointer text-sm ${on ? 'bg-primary/5' : 'hover:bg-muted/30'}`}>
                    <input type="checkbox" checked={on}
                      onChange={() => setSelected((s) => {
                        const next = new Set(s);
                        if (next.has(n.name)) next.delete(n.name); else next.add(n.name);
                        return next;
                      })} />
                    <span className="font-mono text-foreground truncate">{n.name}</span>
                    <span className="text-xs text-muted-foreground">{n.internalIp ?? ''}</span>
                    {!n.ready && <span className="text-xs px-1 rounded bg-red-500/10 text-red-400">NotReady</span>}
                    {isMaster && <span className="text-xs px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">master</span>}
                    <span className="ml-auto">
                      {coverageComputing ? null : has ? (
                        <span className="text-xs px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500">보유</span>
                      ) : (
                        <span className="text-xs px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground">미보유</span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          {runMut.isError && (
            <div className="px-3 py-2 text-sm rounded-lg bg-destructive/10 text-destructive border border-destructive/30">
              {formatApiError(runMut.error, '배포 중 오류')}
            </div>
          )}

          {/* 결과 */}
          {result && (
            <div className="border border-border rounded-xl overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border flex-wrap">
                <span className="text-sm font-semibold">배포 결과</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">성공 {result.okCount}</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/30">실패 {result.errorCount}</span>
                <span className="text-xs text-muted-foreground">총 {result.totalDurationMs}ms</span>
              </div>
              <DoubleScrollX>
                <table className="w-full text-sm">
                  <thead className="bg-muted/20">
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="px-2 py-1 w-6"><span className="sr-only">펼치기</span></th>
                      <th className="px-2 py-1">노드</th>
                      <th className="px-2 py-1">상태</th>
                      <th className="px-2 py-1">exit · 소요</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.results.map((r, idx) => (
                      <ResultRow key={`${r.clusterId ?? ''}|${r.host}|${idx}`} r={r} />
                    ))}
                  </tbody>
                </table>
              </DoubleScrollX>
            </div>
          )}
        </div>

        {/* 푸터 */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border bg-muted/10">
          <p className="text-xs text-muted-foreground">
            {selectedTargets.length}개 노드 → <span className="font-mono">{targetClusterName}</span>
          </p>
          <div className="flex gap-2">
            <button onClick={onClose} disabled={runMut.isPending}
              className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg disabled:opacity-40">
              닫기
            </button>
            {runMut.isPending ? (
              <button onClick={runMut.abort}
                className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-red-500 text-primary-foreground rounded-lg hover:bg-red-600">
                <Loader2 className="w-3 h-3 animate-spin" /> 중지
              </button>
            ) : (
              <button onClick={() => runMut.mutate()} disabled={!canRun}
                className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50">
                <Play className="w-3 h-3" /> 배포 실행 ({selectedTargets.length})
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ResultRow({ r }: { r: BulkExecResultItem }) {
  const [open, setOpen] = useState(r.status !== 'ok');
  const meta = STATUS_META[r.status];
  const Icon = meta.icon;
  return (
    <>
      <tr className="border-t border-border align-top hover:bg-muted/10">
        <td className="px-2 py-1.5">
          <button onClick={() => setOpen((v) => !v)} className="p-0.5 text-muted-foreground hover:text-foreground" aria-label={open ? '접기' : '펼치기'}>
            {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        </td>
        <td className="px-2 py-1.5 font-mono">
          <div className="flex flex-col">
            <span>{r.name || r.host}</span>
            {r.name && r.name !== r.host && <span className="text-xs text-muted-foreground">{r.host}</span>}
          </div>
        </td>
        <td className="px-2 py-1.5">
          <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium ${meta.cls}`}>
            <Icon className="w-3 h-3" /> {meta.label}
          </span>
        </td>
        <td className="px-2 py-1.5 font-mono text-xs text-muted-foreground">
          {r.exitCode ?? '-'} · {r.durationMs}ms
        </td>
      </tr>
      {open && (
        <tr className="bg-muted/5">
          <td colSpan={4} className="px-4 py-2">
            {r.error && <p className="text-xs text-red-400 mb-1">⚠ {r.error}</p>}
            {r.stdout && (
              <pre className="font-mono text-xs bg-background border border-border rounded p-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all">{r.stdout}</pre>
            )}
            {r.stderr && (
              <pre className="font-mono text-xs bg-red-500/5 border border-red-500/20 text-red-400 rounded p-1.5 mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all">{r.stderr}</pre>
            )}
            {!r.stdout && !r.stderr && !r.error && (
              <p className="text-xs text-muted-foreground/70">(출력 없음)</p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
