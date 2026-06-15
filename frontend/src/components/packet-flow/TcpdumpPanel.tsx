import { useEffect, useId, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Play, Square, Server, Terminal, RefreshCw, Download, AlertTriangle, Info,
  CheckCircle2, XCircle,
} from 'lucide-react';
import { bulkExecApi, topologyTraceApi } from '@/services/api';
import type { NodeSummary } from '@/services/api';
import type { TcpdumpCaptureResponse, TcpdumpPacketRow } from '@/types';
import { ConfirmDialog, LogViewer, DoubleScrollX} from '@/components/common';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';

interface Props {
  clusterId: string;
}

const BPF_PRESETS: { id: string; label: string; value: string }[] = [
  { id: 'all',    label: '전체',      value: '' },
  { id: 'https',  label: 'HTTPS :443', value: 'tcp port 443' },
  { id: 'http',   label: 'HTTP :80',   value: 'tcp port 80' },
  { id: 'dns',    label: 'DNS :53',    value: 'udp port 53' },
  { id: 'ssh',    label: 'SSH :22',    value: 'tcp port 22' },
  { id: 'icmp',   label: 'ICMP',       value: 'icmp or icmp6' },
  { id: 'vlan',   label: 'VLAN',       value: 'vlan' },
  { id: 'arp',    label: 'ARP',        value: 'arp' },
];

