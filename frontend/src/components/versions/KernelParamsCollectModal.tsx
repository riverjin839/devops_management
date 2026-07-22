import { useEffect, useId, useMemo, useState } from 'react';
import { X, Cpu, Play, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { bulkExecApi, versionsApi } from '@/services/api';
import type { NodeSummary } from '@/services/api';
import type { KernelParamsCollectResponse } from '@/types';
import { useQuery } from '@tanstack/react-query';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import { useToast, DoubleScrollX} from '@/components/common';
import { useModalA11y } from '@/components/common/useModalA11y';
import { formatApiError } from '@/lib/utils';

interface Props {
  open: boolean;
  clusterId: string;
  onClose: () => void;
}

// 자주 쓰이는 사전 정의 prefix 목록. 사용자가 편집 가능.
const DEFAULT_PREFIXES = [
  'net.ipv4',
  'net.bridge',
  'net.core',
  'vm',
  'fs.file-max',
  'fs.nr_open',
  'kernel.pid_max',
];

/** 노드별 sysctl 값을 수집해 `kernel_params:{host}` 컴포넌트로 저장.
 *  백엔드는 content-hash dedup → 값 변경 있을 때만 새 스냅샷 누적 (history 자동).
 */
export function KernelParamsCollectModal({ open, clusterId, onClose }: Props) {
  const toast = useToast();

  // 자격증명 (세션 한정)
  const [username, setUsername] = useState('root');
  const [port, setPort] = useState(22);
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [useSudo, setUseSudo] = useState(false);

  // prefix 편집 — 기본 7개 · 쉼표 구분 표시
  const [prefixesText, setPrefixesText] = useState(DEFAULT_PREFIXES.join(', '));
  const [parallelism, setParallelism] = useState(10);

  // 대상
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<KernelParamsCollectResponse | null>(null);

  const usernameId = useId();
  const portId = useId();
  const parallelismId = useId();
  const titleId = useId();
  const dialogRef = useModalA11y(open, onClose);

  const nodeQ = useQuery({
    queryKey: ['kernel-params-nodes', clusterId],
    queryFn: () => bulkExecApi.nodeList(clusterId).then((r) => r.data.nodes),
    enabled: open && !!clusterId,
  });
  const nodes: NodeSummary[] = useMemo(() => nodeQ.data ?? [], [nodeQ.data]);

  // 처음 열릴 때 모든 노드 자동 선택
  useEffect(() => {
    if (!open) return;
    if (nodes.length === 0) return;
    setSelected(new Set(nodes.map((n) => n.internalIp || n.name).filter(Boolean) as string[]));
  }, [open, nodes]);

  const prefixes = useMemo(
    () => prefixesText.split(',').map((s) => s.trim()).filter(Boolean),
    [prefixesText],
  );

  const collectMut = useAbortableMutation({
    mutationFn: async (_: void, signal) => {
      const r = await versionsApi.collectKernelParams(clusterId, {
        hosts: Array.from(selected),
        port,
        username,
        password: authMode === 'password' ? password : undefined,
        privateKey: authMode === 'key' ? privateKey : undefined,
        useSudo,
        defaultPrefixes: prefixes,
        parallelism,
      }, signal);
      return r.data;
    },
    onSuccess: (d) => {
      setResult(d);
      if (d.changed > 0) {
        toast.success(
          '커널 파라미터 수집 완료',
          `${d.changed}개 노드 변경 감지 · 히스토리에 누적`,
        );
      } else {
        toast.info('커널 파라미터 수집 완료', '변경 없음 (히스토리 동일)');
      }
    },
    onError: (e: unknown) => {
      toast.error('수집 실패', formatApiError(e));
    },
  });

  const canRun = selected.size > 0
    && (authMode === 'password' ? !!password : !!privateKey.trim())
    && prefixes.length > 0;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={() => !collectMut.isPending && onClose()} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border bg-muted/30">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary/10 text-primary">
            <Cpu className="w-4 h-4" />
          </div>
          <div className="flex-1">
            <h2 id={titleId} className="text-sm font-semibold">커널 파라미터 수집</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              각 노드 SSH → <span className="font-mono">sysctl -a | grep prefix</span> 결과를 호스트별 스냅샷으로 저장.
              값 변경시에만 히스토리 누적.
            </p>
          </div>
          <button onClick={onClose} disabled={collectMut.isPending}
            className="p-1 rounded hover:bg-secondary text-muted-foreground disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 max-h-[520px] overflow-y-auto space-y-4">
          {/* SSH 자격증명 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label htmlFor={usernameId} className="text-xs text-muted-foreground mb-1 block">SSH User</label>
              <input id={usernameId} value={username} onChange={(e) => setUsername(e.target.value)}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg" />
            </div>
            <div>
              <label htmlFor={portId} className="text-xs text-muted-foreground mb-1 block">SSH Port</label>
              <input id={portId} type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)}
                min={1} max={65535}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg" />
            </div>
            <div>
              <label htmlFor={parallelismId} className="text-xs text-muted-foreground mb-1 block"
                title="동시에 SSH 세션 몇 개 열지 상한. 300 노드 이상이면 10~20 권장.">
                Parallelism
              </label>
              <input id={parallelismId} type="number" value={parallelism}
                onChange={(e) => setParallelism(Number(e.target.value) || 10)}
                min={1} max={50}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg" />
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
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg" />
            ) : (
              <textarea value={privateKey} onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                rows={3}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg" />
            )}
          </div>

          {/* prefix 선택 */}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              수집 대상 prefix ({prefixes.length}개, 쉼표 구분)
            </label>
            <input value={prefixesText} onChange={(e) => setPrefixesText(e.target.value)}
              placeholder="net.ipv4, net.bridge, vm, kernel.pid_max"
              className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg" />
            <p className="mt-1 text-xs text-muted-foreground">
              예: <code className="font-mono">net.ipv4.tcp_*</code>, <code className="font-mono">net.bridge.bridge-nf-call-iptables</code>,
              <code className="font-mono">vm.swappiness</code> 등.
              여기에 없는 키는 수집 대상에서 제외됩니다.
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
                <p className="text-center py-3 text-sm text-muted-foreground">
                  {nodeQ.isLoading ? '노드 로딩 중...' : '노드 없음'}
                </p>
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
                  ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
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
                      <th className="px-2 py-1">파라미터</th>
                      <th className="px-2 py-1">저장</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.hosts.map((h) => (
                      <tr key={h.host} className="border-t border-border">
                        <td className="px-2 py-1 font-mono">{h.host}</td>
                        <td className={`px-2 py-1 ${h.status === 'ok' ? 'text-emerald-500' : 'text-red-500'}`}>
                          {h.status}
                        </td>
                        <td className="px-2 py-1 font-mono">{h.paramCount ?? '-'}</td>
                        <td className="px-2 py-1">
                          {h.stored === true
                            ? <span className="text-xs text-emerald-500">신규 저장</span>
                            : h.stored === false
                              ? <span className="text-xs text-muted-foreground">동일 (skip)</span>
                              : <span className="text-xs text-red-400">{h.error ?? '실패'}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DoubleScrollX>
              {result.errors.length > 0 && (
                <div className="px-3 py-2 text-xs text-amber-500 border-t border-border bg-amber-500/5">
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
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-red-500 text-primary-foreground rounded-lg hover:bg-red-600">
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
