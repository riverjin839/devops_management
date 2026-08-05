import { useEffect, useId, useMemo, useState } from 'react';
import { X, ShieldCheck, Play, Loader2, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { bulkExecApi, versionsApi } from '@/services/api';
import type { NodeSummary } from '@/services/api';
import type { KubeadmCertsCollectResponse } from '@/types';
import { useQuery } from '@tanstack/react-query';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import { useModalA11y } from '@/components/common/useModalA11y';

interface Props {
  open: boolean;
  clusterId: string;
  onClose: () => void;
}

/** 클러스터의 control-plane 노드에 SSH 로 접속해 `kubeadm certs check-expiration`
 *  을 직접 실행·수집하는 모달. kube-apiserver 파드 이미지는 distroless(쉘 없음)라
 *  kubectl exec 로는 kubeadm 을 실행할 수 없어, Ops Checks 의 `cert_expiry` 체커가
 *  source=snapshot(또는 auto 폴백)일 때 여기서 수집한 스냅샷을 읽는다.
 *  SSH 자격증명은 요청에만 사용되고 DB 에 저장되지 않는다. */
export function KubeadmCertsModal({ open, clusterId, onClose }: Props) {
  const [username, setUsername] = useState('root');
  const [port, setPort] = useState(22);
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [useSudo, setUseSudo] = useState(true);
  const [result, setResult] = useState<KubeadmCertsCollectResponse | null>(null);

  const usernameId = useId();
  const portId = useId();
  const titleId = useId();
  const dialogRef = useModalA11y(open, onClose);

  const nodeQ = useQuery({
    queryKey: ['kubeadm-certs-nodes', clusterId],
    queryFn: () => bulkExecApi.nodeList(clusterId).then((r) => r.data.nodes),
    enabled: open && !!clusterId,
  });
  const nodes: NodeSummary[] = useMemo(() => nodeQ.data ?? [], [nodeQ.data]);

  // 처음 열릴 때 control-plane 노드 자동 선택 — 인증서는 컨트롤 플레인에만 있다.
  useEffect(() => {
    if (!open) return;
    if (nodes.length === 0) return;
    const masters = nodes.filter((n) => n.roles.includes('control-plane'));
    const target = masters.length > 0 ? masters : nodes;
    setSelected(new Set(target.map((n) => n.internalIp || n.name).filter(Boolean) as string[]));
  }, [open, nodes]);

  const collectMut = useAbortableMutation({
    mutationFn: async (_: void, signal) => {
      const r = await versionsApi.collectKubeadmCerts(clusterId, {
        hosts: Array.from(selected),
        port,
        username,
        password: authMode === 'password' ? password : undefined,
        privateKey: authMode === 'key' ? privateKey : undefined,
        useSudo,
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
        className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border bg-muted/30">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary/10 text-primary">
            <ShieldCheck className="w-4 h-4" />
          </div>
          <div className="flex-1">
            <h2 id={titleId} className="text-sm font-semibold">kubeadm 인증서 만료 수집</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              컨트롤 플레인 노드에 SSH 접속 → <span className="font-mono">kubeadm certs check-expiration</span>
            </p>
          </div>
          <button onClick={onClose} disabled={collectMut.isPending}
            className="p-1 rounded hover:bg-secondary text-muted-foreground disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 max-h-[520px] overflow-y-auto space-y-4">
          <p className="text-xs text-muted-foreground bg-muted/30 border border-border rounded-lg px-3 py-2">
            kube-apiserver 파드 이미지에는 쉘/kubeadm 바이너리가 없어 kubectl exec 로는
            인증서 만료를 확인할 수 없습니다 — 여기서 SSH 로 호스트에 설치된 kubeadm 을
            직접 실행해 수집하면, Ops Checks 의 &quot;K8s 인증서 만료&quot; 점검이 이 스냅샷을
            읽어 판정합니다.
          </p>

          {/* 자격증명 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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

          <label className="flex items-center gap-1.5 text-sm text-foreground/80">
            <input type="checkbox" checked={useSudo} onChange={(e) => setUseSudo(e.target.checked)} />
            sudo 사용
          </label>

          {/* 노드 선택 */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-muted-foreground">대상 노드 ({selected.size} / {nodes.length}) — 컨트롤 플레인만 선택하세요</label>
              <div className="flex gap-1">
                <button onClick={() => setSelected(new Set(nodes.map((n) => n.internalIp || n.name).filter(Boolean) as string[]))}
                  className="text-xs text-primary hover:underline">모두</button>
                <button onClick={() => setSelected(new Set())}
                  className="text-xs text-muted-foreground hover:text-foreground">해제</button>
              </div>
            </div>
            <div className="max-h-40 overflow-y-auto border border-border rounded-lg bg-background p-1">
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
                {result.changed > 0
                  ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  : <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />}
                <span className="text-sm font-semibold">
                  {result.changed > 0 ? `${result.changed}개 호스트 스냅샷 저장됨` : '변경 없음 (저장 안 함)'}
                </span>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-muted/30">
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="px-2 py-1">Host</th>
                    <th className="px-2 py-1">Status</th>
                    <th className="px-2 py-1">비고</th>
                  </tr>
                </thead>
                <tbody>
                  {result.hosts.map((h) => (
                    <tr key={h.host} className="border-t border-border">
                      <td className="px-2 py-1 font-mono">{h.host}</td>
                      <td className="px-2 py-1">
                        {!h.error
                          ? <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                          : <XCircle className="w-3 h-3 text-red-400" />}
                      </td>
                      <td className="px-2 py-1 text-muted-foreground truncate max-w-[280px]" title={h.error ?? ''}>
                        {h.error ?? (h.stored ? '저장됨' : '변경 없음')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {result.errors.length > 0 && (
                <div className="px-3 py-2 text-xs text-amber-400 border-t border-border bg-amber-500/5">
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
