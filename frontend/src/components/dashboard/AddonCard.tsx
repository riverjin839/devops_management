import { Addon } from '@/types';
import { Pencil, Play, Trash2, Crown, ClipboardList, Clock, AlertTriangle } from 'lucide-react';
import { StatusBadge } from './StatusBadge';
import { formatRelativeTime } from '@/lib/utils';

interface AddonCardProps {
  addon: Addon;
  onClick?: () => void;
  onEdit?: (addon: Addon) => void;
  onDelete?: (addon: Addon) => void;
  onRun?: (addon: Addon) => void;
}

// ── Detail type definitions ────────────────────────────

// Addon.details 는 backend JSONB에서 nested object를 포함하므로 Addon['details'] 그대로 사용
type Details = NonNullable<Addon['details']>;

interface NodeIssue {
  node: string;
  reason: string;
}

interface ComponentStatus {
  name: string;
  status: string;
  latencyMs?: number;
  ready?: number;
  total?: number;
}

// ── Type-specific detail renderers ─────────────────────

function EtcdDetails({ details }: { details: Details }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {details.isLeader !== undefined && (
        <span className="text-sm text-muted-foreground font-mono inline-flex items-center gap-1">
          {details.isLeader
            ? <><Crown className="w-3.5 h-3.5" /> Leader</>
            : <><ClipboardList className="w-3.5 h-3.5" /> Follower</>}
        </span>
      )}
      {details.version && (
        <span className="text-sm text-muted-foreground font-mono">v{details.version}</span>
      )}
      {details.dbSizeMb !== undefined && (
        <span className="text-sm text-muted-foreground font-mono">DB: {details.dbSizeMb}MB</span>
      )}
      {details.memberCount !== undefined && (
        <span className="text-sm text-muted-foreground font-mono">Members: {details.memberCount}</span>
      )}
      {details.raftTerm !== undefined && (
        <span className="text-sm text-muted-foreground font-mono">Term: {details.raftTerm}</span>
      )}
    </div>
  );
}

/** 공통 prefix + 숫자 suffix 를 정규식/브라켓 패턴으로 압축.
 *  예) ['k8s-master-01','k8s-master-02','k8s-worker-01'] → 'k8s-master-[01-02], k8s-worker-01'
 */
function compressNodeNames(names: string[]): string {
  if (names.length === 0) return '';
  const groups = new Map<string, { width: number; nums: number[] }>();
  const standalone: string[] = [];

  for (const name of names) {
    const m = name.match(/^(.+?)(\d+)$/);
    if (!m) {
      standalone.push(name);
      continue;
    }
    const [, prefix, numStr] = m;
    const group = groups.get(prefix);
    const n = parseInt(numStr, 10);
    if (group) {
      group.nums.push(n);
      group.width = Math.max(group.width, numStr.length);
    } else {
      groups.set(prefix, { width: numStr.length, nums: [n] });
    }
  }

  const parts: string[] = [];
  for (const [prefix, { width, nums }] of groups) {
    nums.sort((a, b) => a - b);
    const pad = (n: number) => String(n).padStart(width, '0');

    if (nums.length === 1) {
      parts.push(`${prefix}${pad(nums[0])}`);
      continue;
    }

    // 연속 범위로 쪼개기: [1,2,3,5,7,8] → "01-03,05,07-08"
    const ranges: string[] = [];
    let start = nums[0];
    let prev = nums[0];
    for (let i = 1; i <= nums.length; i++) {
      const curr = nums[i];
      if (i === nums.length || curr !== prev + 1) {
        ranges.push(start === prev ? pad(start) : `${pad(start)}-${pad(prev)}`);
        start = curr;
      }
      prev = curr;
    }
    parts.push(`${prefix}[${ranges.join(',')}]`);
  }
  return [...parts, ...standalone].join(', ');
}

