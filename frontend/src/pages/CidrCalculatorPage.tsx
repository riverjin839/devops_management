import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Calculator,
  Check,
  Copy,
  ExternalLink,
  GitCompare,
  Globe,
  Lock,
  Plus,
  Scissors,
  Trash2,
} from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useClusterStore } from '@/stores/clusterStore';
import { clustersApi } from '@/services/api';
import { ResizeGrip, DoubleScrollX} from '@/components/common';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { MacCard } from '@/components/ui/MacCard';

// ── Pure CIDR logic ───────────────────────────────────────────────────────────

function ipToNum(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
}

function numToIp(n: number): string {
  return [
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ].join('.');
}

function maskFromPrefix(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

interface CidrInfo {
  network: string;
  broadcast: string;
  mask: string;
  wildcard: string;
  firstHost: string;
  lastHost: string;
  totalHosts: number;
  usableHosts: number;
  prefix: number;
  ipClass: string;
}

function parseCidr(cidr: string): CidrInfo | null {
  const match = cidr.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/);
  if (!match) return null;

  const [, ipStr, prefixStr] = match;
  const prefix = parseInt(prefixStr, 10);
  if (prefix < 0 || prefix > 32) return null;

  const octets = ipStr.split('.').map(Number);
  if (octets.some((o) => o < 0 || o > 255)) return null;

  const ipNum = ipToNum(ipStr);
  const mask = maskFromPrefix(prefix);
  const networkNum = (ipNum & mask) >>> 0;
  const broadcastNum = (networkNum | (~mask >>> 0)) >>> 0;

  const totalHosts = Math.pow(2, 32 - prefix);
  const usableHosts = prefix >= 31 ? totalHosts : Math.max(totalHosts - 2, 0);
  const firstHost = prefix >= 31 ? networkNum : networkNum + 1;
  const lastHost = prefix >= 31 ? broadcastNum : broadcastNum - 1;

  // IP class
  const firstOctet = octets[0];
  let ipClass = 'A';
  if (firstOctet >= 128 && firstOctet <= 191) ipClass = 'B';
  else if (firstOctet >= 192 && firstOctet <= 223) ipClass = 'C';
  else if (firstOctet >= 224 && firstOctet <= 239) ipClass = 'D (Multicast)';
  else if (firstOctet >= 240) ipClass = 'E (Reserved)';

  return {
    network: numToIp(networkNum),
    broadcast: numToIp(broadcastNum),
    mask: numToIp(mask),
    wildcard: numToIp(~mask >>> 0),
    firstHost: numToIp(firstHost),
    lastHost: numToIp(lastHost),
    totalHosts,
    usableHosts,
    prefix,
    ipClass,
  };
}

// Divide a CIDR block into N equal subnets
function divideSubnets(cidr: string, count: number): string[] {
  if (count < 2 || count > 256) return [];
  const info = parseCidr(cidr);
  if (!info) return [];

  const bitsNeeded = Math.ceil(Math.log2(count));
  const newPrefix = info.prefix + bitsNeeded;
  if (newPrefix > 32) return [];

  const base = ipToNum(info.network);
  const step = Math.pow(2, 32 - newPrefix);
  const result: string[] = [];
  for (let i = 0; i < Math.pow(2, bitsNeeded); i++) {
    result.push(`${numToIp((base + i * step) >>> 0)}/${newPrefix}`);
  }
  return result;
}

interface OverlapRange {
  start: string;
  end: string;
  size: number;
}

/**
 * 두 CIDR 의 실제 겹치는 IP 구간을 반환. 안 겹치면 null.
 * 가독성 개선용 — "어디까지 겹치는지" 를 사용자에게 명확히 보여주기 위함.
 */
function computeOverlap(cidr1: string, cidr2: string): OverlapRange | null {
  const r1 = parseCidr(cidr1);
  const r2 = parseCidr(cidr2);
  if (!r1 || !r2) return null;
  const start1 = ipToNum(r1.network);
  const end1 = ipToNum(r1.broadcast);
  const start2 = ipToNum(r2.network);
  const end2 = ipToNum(r2.broadcast);
  if (start1 > end2 || start2 > end1) return null;
  const start = Math.max(start1, start2);
  const end = Math.min(end1, end2);
  return { start: numToIp(start), end: numToIp(end), size: end - start + 1 };
}

