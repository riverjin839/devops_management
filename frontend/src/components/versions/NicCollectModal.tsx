import { useEffect, useId, useMemo, useState } from 'react';
import { X, Cable, Play, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { bulkExecApi } from '@/services/api';
import type { NodeSummary } from '@/services/api';
import type { NicCollectRequest, NicCollectResponse } from '@/types';
import { useQuery } from '@tanstack/react-query';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import { useRunLog } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { useToast, DoubleScrollX, RunLogPanel } from '@/components/common';
import { useModalA11y } from '@/components/common/useModalA11y';
import { RawOutputDetails, CollectErrorList } from './RawOutputDetails';
import { collectFirstLine, streamCollect } from './collectRunLog';
import { formatApiError } from '@/lib/utils';

interface Props {
  open: boolean;
  clusterId: string;
  /** 실행 로그 첫 줄에 표시할 클러스터 이름(없으면 생략). */
  clusterName?: string;
  onClose: () => void;
}

/** 서비스 구성 ▸ NIC 현재 값 수집 — 노드마다 SSH 로 **조회 명령만**(sysfs·/proc/net/bonding·ethtool -g/-l/-k/-i/-S) 실행.
 *  결과는 노드 파라미터 에이전트 보고와 같은 NIC 상태 + 서비스 구성 `nic:{node}` 스냅샷(설정 값이 같으면 저장 안 함).
 *  에이전트가 없는 클러스터도 NIC 화면·설정 비교를 쓸 수 있게 한다. 노드 수백 대는 동시 실행 수로 조절.
 */
export function NicCollectModal({ open, clusterId, clusterName, onClose }: Props) {
  const toast = useToast();

  // 자격증명 (세션 한정)
  const [username, setUsername] = useState('root');
  const [port, setPort] = useState(22);
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [useSudo, setUseSudo] = useState(false);

  const [parallelism, setParallelism] = useState(20);

  // 대상
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<NicCollectResponse | null>(null);

  const usernameId = useId();
  const portId = useId();
  const parallelismId = useId();
  const titleId = useId();
  const dialogRef = useModalA11y(open, onClose);

  const nodeQ = useQuery({
    queryKey: ['nic-collect-nodes', clusterId],
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

  const hostNames = useMemo(() => Object.fromEntries(nodes.map((n) => [n.internalIp || n.name, n.name])), [nodes]);

  // 실행 로그(D-135) — 수집을 SSE 스트림으로 실행해 서버가 흘리는 시작·호스트별 결과([i/N])·요약 줄을 실시간으로 쌓는다.
  // 결과 표·토스트·중지는 기존 mutation 흐름 그대로(streamCollect 가 동기 응답과 같은 본문을 돌려준다).
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('service-config-collect');
  const collectMut = useAbortableMutation({
    mutationFn: (_: void, signal) =>
      streamCollect<NicCollectResponse>(runLog, {
        title: 'NIC 현재 값 수집',
        first: collectFirstLine(clusterName, selected.size, 'NIC', useSudo),
        clusterId,
        kind: 'nic',
        body: {
          hosts: Array.from(selected),
          port,
          username,
          password: authMode === 'password' ? password : undefined,
          privateKey: authMode === 'key' ? privateKey : undefined,
          useSudo,
          parallelism,
          hostNames: Object.fromEntries([...selected].map((h) => [h, hostNames[h] ?? h])),
        } satisfies NicCollectRequest,
        signal,
        detail: (h) => (h.interfaceCount !== undefined ? `인터페이스 ${h.interfaceCount}개` : null),
      }),
    onSuccess: (d) => {
      setResult(d);
      const failed = d.hosts.length - d.changed;
      if (failed > 0) toast.info('NIC 수집 끝', `저장 ${d.changed}대 · 실패 ${failed}대 — 실행 로그를 확인하세요`);
      else toast.success('NIC 수집 끝', `${d.changed}대 저장`);
    },
    onError: (e: unknown) => {
      toast.error('수집 실패', formatApiError(e));
    },
  });

  const handleRun = () => collectMut.mutate();

  const canRun = selected.size > 0
    && (authMode === 'password' ? !!password : !!privateKey.trim());

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={() => !collectMut.isPending && onClose()} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="relative bg-card border border-border rounded-md shadow-2xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border bg-muted/30">
          <Cable className="w-4 h-4 text-muted-foreground flex-shrink-0" aria-hidden="true" />
          <div className="flex-1">
            <h2 id={titleId} className="text-sm font-semibold">NIC 현재 값 수집</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              노드마다 SSH 로 조회 명령만 실행한다 — <span className="font-mono">/sys/class/net</span>·<span className="font-mono">/proc/net/bonding</span>·
              <span className="font-mono">ethtool -g -l -k -i -S</span>. 노드 설정은 바꾸지 않는다.
            </p>
          </div>
          <button onClick={onClose} disabled={collectMut.isPending} title="닫기" aria-label="닫기"
            className="p-1 rounded hover:bg-secondary text-muted-foreground disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 max-h-[520px] overflow-y-auto space-y-4">
          {/* SSH 자격증명 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label htmlFor={usernameId} className="text-xs text-muted-foreground mb-1 block">SSH 사용자</label>
              <input id={usernameId} value={username} onChange={(e) => setUsername(e.target.value)}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
            <div>
              <label htmlFor={portId} className="text-xs text-muted-foreground mb-1 block">SSH 포트</label>
              <input id={portId} type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)}
                min={1} max={65535}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
            <div>
              <label htmlFor={parallelismId} className="text-xs text-muted-foreground mb-1 block"
                title="동시에 여는 SSH 세션 수 상한(1~50). 노드 500대·동시 20이면 약 1분.">
                동시 실행 수
              </label>
              <input id={parallelismId} type="number" value={parallelism}
                onChange={(e) => setParallelism(Number(e.target.value) || 20)}
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
                  <button key={m} onClick={() => setAuthMode(m)} aria-pressed={authMode === m}
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
                placeholder="SSH 비밀번호"
                aria-label="SSH 비밀번호"
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            ) : (
              <textarea value={privateKey} onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                rows={3}
                aria-label="SSH 개인키 (PEM)"
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            )}
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
                  {nodeQ.isLoading ? '노드 불러오는 중…' : nodeQ.isError ? (
                    <span className="block space-y-1.5">
                      <span className="block text-status-critical">노드 목록을 불러오지 못했습니다.</span>
                      <span className="block text-xs text-muted-foreground">{formatApiError(nodeQ.error)}</span>
                      <button onClick={() => nodeQ.refetch()}
                        className="px-2 py-1 text-xs font-medium rounded-lg border border-border hover:bg-secondary transition-colors">
                        다시 시도
                      </button>
                    </span>
                  ) : '노드 없음'}
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
          <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />

          {result && (
            <div className="border border-border rounded-xl overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border">
                {result.changed === result.hosts.length
                  ? <CheckCircle2 className="w-3.5 h-3.5 text-muted-foreground" />
                  : <AlertTriangle className="w-3.5 h-3.5 text-status-warning" />}
                <span className="text-sm font-semibold">
                  저장 {result.changed}대{result.changed < result.hosts.length ? ` · 실패 ${result.hosts.length - result.changed}대` : ''}
                </span>
              </div>
              <DoubleScrollX>
                <table className="w-full text-sm">
                  <thead className="bg-muted/30">
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="px-2 py-1">Host</th>
                      <th className="px-2 py-1">상태</th>
                      <th className="px-2 py-1">노드</th>
                      <th className="px-2 py-1">인터페이스</th>
                      <th className="px-2 py-1">저장</th>
                      <th className="px-2 py-1">출력</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.hosts.map((h) => (
                      <tr key={h.host} className="border-t border-border">
                        <td className="px-2 py-1 font-mono">{h.host}</td>
                        <td className={`px-2 py-1 ${h.status === 'ok' ? 'text-muted-foreground' : 'text-status-critical'}`}>
                          {h.status}
                        </td>
                        <td className="px-2 py-1 font-mono">{h.node ?? '—'}</td>
                        <td className="px-2 py-1 font-mono">{h.interfaceCount ?? '—'}
                          {(h.warnings ?? []).length > 0 && <span className="block text-xs text-status-warning">{h.warnings?.join(' · ')}</span>}
                        </td>
                        <td className="px-2 py-1">
                          {h.stored === true
                            ? <span className="text-xs text-muted-foreground">저장</span>
                            : <span className="text-xs text-status-critical">{h.error ?? '실패'}</span>}
                        </td>
                        <td className="px-2 py-1 align-top">
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
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-status-critical text-primary-foreground rounded-lg hover:bg-status-critical">
              <Loader2 className="w-3 h-3 animate-spin" /> 중지
            </button>
          ) : (
            <button onClick={handleRun}
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
