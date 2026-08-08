import { useEffect, useId, useMemo, useState } from 'react';
import { X, Network, Play, Loader2, CheckCircle2, AlertTriangle, Globe, Lock } from 'lucide-react';
import { bulkExecApi, versionsApi } from '@/services/api';
import type { NodeSummary } from '@/services/api';
import type { NodeNicsCollectResponse } from '@/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import { useToast, DoubleScrollX, LogViewer } from '@/components/common';
import { useModalA11y } from '@/components/common/useModalA11y';
import { formatApiError } from '@/lib/utils';

interface Props {
  open: boolean;
  clusterId: string;
  onClose: () => void;
}

// 기본 skip 패턴 — 노이즈 인터페이스 (loopback, container, vxlan 등)
const DEFAULT_SKIP = [
  'lo', 'docker', 'cni', 'veth', 'kube-ipvs',
  'flannel', 'cilium_', 'tunl', 'calico', 'br-',
];

/** 각 노드 SSH → `ip -j addr show` 로 NIC/IP 정보 수집.
 *  bond0/bond1 처럼 노드당 다중 IP (public/private) 환경을 정확히 표현하기 위함.
 *  결과는 호스트별 `node_nics:{host}` 스냅샷 + Cluster.node_ips 갱신.
 */
export function NodeNicsCollectModal({ open, clusterId, onClose }: Props) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [username, setUsername] = useState('root');
  const [port, setPort] = useState(22);
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [useSudo, setUseSudo] = useState(false);

  const [skipText, setSkipText] = useState(DEFAULT_SKIP.join(', '));
  const [parallelism, setParallelism] = useState(10);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<NodeNicsCollectResponse | null>(null);

  const usernameId = useId();
  const portId = useId();
  const parallelismId = useId();
  const skipId = useId();
  const titleId = useId();
  const dialogRef = useModalA11y(open, onClose);

  const nodeQ = useQuery({
    queryKey: ['node-nics-nodes', clusterId],
    queryFn: () => bulkExecApi.nodeList(clusterId).then((r) => r.data.nodes),
    enabled: open && !!clusterId,
  });
  const nodes: NodeSummary[] = useMemo(() => nodeQ.data ?? [], [nodeQ.data]);

  useEffect(() => {
    if (!open) return;
    if (nodes.length === 0) return;
    setSelected(new Set(nodes.map((n) => n.internalIp || n.name).filter(Boolean) as string[]));
  }, [open, nodes]);

  const skipPatterns = useMemo(
    () => skipText.split(',').map((s) => s.trim()).filter(Boolean),
    [skipText],
  );

  const collectMut = useAbortableMutation({
    mutationFn: async (_: void, signal) => {
      const r = await versionsApi.collectNodeNics(clusterId, {
        hosts: Array.from(selected),
        port,
        username,
        password: authMode === 'password' ? password : undefined,
        privateKey: authMode === 'key' ? privateKey : undefined,
        useSudo,
        skipIfacePatterns: skipPatterns,
        parallelism,
      }, signal);
      return r.data;
    },
    onSuccess: (d) => {
      setResult(d);
      const okCount = d.hosts.filter((h) => h.status === 'ok').length;
      // 백엔드가 cluster.node_ips / bond0_ip / bond1_ip / mac 들을 갱신하므로
      // 클러스터 캐시를 즉시 무효화해야 ClusterManagePage 표가 새 값으로 다시
      // 그려진다 (그렇지 않으면 useClusters 의 30s refetchInterval 전까지 stale).
      queryClient.invalidateQueries({ queryKey: ['clusters'] });
      // 노드 서버 스펙 페이지도 cluster.node_ips 의 bond IP/MAC 을 사용한다.
      queryClient.invalidateQueries({ queryKey: ['node-specs'] });
      // 자기 자신의 노드 목록도 수집 직후 새로고침 (집계 변동 가능).
      queryClient.invalidateQueries({ queryKey: ['node-nics-nodes', clusterId] });
      // VersionsPage 가 node_nics:{host} 스냅샷을 history 로 표시 — 새 변경 감지 시 invalidation.
      queryClient.invalidateQueries({ queryKey: ['versions'] });

      const noNicCount = d.hosts.filter(
        (h) => h.status === 'ok' && (h.interfaces?.length ?? 0) === 0,
      ).length;
      if (d.changed > 0) {
        toast.success(
          'NIC 수집 완료',
          `${okCount}개 노드 수집 · ${d.changed}건 변경 감지 · 표 갱신 완료`,
        );
      } else if (noNicCount > 0) {
        toast.info(
          'NIC 수집 완료',
          `${okCount}개 노드 · ${noNicCount}개 노드는 NIC 미검출 (raw 출력 확인)`,
        );
      } else {
        toast.info('NIC 수집 완료', `${okCount}개 노드 · 변경 없음`);
      }
    },
    onError: (e: unknown) => {
      toast.error('수집 실패', formatApiError(e));
    },
  });

  const canRun = selected.size > 0
    && (authMode === 'password' ? !!password : !!privateKey.trim());

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={() => !collectMut.isPending && onClose()} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-4xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border bg-muted/30">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary/10 text-primary">
            <Network className="w-4 h-4" />
          </div>
          <div className="flex-1">
            <h2 id={titleId} className="text-sm font-semibold">노드 NIC / IP 수집</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              SSH → <span className="font-mono">ip -j addr show</span> 결과를 파싱해 bond0/bond1 등 모든 인터페이스와
              public/private IP 를 분류 저장. 변경시 히스토리 누적.
            </p>
          </div>
          <button onClick={onClose} disabled={collectMut.isPending} title="닫기" aria-label="닫기"
            className="p-1 rounded hover:bg-secondary text-muted-foreground disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 max-h-[560px] overflow-y-auto space-y-4">
          {/* SSH 자격증명 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label htmlFor={usernameId} className="text-xs text-muted-foreground mb-1 block">SSH User</label>
              <input id={usernameId} value={username} onChange={(e) => setUsername(e.target.value)}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
            <div>
              <label htmlFor={portId} className="text-xs text-muted-foreground mb-1 block">SSH Port</label>
              <input id={portId} type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)}
                min={1} max={65535}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
            <div>
              <label htmlFor={parallelismId} className="text-xs text-muted-foreground mb-1 block"
                title="동시 SSH 세션 수. 300 노드 이상이면 10~20 권장.">
                Parallelism
              </label>
              <input id={parallelismId} type="number" value={parallelism}
                onChange={(e) => setParallelism(Number(e.target.value) || 10)}
                min={1} max={50}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-1.5 text-sm text-foreground/80">
                <input type="checkbox" checked={useSudo} onChange={(e) => setUseSudo(e.target.checked)} />
                sudo 사용
              </label>
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-1">
              <div className="flex items-center bg-secondary/60 rounded-lg p-[3px] gap-px">
                {(['password', 'key'] as const).map((m) => (
                  <button key={m} onClick={() => setAuthMode(m)}
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
                aria-label="SSH 비밀번호"
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            ) : (
              <textarea value={privateKey} onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                aria-label="SSH 개인키 (PEM)"
                rows={3}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            )}
          </div>

          {/* skip 패턴 */}
          <div>
            <label htmlFor={skipId} className="text-xs text-muted-foreground mb-1 block">
              제외 인터페이스 prefix ({skipPatterns.length}개, 쉼표 구분)
            </label>
            <input id={skipId} value={skipText} onChange={(e) => setSkipText(e.target.value)}
              placeholder="lo, docker, cni, veth, kube-ipvs, flannel, cilium_, tunl, calico, br-"
              className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            <p className="mt-1 text-xs text-muted-foreground">
              loopback / 컨테이너 가상 NIC / VXLAN tunnel 같이 의미 없는 인터페이스는 제외합니다.
              <span className="font-mono"> bond0, bond1, eth0, ens*</span> 같은 물리 NIC 는 표시됩니다.
            </p>
          </div>

          {/* 노드 선택 */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-muted-foreground">대상 노드 ({selected.size} / {nodes.length})</label>
              <div className="flex gap-1">
                <button onClick={() => setSelected(new Set(nodes.map((n) => n.internalIp || n.name).filter(Boolean) as string[]))}
                  className="text-xs text-primary hover:underline">모두</button>
                <button onClick={() => setSelected(new Set())}
                  className="text-xs text-muted-foreground hover:text-foreground">해제</button>
              </div>
            </div>
            <div className="max-h-52 overflow-y-auto border border-border rounded-lg bg-background p-1">
              {nodes.length === 0 ? (
                <div className="text-center py-3 text-sm">
                  {nodeQ.isLoading ? (
                    <p className="text-muted-foreground">노드 로딩 중...</p>
                  ) : nodeQ.isError ? (
                    <div className="space-y-1.5">
                      <p className="text-status-critical">노드 목록을 불러오지 못했습니다.</p>
                      <p className="text-xs text-muted-foreground">{formatApiError(nodeQ.error)}</p>
                      <button
                        onClick={() => nodeQ.refetch()}
                        className="px-2 py-1 text-xs font-medium rounded-lg border border-border hover:bg-secondary transition-colors"
                      >
                        다시 시도
                      </button>
                    </div>
                  ) : (
                    <p className="text-muted-foreground">노드 없음</p>
                  )}
                </div>
              ) : nodes.map((n) => {
                const host = n.internalIp || n.name;
                const on = selected.has(host);
                const isMaster = n.roles.includes('control-plane');
                return (
                  <label key={n.name}
                    className={`flex items-center gap-2 px-2 py-1 rounded cursor-pointer text-sm ${
                      on ? 'bg-primary/5' : 'hover:bg-muted/30'
                    }`}>
                    <input type="checkbox" checked={on}
                      onChange={() => setSelected((s) => {
                        const next = new Set(s);
                        if (next.has(host)) next.delete(host); else next.add(host);
                        return next;
                      })} />
                    <span className="font-mono text-foreground">{n.name}</span>
                    <span className="text-muted-foreground">{n.internalIp ?? ''}</span>
                    {isMaster && (
                      <span className="ml-auto text-xs px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">master</span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>

          {/* 결과 */}
          {result && (
            <div className="border border-border rounded-xl overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border">
                {result.changed > 0
                  ? <CheckCircle2 className="w-3.5 h-3.5 text-status-healthy" />
                  : <AlertTriangle className="w-3.5 h-3.5 text-muted-foreground" />}
                <span className="text-sm font-semibold">
                  {result.changed > 0
                    ? `${result.changed}개 노드 변경 감지 · 히스토리 누적됨`
                    : '변경 없음 (이전 스냅샷과 동일)'}
                </span>
              </div>
              <DoubleScrollX>
                <table className="w-full text-sm">
                  <thead className="bg-muted/30">
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="px-2 py-1">Host</th>
                      <th className="px-2 py-1">상태</th>
                      <th className="px-2 py-1">인터페이스 / IP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.hosts.map((h) => (
                      <tr key={h.host} className="border-t border-border align-top">
                        <td className="px-2 py-1.5 font-mono">{h.host}</td>
                        <td className={`px-2 py-1.5 ${h.status === 'ok' ? 'text-status-healthy' : 'text-status-critical'}`}>
                          {h.status}
                        </td>
                        <td className="px-2 py-1.5">
                          {h.status !== 'ok' ? (
                            <div className="space-y-1">
                              <span className="text-xs text-status-critical">{h.error ?? '-'}</span>
                              {(h.raw_stdout || h.raw_stderr) && (
                                <RawOutputDetails
                                  stdout={h.raw_stdout}
                                  stderr={h.raw_stderr}
                                  exitCode={h.exit_code}
                                />
                              )}
                            </div>
                          ) : (h.interfaces?.length ?? 0) === 0 ? (
                            <div className="space-y-1">
                              <span className="text-xs text-status-warning">
                                검출된 NIC 없음 — bond/eth/en*/em* 정규식과 일치하지 않거나 출력 파싱 실패
                              </span>
                              <RawOutputDetails
                                stdout={h.raw_stdout}
                                stderr={h.raw_stderr}
                                exitCode={h.exit_code}
                              />
                            </div>
                          ) : (
                            <div className="space-y-0.5">
                              {(h.interfaces ?? []).map((ifc) => (
                                <div key={ifc.name} className="flex items-start gap-1.5 flex-wrap">
                                  <span className="font-mono text-foreground">{ifc.name}</span>
                                  <span className={`text-[10px] px-1 rounded ${
                                    ifc.operstate === 'UP' ? 'bg-status-healthy/15 text-status-healthy' : 'bg-muted text-muted-foreground'
                                  }`}>{ifc.operstate ?? '?'}</span>
                                  {ifc.addrs.map((a) => {
                                    const isPub = !isPrivateIp(a.ip);
                                    return (
                                      <span key={a.ip}
                                        className={`text-xs font-mono px-1 rounded inline-flex items-center gap-0.5 ${
                                          isPub
                                            ? 'bg-status-warning/10 text-status-warning'
                                            : 'bg-chart-1/10 text-chart-1'
                                        }`}
                                        title={isPub ? 'public' : 'private'}>
                                        {isPub ? <Globe className="w-2.5 h-2.5" /> : <Lock className="w-2.5 h-2.5" />}
                                        {a.ip}{a.prefixlen ? `/${a.prefixlen}` : ''}
                                      </span>
                                    );
                                  })}
                                </div>
                              ))}
                              {/* 성공 호스트도 raw 출력 접근 가능하게 — "파싱 결과가 맞나?" 검증은
                                  실패했을 때만 필요한 게 아니다 (실행-로그 규칙). */}
                              <RawOutputDetails
                                stdout={h.raw_stdout}
                                stderr={h.raw_stderr}
                                exitCode={h.exit_code}
                              />
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DoubleScrollX>
              {result.errors.length > 0 && (
                <div className="px-3 py-2 text-xs text-status-warning border-t border-border bg-status-warning/5">
                  {result.errors.length}건 오류: {result.errors.slice(0, 3).join(' / ')}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/10">
          <button onClick={onClose} disabled={collectMut.isPending}
            className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg disabled:opacity-40">
            닫기
          </button>
          {collectMut.isPending ? (
            <button onClick={collectMut.abort}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-status-critical text-primary-foreground rounded-lg hover:bg-status-critical/90">
              <Loader2 className="w-3 h-3 animate-spin" /> 중지
            </button>
          ) : (
            <button onClick={() => collectMut.mutate()}
              disabled={!canRun}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50">
              <Play className="w-3 h-3" /> 수집 실행
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// "검출된 NIC 없음" / 에러 케이스 진단용 — 백엔드가 응답에 같이 실어준
// 원본 stdout / stderr / exit code 를 펼침형으로 노출.
function RawOutputDetails({
  stdout, stderr, exitCode,
}: {
  stdout?: string | null;
  stderr?: string | null;
  exitCode?: number | null;
}) {
  const hasStdout = !!stdout;
  const hasStderr = !!stderr;
  if (!hasStdout && !hasStderr && exitCode === undefined) return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
        raw 출력 보기
        {exitCode !== null && exitCode !== undefined && (
          <span className="ml-1 font-mono">(exit {exitCode})</span>
        )}
      </summary>
      <div className="mt-1 space-y-1">
        {hasStdout && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">stdout</div>
            <LogViewer text={stdout!} maxHeight="max-h-40" hideToolbar />
          </div>
        )}
        {hasStderr && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">stderr</div>
            <LogViewer text={stderr!} maxHeight="max-h-40" asError hideToolbar />
          </div>
        )}
      </div>
    </details>
  );
}

// RFC1918 + 100.64/10 (CGNAT) + link-local + loopback 모두 private 으로 취급.
// 백엔드 _categorize_ip 와 동일 의도 — 표시용 단순 이진 분류.
function isPrivateIp(ip: string): boolean {
  const m = ip.split('.').map((n) => parseInt(n, 10));
  if (m.length !== 4 || m.some((n) => isNaN(n))) return true;
  const [a, b] = m;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true;            // link-local
  if (a === 127) return true;
  return false;
}
