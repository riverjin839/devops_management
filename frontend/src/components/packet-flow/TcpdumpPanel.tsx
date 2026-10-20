import { useEffect, useId, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Play, Square, Server, Terminal, RefreshCw, Download, AlertTriangle, Info,
  CheckCircle2, XCircle,
} from 'lucide-react';
import { bulkExecApi, topologyTraceApi } from '@/services/api';
import type { NodeSummary } from '@/services/api';
import type { TcpdumpCaptureResponse, TcpdumpPacketRow } from '@/types';
import { ConfirmDialog, LogViewer, DoubleScrollX, EmptyState, ErrorState } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import { useCanOperate } from '@/hooks/useCanOperate';
import { formatApiError } from '@/lib/utils';
import { runLogged, consoleRunLines, type RunLog } from '@/hooks/useRunLog';

interface Props {
  clusterId: string;
  /** 화면(패킷 흐름 분석) 공용 실행 로그 — 패널은 페이지가 탭 위에 렌더한다. */
  runLog: RunLog;
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

const STATUS_META: Record<string, { cls: string; label: string }> = {
  ok:            { cls: 'bg-secondary text-muted-foreground border-border', label: '성공' },
  error:         { cls: 'bg-status-critical/10 text-status-critical border-status-critical/30', label: '오류' },
  timeout:       { cls: 'bg-status-warning/10 text-status-warning border-status-warning/30', label: '시간 초과' },
  auth_error:    { cls: 'bg-status-critical/10 text-status-critical border-status-critical/30', label: '인증 실패' },
  connect_error: { cls: 'bg-status-critical/10 text-status-critical border-status-critical/30', label: '연결 실패' },
};

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { cls: 'bg-secondary text-muted-foreground border-border', label: status };
  const Icon = status === 'ok' ? CheckCircle2 : XCircle;
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full border ${meta.cls}`} title={status}>
      <Icon className="w-3 h-3" aria-hidden />
      {meta.label}
    </span>
  );
}

function PacketTable({ rows }: { rows: TcpdumpPacketRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        compact
        title="캡처된 패킷이 없습니다."
        description="BPF 필터를 넓히거나 캡처 시간을 늘려 다시 실행해 보세요."
      />
    );
  }
  return (
    <DoubleScrollX>
      <table className="w-full text-sm">
        <thead className="bg-muted/30 text-left sticky top-0">
          <tr>
            <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground">시각</th>
            <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground">프로토콜</th>
            <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground">출발지</th>
            <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground">목적지</th>
            <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground">플래그</th>
            <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground">길이</th>
            <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground">요약</th>
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
                ) : '—'}
              </td>
              <td className="px-2 py-1 font-mono text-sm text-foreground">{r.src ?? '—'}</td>
              <td className="px-2 py-1 font-mono text-sm text-foreground">{r.dst ?? '—'}</td>
              <td className="px-2 py-1 font-mono text-xs text-muted-foreground">{r.flags ?? '—'}</td>
              <td className="px-2 py-1 font-mono text-xs text-muted-foreground">{r.length ?? '—'}</td>
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

export function TcpdumpPanel({ clusterId, runLog }: Props) {
  // tcpdump 실행·인터페이스 조회는 operate 권한(서버 require_operator, 13차 정책 6) — viewer 에게는
  // 숨기지 않고 비활성 + 사유(§12.9, D-172). 패킷 경로 추적·Hubble 조회는 viewer 도 쓸 수 있다.
  const { canOperate, withHint, ariaWithHint } = useCanOperate(clusterId);

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

  const hasCred = authMode === 'password' ? !!password : !!privateKey;
  const canRun = canOperate && !!host && !!iface.trim() && hasCred;

  // ── 인터페이스 조회 ──────────────────────────────────────────────────────
  const ifaceMut = useMutation({
    mutationFn: async () => {
      const r = await topologyTraceApi.tcpdumpInterfaces({
        host, port, username, ...authPayload,
      }, undefined, clusterId || undefined);
      return r.data.interfaces;
    },
  });

  const targetDesc = `${selectedNode ? `${selectedNode} ` : ''}${username}@${host}:${port}`;

  // 인터페이스 조회 — 예전엔 실패가 화면에 남지 않았다(오류 무음). 이제 실행 로그에 사유가 남는다.
  const doIfaceQuery = async () => {
    const r = await runLogged(runLog, {
      title: '인터페이스 조회',
      first: `${targetDesc} 에 SSH 접속 후 네트워크 인터페이스 목록 조회 요청`,
      fn: () => ifaceMut.mutateAsync(),
      summarize: (ifaces) => (ifaces.length
        ? [['info', `인터페이스 ${ifaces.length}개 — ${ifaces.slice(0, 12).join(', ')}${ifaces.length > 12 ? ' …' : ''}`]]
        : [['warn', '조회된 인터페이스 없음 — 직접 입력하세요']]),
    });
    if (r.ok) {
      setIfaceOptions(r.data);
      if (r.data.length > 0 && !r.data.includes(iface)) setIface(r.data[0]);
    }
  };

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
  });

  const doCapture = async () => {
    const r = await runLogged(runLog, {
      title: '원격 tcpdump 캡처',
      first: `${targetDesc} — tcpdump -i ${iface}${bpf ? ` '${bpf}'` : ''} · ${duration}s · 최대 ${count}패킷${useSudo ? ' · sudo' : ''} 실행 요청`,
      fn: () => runMut.mutateAsync(),
      summarize: (res) => [
        ...consoleRunLines({ host: res.host, status: res.status, exitCode: res.exitCode, durationMs: res.durationMs, stderr: res.stderr, error: res.error }),
        [res.packets.length ? 'info' : 'warn', `캡처 패킷 ${res.packets.length}개${res.packets.length ? '' : ' — BPF 필터·duration 을 조정해 보세요'}`],
      ],
    });
    if (r.ok) setResult(r.data);
  };

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
      <MacCard title="캡처 설정" bodyPadding="p-3" className="space-y-3">
        {/* SSH 자격증명 + 노드 선택 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label htmlFor={f('node')} className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              <Server className="w-3 h-3" aria-hidden /> 대상 노드
            </label>
            <div className="flex gap-2">
              <select id={f('node')} value={selectedNode}
                onChange={(e) => { setSelectedNode(e.target.value); setIfaceOptions([]); }}
                className="flex-1 px-2 py-1 text-sm bg-background border border-border rounded-xl">
                <option value="">
                  {nodeQ.isLoading ? '노드 불러오는 중…'
                    : nodeQ.isError ? '노드 목록을 불러오지 못했습니다'
                    : nodes.length === 0 ? '노드가 없습니다'
                    : '노드를 선택하세요'}
                </option>
                {nodes.map((n) => (
                  <option key={n.name} value={n.name}>
                    {n.name} {n.internalIp ? `(${n.internalIp})` : ''}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => nodeQ.refetch()} className="p-1.5 rounded-xl bg-secondary hover:bg-secondary/80"
                title="노드 목록 새로고침" aria-label="대상 노드 목록 새로고침">
                <RefreshCw className={`w-4 h-4 ${nodeQ.isFetching ? 'animate-spin' : ''}`} aria-hidden />
              </button>
            </div>
            {/* 노드 목록 실패를 "노드를 선택하세요"로 보여주지 않는다(D-173) */}
            {nodeQ.isError && (
              <div className="mt-1">
                <ErrorState compact error={nodeQ.error} title="노드 목록을 불러오지 못했습니다" onRetry={() => { void nodeQ.refetch(); }} />
              </div>
            )}
            {host && (
              <p className="text-xs text-muted-foreground mt-1 font-mono">SSH → {username}@{host}:{port}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor={f('user')} className="text-xs text-muted-foreground mb-1 block">SSH 사용자</label>
              <input id={f('user')} value={username} onChange={(e) => setUsername(e.target.value)}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-xl" />
            </div>
            <div>
              <label htmlFor={f('port')} className="text-xs text-muted-foreground mb-1 block">SSH 포트</label>
              <input id={f('port')} type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)}
                min={1} max={65535}
                className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-xl" />
            </div>
          </div>
        </div>

        <div>
          <div className="flex items-center gap-2 mb-1">
            <div role="group" aria-label="SSH 인증 방식" className="flex items-center bg-secondary/60 rounded-xl p-[3px] gap-px">
              {(['password', 'key'] as const).map((m) => (
                <button key={m} type="button" onClick={() => setAuthMode(m)}
                  aria-pressed={authMode === m}
                  className={`px-2 py-0.5 text-xs font-medium rounded-xl ${
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
              autoComplete="off"
              className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-xl" />
          ) : (
            <textarea value={privateKey} onChange={(e) => setPrivateKey(e.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              aria-label="SSH 개인키 (PEM)"
              spellCheck={false}
              rows={3}
              className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-xl" />
          )}
        </div>

        {/* 인터페이스 + 캡처 옵션 */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label htmlFor={f('iface')} className="text-xs text-muted-foreground mb-1 block">인터페이스</label>
            <div className="flex gap-1">
              {ifaceOptions.length > 0 ? (
                <select id={f('iface')} value={iface} onChange={(e) => setIface(e.target.value)}
                  className="flex-1 px-2 py-1 text-sm font-mono bg-background border border-border rounded-xl">
                  {ifaceOptions.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              ) : (
                <input id={f('iface')} value={iface} onChange={(e) => setIface(e.target.value)}
                  placeholder="bond0"
                  className="flex-1 px-2 py-1 text-sm font-mono bg-background border border-border rounded-xl" />
              )}
              <button type="button" onClick={() => void doIfaceQuery()}
                disabled={!canOperate || !host || !hasCred || ifaceMut.isPending}
                className="p-1.5 rounded-xl bg-secondary hover:bg-secondary/80 disabled:opacity-50"
                title={withHint('원격에서 인터페이스 조회')} aria-label={ariaWithHint('원격에서 인터페이스 조회')}>
                <RefreshCw className={`w-4 h-4 ${ifaceMut.isPending ? 'animate-spin' : ''}`} aria-hidden />
              </button>
            </div>
          </div>
          <div>
            <label htmlFor={f('duration')} className="text-xs text-muted-foreground mb-1 block">캡처 시간(초)</label>
            <input id={f('duration')} type="number" value={duration} min={1} max={120}
              onChange={(e) => setDuration(Number(e.target.value) || 10)}
              className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-xl" />
          </div>
          <div>
            <label htmlFor={f('count')} className="text-xs text-muted-foreground mb-1 block">최대 패킷 수</label>
            <input id={f('count')} type="number" value={count} min={1} max={5000}
              onChange={(e) => setCount(Number(e.target.value) || 200)}
              className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-xl" />
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
              <button key={p.id} type="button" onClick={() => setPreset(p.id)}
                aria-pressed={preset === p.id}
                className={`px-2 py-0.5 text-xs rounded-xl border transition-colors ${
                  preset === p.id ? 'bg-primary/10 text-primary border-primary/40' : 'bg-card border-border text-muted-foreground hover:text-foreground'
                }`}>
                {p.label}
              </button>
            ))}
          </div>
          <input value={bpf} onChange={(e) => { setBpf(e.target.value); setPreset('custom'); }}
            placeholder="예: host 10.0.0.5 and tcp port 443"
            aria-label="BPF 필터"
            className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded-xl" />
        </div>

