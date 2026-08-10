import { useEffect, useId, useMemo, useState } from 'react';
import { X, Server, Play, Loader2, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { bulkExecApi, versionsApi } from '@/services/api';
import type { NodeSummary } from '@/services/api';
import type { EtcdSystemdCollectResponse } from '@/types';
import { useQuery } from '@tanstack/react-query';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import { DoubleScrollX } from '@/components/common';
import { useModalA11y } from '@/components/common/useModalA11y';
import { RawOutputDetails, CollectErrorList } from './RawOutputDetails';
import { formatApiError } from '@/lib/utils';

interface Props {
  open: boolean;
  clusterId: string;
  onClose: () => void;
}

/** 클러스터의 master 노드에 SSH 로 접속해 etcd (systemd) 상태/버전을 수집하는 모달.
 *  SSH 자격증명은 요청에만 사용되고 DB 에 저장되지 않는다.
 */
export function EtcdSystemdModal({ open, clusterId, onClose }: Props) {
  const [username, setUsername] = useState('root');
  const [port, setPort] = useState(22);
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [unit, setUnit] = useState('etcd');
  const [useSudo, setUseSudo] = useState(true);
  // etcd env file 기본값 /etcd/etcd.env (사내 표준), 쉼표로 여러 후보 지정 가능.
  const [envFilesText, setEnvFilesText] = useState('/etcd/etcd.env, /etc/etcd.env, /etc/default/etcd');
  const [parallelism, setParallelism] = useState(10);
  const [result, setResult] = useState<EtcdSystemdCollectResponse | null>(null);

  const usernameId = useId();
  const portId = useId();
  const unitId = useId();
  const envFilesId = useId();
  const parallelismId = useId();
  const titleId = useId();
  const dialogRef = useModalA11y(open, onClose);

  const nodeQ = useQuery({
    queryKey: ['etcd-systemd-nodes', clusterId],
    queryFn: () => bulkExecApi.nodeList(clusterId).then((r) => r.data.nodes),
    enabled: open && !!clusterId,
  });
  const nodes: NodeSummary[] = useMemo(() => nodeQ.data ?? [], [nodeQ.data]);

  // 처음 열릴 때 control-plane 노드 자동 선택
  useEffect(() => {
    if (!open) return;
    if (nodes.length === 0) return;
    const masters = nodes.filter((n) => n.roles.includes('control-plane'));
    const target = masters.length > 0 ? masters : nodes;
    setSelected(new Set(target.map((n) => n.internalIp || n.name).filter(Boolean) as string[]));
  }, [open, nodes]);

  const collectMut = useAbortableMutation({
    mutationFn: async (_: void, signal) => {
      const r = await versionsApi.collectEtcdSystemd(clusterId, {
        hosts: Array.from(selected),
        port,
        username,
        password: authMode === 'password' ? password : undefined,
        privateKey: authMode === 'key' ? privateKey : undefined,
        useSudo,
        unit: unit.trim() || 'etcd',
        envFiles: envFilesText.split(',').map((s) => s.trim()).filter(Boolean),
        parallelism,
      }, signal);
      return r.data;
    },
    onSuccess: (d) => setResult(d),
  });

  const canRun = selected.size > 0
    && (authMode === 'password' ? !!password : !!privateKey.trim());

  const runErr = collectMut.error as { response?: { data?: { detail?: string } }; message?: string } | null;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={() => !collectMut.isPending && onClose()} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-3xl mx-4 overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border bg-muted/30">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary/10 text-primary">
            <Server className="w-4 h-4" />
          </div>
          <div className="flex-1">
            <h2 id={titleId} className="text-sm font-semibold">etcd (systemd) 수집</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              master 노드에 SSH 접속 → <span className="font-mono">systemctl show {unit}</span> + <span className="font-mono">etcd --version</span>
            </p>
          </div>
          <button onClick={onClose} disabled={collectMut.isPending}
            className="p-1 rounded hover:bg-secondary text-muted-foreground disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 max-h-[520px] overflow-y-auto space-y-4">
          {/* 자격증명 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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
              <label htmlFor={unitId} className="text-xs text-muted-foreground mb-1 block">systemd unit</label>
              <input id={unitId} value={unit} onChange={(e) => setUnit(e.target.value)}
                placeholder="etcd"
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
          </div>

          {/* etcd env file 경로 — 사내 표준 /etcd/etcd.env 가 기본, 다른 배포판은 수정 */}
          <div>
            <label htmlFor={envFilesId} className="text-xs text-muted-foreground mb-1 block">
              etcd env 파일 후보 (쉼표 구분, 첫 존재 파일만 저장)
            </label>
            <input id={envFilesId} value={envFilesText} onChange={(e) => setEnvFilesText(e.target.value)}
              placeholder="/etcd/etcd.env, /etc/etcd.env"
              className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            <p className="mt-1 text-xs text-muted-foreground">
              기본: <code className="font-mono">/etcd/etcd.env</code> (사내 표준) — kubeadm 은 <code className="font-mono">/etc/etcd.env</code>,
              CentOS/RHEL 은 <code className="font-mono">/etc/sysconfig/etcd</code> 경우가 많음.
            </p>
          </div>

          {/* 병렬/청크 옵션 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label htmlFor={parallelismId} className="text-xs text-muted-foreground mb-1 block"
                title="동시에 SSH 세션 몇 개 열지 상한">
                Parallelism (동시 SSH 수)
              </label>
              <input id={parallelismId} type="number" value={parallelism}
                onChange={(e) => setParallelism(Number(e.target.value) || 10)}
                min={1} max={50}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
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
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            ) : (
              <textarea value={privateKey} onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                rows={3}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            )}
          </div>

          <label className="flex items-center gap-1.5 text-sm text-foreground/80">
            <input type="checkbox" checked={useSudo} onChange={(e) => setUseSudo(e.target.checked)} />
            sudo 사용
          </label>

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
            <div className="max-h-40 overflow-y-auto border border-border rounded-lg bg-background p-1">
              {nodes.length === 0 ? (
                <div className="text-center py-3 text-sm">
                  {nodeQ.isLoading ? (
                    <p className="text-muted-foreground">노드 로딩 중...</p>
                  ) : nodeQ.isError ? (
                    <div className="space-y-1.5">
                      <p className="text-status-critical">노드 목록을 불러오지 못했습니다.</p>
                      <p className="text-xs text-muted-foreground">{formatApiError(nodeQ.error)}</p>
                      <button onClick={() => nodeQ.refetch()}
                        className="px-2 py-1 text-xs font-medium rounded-lg border border-border hover:bg-secondary transition-colors">
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
                      <span className="ml-auto text-xs px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">
                        master
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>

          {runErr && (
            <div className="px-3 py-2 text-sm rounded-lg bg-destructive/10 text-destructive border border-destructive/30">
              {runErr.response?.data?.detail ?? runErr.message}
            </div>
          )}

          {/* 결과 */}
          {result && (
            <div className="border border-border rounded-xl overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border">
                {result.stored
                  ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  : <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />}
                <span className="text-sm font-semibold">
                  {result.stored ? '새 스냅샷 저장됨' : '변경 없음 (저장 안 함)'}
                </span>
                <span className="text-xs text-muted-foreground ml-auto">component: {result.componentKey}</span>
              </div>
              <DoubleScrollX>
                <table className="w-full text-sm">
                  <thead className="bg-muted/30">
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="px-2 py-1">Host</th>
                      <th className="px-2 py-1">Status</th>
                      <th className="px-2 py-1">Active</th>
                      <th className="px-2 py-1">PID</th>
                      <th className="px-2 py-1">Version</th>
                      <th className="px-2 py-1">Unit</th>
                      <th className="px-2 py-1">출력</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.hosts.map((h) => (
                      <tr key={h.host} className="border-t border-border">
                        <td className="px-2 py-1 font-mono">{h.host}</td>
                        <td className="px-2 py-1">
                          {h.status === 'ok'
                            ? <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                            : <XCircle className="w-3 h-3 text-red-400" />}
                        </td>
                        <td className="px-2 py-1 text-muted-foreground">{h.activeState ?? '-'}</td>
                        <td className="px-2 py-1 font-mono text-muted-foreground">{h.mainPid ?? '-'}</td>
                        <td className="px-2 py-1 font-mono">{h.version ?? '-'}</td>
                        <td className="px-2 py-1 text-muted-foreground truncate max-w-[200px]" title={h.fragmentPath ?? ''}>
                          {h.fragmentPath ?? '-'}
                        </td>
                        <td className="px-2 py-1 align-top">
                          {h.error && <p className="text-xs text-status-critical mb-0.5">{h.error}</p>}
                          <RawOutputDetails stdout={h.rawStdout} stderr={h.rawStderr} exitCode={h.exitCode} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DoubleScrollX>
              <CollectErrorList errors={result.errors} />
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
