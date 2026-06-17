import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import {
  Cpu, Play, Square, CheckCircle, XCircle, Clock,
  ShieldAlert, Wifi, Terminal, ChevronDown, ChevronRight,
} from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { ConfirmDialog, LogViewer, ClusterSidebar, SavedCommands } from '@/components/common';
import {
  bulkExecApi, type NodeSummary, type BulkExecResultItem, type BulkExecResponse,
} from '@/services/api';
import { formatApiError } from '@/lib/utils';

// ── 커널/OS 파라미터 조회 프리셋 ─────────────────────────────────────────────

interface Preset {
  key: string;
  label: string;
  description: string;
  cmd: string;
  danger?: boolean;  // 수정 등 위험 명령
}

const PRESETS: Preset[] = [
  {
    key: 'os-info',
    label: 'OS / Kernel 정보',
    description: 'OS 이름/버전, 커널, 호스트명, 가동시간, CPU',
    cmd: "echo '### os-release ###' && cat /etc/os-release 2>/dev/null | head -15 && "
       + "echo && echo '### uname ###' && uname -a && "
       + "echo && echo '### uptime ###' && uptime && "
       + "echo && echo '### cpu ###' && lscpu 2>/dev/null | head -20 || cat /proc/cpuinfo | head -20",
  },
  {
    key: 'sysctl-net',
    label: 'sysctl — 네트워크 (k8s/cilium 관련)',
    description: 'net.ipv4.ip_forward, bridge-nf, conntrack, somaxconn 등',
    cmd: "sysctl -a 2>/dev/null | grep -E "
       + "'^(net\\.ipv4\\.ip_forward|net\\.ipv4\\.conf\\.all\\.|net\\.bridge\\.|net\\.core\\.|"
       + "net\\.netfilter\\.|net\\.ipv6\\.conf\\.default\\.disable_ipv6)' | sort",
  },
  {
    key: 'conntrack',
    label: 'conntrack 현재치 vs 최대치',
    description: 'nf_conntrack_count / max 비율. k8s 네트워크 이슈 진단',
    cmd: "sysctl net.netfilter.nf_conntrack_count net.netfilter.nf_conntrack_max 2>/dev/null; "
       + "echo; cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null; "
       + "cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null",
  },
  {
    key: 'sysctl-mem',
    label: 'sysctl — 메모리 / VM',
    description: 'vm.max_map_count, swappiness, overcommit 등',
    cmd: "sysctl -a 2>/dev/null | grep -E '^(vm\\.|kernel\\.shm|kernel\\.msgmax|kernel\\.sem)' | sort",
  },
  {
    key: 'sysctl-fs',
    label: 'sysctl — 파일시스템 / inotify',
    description: 'fs.file-max, fs.inotify.*',
    cmd: "sysctl -a 2>/dev/null | grep -E '^(fs\\.|kernel\\.pid_max)' | sort",
  },
  {
    key: 'sysctl-conf-files',
    label: '/etc/sysctl.d/ 파일 목록 + 내용',
    description: '부팅 시 적용되는 sysctl 파일들',
    cmd: "ls -la /etc/sysctl.d/ 2>/dev/null && echo && "
       + "for f in /etc/sysctl.d/*.conf /etc/sysctl.conf; do "
       + "[ -f \"$f\" ] && echo && echo \"### $f ###\" && cat \"$f\"; done",
  },
  {
    key: 'limits',
    label: 'ulimit / limits.conf',
    description: '사용자별 파일 핸들/프로세스 제한',
    cmd: "echo '### ulimit -a (현재 쉘) ###' && ulimit -a && "
       + "echo && echo '### /etc/security/limits.conf ###' && "
       + "grep -vE '^\\s*(#|$)' /etc/security/limits.conf 2>/dev/null && "
       + "echo && echo '### /etc/security/limits.d/ ###' && "
       + "for f in /etc/security/limits.d/*.conf; do "
       + "[ -f \"$f\" ] && echo \"=== $f ===\" && grep -vE '^\\s*(#|$)' \"$f\"; done",
  },
  {
    key: 'memory',
    label: '메모리 / swap 상태',
    description: 'free, swap, cgroup memory',
    cmd: "free -h && echo && swapon --show 2>/dev/null && "
       + "echo && echo '### /proc/meminfo head ###' && head -25 /proc/meminfo",
  },
  {
    key: 'disk-io',
    label: '디스크 I/O / 마운트',
    description: 'df, lsblk, mount, IO scheduler',
    cmd: "df -hT 2>/dev/null | head -25 && echo && lsblk 2>/dev/null && echo && "
       + "mount | grep -v -E '^(proc|sysfs|tmpfs|devpts|cgroup|overlay|fuse)' | head -20 && "
       + "echo && echo '### IO scheduler ###' && for d in /sys/block/*/queue/scheduler; do "
       + "echo \"$d → $(cat $d 2>/dev/null)\"; done",
  },
  {
    key: 'kernel-modules',
    label: '로드된 커널 모듈',
    description: 'lsmod — k8s/cilium 관련 (ip_tables, br_netfilter 등)',
    cmd: "lsmod | head -1 && lsmod | grep -E "
       + "'^(br_netfilter|nf_conntrack|iptable|ip_tables|ip_set|xt_|nfnetlink|bpf|cls_bpf|overlay)'",
  },
  {
    key: 'time-sync',
    label: '시간 동기화 상태 (chronyd / NTP)',
    description: 'etcd 가 가장 민감 — time sync 필수',
    cmd: "timedatectl 2>/dev/null && echo && "
       + "chronyc tracking 2>/dev/null || ntpstat 2>/dev/null || echo '(chronyc/ntpstat 없음)'",
  },
];