function cidrsOverlap(cidr1: string, cidr2: string): boolean {
  return computeOverlap(cidr1, cidr2) !== null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isPrivateRange(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  return false;
}

function maskBinary(mask: string): string[] {
  return mask.split('.').map((o) => parseInt(o, 10).toString(2).padStart(8, '0'));
}

function formatHosts(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

// ── UI subatoms ───────────────────────────────────────────────────────────────

function CopyButton({ value, className = '' }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`inline-flex items-center justify-center p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors ${className}`}
      title="복사"
      aria-label={`Copy ${value}`}
    >
      {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

interface StatTileProps {
  label: string;
  value: string;
  accent?: 'default' | 'primary' | 'success';
}

function StatTile({ label, value, accent = 'default' }: StatTileProps) {
  const accentCls =
    accent === 'primary' ? 'text-primary' :
    accent === 'success' ? 'text-emerald-600' : 'text-foreground';
  return (
    <div className="group relative bg-secondary/40 hover:bg-secondary/70 border border-border rounded-lg px-3 py-2.5 transition-colors">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className="opacity-0 group-hover:opacity-100 transition-opacity">
          <CopyButton value={value} />
        </span>
      </div>
      <div className={`font-mono text-sm tabular-nums truncate ${accentCls}`} title={value}>
        {value}
      </div>
    </div>
  );
}

/**
 * 한 쌍의 겹침을 "A ↔ B + 겹치는 IP 구간" 형태로 보여준다.
 * 가독성 개선의 핵심: 좌/우 어느 쪽이 어느 CIDR 인지, 그리고 *어디까지* 겹치는지를
 * 한 줄 카드 안에서 즉시 파악할 수 있게 한다.
 */
interface OverlapPairProps {
  leftLabel: string;
  leftCidr: string;
  rightLabel: string;
  rightCidr: string;
  /** 두 노드의 색상 그룹 (같은 충돌 그룹은 같은 색) */
  hue?: 'amber' | 'rose' | 'fuchsia' | 'orange' | 'cyan';
}

const HUE_TOKENS = {
  amber:   { bg: 'bg-amber-500/10',   border: 'border-amber-500/30',   dot: 'bg-amber-500',   text: 'text-amber-600' },
  rose:    { bg: 'bg-rose-500/10',    border: 'border-rose-500/30',    dot: 'bg-rose-500',    text: 'text-rose-600' },
  fuchsia: { bg: 'bg-fuchsia-500/10', border: 'border-fuchsia-500/30', dot: 'bg-fuchsia-500', text: 'text-fuchsia-600' },
  orange:  { bg: 'bg-orange-500/10',  border: 'border-orange-500/30',  dot: 'bg-orange-500',  text: 'text-orange-600' },
  cyan:    { bg: 'bg-cyan-500/10',    border: 'border-cyan-500/30',    dot: 'bg-cyan-500',    text: 'text-cyan-600' },
} as const;

function OverlapPair({ leftLabel, leftCidr, rightLabel, rightCidr, hue = 'amber' }: OverlapPairProps) {
  const overlap = computeOverlap(leftCidr, rightCidr);
  const tone = HUE_TOKENS[hue];
  return (
    <div className={`px-2.5 py-2 border rounded-md ${tone.bg} ${tone.border}`}>
      <div className="flex items-center gap-2 text-xs">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${tone.dot}`} />
        <div className="flex-1 min-w-0 grid grid-cols-[1fr,auto,1fr] items-center gap-1.5">
          <div className="min-w-0 text-right">
            <div className="font-medium truncate" title={leftLabel}>{leftLabel}</div>
            <div className="font-mono tabular-nums text-[10px] text-muted-foreground truncate">{leftCidr}</div>
          </div>
          <span className={`text-[11px] font-bold ${tone.text}`}>↔</span>
          <div className="min-w-0">
            <div className="font-medium truncate" title={rightLabel}>{rightLabel}</div>
            <div className="font-mono tabular-nums text-[10px] text-muted-foreground truncate">{rightCidr}</div>
          </div>
        </div>
      </div>
      {overlap && (
        <div className="mt-1.5 pt-1.5 border-t border-border/40 flex items-center gap-1.5 text-[10px]">
          <span className="uppercase tracking-wider text-muted-foreground">겹침 구간</span>
          <span className="font-mono tabular-nums text-foreground truncate">
            {overlap.start} – {overlap.end}
          </span>
          <span className="font-mono tabular-nums text-muted-foreground ml-auto flex-shrink-0">
            {formatHosts(overlap.size)} IPs
          </span>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

interface SubnetEntry {
  id: string;
  cidr: string;
  label: string;
}

function genId() {
  return Math.random().toString(36).slice(2, 8);
}

const QUICK_REF: ReadonlyArray<readonly [string, string, string]> = [
  ['/8', '16.7M', 'hosts'],
  ['/16', '65,534', 'hosts'],
  ['/20', '4,094', 'hosts'],
  ['/22', '1,022', 'hosts'],
  ['/24', '254', 'hosts'],
  ['/25', '126', 'hosts'],
  ['/26', '62', 'hosts'],
  ['/27', '30', 'hosts'],
  ['/28', '14', 'hosts'],
  ['/29', '6', 'hosts'],
  ['/30', '2', 'hosts'],
  ['/32', 'Single', 'IP'],
];

export function CidrCalculatorPage() {
  const [searchParams] = useSearchParams();
  const initialCidr = searchParams.get('cidr')?.trim() || '192.168.1.0/24';

  // Main calculator
  const [input, setInput] = useState(initialCidr);
  const [info, setInfo] = useState<CidrInfo | null>(() => parseCidr(initialCidr));
  const [inputError, setInputError] = useState(() =>
    parseCidr(initialCidr) ? '' : '잘못된 CIDR 표기입니다. 예: 192.168.1.0/24',
  );

  // Subnet divider
  const [divideCount, setDivideCount] = useState(4);
  const [subnets, setSubnets] = useState<string[]>([]);
  const [divideError, setDivideError] = useState('');

  const compareColW = useColumnWidths('cidr-compare-table', {
    defaults: { label: 140, network: 180, mask: 160, hosts: 140, overlap: 220 },
    min: 60, max: 600,
  });

  // Apply CIDR to cluster
  const { clusters } = useClusterStore();
  useClusters();
  const [applyClusterId, setApplyClusterId] = useState('');
  const [applyStatus, setApplyStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');

  const handleApplyToCluster = async () => {
    if (!applyClusterId || !info) return;
    setApplyStatus('loading');
    try {
      const networkCidr = `${info.network}/${info.prefix}`;
      await clustersApi.update(applyClusterId, {
        cidr: networkCidr,
        first_host: info.firstHost,
        last_host: info.lastHost,
      } as Record<string, unknown>);
      setApplyStatus('success');
      setTimeout(() => setApplyStatus('idle'), 3000);
    } catch {
      setApplyStatus('error');
      setTimeout(() => setApplyStatus('idle'), 3000);
    }
  };

  // Multi-CIDR comparator
  const [entries, setEntries] = useState<SubnetEntry[]>([
    { id: genId(), cidr: '10.0.0.0/8', label: 'Cluster A' },
    { id: genId(), cidr: '172.16.0.0/12', label: 'Cluster B' },
  ]);

  const handleCalculate = (value: string) => {
    setInput(value);
    const result = parseCidr(value);
    if (result) {
      setInfo(result);
      setInputError('');
      setSubnets([]);
      setDivideError('');
    } else {
      setInfo(null);
      setInputError('잘못된 CIDR 표기입니다. 예: 192.168.1.0/24');
    }
  };

  const handleDivide = () => {
    if (!info) return;
    const result = divideSubnets(input, divideCount);
    if (result.length === 0) {
      setDivideError(`/${info.prefix} 을 ${divideCount}개로 분할할 수 없습니다 — prefix 가 /32 를 초과합니다`);
      setSubnets([]);
    } else {
      setSubnets(result);
      setDivideError('');
    }
  };

  const addEntry = () => {
    setEntries((prev) => [...prev, { id: genId(), cidr: '10.0.0.0/24', label: `Network ${prev.length + 1}` }]);
  };

  const updateEntry = (id: string, field: keyof SubnetEntry, value: string) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, [field]: value } : e)));
  };

  const removeEntry = (id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };

  // Derived
  const isPrivate = info ? isPrivateRange(info.network) : false;
  const sliderPct = info ? (info.prefix / 32) * 100 : 0;

  const overlappingClusters = useMemo(() => {
    if (!info) return [];
    const cur = `${info.network}/${info.prefix}`;
    return clusters.filter((c) => Boolean(c.cidr) && cidrsOverlap(cur, c.cidr as string));
  }, [info, clusters]);

  /**
   * 비교 테이블의 충돌 그룹별 색상 매핑.
   * 같은 충돌 그룹(서로 겹치는 entry 들의 집합) 은 같은 hue 를 공유해
   * "어느 행끼리 겹치는지" 한눈에 파악할 수 있게 한다.
   */
  const entryHueMap = useMemo(() => {
    const palette: Array<keyof typeof HUE_TOKENS> = ['amber', 'rose', 'fuchsia', 'orange', 'cyan'];
    const groups: string[][] = [];
    const visited = new Set<string>();
    for (const e of entries) {
      if (visited.has(e.id)) continue;
      const stack = [e.id];
      const group: string[] = [];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (visited.has(cur)) continue;
        visited.add(cur);
        group.push(cur);
        const curEntry = entries.find((x) => x.id === cur);
        if (!curEntry) continue;
        for (const other of entries) {
          if (other.id === cur || visited.has(other.id)) continue;
          if (cidrsOverlap(curEntry.cidr, other.cidr)) {
            stack.push(other.id);
          }
        }
      }
      if (group.length > 1) groups.push(group);
    }
    const map: Record<string, keyof typeof HUE_TOKENS> = {};
    groups.forEach((ids, gi) => {
      const hue = palette[gi % palette.length];
      ids.forEach((id) => { map[id] = hue; });
    });
    return map;
  }, [entries]);

  const inputBaseCls =
    'px-3 py-2 bg-secondary border border-border rounded-lg text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 transition-colors';

  return (
    <div className="min-h-screen bg-background">
      <main className="max-w-[1440px] mx-auto px-6 py-6 space-y-5">
        {/* ── Page Header ─────────────────────────────────────────────────── */}
        <header className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center border border-primary/20">
              <Calculator className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">CIDR Calculator</h1>
              <p className="text-xs text-muted-foreground">서브넷 계산 · 분할 · 충돌 검사</p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-sky-500" /> Private (RFC1918)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> Public
            </span>
          </div>
        </header>

        {/* ── HERO: input + summary ──────────────────────────────────────── */}
        <MacCard title="CIDR INPUT" bodyPadding="p-0">
          <div className="grid grid-cols-1 lg:grid-cols-[1.05fr,1fr] divide-y lg:divide-y-0 lg:divide-x divide-border">
            {/* Left: input + slider */}
            <div className="p-5 lg:p-6">
              <label
                htmlFor="cidr-input-main"
                className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2"
              >
                CIDR Notation
              </label>
              <div className="relative">
                <input
                  id="cidr-input-main"
                  type="text"
                  value={input}
                  onChange={(e) => handleCalculate(e.target.value)}
                  placeholder="192.168.1.0/24"
                  spellCheck={false}
                  className={[
                    'w-full px-4 py-3 pr-36 bg-secondary/60 border border-border rounded-xl',
                    'text-lg font-mono tabular-nums tracking-tight',
                    'focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all',
                    inputError ? 'border-rose-500/60 focus:ring-rose-500/30' : '',
                  ].join(' ')}
                />
                {info && !inputError && (
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    <span className="px-2 py-0.5 text-[10px] font-semibold rounded-md bg-primary/10 text-primary border border-primary/20">
                      Class {info.ipClass.split(' ')[0]}
                    </span>
                    <span
                      className={[
                        'px-2 py-0.5 text-[10px] font-semibold rounded-md border inline-flex items-center gap-1',
                        isPrivate
                          ? 'bg-sky-500/10 text-sky-600 border-sky-500/30'
                          : 'bg-amber-500/10 text-amber-600 border-amber-500/30',
                      ].join(' ')}
                    >
                      {isPrivate ? <Lock className="w-2.5 h-2.5" /> : <Globe className="w-2.5 h-2.5" />}
                      {isPrivate ? 'Private' : 'Public'}
                    </span>
                  </div>
                )}
              </div>

              {inputError && (
                <p className="mt-2 text-xs text-rose-500 inline-flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3" />
                  {inputError}
                </p>
              )}

              {/* Address space slider */}
              {info && (
                <div className="mt-6">
                  <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
                    <span>Address Space</span>
                    <span className="font-mono tabular-nums">/{info.prefix}</span>
                  </div>
                  <div className="relative h-2 bg-secondary rounded-full overflow-visible">
                    <div
                      className="absolute inset-y-0 left-0 bg-gradient-to-r from-primary/50 to-primary rounded-full transition-all"
                      style={{ width: `${sliderPct}%` }}
                    />
                    <div
                      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-3.5 bg-card border-2 border-primary rounded-full transition-all"
                      style={{ left: `${sliderPct}%`, boxShadow: '0 1px 4px rgba(0,0,0,0.12)' }}
                      aria-hidden
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-muted-foreground mt-2 font-mono tabular-nums">
                    <span>/0</span>
                    <span>/8</span>
                    <span>/16</span>
                    <span>/24</span>
                    <span>/32</span>
                  </div>
                </div>
              )}
            </div>

            {/* Right: summary numbers */}
            {info ? (
              <div className="p-5 lg:p-6 bg-muted/30">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                      Usable Hosts
                    </div>
                    <div className="text-3xl font-bold tabular-nums text-primary leading-none">
                      {formatHosts(info.usableHosts)}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1.5 font-mono tabular-nums">
                      {info.usableHosts.toLocaleString()} addresses
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                      Total
                    </div>
                    <div className="text-3xl font-bold tabular-nums text-foreground leading-none">
                      {formatHosts(info.totalHosts)}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1.5 font-mono tabular-nums">
                      2<sup>{32 - info.prefix}</sup> addresses
                    </div>
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t border-border">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
                    Host Range
                  </div>
                  <div className="flex items-center gap-2 font-mono tabular-nums text-sm">
                    <span className="text-emerald-600 font-medium">{info.firstHost}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-muted-foreground/60 flex-shrink-0" />
                    <span className="text-emerald-600 font-medium">{info.lastHost}</span>
                    <CopyButton value={`${info.firstHost} - ${info.lastHost}`} className="ml-auto" />
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-6 bg-muted/30 flex items-center justify-center text-xs text-muted-foreground">
                CIDR 입력 시 결과가 여기에 표시됩니다.
              </div>
            )}
          </div>
        </MacCard>

        {/* ── Network Details (tiles + binary mask) ──────────────────────── */}
        {info && (
          <MacCard title="Network Details">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
              <StatTile label="Network" value={`${info.network}/${info.prefix}`} accent="primary" />
              <StatTile label="Broadcast" value={info.broadcast} />
              <StatTile label="Subnet Mask" value={info.mask} />
              <StatTile label="Wildcard" value={info.wildcard} />
            </div>

            {/* Binary mask visualization */}
            <div className="mt-4 p-3.5 bg-secondary/40 border border-border rounded-lg">
              <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Binary Mask
                </span>
                <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-sm bg-primary" />
                    network bits ({info.prefix})
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-sm bg-muted-foreground/30" />
                    host bits ({32 - info.prefix})
                  </span>
                </div>
              </div>
              <div className="font-mono text-sm tabular-nums tracking-tight flex flex-wrap items-center gap-x-2.5 gap-y-1">
                {maskBinary(info.mask).map((octet, i) => (
                  <span key={i} className="inline-flex items-center">
                    <span className="inline-flex">
                      {octet.split('').map((bit, j) => {
                        const bitIdx = i * 8 + j;
                        const isNetwork = bitIdx < info.prefix;
                        return (
                          <span
                            key={j}
                            className={
                              isNetwork
                                ? 'text-primary font-semibold'
                                : 'text-muted-foreground/50'
                            }
                          >
                            {bit}
                          </span>
                        );
                      })}
                    </span>
                    {i < 3 && <span className="text-border ml-2">·</span>}
                  </span>
                ))}
              </div>
            </div>

            {/* Cluster overlap warning — "현재 입력 ↔ 클러스터" 형태로 양쪽을 함께 보여준다 */}
            {overlappingClusters.length > 0 && (() => {
              const cur = `${info.network}/${info.prefix}`;
              return (
                <div className="mt-3">
                  <p className="text-xs font-semibold text-amber-600 inline-flex items-center gap-1.5 mb-2">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    등록 클러스터와 CIDR 겹침 — {overlappingClusters.length}개 충돌
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {overlappingClusters.map((c) => (
                      <OverlapPair
                        key={c.id}
                        leftLabel="현재 입력"
                        leftCidr={cur}
                        rightLabel={c.name}
                        rightCidr={c.cidr as string}
                        hue="amber"
                      />
                    ))}
                  </div>
                </div>
              );
            })()}
          </MacCard>
        )}

        {/* ── Body grid: Subnet divider + Compare | Apply + Quick ref ───── */}
        <div className="grid grid-cols-1 xl:grid-cols-[1.5fr,1fr] gap-5 items-start">
          {/* LEFT column */}
          <div className="space-y-5 min-w-0">
            {/* Subnet divider */}
            {info && (
              <MacCard title="서브넷 분할 (SUBNET DIVIDER)">
                <div className="flex items-end gap-3 flex-wrap">
                  <div className="flex-shrink-0">
                    <label
                      htmlFor="cidr-divide-count"
                      className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5"
                    >
                      분할 개수
                    </label>
                    <input
                      id="cidr-divide-count"
                      type="number"
                      min={2}
                      max={256}
                      value={divideCount}
                      onChange={(e) => setDivideCount(parseInt(e.target.value, 10) || 2)}
                      className={`${inputBaseCls} w-24`}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleDivide}
                    className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors inline-flex items-center gap-1.5"
                  >
                    <Scissors className="w-3.5 h-3.5" />
                    분할
                  </button>
                  <div className="flex-1 min-w-0 text-[11px] text-muted-foreground">
                    {info.network}/{info.prefix} 을 {divideCount}개 균등 분할
                    {(() => {
                      const bits = Math.ceil(Math.log2(Math.max(divideCount, 2)));
                      const newPrefix = info.prefix + bits;
                      if (newPrefix > 32) return <> · <span className="text-rose-500">/32 초과</span></>;
                      return <> · 결과 prefix /{newPrefix} · 각 {formatHosts(Math.pow(2, 32 - newPrefix))} addresses</>;
                    })()}
                  </div>
                </div>

                {divideError && (
                  <p className="mt-3 text-xs text-rose-500 inline-flex items-center gap-1.5">
                    <AlertTriangle className="w-3 h-3" />
                    {divideError}
                  </p>
                )}

                {subnets.length > 0 && (
                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-72 overflow-y-auto pr-1">
                    {subnets.map((s, i) => {
                      const si = parseCidr(s);
                      return (
                        <div
                          key={i}
                          className="group flex items-center gap-2 px-3 py-2 bg-secondary/40 hover:bg-secondary border border-border rounded-md text-xs transition-colors"
                        >
                          <span className="text-[10px] text-muted-foreground font-mono tabular-nums w-7 flex-shrink-0">
                            #{String(i + 1).padStart(2, '0')}
                          </span>
                          <span className="font-mono tabular-nums font-medium flex-shrink-0">{s}</span>
                          {si && (
                            <span className="text-[10px] text-muted-foreground font-mono tabular-nums truncate ml-auto">
                              {si.firstHost}–{si.lastHost}
                            </span>
                          )}
                          <span className="opacity-0 group-hover:opacity-100 transition-opacity">
                            <CopyButton value={s} />
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </MacCard>
            )}

            {/* Multi-CIDR comparator — 같은 충돌 그룹은 같은 색으로 묶어 표시 */}
            <MacCard title="멀티 CIDR 비교 (OVERLAP CHECK)">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[11px] text-muted-foreground inline-flex items-center gap-1.5">
                  <GitCompare className="w-3.5 h-3.5" />
                  여러 CIDR 블록의 주소 충돌을 한눈에 확인합니다 — 같은 색은 서로 겹치는 그룹
                </p>
                <button
                  type="button"
                  onClick={addEntry}
                  className="px-2.5 py-1 text-[11px] font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded-md transition-colors inline-flex items-center gap-1"
                >
                  <Plus className="w-3 h-3" />
                  추가
                </button>
              </div>

              <div className="space-y-2 mb-4">
                {entries.map((entry) => {
                  const hue = entryHueMap[entry.id];
                  const dot = hue ? HUE_TOKENS[hue].dot : 'bg-muted-foreground/30';
                  return (
                    <div key={entry.id} className="flex items-center gap-2">
                      <span
                        className={`w-1.5 h-6 rounded-full flex-shrink-0 ${dot}`}
                        title={hue ? '겹치는 그룹의 색상' : '충돌 없음'}
                      />
                      <input
                        type="text"
                        value={entry.label}
                        onChange={(e) => updateEntry(entry.id, 'label', e.target.value)}
                        placeholder="Label"
                        className="px-2 py-1.5 bg-secondary border border-border rounded-md text-xs w-32 focus:outline-none focus:ring-1 focus:ring-primary/40"
                      />
                      <input
                        type="text"
                        value={entry.cidr}
                        onChange={(e) => updateEntry(entry.id, 'cidr', e.target.value)}
                        placeholder="10.0.0.0/24"
                        spellCheck={false}
                        className={`${inputBaseCls} flex-1 text-xs py-1.5`}
                      />
                      <button
                        type="button"
                        onClick={() => removeEntry(entry.id)}
                        className="p-1.5 hover:bg-rose-500/10 rounded-md text-muted-foreground hover:text-rose-500 flex-shrink-0 transition-colors"
                        aria-label="Remove entry"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Comparison table */}
              <DoubleScrollX className="border border-border rounded-md">
                <table
                  className="text-xs"
                  style={{ tableLayout: 'fixed', width: 'max-content', minWidth: '100%' }}
                >
                  <colgroup>
                    {(['label', 'network', 'mask', 'hosts', 'overlap'] as const).map((k) => (
                      <col key={k} style={{ width: `${compareColW.getWidth(k)}px` }} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr className="bg-muted/40 border-b border-border">
                      <th className="relative text-left py-2 px-3 text-muted-foreground font-medium uppercase text-[10px] tracking-wider">
                        Label
                        <ResizeGrip onMouseDown={(e) => compareColW.beginResize('label', e)} onDoubleClick={() => compareColW.autoFit('label')} />
                      </th>
                      <th className="relative text-left py-2 px-3 text-muted-foreground font-medium uppercase text-[10px] tracking-wider">
                        Network
                        <ResizeGrip onMouseDown={(e) => compareColW.beginResize('network', e)} onDoubleClick={() => compareColW.autoFit('network')} />
                      </th>
                      <th className="relative text-left py-2 px-3 text-muted-foreground font-medium uppercase text-[10px] tracking-wider">
                        Mask
                        <ResizeGrip onMouseDown={(e) => compareColW.beginResize('mask', e)} onDoubleClick={() => compareColW.autoFit('mask')} />
                      </th>
                      <th className="relative text-right py-2 px-3 text-muted-foreground font-medium uppercase text-[10px] tracking-wider">
                        Usable
                        <ResizeGrip onMouseDown={(e) => compareColW.beginResize('hosts', e)} onDoubleClick={() => compareColW.autoFit('hosts')} />
                      </th>
                      <th className="relative text-left py-2 px-3 text-muted-foreground font-medium uppercase text-[10px] tracking-wider">
                        겹침 상대
                        <ResizeGrip onMouseDown={(e) => compareColW.beginResize('overlap', e)} onDoubleClick={() => compareColW.autoFit('overlap')} />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => {
                      const ei = parseCidr(entry.cidr);
                      const overlappingEntries = entries.filter(
                        (e) => e.id !== entry.id && cidrsOverlap(entry.cidr, e.cidr),
                      );
                      const hue = entryHueMap[entry.id];
                      const hueTone = hue ? HUE_TOKENS[hue] : null;
                      return (
                        <tr
                          key={entry.id}
                          className={`border-b border-border/60 last:border-b-0 transition-colors ${
                            hueTone ? `${hueTone.bg} hover:brightness-95` : 'hover:bg-muted/30'
                          }`}
                        >
                          <td className="py-2 px-3 font-medium truncate">
                            <span className="inline-flex items-center gap-1.5">
                              {hueTone && (
                                <span
                                  className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${hueTone.dot}`}
                                  aria-hidden
                                />
                              )}
                              {entry.label || '—'}
                            </span>
                          </td>
                          <td className="py-2 px-3 font-mono tabular-nums text-muted-foreground truncate">
                            {ei ? `${ei.network}/${ei.prefix}` : <span className="text-rose-500">invalid</span>}
                          </td>
                          <td className="py-2 px-3 font-mono tabular-nums text-muted-foreground truncate">
                            {ei ? ei.mask : '—'}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums text-primary font-medium">
                            {ei ? formatHosts(ei.usableHosts) : '—'}
                          </td>
                          <td className="py-2 px-3">
                            {overlappingEntries.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {overlappingEntries.map((e) => {
                                  const ov = computeOverlap(entry.cidr, e.cidr);
                                  const tone = hueTone ?? HUE_TOKENS.amber;
                                  return (
                                    <span
                                      key={e.id}
                                      className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md border ${tone.bg} ${tone.border} ${tone.text}`}
                                      title={ov ? `겹침 구간: ${ov.start} – ${ov.end} (${formatHosts(ov.size)} IPs)` : undefined}
                                    >
                                      <AlertTriangle className="w-2.5 h-2.5" />
                                      <span className="font-medium">{e.label || e.cidr}</span>
                                      {ov && (
                                        <span className="font-mono tabular-nums text-muted-foreground">
                                          ({formatHosts(ov.size)})
                                        </span>
                                      )}
                                    </span>
                                  );
                                })}
                              </div>
                            ) : ei ? (
                              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 border border-emerald-500/30">
                                <Check className="w-2.5 h-2.5" />
                                clean
                              </span>
                            ) : (
                              <span className="text-muted-foreground/40">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </DoubleScrollX>

              {/* Registered cluster overlap check — entry ↔ cluster 페어로 표시 */}
              {clusters.length > 0 && (() => {
                const conflicts: { entry: SubnetEntry; clusterName: string; clusterCidr: string }[] = [];
                for (const entry of entries) {
                  for (const cluster of clusters) {
                    if (cluster.cidr && cidrsOverlap(entry.cidr, cluster.cidr)) {
                      conflicts.push({ entry, clusterName: cluster.name, clusterCidr: cluster.cidr });
                    }
                  }
                }
                if (conflicts.length === 0) return null;
                return (
                  <div className="mt-3">
                    <p className="text-xs font-semibold text-amber-600 inline-flex items-center gap-1.5 mb-2">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      등록 클러스터 CIDR 겹침 — {conflicts.length}건
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
                      {conflicts.map((c, i) => (
                        <OverlapPair
                          key={i}
                          leftLabel={c.entry.label || c.entry.cidr}
                          leftCidr={c.entry.cidr}
                          rightLabel={c.clusterName}
                          rightCidr={c.clusterCidr}
                          hue={entryHueMap[c.entry.id] ?? 'amber'}
                        />
                      ))}
                    </div>
                  </div>
                );
              })()}
            </MacCard>
          </div>

          {/* RIGHT column */}
          <div className="space-y-5 min-w-0">
            {/* Apply to cluster */}
            {info && clusters.length > 0 && (
              <MacCard title="클러스터에 적용 (APPLY)">
                <p className="text-[11px] text-muted-foreground mb-3 inline-flex items-center gap-1.5">
                  <ExternalLink className="w-3 h-3" />
                  계산된 Network CIDR 을 클러스터 메타정보에 저장
                </p>

                <div className="space-y-2">
                  <label
                    htmlFor="cidr-apply-cluster-select"
                    className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                  >
                    Target Cluster
                  </label>
                  <select
                    id="cidr-apply-cluster-select"
                    value={applyClusterId}
                    onChange={(e) => { setApplyClusterId(e.target.value); setApplyStatus('idle'); }}
                    className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    <option value="">— 클러스터 선택 —</option>
                    {clusters.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}{c.cidr ? ` (현재: ${c.cidr})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Preview of what will be saved */}
                {applyClusterId && (
                  <div className="mt-3 p-3 bg-secondary/40 border border-border rounded-lg">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                      저장될 값
                    </div>
                    <dl className="space-y-1 text-xs font-mono tabular-nums">
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">cidr</dt>
                        <dd className="text-primary truncate">{info.network}/{info.prefix}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">first_host</dt>
                        <dd className="text-emerald-600 truncate">{info.firstHost}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">last_host</dt>
                        <dd className="text-emerald-600 truncate">{info.lastHost}</dd>
                      </div>
                    </dl>
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleApplyToCluster}
                  disabled={!applyClusterId || applyStatus === 'loading'}
                  className="mt-3 w-full px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5"
                >
                  {applyStatus === 'loading' ? '적용 중…' : '클러스터에 적용'}
                </button>

                {applyStatus === 'success' && (
                  <p className="mt-2 text-xs text-emerald-600 inline-flex items-center gap-1">
                    <Check className="w-3 h-3" /> 클러스터 CIDR 이 저장되었습니다
                  </p>
                )}
                {applyStatus === 'error' && (
                  <p className="mt-2 text-xs text-rose-500 inline-flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" /> 저장 실패 — 다시 시도해주세요
                  </p>
                )}

                {applyClusterId && (() => {
                  const currentCidr = `${info.network}/${info.prefix}`;
                  const conflicting = clusters.filter(
                    (c) => c.id !== applyClusterId && Boolean(c.cidr) && cidrsOverlap(currentCidr, c.cidr as string),
                  );
                  if (conflicting.length === 0) return null;
                  return (
                    <div className="mt-3">
                      <p className="text-[11px] font-semibold text-amber-600 inline-flex items-center gap-1.5 mb-1.5">
                        <AlertTriangle className="w-3 h-3" />
                        다른 클러스터와 CIDR 겹침
                      </p>
                      <div className="space-y-1.5">
                        {conflicting.map((c) => (
                          <OverlapPair
                            key={c.id}
                            leftLabel="저장 예정"
                            leftCidr={currentCidr}
                            rightLabel={c.name}
                            rightCidr={c.cidr as string}
                            hue="amber"
                          />
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </MacCard>
            )}

            {/* Quick reference */}
            <MacCard title="QUICK REFERENCE">
              <p className="text-[11px] text-muted-foreground mb-3 inline-flex items-center gap-1.5">
                <BookOpen className="w-3 h-3" />
                자주 쓰이는 prefix별 호스트 수
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                {QUICK_REF.map(([prefix, count, unit]) => (
                  <button
                    key={prefix}
                    type="button"
                    onClick={() => handleCalculate(`${input.split('/')[0] || '192.168.1.0'}${prefix}`)}
                    className="group flex items-center justify-between gap-2 px-2.5 py-1.5 bg-secondary/40 hover:bg-secondary hover:border-primary/30 border border-border rounded-md transition-colors text-left"
                    title={`${prefix} 적용`}
                  >
                    <span className="font-mono tabular-nums text-primary text-xs font-semibold">{prefix}</span>
                    <span className="text-[10px] text-muted-foreground font-mono tabular-nums">
                      <span className="text-foreground">{count}</span> {unit}
                    </span>
                  </button>
                ))}
              </div>
            </MacCard>
          </div>
        </div>
      </main>
    </div>
  );
}