        <div className="flex items-center justify-end gap-2">
          {runError && (
            <div role="alert" className="flex-1 px-3 py-1.5 text-sm rounded-md bg-status-critical/10 text-status-critical border border-status-critical/30">
              {formatApiError(runError)}
            </div>
          )}
          {runMut.isPending ? (
            <button
              onClick={runMut.abort}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-destructive text-destructive-foreground rounded-xl hover:bg-destructive/90"
            >
              <Square className="w-4 h-4 fill-current" aria-hidden />
              중지
            </button>
          ) : (
            <button
              onClick={() => setConfirmOpen(true)}
              disabled={!canRun}
              title={withHint('원격 tcpdump 캡처 실행 — 실행 전 확인창이 열립니다')}
              aria-label={ariaWithHint('캡처 실행')}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50"
            >
              <Play className="w-4 h-4" aria-hidden />
              캡처 실행
            </button>
          )}
        </div>
      </MacCard>

      {/* 결과 */}
      {result && (
        <MacCard
          title="캡처 결과"
          bodyPadding="p-0"
          titleExtra={
            <span className="flex items-center gap-2 flex-wrap min-w-0">
              <StatusBadge status={result.status} />
              <span className="text-sm font-mono">{result.host}</span>
              <span className="text-sm text-muted-foreground tabular-nums">· 패킷 {result.packets.length}개 · {result.durationMs}ms</span>
              {result.exitCode != null && (
                <span className="text-xs text-muted-foreground font-mono">exit {result.exitCode}</span>
              )}
            </span>
          }
          actions={
            <button type="button" onClick={downloadRaw} disabled={!result.raw}
              title="tcpdump 원본 출력을 텍스트 파일로 저장"
              className="flex items-center gap-1 px-2 py-1 text-xs rounded-xl bg-secondary hover:bg-secondary/80 disabled:opacity-50">
              <Download className="w-3 h-3" aria-hidden /> 원본 저장
            </button>
          }
        >

          {result.error && (
            <div role="alert" className="px-3 py-2 flex items-start gap-2 bg-status-critical/5 border-b border-border">
              <AlertTriangle className="w-4 h-4 text-status-critical flex-shrink-0 mt-0.5" aria-hidden />
              <p className="text-sm text-status-critical">{result.error}</p>
            </div>
          )}

          <div className="px-3 py-2 text-xs text-muted-foreground font-mono border-b border-border flex items-center gap-1">
            <Terminal className="w-3 h-3" aria-hidden />
            <span className="truncate" title={result.executed}>{result.executed}</span>
          </div>

          <div className="max-h-[480px] overflow-auto">
            <PacketTable rows={result.packets} />
          </div>

          {result.stderr && (
            <div className="border-t border-border p-2 bg-muted/20">
              <p className="text-xs text-muted-foreground mb-1">표준 오류(stderr)</p>
              <LogViewer text={result.stderr} maxHeight="max-h-40" asError hideToolbar />
            </div>
          )}
        </MacCard>
      )}

