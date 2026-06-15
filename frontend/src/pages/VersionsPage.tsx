import { useEffect, useMemo, useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  GitCommit, RefreshCw, Square, Clock, Share2, X, ChevronDown, ChevronUp,
  Server, Cpu, Network, Settings2, HardDrive, Search, FileSpreadsheet, FileText,
} from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { ClusterSidebar, DebugLogPanel, useToast, EmptyState, SkeletonCard, DoubleScrollX} from '@/components/common';
import { formatApiError } from '@/lib/utils';
import { versionsApi, type ComponentSnapshot } from '@/services/api';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import {
  EtcdSystemdModal, KernelParamsCollectModal, NodeNicsCollectModal,
  KubeletConfigCollectModal, CsvExportModal,
} from '@/components/versions';
import { Database } from 'lucide-react';

// ── 유틸 ────────────────────────────────────────────────────────────────────

const CATEGORY_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; cls: string }> = {
  control_plane: { label: 'Control Plane', icon: Server,     cls: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30' },
  kubelet:       { label: 'Kubelet',        icon: Cpu,        cls: 'bg-sky-500/10 text-sky-400 border-sky-500/30' },
  cni:           { label: 'CNI / Cilium',   icon: Network,    cls: 'bg-purple-500/10 text-purple-400 border-purple-500/30' },
  // OS 레벨 — kernel sysctl · etcd systemd · etcdctl config 를 한 카테고리로.
  os:            { label: 'OS',              icon: Cpu,        cls: 'bg-amber-500/10 text-amber-500 border-amber-500/30' },
  // Storage — MinIO / AIStor / DirectPV 등 객체스토리지 레이어
  storage:       { label: 'Storage (S3/MinIO)', icon: HardDrive, cls: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30' },
  cluster:       { label: 'Cluster',        icon: Server,     cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30' },
  other:         { label: 'Other',          icon: Settings2,  cls: 'bg-muted text-muted-foreground border-border' },
};

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Kernel sysctl params 전용 디테일 ─────────────────────────────────────────

// axios response 인터셉터가 키를 재귀적으로 camelCase 로 바꾸는 바람에
// `net.ipv4.ip_forward` 같은 sysctl 키가 `net.ipv4.ipForward` 처럼 mangling 됨.
// sysctl 키는 항상 소문자 + 숫자 + 점/하이픈 조합이므로 대문자만 안전하게
// 다시 `_lowercase` 로 되돌릴 수 있다.
function unCamelSysctlKey(k: string): string {
  return k.replace(/([A-Z])/g, (_, c: string) => '_' + c.toLowerCase());
}

function KernelParamsDetails({ data }: { data: Record<string, unknown> }) {
  const rawParams = (data?.params && typeof data.params === 'object')
    ? data.params as Record<string, string>
    : {};
  // 키 mangling 복원 — 표시 + 그룹 분류 모두 원본 키로 동작해야 한다.
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawParams)) {
    params[unCamelSysctlKey(k)] = String(v);
  }
  const host = typeof data?.host === 'string' ? data.host : null;
  const collectedAtRaw = data?.collected_at ?? data?.collectedAt;
  const collectedAt = typeof collectedAtRaw === 'string' ? collectedAtRaw : null;

  const [filter, setFilter] = useState('');
  const entries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  const filtered = filter
    ? entries.filter(([k, v]) => k.toLowerCase().includes(filter.toLowerCase())
      || String(v).toLowerCase().includes(filter.toLowerCase()))
    : entries;

  // 자주 보는 prefix 그룹화 — 가독성을 위해 카테고리 별로 묶음.
  const groups: Record<string, [string, string][]> = {};
  for (const [k, v] of filtered) {
    let g = 'other';
    if (k.startsWith('net.ipv4')) g = 'net.ipv4';
    else if (k.startsWith('net.ipv6')) g = 'net.ipv6';
    else if (k.startsWith('net.bridge')) g = 'net.bridge';
    else if (k.startsWith('net.core')) g = 'net.core';
    else if (k.startsWith('net.netfilter')) g = 'net.netfilter';
    else if (k.startsWith('vm.')) g = 'vm';
    else if (k.startsWith('fs.')) g = 'fs';
    else if (k.startsWith('kernel.')) g = 'kernel';
    if (!groups[g]) groups[g] = [];
    groups[g].push([k, v]);
  }
  const orderedKeys = ['net.ipv4', 'net.ipv6', 'net.bridge', 'net.core', 'net.netfilter', 'vm', 'fs', 'kernel', 'other']
    .filter((k) => groups[k]?.length);

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        수집된 sysctl 값이 없습니다. (수집이 실패했거나 값이 없는 호스트)
      </p>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      {(host || collectedAt) && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {host && <span className="font-mono">호스트: <span className="text-foreground">{host}</span></span>}
          {collectedAt && <span>수집: {formatDateTime(collectedAt)}</span>}
          <span>총 {entries.length}개 파라미터</span>
        </div>
      )}
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="파라미터 필터 (예: net.ipv4.ip_forward)"
        className="w-full px-3 py-1.5 text-sm bg-background border border-border rounded-md font-mono"
      />
      <div className="space-y-2">
        {orderedKeys.map((g) => (
          <details key={g} open className="rounded-md border border-border bg-muted/30">
            <summary className="cursor-pointer px-3 py-1.5 text-xs uppercase tracking-wider text-muted-foreground select-none flex items-center justify-between">
              <span>{g}</span>
              <span className="font-mono text-foreground/60">{groups[g].length}</span>
            </summary>
            <div className="px-3 pb-2 pt-1 space-y-0.5 max-h-72 overflow-y-auto">
              {groups[g].map(([k, v]) => (
                <div key={k} className="font-mono text-xs break-all flex gap-2">
                  <span className="text-primary flex-shrink-0">{k}</span>
                  <span className="text-muted-foreground">=</span>
                  <span className="text-foreground/80 break-all">{String(v)}</span>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

// ── Component detail (flags / data) ─────────────────────────────────────────

/** 값의 출처(`_sources[k]`)가 있으면 작은 뱃지로 표기. 없으면 null. */
function SourceBadge({ src }: { src?: string | null }) {
  if (!src) return null;
  return (
    <span
      title={`출처: ${src}`}
      className="ml-1.5 text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border"
    >
      {src}
    </span>
  );
}

/** 출처를 설명적으로 풀어주는 작은 카드 — etcd_systemd / kubelet_config 디테일에서 재사용. */
function SourcesNote({ sources }: { sources?: Record<string, string> | null }) {
  if (!sources || Object.keys(sources).length === 0) return null;
  const groups = new Map<string, string[]>();
  for (const [field, src] of Object.entries(sources)) {
    if (!groups.has(src)) groups.set(src, []);
    groups.get(src)!.push(field);
  }
  return (
    <div className="rounded-md border border-border bg-muted/20 p-2">
      <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">데이터 출처</p>
      <ul className="space-y-0.5">
        {Array.from(groups.entries()).map(([src, fields]) => (
          <li key={src} className="font-mono text-xs break-all">
            <span className="text-primary">{src}</span>
            <span className="text-muted-foreground"> → </span>
            <span className="text-foreground/80">{fields.join(', ')}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** etcd_systemd:{host} 전용 디테일 — config 경로(env file / systemd / ps -ef) 와 내용 강조. */
function EtcdSystemdDetails({ data }: { data: Record<string, unknown> }) {
  const sources = (data?._sources && typeof data._sources === 'object')
    ? data._sources as Record<string, string>
    : null;
  const str = (k: string) => typeof data?.[k] === 'string' ? (data[k] as string) : null;
  const num = (k: string) => typeof data?.[k] === 'number' ? (data[k] as number) : null;
  const host = str('host');
  const fragmentPath = str('fragment_path');
  const envFile = str('env_file');
  const envContent = str('env_content');
  const systemdEnvFile = str('systemd_env_file');
  const configFileArg = str('config_file_arg');
  const psCmdline = str('ps_cmdline');
  const execStart = str('exec_start');
  const activeState = str('active_state');
  const subState = str('sub_state');
  const version = str('version');
  const mainPid = num('main_pid');

  // 사용자가 가장 궁금해하는 건 "어디에 어떤 config 가 있는지". 출처 별로 모두 보여준다.
  const pathRows: { label: string; value: string | null; src: string | null }[] = [
    { label: 'EnvironmentFile (file)',     value: envFile,       src: sources?.env_file ?? null },
    { label: 'EnvironmentFile (systemd)',  value: systemdEnvFile, src: sources?.systemd_env_file ?? null },
    { label: 'config-file (ps -ef)',       value: configFileArg, src: sources?.config_file_arg ?? null },
    { label: 'unit fragment',              value: fragmentPath,  src: sources?.fragment_path ?? null },
  ];

  const [envFilter, setEnvFilter] = useState('');
  const filteredEnv = useMemo(() => {
    if (!envContent) return null;
    if (!envFilter.trim()) return envContent;
    const q = envFilter.toLowerCase();
    return envContent
      .split('\n')
      .filter((l) => l.toLowerCase().includes(q))
      .join('\n');
  }, [envContent, envFilter]);

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {host && (
          <div><span className="text-xs text-muted-foreground">Host</span>
            <p className="font-mono">{host}</p></div>
        )}
        {version && (
          <div><span className="text-xs text-muted-foreground">version<SourceBadge src={sources?.version} /></span>
            <p className="font-mono">{version}</p></div>
        )}
        {activeState && (
          <div><span className="text-xs text-muted-foreground">ActiveState<SourceBadge src={sources?.active_state} /></span>
            <p className={`font-mono ${activeState === 'active' ? 'text-emerald-500' : 'text-amber-500'}`}>
              {activeState}{subState ? ` / ${subState}` : ''}
            </p></div>
        )}
        {mainPid !== null && (
          <div><span className="text-xs text-muted-foreground">MainPID</span>
            <p className="font-mono">{mainPid}</p></div>
        )}
      </div>

      <div>
        <p className="text-xs text-muted-foreground uppercase mb-1">설정 파일 경로 (출처별)</p>
        <div className="space-y-1 rounded-md bg-muted/30 p-2">
          {pathRows.map((r) => (
            <div key={r.label} className="font-mono text-xs break-all flex flex-wrap items-center gap-1">
              <span className="text-primary">{r.label}:</span>
              {r.value
                ? <span className="text-foreground/90">{r.value}</span>
                : <span className="text-muted-foreground/60">(없음)</span>}
              <SourceBadge src={r.src} />
            </div>
          ))}
        </div>
      </div>

      {execStart && (
        <div>
          <p className="text-xs text-muted-foreground uppercase mb-1">
            ExecStart<SourceBadge src={sources?.exec_start} />
          </p>
          <pre className="text-xs font-mono bg-muted/30 rounded-md p-2 break-all whitespace-pre-wrap max-h-32 overflow-auto">{execStart}</pre>
        </div>
      )}

      {psCmdline && (
        <div>
          <p className="text-xs text-muted-foreground uppercase mb-1">
            ps -ef cmdline<SourceBadge src={sources?.ps_cmdline} />
          </p>
          <pre className="text-xs font-mono bg-muted/30 rounded-md p-2 break-all whitespace-pre-wrap max-h-24 overflow-auto">{psCmdline}</pre>
        </div>
      )}

      {envContent && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs text-muted-foreground uppercase">
              env 파일 내용 ({envFile})<SourceBadge src={sources?.env_content} />
            </p>
          </div>
          <input
            value={envFilter}
            onChange={(e) => setEnvFilter(e.target.value)}
            placeholder="env 파일 라인 필터 (예: ETCD_LISTEN_CLIENT_URLS)"
            className="w-full px-2 py-1 mb-1 text-xs font-mono bg-background border border-border rounded-md"
          />
          <pre className="text-xs font-mono bg-muted/30 rounded-md p-2 max-h-72 overflow-auto whitespace-pre-wrap">
            {filteredEnv || (envFilter ? '(필터 매칭 없음)' : '')}
          </pre>
        </div>
      )}

      <SourcesNote sources={sources} />
    </div>
  );
}

/** kubelet_config:{host} 전용 디테일 — config 경로 + YAML 내용 강조. */
function KubeletConfigDetails({ data }: { data: Record<string, unknown> }) {
  const sources = (data?._sources && typeof data._sources === 'object')
    ? data._sources as Record<string, string>
    : null;
  const str = (k: string) => typeof data?.[k] === 'string' ? (data[k] as string) : null;
  const host = str('host');
  const configFile = str('config_file');
  const configContent = str('config_content');
  const psCmdline = str('ps_cmdline');
  const kubeconfig = str('kubeconfig');
  const cre = str('container_runtime_endpoint');
  const nodeIp = str('node_ip');
  const cgroup = str('cgroup_driver');

  const [filter, setFilter] = useState('');
  const filtered = useMemo(() => {
    if (!configContent) return null;
    if (!filter.trim()) return configContent;
    const q = filter.toLowerCase();
    return configContent
      .split('\n')
      .filter((l) => l.toLowerCase().includes(q))
      .join('\n');
  }, [configContent, filter]);

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {host && <div><span className="text-xs text-muted-foreground">Host</span><p className="font-mono">{host}</p></div>}
        {configFile && (
          <div><span className="text-xs text-muted-foreground">config 파일<SourceBadge src={sources?.config_file} /></span>
            <p className="font-mono break-all">{configFile}</p></div>
        )}
        {kubeconfig && (
          <div><span className="text-xs text-muted-foreground">kubeconfig<SourceBadge src={sources?.kubeconfig} /></span>
            <p className="font-mono break-all">{kubeconfig}</p></div>
        )}
        {cre && (
          <div><span className="text-xs text-muted-foreground">container-runtime-endpoint<SourceBadge src={sources?.container_runtime_endpoint} /></span>
            <p className="font-mono break-all">{cre}</p></div>
        )}
        {nodeIp && (
          <div><span className="text-xs text-muted-foreground">node-ip<SourceBadge src={sources?.node_ip} /></span>
            <p className="font-mono">{nodeIp}</p></div>
        )}
        {cgroup && (
          <div><span className="text-xs text-muted-foreground">cgroup-driver<SourceBadge src={sources?.cgroup_driver} /></span>
            <p className="font-mono">{cgroup}</p></div>
        )}
      </div>

      {psCmdline && (
        <div>
          <p className="text-xs text-muted-foreground uppercase mb-1">
            ps -ef cmdline<SourceBadge src={sources?.ps_cmdline} />
          </p>
          <pre className="text-xs font-mono bg-muted/30 rounded-md p-2 break-all whitespace-pre-wrap max-h-24 overflow-auto">{psCmdline}</pre>
        </div>
      )}

      {configContent && (
        <div>
          <p className="text-xs text-muted-foreground uppercase mb-1">
            config 파일 내용<SourceBadge src={sources?.config_content} />
          </p>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="라인 필터 (예: cgroupDriver, runtimeRequestTimeout)"
            className="w-full px-2 py-1 mb-1 text-xs font-mono bg-background border border-border rounded-md"
          />
          <pre className="text-xs font-mono bg-muted/30 rounded-md p-2 max-h-96 overflow-auto whitespace-pre-wrap">
            {filtered || (filter ? '(필터 매칭 없음)' : '')}
          </pre>
        </div>
      )}

      <SourcesNote sources={sources} />
    </div>
  );
}

function ComponentDetails({ snap }: { snap: ComponentSnapshot }) {
  const data = snap.data as Record<string, unknown>;
  const flags = (data?.flags && typeof data.flags === 'object') ? data.flags as Record<string, string> : null;
  const image = typeof data?.image === 'string' ? data.image : null;
  const cmData = (data?.data && typeof data.data === 'object') ? data.data as Record<string, string> : null;
  const sources = (data?._sources && typeof data._sources === 'object')
    ? data._sources as Record<string, string>
    : null;

  // 모듈별 전용 디테일 (데이터 모양이 다른 컴포넌트는 별도 렌더)
  if (snap.component.startsWith('minio_tenant:')) {
    return <MinioTenantDetails data={data} />;
  }
  if (snap.component === 'directpv_summary') {
    return <DirectPVDetails data={data} />;
  }
  if (snap.component.startsWith('kernel_params:')) {
    return <KernelParamsDetails data={data} />;
  }
  if (snap.component.startsWith('etcd_systemd:')) {
    return <EtcdSystemdDetails data={data} />;
  }
  if (snap.component.startsWith('kubelet_config:')) {
    return <KubeletConfigDetails data={data} />;
  }

  // 일반 컴포넌트 — flags / configmap / 원시 필드 모두 필터로 검색 가능.
  return <GenericComponentDetails
    image={image}
    flags={flags}
    cmData={cmData}
    rawData={(!flags && !cmData) ? data : null}
    sources={sources}
  />;
}

/** flags / configmap / raw 데이터를 공통 필터로 검색할 수 있는 디테일 패널.
 *  키나 값 어느 쪽이든 매칭. 노드/모듈에 값이 많을 때 빠르게 찾기 위함. */
function GenericComponentDetails({
  image, flags, cmData, rawData, sources,
}: {
  image: string | null;
  flags: Record<string, string> | null;
  cmData: Record<string, string> | null;
  rawData: Record<string, unknown> | null;
  sources: Record<string, string> | null;
}) {
  const [filter, setFilter] = useState('');
  const matches = useCallback((k: string, v: unknown) => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    const sv = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return k.toLowerCase().includes(q) || sv.toLowerCase().includes(q);
  }, [filter]);

  const flagsEntries = flags ? Object.entries(flags).filter(([k, v]) => matches(k, v)).sort() : [];
  const cmEntries = cmData ? Object.entries(cmData).filter(([k, v]) => matches(k, v)).sort() : [];
  const rawEntries = rawData
    ? Object.entries(rawData).filter(([k, v]) => k !== '_sources' && matches(k, v))
    : [];

  const totalSearchable = (flags ? Object.keys(flags).length : 0)
    + (cmData ? Object.keys(cmData).length : 0)
    + (rawData ? Object.keys(rawData).filter((k) => k !== '_sources').length : 0);

  return (
    <div className="space-y-3 text-sm">
      {image && (
        <div>
          <p className="text-xs text-muted-foreground uppercase mb-0.5">Image</p>
          <p className="font-mono text-foreground break-all">{image}</p>
        </div>
      )}

      {totalSearchable >= 6 && (
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`이 모듈의 키/값 필터 (총 ${totalSearchable}개)`}
          className="w-full px-2 py-1 text-xs font-mono bg-background border border-border rounded-md"
        />
      )}

      {flags && (
        <div>
          <p className="text-xs text-muted-foreground uppercase mb-0.5">
            Flags ({flagsEntries.length}{filter ? ` / ${Object.keys(flags).length}` : ''})
          </p>
          <div className="max-h-60 overflow-y-auto space-y-0.5 rounded-md bg-muted/30 p-2">
            {flagsEntries.length === 0 ? (
              <p className="text-xs text-muted-foreground/70">(필터 매칭 없음)</p>
            ) : flagsEntries.map(([k, v]) => (
              <div key={k} className="font-mono text-xs break-all">
                <span className="text-primary">--{k}</span>
                <span className="text-muted-foreground">=</span>
                <span className="text-foreground/80">{String(v)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {cmData && (
        <div>
          <p className="text-xs text-muted-foreground uppercase mb-0.5">
            ConfigMap data ({cmEntries.length}{filter ? ` / ${Object.keys(cmData).length}` : ''})
          </p>
          <div className="max-h-60 overflow-y-auto space-y-0.5 rounded-md bg-muted/30 p-2">
            {cmEntries.length === 0 ? (
              <p className="text-xs text-muted-foreground/70">(필터 매칭 없음)</p>
            ) : cmEntries.map(([k, v]) => (
              <div key={k} className="font-mono text-xs break-all">
                <span className="text-primary">{k}</span>:{' '}
                <span className="text-foreground/80">{String(v)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {rawData && (
        <div className="space-y-0.5 rounded-md bg-muted/30 p-2">
          {rawEntries.length === 0 ? (
            <p className="text-xs text-muted-foreground/70">(필터 매칭 없음)</p>
          ) : rawEntries.map(([k, v]) => (
            <div key={k} className="font-mono text-xs break-all">
              <span className="text-primary">{k}</span>
              <SourceBadge src={sources?.[k]} />
              <span className="text-muted-foreground">: </span>
              <span className="text-foreground/80">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
            </div>
          ))}
        </div>
      )}
      <SourcesNote sources={sources} />
    </div>
  );
}

// ── MinIO Tenant / DirectPV 전용 디테일 ───────────────────────────────────

function MinioTenantDetails({ data }: { data: Record<string, unknown> }) {
  const pools = Array.isArray(data?.pools) ? data.pools as Array<Record<string, unknown>> : [];
  const num = (k: string) => typeof data?.[k] === 'number' ? data[k] as number : null;
  const str = (k: string) => typeof data?.[k] === 'string' ? data[k] as string : null;
  const totalServers  = num('totalServers');
  const totalDrives   = num('totalDrives');
  const drivesPerSet  = num('drivesPerSet');
  const ecParity      = num('ecParity');
  const ecDataShards  = num('ecDataShards');
  const ecExplicit    = data?.ecExplicit === true;
  const requestAutoCert = data?.requestAutoCert === true;
  const ecRatio = (drivesPerSet && ecDataShards != null && ecParity != null && drivesPerSet > 0)
    ? `EC:${ecParity} (${ecDataShards} data + ${ecParity} parity / ${drivesPerSet})`
    : null;

  const stat = (label: string, value: React.ReactNode, color?: string) => (
    <div className="bg-muted/40 rounded-md px-2 py-1.5">
      <p className="text-[10px] uppercase text-muted-foreground tracking-wider">{label}</p>
      <p className={`text-sm font-semibold font-mono ${color ?? 'text-foreground'}`}>{value ?? '-'}</p>
    </div>
  );

  return (
    <div className="space-y-3 text-sm">
      {str('image') && (
        <div>
          <p className="text-xs text-muted-foreground uppercase mb-0.5">Image</p>
          <p className="font-mono text-foreground break-all">{str('image')}</p>
        </div>
      )}
      <div className="grid grid-cols-3 gap-1.5">
        {stat('서버 수',   totalServers,  'text-sky-500')}
        {stat('드라이브',  totalDrives,   'text-emerald-500')}
        {stat('Erasure Set', drivesPerSet)}
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {stat('Parity (EC)', ecParity != null ? `${ecParity}${ecExplicit ? ' (명시)' : ' (default)'}` : '-', 'text-amber-500')}
        {stat('Data shards', ecDataShards)}
        {stat('Auto TLS', requestAutoCert ? 'Yes' : 'No', requestAutoCert ? 'text-emerald-500' : 'text-muted-foreground')}
      </div>
      {ecRatio && (
        <p className="text-xs font-mono text-emerald-500/80 bg-emerald-500/5 border border-emerald-500/20 rounded-md px-2 py-1">
          {ecRatio} — 손실 허용 디스크: {ecParity}개
        </p>
      )}

      {pools.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground uppercase mb-1 tracking-wider">
            Pools ({pools.length})
          </p>
          <DoubleScrollX className="rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40">
                <tr className="text-left">
                  <th className="px-2 py-1 font-medium">name</th>
                  <th className="px-2 py-1 font-medium">servers</th>
                  <th className="px-2 py-1 font-medium">vol/srv</th>
                  <th className="px-2 py-1 font-medium">drives</th>
                  <th className="px-2 py-1 font-medium">size</th>
                  <th className="px-2 py-1 font-medium">storageClass</th>
                </tr>
              </thead>
              <tbody>
                {pools.map((p, i) => (
                  <tr key={i} className="border-t border-border font-mono">
                    <td className="px-2 py-1">{String(p.name ?? `pool-${i}`)}</td>
                    <td className="px-2 py-1">{String(p.servers ?? '-')}</td>
                    <td className="px-2 py-1">{String(p.volumesPerServer ?? '-')}</td>
                    <td className="px-2 py-1 text-emerald-500">{String(p.drives ?? '-')}</td>
                    <td className="px-2 py-1">{String(p.volumeSize ?? '-')}</td>
                    <td className="px-2 py-1 truncate max-w-[140px]" title={String(p.storageClass ?? '')}>{String(p.storageClass ?? '-')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DoubleScrollX>
        </div>
      )}

      {/* 상태 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5">
        {stat('currentState', str('currentState'))}
        {stat('health', str('healthStatus'))}
        {stat('online', num('drivesOnline'), 'text-emerald-500')}
        {stat('offline', num('drivesOffline'),
          (num('drivesOffline') ?? 0) > 0 ? 'text-red-500' : undefined)}
      </div>
    </div>
  );
}

function DirectPVDetails({ data }: { data: Record<string, unknown> }) {
  const num = (k: string) => typeof data?.[k] === 'number' ? data[k] as number : null;
  const nodes = Array.isArray(data?.nodes) ? data.nodes as Array<Record<string, unknown>> : [];
  const totalDrives = num('totalDrives') ?? 0;
  const readyDrives = num('readyDrives') ?? 0;
  const totalCap   = num('totalCapacity') ?? 0;
  const allocCap   = num('allocatedCapacity') ?? 0;
  const nodeCount  = num('nodeCount') ?? 0;
  const fmtBytes = (b: number) => {
    if (b <= 0) return '-';
    const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0; let v = b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(2)} ${u[i]}`;
  };

  const stat = (label: string, value: React.ReactNode, color?: string) => (
    <div className="bg-muted/40 rounded-md px-2 py-1.5">
      <p className="text-[10px] uppercase text-muted-foreground tracking-wider">{label}</p>
      <p className={`text-sm font-semibold font-mono ${color ?? 'text-foreground'}`}>{value ?? '-'}</p>
    </div>
  );
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-3 gap-1.5">
        {stat('총 드라이브', totalDrives, 'text-emerald-500')}
        {stat('Ready', `${readyDrives} / ${totalDrives}`, readyDrives === totalDrives ? 'text-emerald-500' : 'text-amber-500')}
        {stat('노드 수', nodeCount, 'text-sky-500')}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {stat('총 용량', fmtBytes(totalCap))}
        {stat('할당된 용량', fmtBytes(allocCap),
          (totalCap > 0 && allocCap / totalCap > 0.85) ? 'text-amber-500' : undefined)}
      </div>
      {nodes.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground uppercase mb-1 tracking-wider">
            Per-node ({nodes.length})
          </p>
          <div className="max-h-60 overflow-y-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 sticky top-0">
                <tr className="text-left">
                  <th className="px-2 py-1 font-medium">node</th>
                  <th className="px-2 py-1 font-medium">drives</th>
                  <th className="px-2 py-1 font-medium">ready</th>
                  <th className="px-2 py-1 font-medium">total</th>
                  <th className="px-2 py-1 font-medium">fs</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((n, i) => (
                  <tr key={i} className="border-t border-border font-mono">
                    <td className="px-2 py-1 break-all">{String(n.node ?? '-')}</td>
                    <td className="px-2 py-1">{String(n.drives ?? '-')}</td>
                    <td className="px-2 py-1">{String(n.ready ?? '-')}</td>
                    <td className="px-2 py-1">{fmtBytes(Number(n.total ?? 0))}</td>
                    <td className="px-2 py-1">{Array.isArray(n.fsTypes) ? (n.fsTypes as string[]).join(', ') : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── History timeline for one component ──────────────────────────────────────

function HistoryTimeline({
  clusterId, component, onPickDiff,
}: {
  clusterId: string;
  component: string;
  onPickDiff: (from: ComponentSnapshot, to: ComponentSnapshot) => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['versions', 'history', clusterId, component],
    queryFn: () => versionsApi.history(clusterId, component).then((r) => r.data),
    staleTime: 30_000,
  });
  const [pickedIds, setPicked] = useState<string[]>([]);

  const snapshots = useMemo(() => data?.snapshots ?? [], [data]);

  const togglePick = useCallback((id: string) => {
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return [id, ...prev].slice(0, 2);
    });
  }, []);

  useEffect(() => {
    if (pickedIds.length === 2) {
      const [b, a] = pickedIds; // 선택한 순서 — 두 번째가 구(오래된)
      const from = snapshots.find((s) => s.id === a);
      const to = snapshots.find((s) => s.id === b);
      if (from && to) onPickDiff(from, to);
      setPicked([]);
    }
  }, [pickedIds, snapshots, onPickDiff]);

  if (isLoading) return <p className="text-sm text-muted-foreground px-4 py-3">불러오는 중…</p>;
  if (snapshots.length === 0) return <p className="text-sm text-muted-foreground px-4 py-3">히스토리 없음</p>;

  return (
    <div className="space-y-1 px-4 py-3">
      <p className="text-xs text-muted-foreground mb-2">
        두 개 선택 시 diff를 자동으로 표시합니다 (선택 {pickedIds.length}/2)
      </p>
      <div className="relative pl-4 border-l-2 border-border space-y-3">
        {snapshots.map((s) => {
          const picked = pickedIds.includes(s.id);
          return (
            <div key={s.id} className="relative">
              <span className={`absolute -left-[22px] top-1 w-3 h-3 rounded-full border-2 ${
                picked ? 'bg-primary border-primary' : 'bg-background border-border'
              }`} />
              <button
                onClick={() => togglePick(s.id)}
                className={`w-full text-left rounded-md px-3 py-2 transition-colors ${
                  picked ? 'bg-primary/10 border border-primary/30' : 'hover:bg-muted/40'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm text-foreground">
                    {s.version || '(version 없음)'}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(s.collectedAt)}
                  </span>
                </div>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Diff Panel ──────────────────────────────────────────────────────────────

function DiffPanel({
  clusterId, from, to, onClose,
}: {
  clusterId: string;
  from: ComponentSnapshot;
  to: ComponentSnapshot;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['versions', 'diff', clusterId, from.id, to.id],
    queryFn: () => versionsApi.diff(clusterId, from.id, to.id).then((r) => r.data),
  });

  return (
    <div className="bg-card border border-border rounded-xl p-5 mt-4">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold mb-0.5">
            <span className="text-muted-foreground">Diff: </span>
            <span className="font-mono">{from.component}</span>
          </h3>
          <p className="text-sm text-muted-foreground font-mono">
            {formatDateTime(from.collectedAt)} → {formatDateTime(to.collectedAt)}
          </p>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-secondary text-muted-foreground">
          <X className="w-4 h-4" />
        </button>
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">분석 중…</p>
      ) : data?.changes.length === 0 ? (
        <p className="text-sm text-muted-foreground">변경 없음</p>
      ) : (
        <div className="space-y-1.5 max-h-80 overflow-y-auto">
          {data?.versionChanged && (
            <div className="text-sm font-mono px-2 py-1 bg-primary/10 text-primary border border-primary/30 rounded">
              version: {from.version} → {to.version}
            </div>
          )}
          {data?.changes.map((c, i) => (
            <div key={i} className="text-sm font-mono px-2 py-1 rounded bg-muted/30 border border-border">
              <p className="text-primary mb-0.5">{c.key}</p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="text-red-400 break-all">- {String(c.from ?? '(없음)')}</div>
                <div className="text-emerald-400 break-all">+ {String(c.to ?? '(없음)')}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 메인 페이지 ──────────────────────────────────────────────────────────────

export function VersionsPage() {
  const queryClient = useQueryClient();
  const { data: clusters = [] } = useClusters();
  const toast = useToast();
  const [clusterId, setClusterId] = useState<string>('');
  const [etcdModalOpen, setEtcdModalOpen] = useState(false);
  const [kernelModalOpen, setKernelModalOpen] = useState(false);
  const [nicsModalOpen, setNicsModalOpen] = useState(false);
  const [kubeletModalOpen, setKubeletModalOpen] = useState(false);
  const [csvModalOpen, setCsvModalOpen] = useState(false);
  // 노드/컴포넌트 키워드 검색 — 노드가 많을 때 빠르게 찾기 위함.
  // component 이름·version·data 의 host/config_path 어디든 매칭하면 표시.
  const [nodeSearch, setNodeSearch] = useState('');

  // 사이드바 진입 시 자동으로 첫 클러스터 선택
  useEffect(() => {
    if (!clusterId && clusters.length > 0) setClusterId(clusters[0].id);
  }, [clusters, clusterId]);

  const { data: current, isLoading } = useQuery({
    queryKey: ['versions', 'current', clusterId],
    queryFn: () => versionsApi.current(clusterId).then((r) => r.data),
    enabled: !!clusterId,
    staleTime: 30_000,
  });

  const collect = useAbortableMutation({
    mutationFn: (_: void, signal) => versionsApi.collect(clusterId, signal),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['versions'] });
      const { changed, errors } = res.data;
      if (errors.length > 0) {
        toast.warning(`${changed}개 변경 감지됨 · 경고 ${errors.length}건`, errors.slice(0, 3).join('\n'));
      } else {
        toast.success(`${changed}개 변경 감지됨`, '스냅샷 갱신 완료');
      }
    },
    onError: (err: unknown) => {
      toast.error('수집 실패', formatApiError(err));
    },
  });

  const collectMinio = useAbortableMutation({
    mutationFn: (_: void, signal) => versionsApi.collectMinio(clusterId, signal),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['versions'] });
      const { changed, summary, warnings } = res.data;
      const tenants = summary.tenants?.length ?? 0;
      const op = summary.operator ? '운영자 OK' : '운영자 X';
      const directpv = summary.directpv ? `DirectPV ${summary.directpv.totalDrives}드라이브` : 'DirectPV X';
      const desc = `${op} · 테넌트 ${tenants}개 · ${directpv}`;
      if (changed > 0) {
        toast.success(`MinIO ${changed}건 변경 감지`, desc);
      } else if (tenants === 0 && !summary.operator) {
        toast.info('MinIO 미설치', warnings.slice(0, 2).join('\n') || '관련 리소스를 찾지 못했습니다.');
      } else {
        toast.info('MinIO 변경 없음', desc);
      }
    },
    onError: (err: unknown) => {
      toast.error('MinIO 수집 실패', formatApiError(err));
    },
  });

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (comp: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(comp)) next.delete(comp);
    else next.add(comp);
    return next;
  });

  // 카테고리 단위 접기 — 기본 모두 펼침, control_plane/kubelet/cni 처럼 컴포넌트가
  // 많은 카테고리에서 가독성을 위해 한 번에 접을 수 있게 한다.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (cat: string) => setCollapsedGroups((prev) => {
    const next = new Set(prev);
    if (next.has(cat)) next.delete(cat);
    else next.add(cat);
    return next;
  });

  const [diffPair, setDiffPair] = useState<{ from: ComponentSnapshot; to: ComponentSnapshot } | null>(null);

  const grouped = useMemo(() => {
    const q = nodeSearch.trim().toLowerCase();
    const matchSnap = (c: ComponentSnapshot): boolean => {
      if (!q) return true;
      if (c.component.toLowerCase().includes(q)) return true;
      if ((c.version ?? '').toLowerCase().includes(q)) return true;
      // data 안의 host / config 경로 같은 핵심 식별 필드도 검색.
      const d = c.data as Record<string, unknown> | null;
      if (!d) return false;
      const probe = ['host', 'config_file', 'config_file_arg', 'env_file', 'systemd_env_file', 'fragment_path'];
      for (const k of probe) {
        const v = d[k];
        if (typeof v === 'string' && v.toLowerCase().includes(q)) return true;
      }
      return false;
    };
    const byCategory = new Map<string, ComponentSnapshot[]>();
    for (const c of current?.components ?? []) {
      if (!matchSnap(c)) continue;
      const key = c.category || 'other';
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key)!.push(c);
    }
    // control_plane 먼저, 그 다음 cni, kubelet, os, storage, other
    const order = ['control_plane', 'cni', 'kubelet', 'os', 'storage', 'other'];
    return order.filter((k) => byCategory.has(k)).map((k) => ({
      category: k,
      items: byCategory.get(k)!.sort((a, b) => a.component.localeCompare(b.component)),
    }));
  }, [current, nodeSearch]);

  const totalComponents = current?.components?.length ?? 0;
  const visibleComponents = grouped.reduce((acc, g) => acc + g.items.length, 0);

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto px-3 py-3 flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={clusterId || null}
          onSelect={(id) => setClusterId(id ?? '')}
          iconOnly
        />
        <div className="flex-1 min-w-0">
        <DebugLogPanel pageKey="versions" extra={{ clusterId, components: current?.components?.length ?? 0, pending: collect.isPending }} />
        {/* 헤더 */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <GitCommit className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">버전 / 설정 관리</h1>
            {clusterId && current?.components && (
              <>
                <span className="text-sm font-mono text-muted-foreground">· {clusters.find((c) => c.id === clusterId)?.name}</span>
                <span className="text-sm px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-400 border border-slate-500/30">
                  {current.components.length}개 컴포넌트
                </span>
              </>
            )}
          </div>
          {clusterId && (
            <div className="flex items-center gap-2">
              <Link
                to={`/versions/${clusterId}/graph`}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg text-foreground transition-colors"
                title="3D 관계 그래프"
              >
                <Share2 className="w-4 h-4" />
                3D 그래프
              </Link>
              <button
                onClick={() => setCsvModalOpen(true)}
                disabled={totalComponents === 0}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg text-foreground transition-colors disabled:opacity-50"
                title="현재 스냅샷을 CSV 로 내보내기 (디테일 레벨 선택 가능)"
              >
                <FileSpreadsheet className="w-4 h-4" />
                CSV 내보내기
              </button>
              <button
                onClick={() => setEtcdModalOpen(true)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg text-foreground transition-colors"
                title="etcd (systemd) — SSH 로 수집. ps -ef 와 systemctl 양쪽에서 config 경로 추정."
              >
                <Database className="w-4 h-4" />
                etcd (systemd)
              </button>
              <button
                onClick={() => setKubeletModalOpen(true)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg text-foreground transition-colors"
                title="kubelet 의 *실제 사용중* config 파일을 SSH 로 발견 (ps -eo args | grep kubelet → --config) + 내용 읽기"
              >
                <FileText className="w-4 h-4" />
                kubelet config
              </button>
              <button
                onClick={() => setKernelModalOpen(true)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg text-foreground transition-colors"
                title="노드별 sysctl 커널 파라미터 — SSH 로 수집 (값 변경시 히스토리 누적)"
              >
                <Cpu className="w-4 h-4" />
                커널 파라미터
              </button>
              <button
                onClick={() => setNicsModalOpen(true)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg text-foreground transition-colors"
                title="노드별 NIC / IP — SSH 로 수집 (bond0/bond1 + public/private 분류)"
              >
                <Network className="w-4 h-4" />
                노드 NIC
              </button>
              {collectMinio.isPending ? (
                <button
                  onClick={collectMinio.abort}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-red-500 hover:bg-red-600 text-primary-foreground rounded-lg transition-colors"
                  title="MinIO 수집 중지"
                >
                  <Square className="w-4 h-4 fill-current" />
                  MinIO 중지
                </button>
              ) : (
                <button
                  onClick={() => collectMinio.mutate()}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg text-foreground transition-colors"
                  title="MinIO Operator + Tenant + DirectPV 정보 수집 (pool/disk/parity)"
                >
                  <HardDrive className="w-4 h-4" />
                  MinIO
                </button>
              )}
              {collect.isPending ? (
                <button
                  onClick={collect.abort}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-red-500 hover:bg-red-600 text-primary-foreground rounded-lg transition-colors"
                >
                  <Square className="w-4 h-4 fill-current" />
                  중지
                </button>
              ) : (
                <button
                  onClick={() => collect.mutate()}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors"
                >
                  <RefreshCw className="w-4 h-4" />
                  지금 수집
                </button>
              )}
            </div>
          )}
        </div>

        {!clusterId && clusters.length === 0 && (
          <p className="text-center text-muted-foreground py-20">등록된 클러스터가 없습니다.</p>
        )}

        {/* 선택된 클러스터 상세 */}
        {clusterId && (
          <>
            <div className="bg-card border border-border rounded-xl p-4 mb-5 text-sm text-muted-foreground leading-relaxed">
              kubeconfig 를 통해 K8s/Cilium 버전, core component image tag, command/args 플래그, cilium-config ConfigMap 을 수집합니다.
              동일 hash 가 감지되면 저장하지 않으므로 반복 실행해도 안전. 변경이 발생한 시점에만 히스토리에 새 레코드가 생깁니다.
            </div>

            {/* 노드/컴포넌트 검색 — 노드가 많을 때 빠르게 찾기.
                키워드는 component 이름 / version / data 의 host·config_path 에 매칭한다. */}
            {totalComponents > 0 && (
              <div className="bg-card border border-border rounded-xl px-4 py-2.5 mb-4 flex items-center gap-3">
                <Search className="w-4 h-4 text-muted-foreground" />
                <input
                  value={nodeSearch}
                  onChange={(e) => setNodeSearch(e.target.value)}
                  placeholder="노드 이름·컴포넌트·버전·config 경로로 검색 (예: master-1, kubelet, /var/lib)"
                  className="flex-1 bg-transparent border-0 text-sm font-mono focus:outline-none focus:ring-0"
                />
                {nodeSearch && (
                  <>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {visibleComponents} / {totalComponents}
                    </span>
                    <button
                      onClick={() => setNodeSearch('')}
                      className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
                      aria-label="검색 지우기"
                      title="검색 지우기"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
              </div>
            )}
          </>
        )}

        {/* 본문 */}
        {!clusterId ? null : isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        ) : (current?.components.length ?? 0) === 0 ? (
          <EmptyState
            icon={Clock}
            title="아직 수집된 스냅샷이 없습니다"
            description="kubeconfig 에 연결해 현재 K8s 버전/설정을 스냅샷으로 저장합니다."
            action={{ label: '지금 수집', onClick: () => collect.mutate() }}
          />
        ) : nodeSearch.trim() && grouped.length === 0 ? (
          <EmptyState
            icon={Search}
            title="검색 결과 없음"
            description={`"${nodeSearch}" 와 매칭되는 컴포넌트/노드/config 경로가 없습니다.`}
            action={{ label: '검색 지우기', onClick: () => setNodeSearch(''), variant: 'secondary' }}
          />
        ) : (
          <div className="space-y-5">
            {grouped.map(({ category, items }) => {
              const meta = CATEGORY_META[category] ?? CATEGORY_META.other;
              const Icon = meta.icon;
              const groupCollapsed = collapsedGroups.has(category);
              const groupExpandedCount = items.filter((s) => expanded.has(s.component)).length;
              return (
                <section key={category} className="bg-card border border-border rounded-xl overflow-hidden">
                  <header className="flex items-center gap-2 px-5 py-3 border-b border-border bg-muted/20">
                    <button
                      onClick={() => toggleGroup(category)}
                      className="flex items-center gap-2 flex-1 text-left hover:opacity-80 transition-opacity"
                      aria-label={`${meta.label} 섹션 ${groupCollapsed ? '펼치기' : '접기'}`}
                    >
                      {groupCollapsed
                        ? <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                        : <ChevronUp className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
                      <Icon className="w-4 h-4 text-muted-foreground" />
                      <h2 className="text-sm font-semibold">{meta.label}</h2>
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${meta.cls}`}>
                        {items.length}
                      </span>
                      {groupCollapsed && groupExpandedCount > 0 && (
                        <span className="text-xs text-muted-foreground">
                          ({groupExpandedCount}개 상세 펼침)
                        </span>
                      )}
                    </button>
                    {!groupCollapsed && items.length > 1 && (
                      <button
                        onClick={() => {
                          // 모두 펼침/접기 토글 — 이 섹션 안의 컴포넌트만 영향.
                          const compNames = items.map((s) => s.component);
                          const anyOpen = compNames.some((c) => expanded.has(c));
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            if (anyOpen) compNames.forEach((c) => next.delete(c));
                            else compNames.forEach((c) => next.add(c));
                            return next;
                          });
                        }}
                        className="text-xs px-2 py-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary"
                      >
                        {items.some((s) => expanded.has(s.component)) ? '모두 접기' : '모두 펼치기'}
                      </button>
                    )}
                  </header>
                  {!groupCollapsed && (
                  <ul className="divide-y divide-border">
                    {items.map((snap) => {
                      const isOpen = expanded.has(snap.component);
                      return (
                        <li key={snap.component}>
                          <button
                            onClick={() => toggle(snap.component)}
                            className="w-full flex items-center justify-between px-5 py-3 hover:bg-muted/30 transition-colors text-left"
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              {isOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                                       : <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
                              <span className="font-mono text-sm text-foreground truncate">{snap.component}</span>
                              {snap.version && (
                                <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/30">
                                  {snap.version}
                                </span>
                              )}
                            </div>
                            <span className="text-xs text-muted-foreground font-mono flex-shrink-0 ml-2">
                              {formatDateTime(snap.collectedAt)}
                            </span>
                          </button>
                          {isOpen && (
                            <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-border border-t border-border bg-muted/10">
                              <div className="px-5 py-4">
                                <p className="text-xs text-muted-foreground uppercase mb-2 tracking-wider">현재 값</p>
                                <ComponentDetails snap={snap} />
                              </div>
                              <div>
                                <p className="text-xs text-muted-foreground uppercase px-4 pt-4 tracking-wider">히스토리</p>
                                <HistoryTimeline
                                  clusterId={clusterId}
                                  component={snap.component}
                                  onPickDiff={(from, to) => setDiffPair({ from, to })}
                                />
                              </div>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  )}
                </section>
              );
            })}

            {diffPair && (
              <DiffPanel
                clusterId={clusterId}
                from={diffPair.from}
                to={diffPair.to}
                onClose={() => setDiffPair(null)}
              />
            )}
          </div>
        )}
        </div>
      </main>

      <EtcdSystemdModal
        open={etcdModalOpen && !!clusterId}
        clusterId={clusterId}
        onClose={() => setEtcdModalOpen(false)}
      />
      <KernelParamsCollectModal
        open={kernelModalOpen && !!clusterId}
        clusterId={clusterId}
        onClose={() => setKernelModalOpen(false)}
      />
      <NodeNicsCollectModal
        open={nicsModalOpen && !!clusterId}
        clusterId={clusterId}
        onClose={() => {
          setNicsModalOpen(false);
          // Cluster 정보 (node_ips) 가 갱신됐을 수 있으므로 클러스터 캐시 무효화
          queryClient.invalidateQueries({ queryKey: ['clusters'] });
        }}
      />
      <KubeletConfigCollectModal
        open={kubeletModalOpen && !!clusterId}
        clusterId={clusterId}
        onClose={() => {
          setKubeletModalOpen(false);
          // 새 kubelet_config 스냅샷이 생겼을 수 있으니 current 캐시 무효화
          queryClient.invalidateQueries({ queryKey: ['versions', 'current', clusterId] });
        }}
      />
      <CsvExportModal
        open={csvModalOpen && !!clusterId}
        clusterId={clusterId}
        clusterName={clusters.find((c) => c.id === clusterId)?.name ?? clusterId}
        components={current?.components ?? []}
        onClose={() => setCsvModalOpen(false)}
      />
    </div>
  );
}
