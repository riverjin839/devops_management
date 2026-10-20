import { useEffect, useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import {
  Cpu, Play, Square, CheckCircle2, XCircle, Clock, AlertTriangle,
  ShieldAlert, Wifi, Terminal, ChevronDown, ChevronRight, X,
} from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useTerminalEnvSync } from '@/hooks/useTerminalEnvSync';
import { useRunLog, runLogged, consoleRunLines } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import {
  ConfirmDialog, ExecOutputTabs, ClusterSidebar, SavedCommands, SelectClusterEmptyState, LoadingState, EmptyState, ErrorState,
  PageShell, RunLogPanel, useToast,
} from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { MacCard } from '@/components/ui/MacCard';
import {
  bulkExecApi, type NodeSummary, type BulkExecResultItem, type BulkExecResponse,
} from '@/services/api';
import { formatApiError } from '@/lib/utils';
import { maskCommand } from '@/lib/commandMask';
import { judgeCommand } from '@/lib/dangerCommand';

// ── 커널/OS 파라미터 조회 프리셋 ─────────────────────────────────────────────
// 프리셋은 전부 조회 전용이다(D-171) — 위험 판정은 "직접 입력"에만 `lib/dangerCommand` 셸 allowlist 로 한다.

interface Preset {
  key: string;
  label: string;
  description: string;
  cmd: string;
}