// ── 상태 색상 ──────────────────────────────────────────────────────────────

const STATUS_META: Record<BulkExecResultItem['status'], { label: string; cls: string; icon: React.ComponentType<{ className?: string }> }> = {
  ok:            { label: '정상',     cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',  icon: CheckCircle },
  error:         { label: '에러',     cls: 'bg-red-500/10 text-red-400 border-red-500/30',              icon: XCircle },
  timeout:       { label: '타임아웃', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30',        icon: Clock },
  auth_error:    { label: '인증 실패', cls: 'bg-orange-500/10 text-orange-400 border-orange-500/30',    icon: ShieldAlert },
  connect_error: { label: '연결 실패', cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30',       icon: Wifi },
};

// ── 노드 선택 리스트 row ────────────────────────────────────────────────────

function NodeRow({ node, checked, onToggle }: { node: NodeSummary; checked: boolean; onToggle: () => void }) {
  const host = node.internalIp || node.name;
  return (
    <label className={`flex items-center gap-2 px-3 py-2 cursor-pointer border-b border-border/40 last:border-b-0 hover:bg-muted/30 ${
      checked ? 'bg-primary/5' : ''
    }`}>
      <input type="checkbox" checked={checked} onChange={onToggle} className="w-4 h-4 accent-primary" />
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${node.ready ? 'bg-emerald-500' : 'bg-red-500'}`} />
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-mono text-foreground truncate">{node.name}</span>
        <span className="block text-sm font-mono text-muted-foreground">{host}</span>
      </span>
      <span className="flex gap-1 flex-shrink-0">
        {node.roles.map((r) => (
          <span key={r} className="text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">{r}</span>
        ))}
      </span>
    </label>
  );
}

// ── 결과 카드 (노드별) ──────────────────────────────────────────────────────

function ResultCard({
  result, command, globalFilter, defaultOpen,
}: { result: BulkExecResultItem; command: string; globalFilter: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const meta = STATUS_META[result.status];
  const Icon = meta.icon;

  // 실패한 노드도 사용자가 즉시 사유를 알 수 있게 헤더에 한 줄 미리보기 표시.
  const inlinePreview =
    result.status !== 'ok'
      ? (result.error?.trim() || result.stderr.trim().split('\n')[0] || '')
      : '';

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors text-left"
      >
        {open ? <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
        <span className="font-mono text-sm text-foreground flex-shrink-0">{result.host}</span>
        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium flex-shrink-0 ${meta.cls}`}>
          <Icon className="w-3 h-3" />
          {meta.label}
        </span>
        {inlinePreview && !open && (
          <span className="text-xs text-red-400/90 font-mono truncate min-w-0">
            {inlinePreview}
          </span>
        )}
        <span className="ml-auto text-sm font-mono text-muted-foreground flex-shrink-0">
          {result.exitCode !== null && result.exitCode !== undefined ? `exit ${result.exitCode} · ` : ''}
          {result.durationMs}ms · {result.stdout.length}B
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-2">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">command</p>
          <pre className="text-xs font-mono bg-background border border-border rounded p-2 overflow-auto whitespace-pre-wrap break-all max-h-24">
            {command}
          </pre>
          {result.error && (
            <p className="text-sm text-red-400 font-mono break-all">⚠ {result.error}</p>
          )}
          <p className="text-xs uppercase tracking-wider text-muted-foreground">stdout</p>
          {result.stdout.trim() ? (
            <LogViewer text={result.stdout} maxHeight="max-h-96" filterOverride={globalFilter || undefined} hideToolbar={!!globalFilter.trim()} />
          ) : (
            <p className="text-xs text-muted-foreground italic px-2 py-1.5 bg-background border border-border rounded">
              (no output — 명령은 실행됐지만 stdout 이 비어있음. stderr 또는 exit code 를 확인하세요.)
            </p>
          )}
          {result.stderr && (
            <>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">stderr</p>
              <LogViewer text={result.stderr} maxHeight="max-h-40" asError filterOverride={globalFilter || undefined} hideToolbar={!!globalFilter.trim()} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── 메인 페이지 ──────────────────────────────────────────────────────────────

export function KernelParamsPage() {
  const { data: clusters = [] } = useClusters();
  const [clusterId, setClusterId] = useState('');
  useEffect(() => {
    if (!clusterId && clusters.length > 0) setClusterId(clusters[0].id);
  }, [clusters, clusterId]);

  const nodesQ = useQuery({
    queryKey: ['bulk-exec', 'nodes', clusterId],
    queryFn: () => bulkExecApi.nodeList(clusterId).then((r) => r.data),
    enabled: !!clusterId,
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setSelected(new Set()), [clusterId]);
  const toggle = (name: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  const toggleAll = () => {
    const all = (nodesQ.data?.nodes ?? []).map((n) => n.name);
    setSelected((prev) => prev.size === all.length ? new Set() : new Set(all));
  };

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  // 실행 구성
  const [presetKey, setPresetKey] = useState<string>('os-info');
  const [customCmd, setCustomCmd] = useState('');
  const [username, setUsername] = useState('root');
  const [port, setPort] = useState(22);
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [mode, setMode] = useState<'parallel' | 'sequential'>('parallel');

  const preset = PRESETS.find((p) => p.key === presetKey);
  const useCustom = presetKey === 'custom';
  const commandToRun = useCustom ? customCmd : (preset?.cmd ?? '');

  const selectedHosts = useMemo(() => {
    const byName = new Map((nodesQ.data?.nodes ?? []).map((n) => [n.name, n]));
    return Array.from(selected).map((name) => {
      const n = byName.get(name);
      return { name, host: n?.internalIp || n?.name || name };
    });
  }, [selected, nodesQ.data]);

  const [runResponse, setRunResponse] = useState<BulkExecResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [globalFilter, setGlobalFilter] = useState('');
  const [allOpen, setAllOpen] = useState(true);
  const resultsRef = useRef<HTMLElement | null>(null);

  const runMut = useAbortableMutation({
    mutationFn: async (_: void, signal) => {
      const res = await bulkExecApi.run({
        clusterId: clusterId || undefined,
        action: 'ssh',
        targets: selectedHosts.map((t) => ({ host: t.host })),
        username, port,
        password: authMode === 'password' ? password : undefined,
        privateKey: authMode === 'key' ? privateKey : undefined,
        command: commandToRun,
        mode,
        parallelism: 10,
        connectTimeout: 8,
        execTimeout: 60,
      }, signal);
      return res.data;
    },
    onSuccess: (d) => {
      setRunResponse(d);
      setAllOpen(true);
      // 결과가 화면 아래쪽에 그려져 사용자가 못 볼 가능성을 줄이기 위해 자동 스크롤
      requestAnimationFrame(() => {
        resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    },
  });

  const canRun = !!clusterId && selected.size > 0
    && (authMode === 'password' ? !!password : !!privateKey.trim())
    && !!commandToRun.trim();

  const runError = runMut.error as { response?: { data?: { detail?: string } }; message?: string } | null;

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto px-3 py-3 flex gap-3">
        <ClusterSidebar clusters={clusters} selectedId={clusterId || null} onSelect={(id) => setClusterId(id ?? '')} iconOnly />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-6">
            <Cpu className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">OS / 커널 파라미터 조회</h1>
            {nodesQ.data?.nodes && (
              <span className="text-sm px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-400 border border-slate-500/30">
                선택 {selected.size} / {nodesQ.data.nodes.length}
              </span>
            )}
          </div>

          <div className="bg-card border border-border rounded-xl p-4 mb-5 text-sm text-muted-foreground leading-relaxed">
            노드에 SSH 로 접속해 sysctl / limits / 모듈 / 디스크 등의 상태를 조회합니다.
            수정은 하지 않으며(읽기 전용), 인증정보는 이 실행에만 사용되고 저장되지 않습니다.
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* 좌: 노드 선택 */}
            <section className="bg-card border border-border rounded-xl overflow-hidden">
              <header className="px-4 py-3 border-b border-border bg-muted/20 flex items-center justify-between">
                <h2 className="text-sm font-semibold">대상 노드</h2>
                <button
                  onClick={toggleAll}
                  disabled={!nodesQ.data?.nodes?.length}
                  className="text-sm text-primary hover:text-primary/80 disabled:opacity-40"
                >
                  {selected.size === (nodesQ.data?.nodes?.length ?? 0) ? '전체 해제' : '전체 선택'}
                </button>
              </header>
              <div className="max-h-[540px] overflow-y-auto">
                {!clusterId ? (
                  <p className="text-center text-muted-foreground text-sm py-10">클러스터를 선택하세요.</p>
                ) : nodesQ.isLoading ? (
                  <p className="text-center text-muted-foreground text-sm py-10">불러오는 중…</p>
                ) : (nodesQ.data?.nodes ?? []).map((n) => (
                  <NodeRow key={n.name} node={n} checked={selected.has(n.name)} onToggle={() => toggle(n.name)} />
                ))}
              </div>
            </section>

            {/* 우: 프리셋 + 인증 */}
            <section className="lg:col-span-2 bg-card border border-border rounded-xl p-5 space-y-4">
              {/* 프리셋 */}
              <div>
                <p className="text-sm text-muted-foreground mb-2">프리셋</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {PRESETS.map((p) => {
                    const active = presetKey === p.key;
                    return (
                      <button
                        key={p.key}
                        onClick={() => setPresetKey(p.key)}
                        className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-left transition-colors ${
                          active
                            ? 'bg-primary/10 border-primary/40 text-primary'
                            : 'bg-secondary/40 border-border hover:bg-secondary text-foreground'
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold truncate">{p.label}</p>
                          <p className="text-xs text-muted-foreground line-clamp-2">{p.description}</p>
                        </div>
                      </button>
                    );
                  })}
                  <button
                    onClick={() => setPresetKey('custom')}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-left ${
                      presetKey === 'custom'
                        ? 'bg-primary/10 border-primary/40 text-primary'
                        : 'bg-secondary/40 border-border hover:bg-secondary text-foreground'
                    }`}
                  >
                    <Terminal className="w-3.5 h-3.5" />
                    <span className="text-sm font-semibold">직접 입력</span>
                  </button>
                </div>
              </div>

              {useCustom && (
                <div>
                  <label htmlFor={f('cmd')} className="text-sm text-muted-foreground mb-1 block">명령 (읽기 전용 권장)</label>
                  <textarea
                    id={f('cmd')}
                    value={customCmd}
                    onChange={(e) => setCustomCmd(e.target.value)}
                    placeholder="예: sysctl net.ipv4.ip_forward"
                    rows={3}
                    className="w-full px-3 py-2 text-[12px] font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                  />
                  <SavedCommands
                    className="mt-2"
                    storageKey="k8s:saved-cmd:kernel-params"
                    currentValue={customCmd}
                    onPick={(v) => { setCustomCmd(v); setPresetKey('custom'); }}
                  />
                </div>
              )}

              {/* 인증 */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label htmlFor={f('user')} className="block text-sm text-muted-foreground mb-1">사용자</label>
                  <input id={f('user')} type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
                </div>
                <div>
                  <label htmlFor={f('port')} className="block text-sm text-muted-foreground mb-1">포트</label>
                  <input id={f('port')} type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)}
                    className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
                </div>
                <div>
                  <p className="block text-sm text-muted-foreground mb-1">인증</p>
                  <div className="flex items-center bg-secondary/60 rounded-lg p-[3px] gap-px">
                    {(['password', 'key'] as const).map((m) => (
                      <button key={m} onClick={() => setAuthMode(m)}
                        className={`flex-1 px-2 py-1.5 text-sm font-medium rounded-md transition-all ${
                          authMode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground/70 hover:text-foreground'
                        }`}>
                        {m === 'password' ? '비밀번호' : 'Private Key'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {authMode === 'password' ? (
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="SSH 비밀번호"
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
              ) : (
                <textarea value={privateKey} onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" rows={4}
                  className="w-full px-3 py-2 text-xs font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary resize-none" />
              )}

              {/* 모드 */}
              <div className="flex items-center gap-2">
                <p className="text-sm text-muted-foreground">실행 모드:</p>
                <div className="flex items-center bg-secondary/60 rounded-lg p-[3px] gap-px">
                  {(['parallel', 'sequential'] as const).map((m) => (
                    <button key={m} onClick={() => setMode(m)}
                      className={`px-3 py-1.5 text-sm font-medium rounded-md transition-all ${
                        mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground/70 hover:text-foreground'
                      }`}>
                      {m === 'parallel' ? '병렬' : '순차'}
                    </button>
                  ))}
                </div>
              </div>

              {/* 미리보기 */}
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">실행될 명령</p>
                <pre className="text-xs font-mono bg-background border border-border rounded p-2 overflow-auto whitespace-pre-wrap break-all max-h-24">
                  {commandToRun || '(선택된 프리셋 없음)'}
                </pre>
              </div>

              {runError && (
                <div className="px-3 py-2 text-sm rounded-lg bg-destructive/10 text-destructive border border-destructive/30">
                  {formatApiError(runError)}
                </div>
              )}

              <div className="flex justify-end pt-2 border-t border-border">
                {runMut.isPending ? (
                  <button
                    onClick={runMut.abort}
                    className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-red-500 hover:bg-red-600 text-primary-foreground rounded-lg transition-colors"
                  >
                    <Square className="w-4 h-4 fill-current" />
                    중지
                  </button>
                ) : (
                  <button
                    onClick={() => setConfirmOpen(true)}
                    disabled={!canRun}
                    className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors disabled:opacity-50"
                  >
                    <Play className="w-4 h-4" />
                    조회 ({selected.size} 노드)
                  </button>
                )}
              </div>
            </section>
          </div>

          {/* 결과: 노드별 카드 */}
          {runResponse && (
            <section ref={resultsRef} className="mt-6 space-y-3 scroll-mt-6">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-sm font-semibold">결과 — {runResponse.total}개 노드</h2>
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                  정상 {runResponse.okCount}
                </span>
                {runResponse.errorCount > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/30">
                    실패 {runResponse.errorCount}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  {runResponse.totalDurationMs}ms · {runResponse.mode}
                </span>
                {/* 전체 펼침/접힘 토글 — 키 변경으로 카드 defaultOpen 다시 적용 */}
                <button
                  onClick={() => setAllOpen((v) => !v)}
                  className="text-xs px-2 py-1 rounded-md border border-border bg-card hover:bg-secondary"
                >
                  {allOpen ? '전체 접기' : '전체 펼치기'}
                </button>
                {/* 전 노드 공통 필터 */}
                <div className="ml-auto flex items-center gap-1.5">
                  <div className="relative">
                    <input
                      value={globalFilter}
                      onChange={(e) => setGlobalFilter(e.target.value)}
                      placeholder="모든 노드 결과 공통 필터..."
                      className="pl-2 pr-7 py-1 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary w-64"
                    />
                    {globalFilter && (
                      <button
                        onClick={() => setGlobalFilter('')}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        ×
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {runResponse.results.length === 0 ? (
                <p className="text-sm text-muted-foreground italic px-3 py-2 bg-card border border-border rounded-lg">
                  (노드 결과가 비어있음 — targets 가 비어있었는지 확인하세요.)
                </p>
              ) : (
                runResponse.results.map((r) => (
                  <ResultCard
                    // allOpen 토글 시 카드 강제 재마운트로 defaultOpen 재적용
                    key={`${r.host}-${allOpen ? 'open' : 'closed'}`}
                    result={r}
                    command={commandToRun}
                    globalFilter={globalFilter}
                    defaultOpen={allOpen}
                  />
                ))
              )}
            </section>
          )}
        </div>
      </main>

      <ConfirmDialog
        open={confirmOpen}
        title="커널 파라미터 조회 확인"
        description={`${selected.size}개 노드에 SSH 접속 후 조회 명령을 실행합니다 (읽기 전용).`}
        confirmLabel="조회"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => { setConfirmOpen(false); runMut.mutate(); }}
      >
        <div className="space-y-2">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">프리셋</p>
            <p className="text-sm font-semibold">{preset?.label ?? '직접 입력'}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">실행 명령</p>
            <pre className="text-xs font-mono bg-background border border-border rounded p-2 max-h-28 overflow-auto whitespace-pre-wrap break-all">
              {commandToRun}
            </pre>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">대상 ({selected.size})</p>
            <div className="text-xs font-mono max-h-20 overflow-auto bg-background border border-border rounded p-2">
              {selectedHosts.slice(0, 8).map((t) => <div key={t.name}>{t.name}</div>)}
              {selectedHosts.length > 8 && <div className="text-muted-foreground">+ {selectedHosts.length - 8}개 더…</div>}
            </div>
          </div>
        </div>
      </ConfirmDialog>
    </div>
  );
}