const STATUS_CLS: Record<string, string> = {
  ok:            'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  error:         'bg-red-500/10 text-red-400 border-red-500/30',
  timeout:       'bg-amber-500/10 text-amber-400 border-amber-500/30',
  auth_error:    'bg-red-500/10 text-red-400 border-red-500/30',
  connect_error: 'bg-red-500/10 text-red-400 border-red-500/30',
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_CLS[status] ?? 'bg-slate-500/10 text-slate-400 border-slate-500/30';
  const Icon = status === 'ok' ? CheckCircle2 : XCircle;
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full border ${cls}`}>
      <Icon className="w-3 h-3" />
      {status}
    </span>
  );
}

function PacketTable({ rows }: { rows: TcpdumpPacketRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="text-center py-6 text-sm text-muted-foreground">
        캡처된 패킷이 없습니다. (BPF 필터 / duration 을 조정해 보세요)
      </div>
    );
  }
  return (
    <DoubleScrollX>
      <table className="w-full text-sm">
        <thead className="bg-muted/30 text-left sticky top-0">
          <tr>
            <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase">Time</th>
            <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase">Proto</th>
            <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase">Source</th>
            <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase">Destination</th>
            <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase">Flags</th>
            <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase">Len</th>
            <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase">Summary</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border hover:bg-muted/20">
              <td className="px-2 py-1 font-mono text-xs text-muted-foreground whitespace-nowrap">
                {r.timestamp.split(' ')[1] ?? r.timestamp}
              </td>
              <td className="px-2 py-1 text-xs">
                {r.proto ? (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-secondary text-foreground/80 font-mono">
                    {r.proto}
                  </span>
                ) : '-'}
              </td>
              <td className="px-2 py-1 font-mono text-sm text-foreground">{r.src ?? '-'}</td>
              <td className="px-2 py-1 font-mono text-sm text-foreground">{r.dst ?? '-'}</td>
              <td className="px-2 py-1 font-mono text-xs text-muted-foreground">{r.flags ?? '-'}</td>
              <td className="px-2 py-1 font-mono text-xs text-muted-foreground">{r.length ?? '-'}</td>
              <td className="px-2 py-1 text-xs text-foreground/80 max-w-[520px]">
                <div className="truncate" title={r.summary}>{r.summary}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </DoubleScrollX>
  );
}

export function TcpdumpPanel({ clusterId }: Props) {
  // ── 노드 목록 ────────────────────────────────────────────────────────────
  const nodeQ = useQuery({
    queryKey: ['tcpdump-nodes', clusterId],
    queryFn: () => bulkExecApi.nodeList(clusterId).then((r) => r.data.nodes),
    enabled: !!clusterId,
  });
  const nodes: NodeSummary[] = nodeQ.data ?? [];

  // ── 자격증명 (세션에만) ─────────────────────────────────────────────────
  const [username, setUsername] = useState('root');
  const [port, setPort] = useState(22);
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  // ── 대상 ────────────────────────────────────────────────────────────────
  const [selectedNode, setSelectedNode] = useState<string>('');
  const selectedNodeInfo = nodes.find((n) => n.name === selectedNode);
  const host = selectedNodeInfo?.internalIp || selectedNodeInfo?.externalIp || '';

  const [iface, setIface] = useState('bond0');
  const [ifaceOptions, setIfaceOptions] = useState<string[]>([]);

  // ── 캡처 옵션 ────────────────────────────────────────────────────────────
  const [preset, setPreset] = useState('all');
  const [bpf, setBpf] = useState('');
  const [duration, setDuration] = useState(10);
  const [count, setCount] = useState(200);
  const [useSudo, setUseSudo] = useState(true);

  useEffect(() => {
    const p = BPF_PRESETS.find((x) => x.id === preset);
    if (p && p.id !== 'custom') setBpf(p.value);
  }, [preset]);

  const authPayload = useMemo(() => {
    return authMode === 'password'
      ? { password }
      : { privateKey };
  }, [authMode, password, privateKey]);

  const canRun = !!host && !!iface.trim() && (authMode === 'password' ? !!password : !!privateKey);

  // ── 인터페이스 조회 ──────────────────────────────────────────────────────
  const ifaceMut = useMutation({
    mutationFn: async () => {
      const r = await topologyTraceApi.tcpdumpInterfaces({
        host, port, username, ...authPayload,
      });
      return r.data.interfaces;
    },
    onSuccess: (ifaces) => {
      setIfaceOptions(ifaces);
      if (ifaces.length > 0 && !ifaces.includes(iface)) setIface(ifaces[0]);
    },
  });

  // ── 캡처 실행 ────────────────────────────────────────────────────────────
  const [result, setResult] = useState<TcpdumpCaptureResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const runMut = useAbortableMutation({
    mutationFn: async (_: void, signal) => {
      const r = await topologyTraceApi.tcpdumpRun({
        clusterId,
        host, port, username, ...authPayload,
        interface: iface,
        bpfFilter: bpf,
        durationSec: duration,
        packetCount: count,
        useSudo,
      }, signal);
      return r.data;
    },
    onSuccess: (d) => setResult(d),
  });

  const runError = runMut.error as { response?: { data?: { detail?: string } }; message?: string } | null;

  const downloadRaw = () => {
    if (!result?.raw) return;
    const blob = new Blob([result.raw], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tcpdump-${result.host}-${iface}-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      <div className="bg-card border border-border rounded-xl p-3 space-y-3">
        {/* SSH 자격증명 + 노드 선택 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label htmlFor={f('node')} className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
              <Server className="w-3 h-3" /> 대상 노드
            </label>
            <div className="flex gap-2">
              <select id={f('node')} value={selectedNode}
                onChange={(e) => { setSelectedNode(e.target.value); setIfaceOptions([]); }}
                className="flex-1 px-2 py-1 text-sm bg-background border border-border rounded-lg">
                <option value="">{nodeQ.isLoading ? '노드 로딩 중...' : '노드를 선택하세요'}</option>
                {nodes.map((n) => (
                  <option key={n.name} value={n.name}>
                    {n.name} {n.internalIp ? `(${n.internalIp})` : ''}
                  </option>
                ))}
              </select>
              <button onClick={() => nodeQ.refetch()} className="p-1.5 rounded-lg bg-secondary hover:bg-secondary/80"
                title="노드 목록 새로고침">
                <RefreshCw className={`w-4 h-4 ${nodeQ.isFetching ? 'animate-spin' : ''}`} />
              </button>
            </div>
            {host && (
              <p className="text-xs text-muted-foreground mt-1 font-mono">SSH → {username}@{host}:{port}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor={f('user')} className="text-xs text-muted-foreground mb-1 block">SSH User</label>
              <input id={f('user')} value={username} onChange={(e) => setUsername(e.target.value)}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg" />
            </div>
            <div>
              <label htmlFor={f('port')} className="text-xs text-muted-foreground mb-1 block">SSH Port</label>
              <input id={f('port')} type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)}
                min={1} max={65535}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg" />
            </div>
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

        {/* 인터페이스 + 캡처 옵션 */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label htmlFor={f('iface')} className="text-xs text-muted-foreground mb-1 block">Interface</label>
            <div className="flex gap-1">
              {ifaceOptions.length > 0 ? (
                <select id={f('iface')} value={iface} onChange={(e) => setIface(e.target.value)}
                  className="flex-1 px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg">
                  {ifaceOptions.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              ) : (
                <input id={f('iface')} value={iface} onChange={(e) => setIface(e.target.value)}
                  placeholder="bond0"
                  className="flex-1 px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg" />
              )}
              <button onClick={() => ifaceMut.mutate()}
                disabled={!host || (authMode === 'password' ? !password : !privateKey) || ifaceMut.isPending}
                className="p-1.5 rounded-lg bg-secondary hover:bg-secondary/80 disabled:opacity-50"
                title="원격에서 인터페이스 조회">
                <RefreshCw className={`w-4 h-4 ${ifaceMut.isPending ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>
          <div>
            <label htmlFor={f('duration')} className="text-xs text-muted-foreground mb-1 block">Duration (s)</label>
            <input id={f('duration')} type="number" value={duration} min={1} max={120}
              onChange={(e) => setDuration(Number(e.target.value) || 10)}
              className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg" />
          </div>
          <div>
            <label htmlFor={f('count')} className="text-xs text-muted-foreground mb-1 block">Packet count</label>
            <input id={f('count')} type="number" value={count} min={1} max={5000}
              onChange={(e) => setCount(Number(e.target.value) || 200)}
              className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg" />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-1.5 text-sm text-foreground/80">
              <input type="checkbox" checked={useSudo} onChange={(e) => setUseSudo(e.target.checked)} />
              sudo 사용
            </label>
          </div>
        </div>

        {/* BPF */}
        <div>
          <p className="text-xs text-muted-foreground mb-1 block">BPF 필터 프리셋</p>
          <div className="flex flex-wrap gap-1 mb-1">
            {BPF_PRESETS.map((p) => (
              <button key={p.id} onClick={() => setPreset(p.id)}
                className={`px-2 py-0.5 text-xs rounded-md border transition-colors ${
                  preset === p.id ? 'bg-primary/10 text-primary border-primary/40' : 'bg-card border-border text-muted-foreground hover:text-foreground'
                }`}>
                {p.label}
              </button>
            ))}
          </div>
          <input value={bpf} onChange={(e) => { setBpf(e.target.value); setPreset('custom'); }}
            placeholder="예: host 10.0.0.5 and tcp port 443"
            className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-lg" />
        </div>

        <div className="flex items-center justify-end gap-2">
          {runError && (
            <div className="flex-1 px-3 py-1.5 text-sm rounded-lg bg-destructive/10 text-destructive border border-destructive/30">
              {runError.response?.data?.detail ?? runError.message}
            </div>
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
              onClick={() => setConfirmOpen(true)}
              disabled={!canRun}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
            >
              <Play className="w-4 h-4" />
              캡처 실행
            </button>
          )}
        </div>
      </div>

      {/* 결과 */}
      {result && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
            <StatusBadge status={result.status} />
            <span className="text-sm font-mono">{result.host}</span>
            <span className="text-sm text-muted-foreground">· {result.packets.length} packets · {result.durationMs}ms</span>
            {result.exitCode != null && (
              <span className="text-xs text-muted-foreground font-mono">exit {result.exitCode}</span>
            )}
            <div className="ml-auto flex items-center gap-1">
              <button onClick={downloadRaw} disabled={!result.raw}
                className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-secondary hover:bg-secondary/80 disabled:opacity-50">
                <Download className="w-3 h-3" /> raw
              </button>
            </div>
          </div>

          {result.error && (
            <div className="px-3 py-2 flex items-start gap-2 bg-red-500/5 border-b border-border">
              <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-400">{result.error}</p>
            </div>
          )}

          <div className="px-3 py-2 text-xs text-muted-foreground font-mono border-b border-border flex items-center gap-1">
            <Terminal className="w-3 h-3" />
            <span className="truncate" title={result.executed}>{result.executed}</span>
          </div>

          <div className="max-h-[480px] overflow-auto">
            <PacketTable rows={result.packets} />
          </div>

          {result.stderr && (
            <div className="border-t border-border p-2 bg-muted/20">
              <p className="text-xs text-muted-foreground mb-1">stderr</p>
              <LogViewer text={result.stderr} maxHeight="max-h-40" asError hideToolbar />
            </div>
          )}
        </div>
      )}

      {!result && (
        <div className="bg-card border border-border rounded-xl p-10 text-center text-sm text-muted-foreground">
          <Info className="w-8 h-8 mx-auto mb-2 text-muted-foreground/50" />
          대상 노드/자격증명을 입력하고 "캡처 실행"을 눌러 원격에서 tcpdump 를 수행하세요.
          <br />
          <span className="text-xs">실행 전 확인 모달이 표시됩니다.</span>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="원격 tcpdump 실행"
        description={`${host || '(host)'} 에 SSH 로 접속해 tcpdump 를 수행합니다. (읽기 전용)`}
        confirmLabel="실행"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => { setConfirmOpen(false); runMut.mutate(); }}
      >
        <div className="space-y-1 font-mono text-xs text-muted-foreground">
          <div>host    : {host} ({username}@{port})</div>
          <div>iface   : {iface}</div>
          <div>filter  : {bpf || '(none)'}</div>
          <div>duration: {duration}s · count: {count}</div>
          <div>sudo    : {useSudo ? 'yes' : 'no'}</div>
        </div>
      </ConfirmDialog>
    </div>
  );
}