const PRESETS: Preset[] = [
  {
    key: 'os-info',
    label: 'OS·커널 정보',
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
  ok:            { label: '정상',     cls: 'bg-secondary text-muted-foreground border-border',  icon: CheckCircle2 },
  error:         { label: '오류',     cls: 'bg-status-critical/10 text-status-critical border-status-critical/30',              icon: XCircle },
  timeout:       { label: '타임아웃', cls: 'bg-status-warning/10 text-status-warning border-status-warning/30',        icon: Clock },
  auth_error:    { label: '인증 실패', cls: 'bg-status-warning/10 text-status-warning border-status-warning/30',    icon: ShieldAlert },
  connect_error: { label: '연결 실패', cls: 'bg-status-unknown/10 text-status-unknown border-status-unknown/30',       icon: Wifi },
};

/** 실패 토스트 — 서버 403(역할·테넌트 권한 부족)은 사유를 그대로 보여 준다(D-172). 실행 로그에는 runLogged 가 error 줄을 남긴다. */
function toastFailure(toast: ReturnType<typeof useToast>, title: string, error: unknown) {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  toast.error(status === 403 ? `${title} — 권한이 없습니다` : `${title} 실패`, formatApiError(error));
}

// ── 노드 선택 리스트 row ────────────────────────────────────────────────────

function NodeRow({ node, checked, onToggle }: { node: NodeSummary; checked: boolean; onToggle: () => void }) {
  const host = node.internalIp || node.name;
  const readyLabel = node.ready ? 'Ready' : 'NotReady';
  return (
    <label className={`flex items-center gap-2 px-3 py-2 cursor-pointer border-b border-border/40 last:border-b-0 hover:bg-muted/30 ${
      checked ? 'bg-primary/5' : ''
    }`}>
      <input type="checkbox" checked={checked} onChange={onToggle} className="w-4 h-4 accent-primary" />
      <span
        title={`노드 상태: ${readyLabel}`}
        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${node.ready ? 'bg-muted-foreground/40' : 'bg-status-critical'}`}
      />
      <span className="sr-only">노드 상태 {readyLabel},</span>
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

// ── 결과 행 (노드별) — stdout/stderr 는 ExecOutputTabs(§12.6-2) ───────────────

function ResultRow({
  result, globalFilter, defaultOpen,
}: { result: BulkExecResultItem; globalFilter: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const meta = STATUS_META[result.status];
  const Icon = meta.icon;
  const empty = !result.stdout.trim() && !(result.stderr ?? '').trim();

  // 실패한 노드도 사용자가 즉시 사유를 알 수 있게 헤더에 한 줄 미리보기 표시.
  const inlinePreview =
    result.status !== 'ok'
      ? (result.error?.trim() || result.stderr.trim().split('\n')[0] || '')
      : '';

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors text-left"
      >
        {open ? <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" aria-hidden="true" /> : <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" aria-hidden="true" />}
        <span className="font-mono text-sm text-foreground flex-shrink-0">{result.host}</span>
        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium flex-shrink-0 ${meta.cls}`}>
          <Icon className="w-3 h-3" aria-hidden="true" />
          {meta.label}
        </span>
        {inlinePreview && !open && (
          <span className="text-xs text-status-critical font-mono truncate min-w-0">
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
          {result.error && (
            <p className="text-sm text-status-critical font-mono break-all flex items-start gap-1"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />{result.error}</p>
          )}
          {empty ? (
            <EmptyState
              compact
              icon={Terminal}
              title="출력이 없습니다"
              description="명령은 실행됐지만 stdout·stderr 가 비어 있습니다. exit code 를 확인하세요."
            />
          ) : (
            <ExecOutputTabs
              stdout={result.stdout}
              stderr={result.stderr}
              maxHeight="max-h-80"
              filterOverride={globalFilter || undefined}
              hideToolbar={!!globalFilter.trim()}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── 결과 패널 — 우측 고정, 실행 전에도 같은 자리에 플레이스홀더(§12.6-1) ─────────

function ResultPanel({
  response, command, pending,
}: { response: BulkExecResponse | null; command: string; pending: boolean }) {
  const [globalFilter, setGlobalFilter] = useState('');
  const [allOpen, setAllOpen] = useState(true);
  // 새 실행 결과가 오면 전부 펼친다.
  useEffect(() => { setAllOpen(true); }, [response]);

  if (!response) {
    return (
      <div className="min-w-0 flex items-center justify-center min-h-[200px] lg:h-[calc(100vh-260px)]">
        {pending ? (
          <LoadingState compact label="노드 응답을 기다리는 중…" />
        ) : (
          <EmptyState
            compact
            icon={Terminal}
            title="아직 조회 결과가 없습니다."
            description="노드를 고르고 프리셋이나 명령을 실행하면 노드별 결과가 여기에 표시됩니다."
          />
        )}
      </div>
    );
  }

  return (
    <MacCard
      title="조회 결과"
      titleExtra={
        <span className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground tabular-nums">{response.total}개 노드</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border tabular-nums">
            정상 {response.okCount}
          </span>
          {response.errorCount > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-status-critical/10 text-status-critical border border-status-critical/30">
              실패 {response.errorCount}
            </span>
          )}
          <span className="text-xs text-muted-foreground tabular-nums">
            {response.totalDurationMs}ms · {response.mode === 'sequential' ? '순차' : '병렬'}
          </span>
        </span>
      }
      actions={
        <>
          {/* 전체 펼침/접힘 토글 — 키 변경으로 행 defaultOpen 다시 적용 */}
          <button
            type="button"
            onClick={() => setAllOpen((v) => !v)}
            className="text-xs px-2 py-1 rounded-xl border border-border bg-card hover:bg-secondary"
          >
            {allOpen ? '전체 접기' : '전체 펼치기'}
          </button>
          {/* 전 노드 공통 필터 */}
          <div className="relative">
            <input
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder="모든 노드 결과 공통 필터…"
              aria-label="모든 노드 결과 공통 필터"
              className="pl-2 pr-7 py-1 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary w-56"
            />
            {globalFilter && (
              <button
                type="button"
                onClick={() => setGlobalFilter('')}
                aria-label="필터 지우기"
                title="필터 지우기"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="w-3.5 h-3.5" aria-hidden />
              </button>
            )}
          </div>
        </>
      }
      rootClassName="min-w-0 flex flex-col lg:h-[calc(100vh-260px)]"
      bodyPadding="p-0"
      className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden divide-y divide-border"
    >
      <div className="px-4 py-2.5">
        <p className="text-xs font-medium text-muted-foreground mb-1">실행한 명령</p>
        <code className="block text-xs font-mono bg-background border border-border rounded-md p-2 max-h-24 overflow-auto whitespace-pre-wrap break-all">
          {command}
        </code>
      </div>
      {response.results.length === 0 ? (
        <EmptyState
          compact
          icon={Cpu}
          title="노드 결과가 비어 있습니다"
          description="대상 노드가 비어 있었는지 확인한 뒤 다시 조회하세요."
        />
      ) : (
        response.results.map((r) => (
          <ResultRow
            // allOpen 토글 시 행 강제 재마운트로 defaultOpen 재적용
            key={`${r.host}-${allOpen ? 'open' : 'closed'}`}
            result={r}
            globalFilter={globalFilter}
            defaultOpen={allOpen}
          />
        ))
      )}
    </MacCard>
  );
}

// ── 메인 페이지 ──────────────────────────────────────────────────────────────

export function KernelParamsPage() {
  const clustersQ = useClusters();
  const { data: clusters = [] } = clustersQ;
  const [clusterId, setClusterId] = useState('');
  useEffect(() => {
    if (!clusterId && clusters.length > 0) setClusterId(clusters[0].id);
  }, [clusters, clusterId]);
  // 선택 클러스터 운영등급 → 터미널 Appearance(개발/운영) 자동 적용.
  useTerminalEnvSync(clusters, clusterId || null);
  const toast = useToast();
  const { canOperate, withHint, ariaWithHint } = useCanOperate(clusterId || null);

  const nodesQ = useQuery({
    queryKey: ['bulk-exec', 'nodes', clusterId],
    queryFn: () => bulkExecApi.nodeList(clusterId).then((r) => r.data),
    enabled: !!clusterId,
  });
  const nodes = nodesQ.data?.nodes;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setSelected(new Set()), [clusterId]);
  const toggle = (name: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  const toggleAll = () => {
    const all = (nodes ?? []).map((n) => n.name);
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
  const commandMasked = maskCommand(commandToRun);

  // D-171 ③ — 프리셋은 조회 전용, 직접 입력은 셸 조회 allowlist 밖이면 danger.
  const verdict = useMemo(() => (useCustom ? judgeCommand(customCmd, 'shell') : null), [useCustom, customCmd]);
  const isDanger = !!verdict && !verdict.readOnly;

  const selectedHosts = useMemo(() => {
    const byName = new Map((nodes ?? []).map((n) => [n.name, n]));
    return Array.from(selected).map((name) => {
      const n = byName.get(name);
      return { name, host: n?.internalIp || n?.name || name };
    });
  }, [selected, nodes]);

  const [runResponse, setRunResponse] = useState<BulkExecResponse | null>(null);
  const [ranCommand, setRanCommand] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

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
  });

  // 실행 수명주기 로그 — 노드별 출력은 우측 결과 패널, 여기는 요청·대기·노드별 상태 요약·실패 사유.
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('kernel-params-run');
  const runTitle = useCustom ? '노드 명령 실행' : '커널 파라미터 조회';
  const doRun = async () => {
    const names = selectedHosts.map((t) => t.name);
    const shown = commandMasked.length > 200 ? `${commandMasked.slice(0, 200)}…` : commandMasked;
    const r = await runLogged(runLog, {
      title: runTitle,
      first: `${names.length}개 노드(${names.slice(0, 5).join(', ')}${names.length > 5 ? ` 외 ${names.length - 5}` : ''}) — SSH ${username} 포트 ${port} · ${mode === 'parallel' ? '병렬' : '순차'} · ${preset ? `프리셋 ${preset.label}` : `직접 입력 — ${shown}`} 실행 요청`,
      fn: () => runMut.mutateAsync(),
      summarize: (res) => consoleRunLines(res.results.map((x) => ({
        host: x.name && x.name !== x.host ? `${x.name}(${x.host})` : x.host,
        status: x.status, exitCode: x.exitCode, durationMs: x.durationMs, stderr: x.stderr, error: x.error,
      }))),
    });
    if (r.ok) {
      setRunResponse(r.data);
      setRanCommand(commandMasked);
    } else if (!r.aborted) {
      toastFailure(toast, runTitle, r.error);
    }
  };

  const canRun = !!clusterId && selected.size > 0
    && (authMode === 'password' ? !!password : !!privateKey.trim())
    && !!commandToRun.trim();

  const runError = runMut.error as { response?: { data?: { detail?: string } }; message?: string } | null;
  const runLabel = `${useCustom ? '실행' : '조회'} (${selected.size} 노드)`;

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" className="flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={clusterId || null}
          onSelect={(id) => { setClusterId(id ?? ''); setRunResponse(null); }}
          iconOnly
        />

        <div className="flex-1 min-w-0">
          <PageHeader
            className="mb-6"
            icon={Cpu}
            title="OS / 커널 파라미터 조회"
            titleExtra={nodes ? (
              <span className="text-sm px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border">
                선택 {selected.size} / {nodes.length}
              </span>
            ) : undefined}
          />

          <p className="mb-5 text-sm text-muted-foreground leading-relaxed">
            노드에 SSH 로 접속해 sysctl / limits / 모듈 / 디스크 등의 상태를 조회합니다.
            프리셋은 조회 전용입니다. 직접 입력한 명령은 그대로 실행되므로 조회 명령(sysctl·cat·ls·lsmod 등) 밖의 명령은 위험 확인을 거칩니다.
            인증정보는 이 실행에만 사용되고 저장되지 않습니다.
          </p>

          {clustersQ.isError ? (
            <ErrorState error={clustersQ.error} title="클러스터 목록을 불러오지 못했습니다" onRetry={() => { void clustersQ.refetch(); }} />
          ) : (
          /* 좌(컨트롤 4) / 우(결과 6) 한 로우 — §12.6-1. 결과는 실행 전에도 같은 자리에 플레이스홀더. */
          <div className="grid grid-cols-1 lg:grid-cols-10 gap-5 items-start">
            <div className="lg:col-span-4 min-w-0 flex flex-col gap-4">
              {/* 노드 선택 — 전체 선택 액션은 헤더 actions 슬롯 */}
              <MacCard
                title="대상 노드"
                bodyPadding="p-0"
                actions={
                  <button
                    type="button"
                    onClick={toggleAll}
                    disabled={!nodes?.length}
                    className="text-sm text-primary hover:text-primary/80 disabled:opacity-40"
                  >
                    {selected.size === (nodes?.length ?? 0) && selected.size > 0 ? '전체 해제' : '전체 선택'}
                  </button>
                }
              >
                <div className="max-h-[280px] overflow-y-auto">
                  {!clusterId ? (
                    <SelectClusterEmptyState compact />
                  ) : nodesQ.isLoading ? (
                    <LoadingState compact />
                  ) : nodesQ.isError ? (
                    <ErrorState compact error={nodesQ.error} title="노드 목록을 불러오지 못했습니다" onRetry={() => { void nodesQ.refetch(); }} />
                  ) : !nodes?.length ? (
                    <EmptyState
                      compact
                      icon={Cpu}
                      title="노드가 없습니다"
                      description="이 클러스터에서 조회된 노드가 0개입니다. kubeconfig 권한(nodes list)과 클러스터 연결을 확인하세요."
                    />
                  ) : nodes.map((n) => (
                    <NodeRow key={n.name} node={n} checked={selected.has(n.name)} onToggle={() => toggle(n.name)} />
                  ))}
                </div>
              </MacCard>

              {/* 명령 + 인증 */}
              <MacCard title="명령" bodyPadding="p-5" className="space-y-4">
                {/* 프리셋 */}
                <div>
                  <p id={f('presetLabel')} className="text-sm text-muted-foreground mb-2">프리셋 <span className="text-xs opacity-60">(조회 전용)</span></p>
                  <div role="group" aria-labelledby={f('presetLabel')} className="grid grid-cols-1 xl:grid-cols-2 gap-1.5">
                    {PRESETS.map((p) => {
                      const active = presetKey === p.key;
                      return (
                        <button
                          key={p.key}
                          type="button"
                          onClick={() => setPresetKey(p.key)}
                          aria-pressed={active}
                          // 이름은 라벨, 설명은 describedby — aria-label 이 설명을 덮지 않게(D-178).
                          aria-label={p.label}
                          aria-describedby={f(`preset-${p.key}-desc`)}
                          className={`flex items-start gap-2 px-3 py-2 rounded-xl border text-left transition-colors ${
                            active
                              ? 'bg-primary/10 border-primary/40 text-primary'
                              : 'bg-secondary/40 border-border hover:bg-secondary text-foreground'
                          }`}
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold truncate">{p.label}</p>
                            <p id={f(`preset-${p.key}-desc`)} className="text-xs text-muted-foreground line-clamp-2">{p.description}</p>
                          </div>
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => setPresetKey('custom')}
                      aria-pressed={useCustom}
                      className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-left ${
                        useCustom
                          ? 'bg-primary/10 border-primary/40 text-primary'
                          : 'bg-secondary/40 border-border hover:bg-secondary text-foreground'
                      }`}
                    >
                      <Terminal className="w-3.5 h-3.5" aria-hidden="true" />
                      <span className="text-sm font-semibold">직접 입력</span>
                    </button>
                  </div>
                </div>

                {useCustom && (
                  <div>
                    <label htmlFor={f('cmd')} className="text-sm text-muted-foreground mb-1 block">
                      명령 직접 입력 <span className="text-xs opacity-60">(조회 명령 밖은 위험 확인)</span>
                    </label>
                    <textarea
                      id={f('cmd')}
                      value={customCmd}
                      onChange={(e) => setCustomCmd(e.target.value)}
                      placeholder="예: sysctl net.ipv4.ip_forward"
                      rows={3}
                      aria-describedby={verdict && customCmd.trim() ? f('verdict') : undefined}
                      className="w-full px-3 py-2 text-xs font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                    />
                    {verdict && customCmd.trim() && (
                      <p id={f('verdict')} className={`mt-1 text-xs flex items-start gap-1 ${verdict.readOnly ? 'text-muted-foreground' : 'text-status-critical'}`}>
                        {!verdict.readOnly && <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
                        {verdict.readOnly ? `조회 명령으로 판정 — ${verdict.subcommand}` : verdict.reason}
                      </p>
                    )}
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
                      className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary" />
                  </div>
                  <div>
                    <label htmlFor={f('port')} className="block text-sm text-muted-foreground mb-1">포트</label>
                    <input id={f('port')} type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)}
                      className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary" />
                  </div>
                  <div>
                    <p id={f('authLabel')} className="block text-sm text-muted-foreground mb-1">인증</p>
                    <div role="group" aria-labelledby={f('authLabel')} className="flex items-center bg-secondary/60 rounded-xl p-[3px] gap-px">
                      {(['password', 'key'] as const).map((m) => (
                        <button key={m} type="button" aria-pressed={authMode === m} onClick={() => setAuthMode(m)}
                          className={`flex-1 px-2 py-1.5 text-sm font-medium rounded-md transition-colors ${
                            authMode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                          }`}>
                          {m === 'password' ? '비밀번호' : '개인키'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                {authMode === 'password' ? (
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                    aria-label="SSH 비밀번호" autoComplete="off"
                    placeholder="SSH 비밀번호"
                    className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary" />
                ) : (
                  <textarea value={privateKey} onChange={(e) => setPrivateKey(e.target.value)}
                    aria-label="SSH 개인키(PEM)"
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" rows={4}
                    className="w-full px-3 py-2 text-xs font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary resize-none" />
                )}

                {/* 모드 */}
                <div className="flex items-center gap-2">
                  <p id={f('modeLabel')} className="text-sm text-muted-foreground">실행 모드:</p>
                  <div role="group" aria-labelledby={f('modeLabel')} className="flex items-center bg-secondary/60 rounded-xl p-[3px] gap-px">
                    {(['parallel', 'sequential'] as const).map((m) => (
                      <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
                        className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                          mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                        }`}>
                        {m === 'parallel' ? '병렬' : '순차'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 미리보기 */}
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">실행될 명령</p>
                  <code className="block text-xs font-mono bg-background border border-border rounded-md p-2 overflow-auto whitespace-pre-wrap break-all max-h-24">
                    {commandMasked || '(선택된 프리셋 없음)'}
                  </code>
                </div>

                {runError && (
                  <div role="alert" className="px-3 py-2 text-sm rounded-md bg-status-critical/10 text-status-critical border border-status-critical/30">
                    {formatApiError(runError)}
                  </div>
                )}

                <div className="flex justify-end pt-2 border-t border-border">
                  {runMut.isPending ? (
                    <button
                      type="button"
                      onClick={runMut.abort}
                      className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-secondary hover:bg-secondary/80 text-foreground border border-border rounded-xl transition-colors"
                    >
                      <Square className="w-4 h-4 fill-current" aria-hidden="true" />
                      중지
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmOpen(true)}
                      disabled={!canOperate || !canRun}
                      title={withHint(runLabel)}
                      aria-label={ariaWithHint(runLabel)}
                      className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Play className="w-4 h-4" aria-hidden="true" />
                      {runLabel}
                    </button>
                  )}
                </div>
              </MacCard>
            </div>

            {/* 우: 실행 로그(수명주기) + 결과 — 항상 같은 위치(우측)에 고정, 실행 전엔 플레이스홀더 */}
            <div className="lg:col-span-6 min-w-0 flex flex-col gap-3">
              <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
              <ResultPanel response={runResponse} command={ranCommand} pending={runMut.isPending} />
            </div>
          </div>
          )}
        </div>
      </PageShell>

      <ConfirmDialog
        open={confirmOpen}
        title={isDanger ? '노드 명령 실행 확인' : '커널 파라미터 조회 확인'}
        description={!useCustom
          ? `${selected.size}개 노드에 SSH 접속 후 조회 프리셋을 실행합니다 (읽기 전용).`
          : isDanger
            ? `${selected.size}개 노드에 SSH 접속 후 직접 입력한 명령을 그대로 실행합니다. 조회 명령이 아니므로 여러 노드의 커널·서비스 상태를 한꺼번에 바꿀 수 있습니다.`
            : `${selected.size}개 노드에 SSH 접속 후 직접 입력한 조회 명령(${verdict?.subcommand ?? ''})을 실행합니다.`}
        confirmLabel={isDanger ? '실행' : '조회'}
        danger={isDanger}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => { setConfirmOpen(false); void doRun(); }}
      >
        <div className="space-y-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">프리셋</p>
            <p className="text-sm font-semibold">{preset?.label ?? '직접 입력'}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">실행 명령</p>
            <pre className="text-xs font-mono bg-background border border-border rounded-md p-2 max-h-28 overflow-auto whitespace-pre-wrap break-all">
              {commandMasked}
            </pre>
          </div>
          {verdict?.reason && (
            <p className="text-sm text-status-critical flex items-start gap-1.5">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
              {verdict.reason}
            </p>
          )}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">대상 ({selected.size})</p>
            <div className="text-xs font-mono max-h-20 overflow-auto bg-background border border-border rounded-md p-2">
              {selectedHosts.slice(0, 8).map((t) => <div key={t.name}>{t.name}</div>)}
              {selectedHosts.length > 8 && <div className="text-muted-foreground">+ {selectedHosts.length - 8}개 더…</div>}
            </div>
          </div>
        </div>
      </ConfirmDialog>
    </div>
  );
}
