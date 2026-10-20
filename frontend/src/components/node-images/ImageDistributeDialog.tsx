import { useEffect, useId, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  X, Send, Play, Loader2, Key, CheckCircle, XCircle, Clock, ShieldAlert, Wifi, ChevronDown, ChevronRight, AlertTriangle,
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
import {
  ConfirmDialog, DoubleScrollX, EmptyState, ErrorState, ExecOutputTabs, LoadingState, RunLogPanel, useModalA11y,
} from '@/components/common';
import { useRunLog, runLogged, consoleRunLines, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { useCanOperate } from '@/hooks/useCanOperate';
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
  ok:            { label: '완료',     cls: 'bg-secondary text-muted-foreground border-border', icon: CheckCircle },
  error:         { label: '실패',     cls: 'bg-status-critical/10 text-status-critical border-status-critical/30',             icon: XCircle },
  timeout:       { label: '타임아웃', cls: 'bg-status-warning/10 text-status-warning border-status-warning/30',       icon: Clock },
  auth_error:    { label: '인증 실패', cls: 'bg-status-warning/10 text-status-warning border-status-warning/30', icon: ShieldAlert },
  connect_error: { label: '연결 실패', cls: 'bg-status-unknown/10 text-status-unknown border-status-unknown/30',      icon: Wifi },
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
  const queryClient = useQueryClient();
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

  // 실행 구성 — K8s(containerd) 노드의 기본은 crictl(CRI). ctr 로 폴백되면 containerd
  // 네임스페이스가 어긋나 kubelet 에 안 보일 수 있어, 기본을 crictl 로 둔다.
  const [runtime, setRuntime] = useState<'auto' | 'crictl' | 'nerdctl' | 'ctr'>('crictl');
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
  // 배포 실행은 별도 확인창을 거친다(정책 6) — 대상 노드·런타임을 한 번 더 보여 준다.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const runLog = useRunLog();
  // 권한(§12.9) — 서버는 operator + 출처 클러스터(경로) operate 를 요구한다. 대상 클러스터가 다르면 그쪽 operate 도 본다.
  const sourceAccess = useCanOperate(sourceClusterId);
  const targetAccess = useCanOperate(targetClusterId);
  const access = sourceAccess.canOperate ? targetAccess : sourceAccess;
  const [showLog, setShowLog] = useLogPref('node-images-distribute');

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
    onSuccess: (d) => {
      setResult(d);
      // 배포 성공 후 대상 클러스터의 이미지/노드 스냅샷을 무효화 → 보유/미보유 배지 갱신.
      // (K8s API node.status.images 는 kubelet 갱신 주기로 지연될 수 있어 즉시 반영은 안 될 수 있음)
      if (d.okCount > 0) {
        queryClient.invalidateQueries({ queryKey: ['node-images', targetClusterId] });
        queryClient.invalidateQueries({ queryKey: ['image-distribute', 'nodes', targetClusterId] });
      }
    },
  });

  // ESC 닫기(실행 중엔 무시) · 포커스 트랩 · 초점 복원 (공용 훅)
  const dialogRef = useModalA11y(open, () => { if (!runMut.isPending) onClose(); });

  const handleRun = async () => {
    setConfirmOpen(false);
    const via = runtime === 'crictl' ? 'crictl' : `${runtime} (ns ${namespace})`;
    await runLogged(runLog, {
      title: '이미지 배포',
      first: `${image} → ${targetClusterName} 노드 ${selectedTargets.length}대 · ${via}${useSudo ? ' · sudo' : ''} · 동시 ${parallelism} · 노드당 제한 ${execTimeout}s`,
      fn: () => runMut.mutateAsync(),
      summarize: (d: NodeImageDistributeResponse): RunLogEntry[] => [
        ...consoleRunLines(d.results.map((r) => ({
          host: r.name && r.name !== r.host ? `${r.name} (${r.host})` : (r.name || r.host),
          status: r.status, exitCode: r.exitCode, durationMs: r.durationMs, stderr: r.stderr, error: r.error,
        }))),
        [d.errorCount ? 'warn' : 'info', `성공 ${d.okCount} · 실패 ${d.errorCount} · 총 ${d.totalDurationMs}ms`],
      ],
    });
  };

  const canRun =
    access.canOperate &&
    selectedTargets.length > 0 &&
    (authMode === 'password' ? !!password : !!privateKey.trim());
  const runTitle = !access.canOperate
    ? access.withHint('배포 실행')
    : selectedTargets.length === 0
      ? '배포할 노드를 먼저 고르세요'
      : canRun ? '확인 후 선택한 노드로 배포' : 'SSH 비밀번호 또는 개인키를 입력하세요';

  const selectMissingOnly = () =>
    setSelected(new Set(nodes.map((n) => n.name).filter((name) => !havingNodes.has(name))));

  if (!open) return null;

  return (
    <div ref={dialogRef} className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true" aria-labelledby={f('title')}>
      <div className="absolute inset-0 bg-black/60" onClick={() => !runMut.isPending && onClose()} />
      <div className="relative bg-card border border-border rounded-md shadow-2xl w-full max-w-3xl mx-4 max-h-[92vh] overflow-hidden flex flex-col">
        {/* 헤더 */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border bg-muted/30">
          <div className="flex-1 min-w-0">
            <h2 id={f('title')} className="text-sm font-semibold flex items-center gap-1.5">
              <Send className="w-4 h-4 text-muted-foreground flex-shrink-0" aria-hidden />
              이미지 배포 (다른 노드로 prepull)
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5 font-mono break-all">{image}</p>
          </div>
          <button type="button" onClick={onClose} disabled={runMut.isPending}
            className="p-1 rounded-xl hover:bg-secondary text-muted-foreground disabled:opacity-40" title="닫기" aria-label="이미지 배포 닫기">
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
              <p className="text-xs text-muted-foreground mt-1">
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
                  <option value="crictl">crictl (K8s 기본 · 권장)</option>
                  <option value="auto">auto (감지: crictl→nerdctl→ctr)</option>
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
              {runtime === 'ctr' && (
                <p className="mt-1 flex items-start gap-1 text-xs text-status-warning">
                  <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" aria-hidden />
                  <span>ctr 는 namespace 가 <span className="font-mono">k8s.io</span> 가 아니면 kubelet/K8s 에 이미지가 안 보일 수 있습니다. K8s 노드는 crictl 권장.</span>
                </p>
              )}
            </div>
          </div>

          {/* SSH 자격증명 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label htmlFor={f('user')} className="text-xs text-muted-foreground mb-1 block">SSH 사용자</label>
              <input id={f('user')} value={username} onChange={(e) => setUsername(e.target.value)}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
            <div>
              <label htmlFor={f('port')} className="text-xs text-muted-foreground mb-1 block">포트</label>
              <input id={f('port')} type="number" min={1} max={65535} value={port}
                onChange={(e) => setPort(Number(e.target.value) || 22)}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
            <div>
              <label htmlFor={f('par')} className="text-xs text-muted-foreground mb-1 block" title="동시 pull 세션 수">동시 실행 수</label>
              <input id={f('par')} type="number" min={1} max={50} value={parallelism}
                onChange={(e) => setParallelism(Number(e.target.value) || 5)}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
            <div>
              <label htmlFor={f('exec')} className="text-xs text-muted-foreground mb-1 block" title="노드당 pull 최대 시간(초)">제한 시간(초)</label>
              <input id={f('exec')} type="number" min={10} max={3600} value={execTimeout}
                onChange={(e) => setExecTimeout(Number(e.target.value) || 600)}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-1">
              <div className="flex items-center bg-secondary/60 rounded-lg p-[3px] gap-px" role="group" aria-label="SSH 인증 방식">
                {(['password', 'key'] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setAuthMode(m)}
                    aria-pressed={authMode === m}
                    className={`px-2 py-0.5 text-xs font-medium rounded-md ${
                      authMode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    }`}>
                    {m === 'password' ? '비밀번호' : '개인키'}
                  </button>
                ))}
              </div>
              <span className="text-xs text-muted-foreground">자격증명은 요청에만 사용되고 저장되지 않습니다.</span>
            </div>
            {authMode === 'password' ? (
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                aria-label="SSH 비밀번호" autoComplete="off"
                placeholder="SSH 비밀번호"
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            ) : (
              <div>
                <label htmlFor={f('pkey')} className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><Key className="w-3 h-3" aria-hidden /> 개인키(PEM)</label>
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
                  <span className="ml-1 text-muted-foreground">· 보유 {havingNodes.size} · 미보유 {Math.max(0, nodes.length - havingNodes.size)}</span>
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
              <p className="text-xs text-status-warning mb-1 flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> 대상 클러스터 이미지 수집 중 — 보유 여부는 잠시 후 반영됩니다.
              </p>
            )}
            <div className="max-h-56 overflow-y-auto border border-border rounded-lg bg-background p-1">
              {nodeQ.isLoading ? (
                <LoadingState compact />
              ) : nodeQ.isError ? (
                <ErrorState
                  compact
                  error={nodeQ.error}
                  title={`${targetClusterName} 노드를 불러오지 못했습니다`}
                  onRetry={() => { void nodeQ.refetch(); }}
                />
              ) : nodes.length === 0 ? (
                <EmptyState compact title="대상 클러스터에 노드가 없습니다" />
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
                    {!n.ready && <span className="text-xs px-1 rounded bg-status-critical/10 text-status-critical">NotReady</span>}
                    {isMaster && <span className="text-xs px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">컨트롤 플레인</span>}
                    <span className="ml-auto">
                      {coverageComputing ? null : has ? (
                        <span className="text-xs px-1.5 py-0.5 rounded-full bg-secondary text-foreground">보유</span>
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
            <div className="px-3 py-2 text-sm rounded-lg bg-status-critical/10 text-status-critical border border-status-critical/30">
              {formatApiError(runMut.error, '배포 중 오류')}
            </div>
          )}

          {/* 실행 로그 — 요청·대기·노드별 결과 요약·실패 사유 */}
          <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />

          {/* 결과 */}
          {result && (
            <div className="border border-border rounded-xl overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border flex-wrap">
                <span className="text-sm font-semibold">배포 결과</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border">성공 {result.okCount}</span>
                {/* 0 은 중립(§12.12-2) — 실패가 있을 때만 상태색. */}
                <span className={`text-xs px-2 py-0.5 rounded-full border ${
                  result.errorCount > 0
                    ? 'bg-status-critical/10 text-status-critical border-status-critical/30'
                    : 'bg-secondary text-muted-foreground border-border'
                }`}>실패 {result.errorCount}</span>
                <span className="text-xs text-muted-foreground">총 {result.totalDurationMs}ms</span>
              </div>
              <p className="px-3 py-1.5 text-xs text-muted-foreground bg-muted/10 border-b border-border">
                성공 결과의 <span className="font-mono">verified present</span> 는 노드에서 실제 적재를 확인한 것입니다.
                노드 이미지 목록(K8s API)의 보유 배지는 kubelet 갱신 주기로 수십 초~수 분 뒤 반영될 수 있습니다.
              </p>
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
            <button type="button" onClick={onClose} disabled={runMut.isPending}
              className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl disabled:opacity-40">
              닫기
            </button>
            {runMut.isPending ? (
              <button type="button" onClick={runMut.abort}
                className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-status-critical text-primary-foreground rounded-xl hover:bg-status-critical/90">
                <Loader2 className="w-3 h-3 animate-spin" /> 중지
              </button>
            ) : (
              <button type="button" onClick={() => setConfirmOpen(true)} disabled={!canRun}
                title={runTitle}
                aria-label={access.ariaWithHint(`배포 실행 (${selectedTargets.length})`)}
                className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50">
                <Play className="w-3 h-3" /> 배포 실행 ({selectedTargets.length})
              </button>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="이미지를 배포할까요?"
        description="선택한 노드에 SSH 로 접속해 레지스트리에서 이미지를 pull 합니다. 노드 디스크와 레지스트리 대역폭을 씁니다."
        confirmLabel={`배포 실행 (${selectedTargets.length})`}
        onConfirm={() => { void handleRun(); }}
        onCancel={() => setConfirmOpen(false)}
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 mb-2">
          <dt className="text-muted-foreground">이미지</dt>
          <dd className="font-mono break-all">{image}</dd>
          <dt className="text-muted-foreground">대상 클러스터</dt>
          <dd className="font-medium">{targetClusterName}</dd>
          <dt className="text-muted-foreground">런타임</dt>
          <dd className="font-mono">{runtime === 'crictl' ? 'crictl' : `${runtime} (ns ${namespace})`}{useSudo ? ' · sudo' : ''}</dd>
          <dt className="text-muted-foreground">노드</dt>
          <dd>{selectedTargets.length}대 · 동시 {parallelism} · 노드당 {execTimeout}초</dd>
        </dl>
        <ul className="font-mono text-xs space-y-0.5 max-h-32 overflow-y-auto">
          {selectedTargets.slice(0, 20).map((t) => <li key={t.name}>{t.name} ({t.host})</li>)}
          {selectedTargets.length > 20 && <li className="text-muted-foreground">외 {selectedTargets.length - 20}대</li>}
        </ul>
      </ConfirmDialog>
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
          <button type="button" onClick={() => setOpen((v) => !v)} className="p-0.5 rounded-md text-muted-foreground hover:text-foreground"
            aria-expanded={open} aria-label={`${r.name || r.host} 출력 ${open ? '접기' : '펼치기'}`}>
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
          {r.exitCode ?? '—'} · {r.durationMs}ms
        </td>
      </tr>
      {open && (
        <tr className="bg-muted/5">
          <td colSpan={4} className="px-4 py-2">
            {r.error && <p className="flex items-start gap-1 text-xs text-status-critical mb-1"><AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" aria-hidden /><span>{r.error}</span></p>}
            {/* 콘솔 패턴(§12.6-2·3) — stdout/stderr 는 탭 전환 + LogViewer(필터·복사·줄바꿈 툴바). */}
            {(r.stdout || r.stderr) ? (
              <ExecOutputTabs stdout={r.stdout ?? ''} stderr={r.stderr} maxHeight="max-h-40" />
            ) : !r.error && (
              <p className="text-xs text-muted-foreground">출력 없음</p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