function NodeDetails({ details }: { details: Details }) {
  const total = Number(details.total ?? 0);
  const ready = Number(details.ready ?? 0);
  const issues: NodeIssue[] = Array.isArray(details.issues) ? details.issues : [];
  const allNodes: string[] = Array.isArray(details.nodes) ? (details.nodes as string[]) : [];
  const notReadyNodes: string[] = Array.isArray(details.notReady) ? (details.notReady as string[]) : [];
  const pct = total > 0 ? Math.round((ready / total) * 100) : 0;

  const pattern = allNodes.length > 0 ? compressNodeNames(allNodes) : '';
  const notReadyPattern = notReadyNodes.length > 0 ? compressNodeNames(notReadyNodes) : '';

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={`text-sm font-semibold font-mono ${ready < total ? 'text-status-warning' : 'text-status-healthy'}`}>
          {ready}/{total} Ready
        </span>
        {issues.length > 0 && (
          <span className="text-sm text-status-critical font-mono inline-flex items-center gap-1">
            <AlertTriangle className="w-3.5 h-3.5" /> {issues.length} pressure
          </span>
        )}
      </div>
      <div className="w-full bg-secondary rounded-full h-1.5">
        <div
          className={`h-1.5 rounded-full transition-all ${pct === 100 ? 'bg-status-healthy' : pct > 80 ? 'bg-status-warning' : 'bg-status-critical'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {pattern && (
        <div
          className="text-xs font-mono text-muted-foreground break-all"
          title={allNodes.join('\n')}
        >
          {pattern}
        </div>
      )}
      {notReadyPattern && (
        <div className="text-xs font-mono text-status-critical/80 break-all" title={notReadyNodes.join('\n')}>
          NotReady: {notReadyPattern}
        </div>
      )}
    </div>
  );
}

function ControlPlaneDetails({ details }: { details: Details }) {
  const components: ComponentStatus[] = Array.isArray(details.components) ? details.components : [];
  const apiLatency = Number(details.apiLatencyMs ?? 0);

  return (
    <div className="space-y-1.5">
      {components.map((comp) => (
        <div key={comp.name} className="flex items-center justify-between text-sm font-mono">
          <span className="text-muted-foreground flex items-center gap-1.5">
            <span className={`inline-block w-2 h-2 rounded-full ${
              comp.status === 'healthy' ? 'bg-status-healthy' : comp.status === 'warning' ? 'bg-status-warning' : 'bg-status-critical'
            }`} />
            {comp.name}
          </span>
          {comp.latencyMs !== undefined ? (
            <span className="text-muted-foreground">{comp.latencyMs}ms</span>
          ) : comp.ready !== undefined ? (
            <span className="text-muted-foreground">{comp.ready}/{comp.total}</span>
          ) : null}
        </div>
      ))}
      {apiLatency > 0 && (
        <div className="text-sm text-muted-foreground font-mono pt-1 border-t border-border/50">
          API Latency: {apiLatency}ms
        </div>
      )}
    </div>
  );
}

function SystemPodDetails({ details }: { details: Details }) {
  const readyPods = Number(details.readyPods ?? 0);
  const totalPods = Number(details.totalPods ?? 0);
  const totalNodes = details.totalNodes != null ? Number(details.totalNodes) : undefined;
  const ratioPct = details.ratioPct != null ? Number(details.ratioPct) : undefined;
  const kind = String(details.kind ?? 'deployment');

  const denominator = kind === 'daemonset' && totalNodes !== undefined ? totalNodes : totalPods;
  const pct = denominator > 0 ? Math.round((readyPods / denominator) * 100) : 0;
  const displayPct = ratioPct !== undefined ? ratioPct : pct;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold font-mono">
          {readyPods}/{denominator} Ready
        </span>
        <span className="text-sm text-muted-foreground font-mono">{displayPct}%</span>
      </div>
      <div className="w-full bg-secondary rounded-full h-1.5">
        <div
          className={`h-1.5 rounded-full transition-all ${displayPct >= 100 ? 'bg-status-healthy' : displayPct > 80 ? 'bg-status-warning' : 'bg-status-critical'}`}
          style={{ width: `${Math.min(displayPct, 100)}%` }}
        />
      </div>
    </div>
  );
}

// ── DevOps tool detail renderers ─────────────────────

function NexusDetails({ details }: { details: Details }) {
  const writable = details.writable as boolean;
  const systemStatus = String(details.systemStatus ?? 'unknown');

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className={`inline-block w-2 h-2 rounded-full ${writable ? 'bg-status-healthy' : 'bg-status-critical'}`} />
        <span className={`text-sm font-semibold font-mono ${writable ? 'text-status-healthy' : 'text-status-critical'}`}>
          {writable ? 'Writable' : 'Read-Only'}
        </span>
      </div>
      <div className="text-sm text-muted-foreground font-mono">
        System: {systemStatus}
      </div>
    </div>
  );
}

function JenkinsDetails({ details }: { details: Details }) {
  const mode = String(details.mode ?? 'UNKNOWN');
  const quietingDown = details.quietingDown as boolean;
  const numExecutors = Number(details.numExecutors ?? 0);
  const queueItems = Number(details.queueItems ?? 0);

  const modeColor = mode === 'NORMAL' && !quietingDown
    ? 'text-status-healthy' : quietingDown ? 'text-status-warning' : 'text-status-critical';

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm font-mono">
        <span className="text-muted-foreground flex items-center gap-1.5">
          <span className={`inline-block w-2 h-2 rounded-full ${
            mode === 'NORMAL' && !quietingDown ? 'bg-status-healthy' : quietingDown ? 'bg-status-warning' : 'bg-status-critical'
          }`} />
          Mode
        </span>
        <span className={modeColor}>{quietingDown ? 'Quieting Down' : mode}</span>
      </div>
      <div className="flex items-center justify-between text-sm font-mono">
        <span className="text-muted-foreground">Executors</span>
        <span className="text-muted-foreground">{numExecutors}</span>
      </div>
      <div className="flex items-center justify-between text-sm font-mono">
        <span className="text-muted-foreground">Queue</span>
        <span className={queueItems > 20 ? 'text-status-warning' : 'text-muted-foreground'}>{queueItems}</span>
      </div>
    </div>
  );
}

interface ProblemApp {
  name: string;
  sync: string;
  health: string;
}

function ArgoCDDetails({ details }: { details: Details }) {
  const totalApps = Number(details.totalApps ?? 0);
  const synced = Number(details.synced ?? 0);
  const outOfSync = Number(details.outOfSync ?? 0);
  const healthy = Number(details.healthy ?? 0);
  const degraded = Number(details.degraded ?? 0);
  const progressing = Number(details.progressing ?? 0);
  const problemApps: ProblemApp[] = Array.isArray(details.problemApps) ? details.problemApps : [];

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-3 text-sm font-mono">
        <span className="text-muted-foreground">Apps: <strong className="text-foreground">{totalApps}</strong></span>
        <span className="text-status-healthy">Synced: {synced}</span>
        {outOfSync > 0 && <span className="text-status-warning">OutOfSync: {outOfSync}</span>}
      </div>
      <div className="flex items-center gap-3 text-sm font-mono">
        <span className="text-status-healthy">Healthy: {healthy}</span>
        {degraded > 0 && <span className="text-status-critical">Degraded: {degraded}</span>}
        {progressing > 0 && <span className="text-status-info">Progressing: {progressing}</span>}
      </div>
      {problemApps.length > 0 && (
        <div className="pt-1 border-t border-border/50 space-y-0.5">
          {problemApps.slice(0, 3).map((app) => (
            <div key={app.name} className="flex items-center justify-between text-sm font-mono">
              <span className="text-muted-foreground truncate max-w-[120px]">{app.name}</span>
              <span className={app.health === 'Degraded' ? 'text-status-critical' : 'text-status-warning'}>
                {app.sync}/{app.health}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface HealthCheck {
  name: string;
  status: string;
}

function KeycloakDetails({ details }: { details: Details }) {
  const ready = details.ready as boolean;
  const overallStatus = String(details.overallStatus ?? 'unknown');
  const dbStatus = String(details.dbStatus ?? 'unknown');
  const checks: HealthCheck[] = Array.isArray(details.checks) ? details.checks : [];

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className={`inline-block w-2 h-2 rounded-full ${ready ? 'bg-status-healthy' : 'bg-status-critical'}`} />
        <span className={`text-sm font-semibold font-mono ${ready ? 'text-status-healthy' : 'text-status-critical'}`}>
          {ready ? 'Auth Service Ready' : 'Not Ready'}
        </span>
      </div>
      {checks.length > 0 ? (
        checks.map((chk) => (
          <div key={chk.name} className="flex items-center justify-between text-sm font-mono">
            <span className="text-muted-foreground">{chk.name}</span>
            <span className={chk.status === 'UP' ? 'text-status-healthy' : 'text-status-critical'}>{chk.status}</span>
          </div>
        ))
      ) : (
        <div className="text-sm text-muted-foreground font-mono">
          Status: {overallStatus} / DB: {dbStatus}
        </div>
      )}
    </div>
  );
}

// ── Detail renderer dispatcher ─────────────────────────

function AddonDetails({ addon }: { addon: Addon }) {
  if (!addon.details) return null;

  switch (addon.type) {
    case 'etcd-leader':
    case 'etcdLeader':
      return <EtcdDetails details={addon.details} />;
    case 'node-check':
    case 'nodeCheck':
      return <NodeDetails details={addon.details} />;
    case 'control-plane':
    case 'controlPlane':
      return <ControlPlaneDetails details={addon.details} />;
    case 'system-pod':
    case 'systemPod':
      return <SystemPodDetails details={addon.details} />;
    case 'nexus':
      return <NexusDetails details={addon.details} />;
    case 'jenkins':
      return <JenkinsDetails details={addon.details} />;
    case 'argocd':
      return <ArgoCDDetails details={addon.details} />;
    case 'keycloak':
      return <KeycloakDetails details={addon.details} />;
    default:
      return (
        <>
          {Object.entries(addon.details).slice(0, 2).map(([key, value]) => (
            <span key={key} className="text-sm text-muted-foreground font-mono flex items-center gap-1.5">
              {key}: {String(value)}
            </span>
          ))}
        </>
      );
  }
}

// ── Main card ──────────────────────────────────────────

export function AddonCard({ addon, onClick, onEdit, onDelete, onRun }: AddonCardProps) {
  const command = String(addon.details?.command ?? addon.details?.url ?? "").trim();
  const lastMessage = String(addon.details?.lastMessage ?? addon.details?.last_message ?? "").trim();
  const hoverDetail = [
    command ? `명령/요청: ${command}` : "",
    lastMessage ? `최근 로그: ${lastMessage}` : "",
  ].filter(Boolean).join("\n");

  return (
    <div
      className="bg-card border border-border rounded-xl p-5 hover:border-muted-foreground/30 transition-all cursor-pointer hover:-translate-y-0.5"
      onClick={onClick}
      title={hoverDetail || undefined}
    >
      <div className="flex items-start justify-between mb-4 gap-2">
        <div className="w-11 h-11 rounded-lg bg-secondary flex items-center justify-center text-xl shrink-0">
          {addon.icon}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StatusBadge status={addon.status} />
          {onRun && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRun(addon);
              }}
              className="p-1.5 rounded-md hover:bg-status-healthy/10 text-status-healthy transition-colors"
              title="Run this check"
              aria-label="Run this check"
            >
              <Play className="w-4 h-4" />
            </button>
          )}
          {onEdit && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onEdit(addon);
              }}
              className="p-1.5 rounded-md hover:bg-primary/10 text-primary transition-colors"
              title="Edit check"
              aria-label="Edit check"
            >
              <Pencil className="w-4 h-4" />
            </button>
          )}
          {onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(addon);
              }}
              className="p-1.5 rounded-md hover:bg-status-critical/10 text-status-critical transition-colors"
              title="Delete check"
              aria-label="Delete check"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <h3 className="text-base font-semibold mb-1">{addon.name}</h3>
      <p className="text-sm text-muted-foreground mb-4">{addon.description}</p>

      <div className="pt-4 border-t border-border space-y-2">
        <AddonDetails addon={addon} />
        <div className="flex items-center gap-4">
          {addon.responseTime !== undefined && addon.responseTime > 0 && (
            <span className="text-sm text-muted-foreground font-mono flex items-center gap-1.5">
              <Clock className="w-3 h-3" /> {addon.responseTime}ms
            </span>
          )}
          <span className="text-sm text-muted-foreground font-mono ml-auto">
            {formatRelativeTime(addon.lastCheck)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Grid ───────────────────────────────────────────────

interface AddonGridProps {
  addons: Addon[];
  isLoading?: boolean;
  onAddonClick?: (addon: Addon) => void;
  onAddDefaultAddons?: () => void;
  onEditAddon?: (addon: Addon) => void;
  onDeleteAddon?: (addon: Addon) => void;
  onRunAddon?: (addon: Addon) => void;
}

export function AddonGrid({ addons, isLoading, onAddonClick, onAddDefaultAddons, onEditAddon, onDeleteAddon, onRunAddon }: AddonGridProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-card border border-border rounded-xl p-5 h-44 animate-pulse" />
        ))}
      </div>
    );
  }

  if (addons.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground mb-4">이 클러스터에 등록된 점검 항목이 없습니다</p>
        {onAddDefaultAddons && (
          <button
            onClick={onAddDefaultAddons}
            className="px-4 py-2 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded-xl transition-colors"
          >
            + 기본 점검 항목 추가
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {addons.map((addon) => (
          <AddonCard
            key={addon.id}
            addon={addon}
            onClick={() => onAddonClick?.(addon)}
            onEdit={onEditAddon}
            onDelete={onDeleteAddon}
            onRun={onRunAddon}
          />
        ))}
      </div>
      {onAddDefaultAddons && (
        <div className="text-center">
          <button
            onClick={onAddDefaultAddons}
            className="px-4 py-2 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded-xl transition-colors"
          >
            + 누락된 점검 항목 추가
          </button>
        </div>
      )}
    </div>
  );
}