      {!result && (
        <EmptyState
          icon={Info}
          title="아직 캡처한 패킷이 없습니다"
          description={'대상 노드와 자격증명을 입력하고 "캡처 실행"을 누르면 원격에서 tcpdump 를 수행합니다. 실행 전 확인 창이 뜹니다.'}
        />
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="원격 tcpdump 실행"
        description={`${host || '(호스트 없음)'} 에 SSH 로 접속해 tcpdump 로 패킷을 캡처합니다. 노드 설정은 바꾸지 않습니다.`}
        confirmLabel="실행"
        busy={runMut.isPending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => { setConfirmOpen(false); void doCapture(); }}
      >
        <dl className="space-y-1 text-xs">
          {([
            ['대상', `${selectedNode ? `${selectedNode} · ` : ''}${username}@${host}:${port}`],
            ['인터페이스', iface],
            ['BPF 필터', bpf || '(없음 — 전체)'],
            ['캡처', `${duration}초 · 최대 ${count}패킷`],
            ['sudo', useSudo ? '사용' : '미사용'],
          ] as const).map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="w-20 flex-shrink-0 text-muted-foreground">{k}</dt>
              <dd className="font-mono break-all">{v}</dd>
            </div>
          ))}
        </dl>
      </ConfirmDialog>
    </div>
  );
}
