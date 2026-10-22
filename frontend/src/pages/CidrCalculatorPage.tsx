import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/common/PageHeader';
import { StatTile, StatTileRow } from '@/components/common/StatTile';
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
  Repeat,
  Scissors,
  Trash2,
  X,
} from 'lucide-react';
import { useClusters, useUpdateCluster } from '@/hooks/useCluster';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useUrlParams } from '@/hooks/useUrlParams';
import {
  ConfirmDialog,
  DoubleScrollX,
  EmptyState,
  ErrorState,
  PageShell,
  ResizeGrip,
  useToast,
} from '@/components/common';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { MacCard } from '@/components/ui/MacCard';
import { formatApiError } from '@/lib/utils';
import type { Cluster, ClusterManageUpdate } from '@/types';

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
  else if (firstOctet >= 224 && firstOctet <= 239) ipClass = 'D (멀티캐스트)';
  else if (firstOctet >= 240) ipClass = 'E (예약)';

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

const DIVIDE_MIN = 2;
const DIVIDE_MAX = 256;

type DivisionPlan =
  | { ok: true; requested: number; actual: number; newPrefix: number }
  | { ok: false; reason: string };

/**
 * N개 분할 계획. 서브넷은 2의 거듭제곱으로만 나뉘므로 실제 개수(actual)는 N 이상인 가장 작은 2^k 다.
 * 범위 오류(개수)와 prefix 초과(/32 넘음)는 서로 다른 문구로 알린다.
 */
function planDivision(info: CidrInfo, count: number): DivisionPlan {
  if (!Number.isFinite(count)) {
    return { ok: false, reason: `분할 개수를 입력하세요 (${DIVIDE_MIN}~${DIVIDE_MAX})` };
  }
  if (count < DIVIDE_MIN || count > DIVIDE_MAX) {
    return { ok: false, reason: `분할 개수는 ${DIVIDE_MIN}~${DIVIDE_MAX} 사이여야 합니다 (입력: ${count})` };
  }
  const bits = Math.ceil(Math.log2(count));
  const newPrefix = info.prefix + bits;
  if (newPrefix > 32) {
    return {
      ok: false,
      reason: `${info.network}/${info.prefix} 블록을 ${count}개로 나누면 /${newPrefix}가 되어 /32를 넘습니다`,
    };
  }
  return { ok: true, requested: count, actual: Math.pow(2, bits), newPrefix };
}

function divideSubnets(info: CidrInfo, newPrefix: number, actual: number): string[] {
  const base = ipToNum(info.network);
  const step = Math.pow(2, 32 - newPrefix);
  const result: string[] = [];
  for (let i = 0; i < actual; i++) {
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

// ── 등록 클러스터 대역 (노드·파드·서비스) ─────────────────────────────────────

type ClusterCidrField = 'cidr' | 'podCidr' | 'svcCidr';

const CLUSTER_CIDR_FIELDS: ReadonlyArray<{ key: ClusterCidrField; label: string; band: string }> = [
  { key: 'cidr', label: '노드 CIDR', band: '노드 대역' },
  { key: 'podCidr', label: '파드 CIDR', band: '파드 대역' },
  { key: 'svcCidr', label: '서비스 CIDR', band: '서비스 대역' },
];

interface ClusterRange {
  clusterId: string;
  clusterName: string;
  field: ClusterCidrField;
  band: string;
  cidr: string;
}

interface UnparsedValue {
  clusterName: string;
  band: string;
  value: string;
}

/** 쉼표·공백으로 구분된 CIDR 목록을 나눈다(듀얼스택 `10.0.0.0/16,fd00::/108` 등). */
function splitCidrList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

/** 보이는 클러스터의 노드·파드·서비스 CIDR 을 비교 단위로 펼친다. 해석 못 한 값(IPv6 등)은 따로 모은다. */
function collectClusterRanges(clusters: Cluster[]): { ranges: ClusterRange[]; unparsed: UnparsedValue[] } {
  const ranges: ClusterRange[] = [];
  const unparsed: UnparsedValue[] = [];
  for (const c of clusters) {
    for (const f of CLUSTER_CIDR_FIELDS) {
      for (const value of splitCidrList(c[f.key])) {
        if (parseCidr(value)) {
          ranges.push({ clusterId: c.id, clusterName: c.name, field: f.key, band: f.band, cidr: value });
        } else {
          unparsed.push({ clusterName: c.name, band: f.band, value });
        }
      }
    }
  }
  return { ranges, unparsed };
}

function buildClusterCidrUpdate(field: ClusterCidrField, info: CidrInfo): ClusterManageUpdate {
  const cidr = `${info.network}/${info.prefix}`;
  switch (field) {
    case 'podCidr':
      return { podCidr: cidr, podFirstHost: info.firstHost, podLastHost: info.lastHost };
    case 'svcCidr':
      return { svcCidr: cidr, svcFirstHost: info.firstHost, svcLastHost: info.lastHost };
    default:
      return { cidr, firstHost: info.firstHost, lastHost: info.lastHost };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type IpScope = 'private' | 'loopback' | 'public';

function ipScope(ip: string): IpScope {
  const [a, b] = ip.split('.').map(Number);
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  return 'public';
}

const SCOPE_BADGE: Record<IpScope, { label: string; cls: string; icon: typeof Lock }> = {
  private: { label: '사설', cls: 'bg-chart-1/10 text-chart-1-text border-chart-1/30', icon: Lock },
  loopback: { label: '루프백', cls: 'bg-secondary text-muted-foreground border-border', icon: Repeat },
  public: { label: '공인', cls: 'bg-chart-3/10 text-chart-3-text border-chart-3/30', icon: Globe },
};

function maskBinary(mask: string): string[] {
  return mask.split('.').map((o) => parseInt(o, 10).toString(2).padStart(8, '0'));
}

function formatHosts(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

// ── UI subatoms ───────────────────────────────────────────────────────────────

const COPY_FAILED = '복사할 수 없습니다(HTTPS 필요)';

function CopyButton({ value, className = '' }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    // 비보안 컨텍스트(HTTP 폐쇄망)에서는 navigator.clipboard 자체가 없다 — 무음 TypeError 대신 알린다.
    const pending = navigator.clipboard?.writeText(value);
    if (!pending) {
      toast.error(COPY_FAILED);
      return;
    }
    pending.then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => toast.error(COPY_FAILED),
    );
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`inline-flex items-center justify-center p-1 rounded-xl hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors ${className}`}
      title="복사"
      aria-label={`${value} 복사`}
    >
      {copied ? <Check className="w-3 h-3 text-status-healthy" /> : <Copy className="w-3 h-3" />}
    </button>
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
  amber:   { bg: 'bg-chart-3/10', border: 'border-chart-3/30', dot: 'bg-chart-3', text: 'text-chart-3-text' },
  rose:    { bg: 'bg-chart-5/10', border: 'border-chart-5/30', dot: 'bg-chart-5', text: 'text-chart-5-text' },
  fuchsia: { bg: 'bg-chart-4/10', border: 'border-chart-4/30', dot: 'bg-chart-4', text: 'text-chart-4-text' },
  orange:  { bg: 'bg-chart-7/10', border: 'border-chart-7/30', dot: 'bg-chart-7', text: 'text-chart-7-text' },
  cyan:    { bg: 'bg-chart-6/10', border: 'border-chart-6/30', dot: 'bg-chart-6', text: 'text-chart-6-text' },
} as const;

function OverlapPair({ leftLabel, leftCidr, rightLabel, rightCidr, hue = 'amber' }: OverlapPairProps) {
  const overlap = computeOverlap(leftCidr, rightCidr);
  const tone = HUE_TOKENS[hue];
  return (
    <div className={`px-2.5 py-2 border rounded-md ${tone.bg} ${tone.border}`}>
      <div className="flex items-center gap-2 text-sm">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${tone.dot}`} />
        <div className="flex-1 min-w-0 grid grid-cols-[1fr,auto,1fr] items-center gap-1.5">
          <div className="min-w-0 text-right">
            <div className="font-medium truncate" title={leftLabel}>{leftLabel}</div>
            <div className="font-mono tabular-nums text-xs text-muted-foreground truncate">{leftCidr}</div>
          </div>
          <span className={`text-xs font-bold ${tone.text}`}>↔</span>
          <div className="min-w-0">
            <div className="font-medium truncate" title={rightLabel}>{rightLabel}</div>
            <div className="font-mono tabular-nums text-xs text-muted-foreground truncate">{rightCidr}</div>
          </div>
        </div>
      </div>
      {overlap && (
        <div className="mt-1.5 pt-1.5 border-t border-border/40 flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">겹침 구간</span>
          <span className="font-mono tabular-nums text-foreground truncate">
            {overlap.start} – {overlap.end}
          </span>
          <span className="font-mono tabular-nums text-muted-foreground ml-auto flex-shrink-0">
            {formatHosts(overlap.size)} 주소
          </span>
        </div>
      )}
    </div>
  );
}

/** 클러스터 비교 범위 안내 — "보이는 클러스터 N개 기준" + 해석하지 못한 값 목록(정책 ⑤). */
function ClusterScopeNote({ visibleCount, unparsed }: { visibleCount: number; unparsed: UnparsedValue[] }) {
  return (
    <div className="text-xs text-muted-foreground">
      <p>보이는 클러스터 {visibleCount}개 기준 · 노드·파드·서비스 CIDR 비교</p>
      {unparsed.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-status-warning">
            검사하지 못한 값 {unparsed.length}개
          </summary>
          <p className="mt-1">IPv4 CIDR(예: 10.0.0.0/16)만 비교합니다. IPv6·잘못된 형식은 제외됐습니다.</p>
          <ul className="mt-1 space-y-0.5">
            {unparsed.map((u, i) => (
              <li key={i}>
                {u.clusterName} · {u.band}: <span className="font-mono tabular-nums">{u.value}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

interface ClusterPair {
  key: string;
  leftLabel: string;
  leftCidr: string;
  rightLabel: string;
  rightCidr: string;
  hue?: OverlapPairProps['hue'];
}

interface ClusterOverlapSectionProps {
  failed: boolean;
  error: unknown;
  onRetry: () => void;
  loaded: boolean;
  visibleCount: number;
  unparsed: UnparsedValue[];
  pairs: ClusterPair[];
  conflictTitle: string;
  gridCls: string;
}

/** 등록 클러스터 대역과의 겹침 영역 — 조회 실패는 빈 결과("겹침 없음")가 아니라 ErrorState 로 보인다. */
function ClusterOverlapSection({
  failed, error, onRetry, loaded, visibleCount, unparsed, pairs, conflictTitle, gridCls,
}: ClusterOverlapSectionProps) {
  if (failed) {
    return (
      <div className="mt-3">
        <ErrorState
          compact
          error={error}
          title="클러스터 목록을 불러오지 못해 겹침을 검사하지 못했습니다"
          onRetry={onRetry}
        />
      </div>
    );
  }
  if (!loaded || visibleCount === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {pairs.length > 0 ? (
        <div>
          <p className="text-sm font-semibold text-status-warning inline-flex items-center gap-1.5 mb-2">
            <AlertTriangle className="w-3.5 h-3.5" />
            {conflictTitle}
          </p>
          <div className={gridCls}>
            {pairs.map((p) => (
              <OverlapPair
                key={p.key}
                leftLabel={p.leftLabel}
                leftCidr={p.leftCidr}
                rightLabel={p.rightLabel}
                rightCidr={p.rightCidr}
                hue={p.hue ?? 'amber'}
              />
            ))}
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground inline-flex items-center gap-1">
          <Check className="w-3 h-3" />
          등록 클러스터 대역과 겹침 없음
        </p>
      )}
      <ClusterScopeNote visibleCount={visibleCount} unparsed={unparsed} />
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

const DEFAULT_CIDR = '192.168.1.0/24';
const INVALID_CIDR = '잘못된 CIDR 표기입니다. 예: 192.168.1.0/24';

const QUICK_REF: ReadonlyArray<readonly [string, string, string]> = [
  ['/8', '16.7M', '호스트'],
  ['/16', '65,534', '호스트'],
  ['/20', '4,094', '호스트'],
  ['/22', '1,022', '호스트'],
  ['/24', '254', '호스트'],
  ['/25', '126', '호스트'],
  ['/26', '62', '호스트'],
  ['/27', '30', '호스트'],
  ['/28', '14', '호스트'],
  ['/29', '6', '호스트'],
  ['/30', '2', '호스트'],
  ['/32', '단일', '주소'],
];

export function CidrCalculatorPage() {
  // 입력 CIDR 은 URL(?cidr=)과 동기화 — 새로고침·링크 공유 시 같은 값으로 열린다(§12.13).
  const [urlParams, setUrlParams] = useUrlParams({ cidr: DEFAULT_CIDR });
  const input = urlParams.cidr;
  const info = useMemo(() => parseCidr(input), [input]);
  const inputError = info ? '' : INVALID_CIDR;
  const curCidr = info ? `${info.network}/${info.prefix}` : '';

  // Subnet divider — 개수 입력은 문자열로 두고 blur 때 범위로 보정한다.
  const [divideCountText, setDivideCountText] = useState('4');
  const [division, setDivision] = useState<{ key: string; subnets: string[] } | null>(null);
  const divideCount = /^\d+$/.test(divideCountText.trim()) ? parseInt(divideCountText.trim(), 10) : NaN;
  const plan = info ? planDivision(info, divideCount) : null;
  const subnets = division && division.key === curCidr ? division.subnets : [];

  const compareColW = useColumnWidths('cidr-compare-table', {
    defaults: { label: 140, network: 180, mask: 160, hosts: 140, overlap: 220 },
    min: 60, max: 600,
  });

  // 등록 클러스터 (보이는 클러스터만 — 테넌트 격리)
  const clustersQ = useClusters();
  const clusters = useMemo(() => clustersQ.data ?? [], [clustersQ.data]);
  const clustersFailed = clustersQ.isError && !clustersQ.data;
  const clustersLoaded = Boolean(clustersQ.data);
  const { ranges: clusterRanges, unparsed: clusterUnparsed } = useMemo(
    () => collectClusterRanges(clusters),
    [clusters],
  );
  const retryClusters = () => { void clustersQ.refetch(); };

  // Apply CIDR to cluster
  const [applyClusterId, setApplyClusterId] = useState('');
  const [applyFieldKey, setApplyFieldKey] = useState<ClusterCidrField>('cidr');
  const [applyDone, setApplyDone] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const updateCluster = useUpdateCluster();
  const { canOperate, hint: operateHint, withHint, ariaWithHint } = useCanOperate(applyClusterId || null);

  const applyField = CLUSTER_CIDR_FIELDS.find((f) => f.key === applyFieldKey) ?? CLUSTER_CIDR_FIELDS[0];
  const applyCluster = clusters.find((c) => c.id === applyClusterId);
  const applyCurrentValue = (applyCluster?.[applyField.key] ?? '').trim();
  const applyConflicts = useMemo(() => {
    if (!curCidr || !applyClusterId) return [];
    // 같은 클러스터의 같은 필드는 이번 저장으로 바뀌므로 제외한다. 같은 클러스터의 다른 대역은 포함.
    return clusterRanges.filter(
      (r) => !(r.clusterId === applyClusterId && r.field === applyFieldKey) && cidrsOverlap(curCidr, r.cidr),
    );
  }, [curCidr, applyClusterId, applyFieldKey, clusterRanges]);
  const applyNeedsConfirm =
    (applyCurrentValue !== '' && applyCurrentValue !== curCidr) || applyConflicts.length > 0;

  const doApply = () => {
    if (!applyCluster || !info) return;
    setApplyError(null);
    setApplyDone(null);
    const name = applyCluster.name;
    const label = applyField.label;
    const saved = curCidr;
    updateCluster.mutate(
      { id: applyCluster.id, data: buildClusterCidrUpdate(applyField.key, info) },
      {
        onSuccess: () => {
          setConfirmOpen(false);
          setApplyDone(`${name} · ${label}을 ${saved}로 저장했습니다`);
        },
        onError: (err) => {
          setConfirmOpen(false);
          setApplyError(formatApiError(err, '저장하지 못했습니다'));
        },
      },
    );
  };

  const handleApplyClick = () => {
    if (!applyCluster || !info || !canOperate) return;
    if (applyNeedsConfirm) setConfirmOpen(true);
    else doApply();
  };

  // Multi-CIDR comparator
  const [entries, setEntries] = useState<SubnetEntry[]>([
    { id: genId(), cidr: '10.0.0.0/8', label: '클러스터 A' },
    { id: genId(), cidr: '172.16.0.0/12', label: '클러스터 B' },
  ]);

  const handleCalculate = (value: string) => {
    setUrlParams({ cidr: value });
  };

  const commitDivideCount = () => {
    const n = Number.isFinite(divideCount) ? divideCount : DIVIDE_MIN;
    setDivideCountText(String(Math.min(DIVIDE_MAX, Math.max(DIVIDE_MIN, n))));
  };

  const handleDivide = () => {
    if (!info || !plan || !plan.ok) return;
    setDivision({ key: curCidr, subnets: divideSubnets(info, plan.newPrefix, plan.actual) });
  };

  const addEntry = () => {
    setEntries((prev) => [...prev, { id: genId(), cidr: '10.0.0.0/24', label: `네트워크 ${prev.length + 1}` }]);
  };

  const updateEntry = (id: string, field: keyof SubnetEntry, value: string) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, [field]: value } : e)));
  };

  const removeEntry = (id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };

  // Derived
  const scope = info ? SCOPE_BADGE[ipScope(info.network)] : null;
  const sliderPct = info ? (info.prefix / 32) * 100 : 0;

  const currentPairs: ClusterPair[] = useMemo(() => {
    if (!curCidr) return [];
    return clusterRanges
      .filter((r) => cidrsOverlap(curCidr, r.cidr))
      .map((r, i) => ({
        key: `${r.clusterId}-${r.field}-${i}`,
        leftLabel: '현재 입력',
        leftCidr: curCidr,
        rightLabel: `${r.clusterName} · ${r.band}`,
        rightCidr: r.cidr,
      }));
  }, [curCidr, clusterRanges]);

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

  const entryPairs: ClusterPair[] = useMemo(() => {
    const out: ClusterPair[] = [];
    for (const entry of entries) {
      if (!parseCidr(entry.cidr)) continue;
      clusterRanges.forEach((r, i) => {
        if (cidrsOverlap(entry.cidr, r.cidr)) {
          out.push({
            key: `${entry.id}-${r.clusterId}-${r.field}-${i}`,
            leftLabel: entry.label || entry.cidr,
            leftCidr: entry.cidr,
            rightLabel: `${r.clusterName} · ${r.band}`,
            rightCidr: r.cidr,
            hue: entryHueMap[entry.id],
          });
        }
      });
    }
    return out;
  }, [entries, clusterRanges, entryHueMap]);

  const inputBaseCls =
    'px-3 py-2 bg-secondary border border-border rounded-xl text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 transition-colors';

  const ScopeIcon = scope?.icon;

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="hub" className="space-y-5">
        {/* ── Page Header ─────────────────────────────────────────────────── */}
        <PageHeader
          icon={Calculator}
          title="CIDR 계산기"
          description="서브넷 계산 · 분할 · 충돌 검사"
          actions={
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-chart-1" /> 사설(RFC1918)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-chart-3" /> 공인
              </span>
            </div>
          }
        />

        {/* ── HERO: input + summary ──────────────────────────────────────── */}
        <MacCard title="CIDR 입력" bodyPadding="p-0">
          <div className="grid grid-cols-1 lg:grid-cols-[1.05fr,1fr] divide-y lg:divide-y-0 lg:divide-x divide-border">
            {/* Left: input + slider */}
            <div className="p-5 lg:p-6">
              <label
                htmlFor="cidr-input-main"
                className="block text-xs font-medium text-muted-foreground mb-2"
              >
                CIDR 표기
              </label>
              <div className="relative">
                <input
                  id="cidr-input-main"
                  type="text"
                  value={input}
                  onChange={(e) => handleCalculate(e.target.value)}
                  placeholder="192.168.1.0/24"
                  spellCheck={false}
                  aria-invalid={Boolean(inputError)}
                  className={[
                    'w-full px-4 py-3 pr-36 bg-secondary/60 border border-border rounded-xl',
                    'text-lg font-mono tabular-nums tracking-tight',
                    'focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors',
                    inputError ? 'border-status-critical/60 focus:ring-status-critical/30' : '',
                  ].join(' ')}
                />
                {info && scope && ScopeIcon && (
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    <span className="px-2 py-0.5 text-xs font-semibold rounded-md bg-primary/10 text-primary border border-primary/20">
                      클래스 {info.ipClass.split(' ')[0]}
                    </span>
                    <span
                      className={`px-2 py-0.5 text-xs font-semibold rounded-md border inline-flex items-center gap-1 ${scope.cls}`}
                    >
                      <ScopeIcon className="w-2.5 h-2.5" />
                      {scope.label}
                    </span>
                  </div>
                )}
              </div>

              {inputError && (
                <p className="mt-2 text-sm text-status-critical inline-flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3" />
                  {inputError}
                </p>
              )}

              {/* Address space slider */}
              {info && (
                <div className="mt-6">
                  <div className="flex items-center justify-between text-xs font-medium text-muted-foreground mb-2">
                    <span>주소 공간</span>
                    <span className="font-mono tabular-nums">/{info.prefix}</span>
                  </div>
                  <div className="relative h-2 bg-secondary rounded-full overflow-visible">
                    <div
                      className="absolute inset-y-0 left-0 bg-primary rounded-full transition-[width]"
                      style={{ width: `${sliderPct}%` }}
                    />
                    <div
                      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-3.5 bg-card border-2 border-primary rounded-full transition-[left]"
                      style={{ left: `${sliderPct}%` }}
                      aria-hidden
                    />
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground mt-2 font-mono tabular-nums">
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
                    <div className="text-xs font-medium text-muted-foreground mb-1">
                      사용 가능 호스트
                    </div>
                    <div className="text-xl font-semibold tabular-nums text-foreground leading-none">
                      {formatHosts(info.usableHosts)}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1.5 font-mono tabular-nums">
                      {info.usableHosts.toLocaleString()}개 주소
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-muted-foreground mb-1">
                      전체 주소
                    </div>
                    <div className="text-xl font-semibold tabular-nums text-foreground leading-none">
                      {formatHosts(info.totalHosts)}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1.5 font-mono tabular-nums">
                      2<sup>{32 - info.prefix}</sup>개 주소
                    </div>
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t border-border">
                  <div className="text-xs font-medium text-muted-foreground mb-2">
                    호스트 범위
                  </div>
                  <div className="flex items-center gap-2 font-mono tabular-nums text-sm">
                    <span className="text-foreground font-medium">{info.firstHost}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="text-foreground font-medium">{info.lastHost}</span>
                    <CopyButton value={`${info.firstHost} - ${info.lastHost}`} className="ml-auto" />
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-muted/30 flex items-center justify-center">
                <EmptyState
                  compact
                  icon={Calculator}
                  title="결과 없음"
                  description="CIDR을 입력하면 결과가 여기에 표시됩니다."
                />
              </div>
            )}
          </div>
        </MacCard>

        {/* ── Network Details (tiles + binary mask) ──────────────────────── */}
        {info && (
          <MacCard title="네트워크 정보">
            <StatTileRow>
              <StatTile label="네트워크" value={curCidr} hint={<CopyButton value={curCidr} />} />
              <StatTile label="브로드캐스트" value={info.broadcast} hint={<CopyButton value={info.broadcast} />} />
              <StatTile label="서브넷 마스크" value={info.mask} hint={<CopyButton value={info.mask} />} />
              <StatTile label="와일드카드" value={info.wildcard} hint={<CopyButton value={info.wildcard} />} />
            </StatTileRow>

            {/* Binary mask visualization */}
            <div className="mt-4 p-3.5 bg-secondary/40 border border-border rounded-md">
              <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  이진 마스크
                </span>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-sm bg-primary" />
                    네트워크 비트 ({info.prefix})
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-sm bg-muted-foreground/30" />
                    호스트 비트 ({32 - info.prefix})
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
                                : 'text-muted-foreground'
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

            {/* Cluster overlap — "현재 입력 ↔ 클러스터 · 대역" 형태로 양쪽을 함께 보여준다 */}
            <ClusterOverlapSection
              failed={clustersFailed}
              error={clustersQ.error}
              onRetry={retryClusters}
              loaded={clustersLoaded}
              visibleCount={clusters.length}
              unparsed={clusterUnparsed}
              pairs={currentPairs}
              conflictTitle={`등록 클러스터 대역과 겹침 — ${currentPairs.length}건`}
              gridCls="grid grid-cols-1 sm:grid-cols-2 gap-1.5"
            />
          </MacCard>
        )}

        {/* ── Body grid: Subnet divider + Compare | Apply + Quick ref ───── */}
        <div className="grid grid-cols-1 xl:grid-cols-[1.5fr,1fr] gap-5 items-start">
          {/* LEFT column */}
          <div className="space-y-5 min-w-0">
            {/* Subnet divider */}
            {info && plan && (
              <MacCard title="서브넷 분할">
                <div className="flex items-end gap-3 flex-wrap">
                  <div className="flex-shrink-0">
                    <label
                      htmlFor="cidr-divide-count"
                      className="block text-xs font-medium text-muted-foreground mb-1.5"
                    >
                      분할 개수
                    </label>
                    <input
                      id="cidr-divide-count"
                      type="number"
                      inputMode="numeric"
                      min={DIVIDE_MIN}
                      max={DIVIDE_MAX}
                      value={divideCountText}
                      onChange={(e) => setDivideCountText(e.target.value)}
                      onBlur={commitDivideCount}
                      aria-invalid={!plan.ok}
                      aria-describedby="cidr-divide-plan"
                      className={`${inputBaseCls} w-24`}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleDivide}
                    disabled={!plan.ok}
                    title={plan.ok ? '분할' : plan.reason}
                    className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Scissors className="w-3.5 h-3.5" />
                    분할
                  </button>
                  <div id="cidr-divide-plan" className="flex-1 min-w-0 text-xs text-muted-foreground">
                    {plan.ok ? (
                      <>
                        {curCidr} · {plan.requested}개 요청 → {plan.actual}개(/{plan.newPrefix})로 분할 · 각{' '}
                        {formatHosts(Math.pow(2, 32 - plan.newPrefix))} 주소
                      </>
                    ) : (
                      <span className="text-status-critical inline-flex items-center gap-1.5">
                        <AlertTriangle className="w-3 h-3" />
                        {plan.reason}
                      </span>
                    )}
                  </div>
                </div>

                {subnets.length > 0 && (
                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-72 overflow-y-auto pr-1">
                    {subnets.map((s, i) => {
                      const si = parseCidr(s);
                      return (
                        <div
                          key={i}
                          className="group flex items-center gap-2 px-3 py-2 bg-secondary/40 hover:bg-secondary border border-border rounded-md text-sm transition-colors"
                        >
                          <span className="text-xs text-muted-foreground font-mono tabular-nums w-7 flex-shrink-0">
                            #{String(i + 1).padStart(2, '0')}
                          </span>
                          <span className="font-mono tabular-nums font-medium flex-shrink-0">{s}</span>
                          {si && (
                            <span className="text-xs text-muted-foreground font-mono tabular-nums truncate ml-auto">
                              {si.firstHost}–{si.lastHost}
                            </span>
                          )}
                          <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
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
            {/* D-122: 설명+추가 버튼 수제 행 → 추가 버튼은 헤더 actions, 설명은 본문 첫 줄 */}
            <MacCard
              title="멀티 CIDR 겹침 비교"
              icon={GitCompare}
              actions={
                <button
                  type="button"
                  onClick={addEntry}
                  className="px-2.5 py-1 text-xs font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded-xl transition-colors inline-flex items-center gap-1"
                >
                  <Plus className="w-3 h-3" />
                  추가
                </button>
              }
            >
              <p className="mb-3 text-xs text-muted-foreground">
                여러 CIDR 블록의 주소 충돌을 한눈에 확인합니다 — 같은 색은 서로 겹치는 그룹
              </p>

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
                        placeholder="이름"
                        aria-label="이름"
                        className="px-2 py-1.5 bg-secondary border border-border rounded-xl text-sm w-32 focus:outline-none focus:ring-1 focus:ring-primary/40"
                      />
                      <input
                        type="text"
                        value={entry.cidr}
                        onChange={(e) => updateEntry(entry.id, 'cidr', e.target.value)}
                        placeholder="10.0.0.0/24"
                        aria-label="CIDR"
                        spellCheck={false}
                        className={`${inputBaseCls} flex-1 text-sm py-1.5`}
                      />
                      <button
                        type="button"
                        onClick={() => removeEntry(entry.id)}
                        className="p-1.5 hover:bg-status-critical/10 rounded-xl text-muted-foreground hover:text-status-critical flex-shrink-0 transition-colors"
                        title="항목 삭제"
                        aria-label={`${entry.label || entry.cidr} 항목 삭제`}
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
                  className="text-sm"
                  style={{ tableLayout: 'fixed', width: 'max-content', minWidth: '100%' }}
                >
                  <colgroup>
                    {(['label', 'network', 'mask', 'hosts', 'overlap'] as const).map((k) => (
                      <col key={k} style={{ width: `${compareColW.getWidth(k)}px` }} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr className="bg-muted/40 border-b border-border">
                      <th className="relative text-left py-2 px-3 text-muted-foreground font-medium text-xs">
                        이름
                        <ResizeGrip onMouseDown={(e) => compareColW.beginResize('label', e)} onDoubleClick={() => compareColW.autoFit('label')} />
                      </th>
                      <th className="relative text-left py-2 px-3 text-muted-foreground font-medium text-xs">
                        네트워크
                        <ResizeGrip onMouseDown={(e) => compareColW.beginResize('network', e)} onDoubleClick={() => compareColW.autoFit('network')} />
                      </th>
                      <th className="relative text-left py-2 px-3 text-muted-foreground font-medium text-xs">
                        마스크
                        <ResizeGrip onMouseDown={(e) => compareColW.beginResize('mask', e)} onDoubleClick={() => compareColW.autoFit('mask')} />
                      </th>
                      <th className="relative text-right py-2 px-3 text-muted-foreground font-medium text-xs">
                        사용 가능
                        <ResizeGrip onMouseDown={(e) => compareColW.beginResize('hosts', e)} onDoubleClick={() => compareColW.autoFit('hosts')} />
                      </th>
                      <th className="relative text-left py-2 px-3 text-muted-foreground font-medium text-xs">
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
                            {ei ? `${ei.network}/${ei.prefix}` : <span className="text-status-critical">형식 오류</span>}
                          </td>
                          <td className="py-2 px-3 font-mono tabular-nums text-muted-foreground truncate">
                            {ei ? ei.mask : '—'}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground font-medium">
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
                                      className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md border ${tone.bg} ${tone.border} ${tone.text}`}
                                      title={ov ? `겹침 구간: ${ov.start} – ${ov.end} (${formatHosts(ov.size)} 주소)` : undefined}
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
                              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                <Check className="w-2.5 h-2.5" />
                                겹침 없음
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

              {/* Registered cluster overlap check — entry ↔ 클러스터 · 대역 페어로 표시 */}
              <ClusterOverlapSection
                failed={clustersFailed}
                error={clustersQ.error}
                onRetry={retryClusters}
                loaded={clustersLoaded}
                visibleCount={clusters.length}
                unparsed={clusterUnparsed}
                pairs={entryPairs}
                conflictTitle={`등록 클러스터 대역과 겹침 — ${entryPairs.length}건`}
                gridCls="grid grid-cols-1 md:grid-cols-2 gap-1.5"
              />
            </MacCard>
          </div>

          {/* RIGHT column */}
          <div className="space-y-5 min-w-0">
            {/* Apply to cluster — DB 메타 저장(폼 저장)이라 §12.9.1 실행 로그 대상이 아니다 */}
            {info && (clusters.length > 0 || clustersFailed) && (
              <MacCard title="클러스터에 적용">
                {clustersFailed ? (
                  <ErrorState
                    compact
                    error={clustersQ.error}
                    title="클러스터 목록을 불러오지 못했습니다"
                    onRetry={retryClusters}
                  />
                ) : (
                  <>
                    <p className="text-xs text-muted-foreground mb-3 inline-flex items-center gap-1.5">
                      <ExternalLink className="w-3 h-3" />
                      계산된 네트워크 CIDR을 클러스터 메타정보에 저장
                    </p>

                    <div className="space-y-2">
                      <label
                        htmlFor="cidr-apply-cluster-select"
                        className="block text-xs font-medium text-muted-foreground"
                      >
                        대상 클러스터
                      </label>
                      {/* 정책 ⑥: 계산 도구의 "적용 대상" 폼 필드 — ClusterSidebar 규칙 예외 */}
                      <select
                        id="cidr-apply-cluster-select"
                        value={applyClusterId}
                        onChange={(e) => { setApplyClusterId(e.target.value); setApplyDone(null); }}
                        className="w-full px-3 py-2 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                      >
                        <option value="">— 클러스터 선택 —</option>
                        {clusters.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}{c[applyFieldKey] ? ` (현재: ${c[applyFieldKey]})` : ''}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="mt-3 space-y-2">
                      <span id="cidr-apply-field-label" className="block text-xs font-medium text-muted-foreground">
                        대상 필드
                      </span>
                      <div role="group" aria-labelledby="cidr-apply-field-label" className="grid grid-cols-3 gap-1.5">
                        {CLUSTER_CIDR_FIELDS.map((f) => {
                          const active = f.key === applyFieldKey;
                          return (
                            <button
                              key={f.key}
                              type="button"
                              aria-pressed={active}
                              onClick={() => { setApplyFieldKey(f.key); setApplyDone(null); }}
                              className={`px-2 py-1.5 text-xs font-medium rounded-xl border transition-colors ${
                                active
                                  ? 'bg-primary/10 border-primary/40 text-foreground'
                                  : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                              }`}
                            >
                              {f.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Preview of what will be saved */}
                    {applyClusterId && (
                      <div className="mt-3 p-3 bg-secondary/40 border border-border rounded-md">
                        <div className="text-xs font-medium text-muted-foreground mb-2">
                          저장될 값
                        </div>
                        <dl className="space-y-1 text-sm">
                          <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">{applyField.label}</dt>
                            <dd className="font-mono tabular-nums text-foreground truncate">{curCidr}</dd>
                          </div>
                          <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">첫 호스트</dt>
                            <dd className="font-mono tabular-nums text-foreground truncate">{info.firstHost}</dd>
                          </div>
                          <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">마지막 호스트</dt>
                            <dd className="font-mono tabular-nums text-foreground truncate">{info.lastHost}</dd>
                          </div>
                          <div className="flex justify-between gap-2 pt-1 border-t border-border/60">
                            <dt className="text-muted-foreground">현재 값</dt>
                            <dd className="font-mono tabular-nums text-muted-foreground truncate">
                              {applyCurrentValue || '없음'}
                            </dd>
                          </div>
                        </dl>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={handleApplyClick}
                      disabled={!applyClusterId || updateCluster.isPending || !canOperate}
                      title={withHint(applyClusterId ? `${applyField.label}에 적용` : '대상 클러스터를 먼저 고르세요')}
                      aria-label={ariaWithHint('클러스터에 적용')}
                      className="mt-3 w-full px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5"
                    >
                      {updateCluster.isPending ? '적용 중…' : '클러스터에 적용'}
                    </button>
                    {applyClusterId && operateHint && (
                      <p className="mt-1.5 text-xs text-muted-foreground">{operateHint}</p>
                    )}

                    {applyDone && (
                      <p className="mt-2 text-sm text-status-healthy inline-flex items-center gap-1" role="status">
                        <Check className="w-3 h-3" /> {applyDone}
                      </p>
                    )}
                    {applyError && (
                      <div
                        role="alert"
                        className="mt-2 flex items-start gap-1.5 px-2.5 py-2 text-sm text-status-critical bg-status-critical/10 border border-status-critical/30 rounded-md"
                      >
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                        <span className="flex-1 min-w-0 whitespace-pre-line break-words">
                          저장 실패: {applyError}
                        </span>
                        <button
                          type="button"
                          onClick={() => setApplyError(null)}
                          className="p-0.5 rounded-xl hover:bg-status-critical/10 flex-shrink-0"
                          title="닫기"
                          aria-label="오류 닫기"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}

                    {applyClusterId && applyConflicts.length > 0 && (
                      <div className="mt-3">
                        <p className="text-xs font-semibold text-status-warning inline-flex items-center gap-1.5 mb-1.5">
                          <AlertTriangle className="w-3 h-3" />
                          기존 대역과 겹침 — {applyConflicts.length}건
                        </p>
                        <div className="space-y-1.5">
                          {applyConflicts.map((r, i) => (
                            <OverlapPair
                              key={`${r.clusterId}-${r.field}-${i}`}
                              leftLabel="저장 예정"
                              leftCidr={curCidr}
                              rightLabel={`${r.clusterName} · ${r.band}`}
                              rightCidr={r.cidr}
                              hue="amber"
                            />
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="mt-3">
                      <ClusterScopeNote visibleCount={clusters.length} unparsed={clusterUnparsed} />
                    </div>
                  </>
                )}
              </MacCard>
            )}

            {/* Quick reference */}
            <MacCard title="prefix 빠른 참조">
              <p className="text-xs text-muted-foreground mb-3 inline-flex items-center gap-1.5">
                <BookOpen className="w-3 h-3" />
                자주 쓰이는 prefix별 호스트 수
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                {QUICK_REF.map(([prefix, count, unit]) => (
                  <button
                    key={prefix}
                    type="button"
                    onClick={() => handleCalculate(`${input.split('/')[0] || '192.168.1.0'}${prefix}`)}
                    className="group flex items-center justify-between gap-2 px-2.5 py-1.5 bg-secondary/40 hover:bg-secondary hover:border-primary/30 border border-border rounded-xl transition-colors text-left"
                    title={`${prefix} 적용`}
                  >
                    <span className="font-mono tabular-nums text-primary text-sm font-semibold">{prefix}</span>
                    <span className="text-xs text-muted-foreground font-mono tabular-nums">
                      <span className="text-foreground">{count}</span> {unit}
                    </span>
                  </button>
                ))}
              </div>
            </MacCard>
          </div>
        </div>
      </PageShell>

      <ConfirmDialog
        open={confirmOpen}
        title="클러스터 CIDR 덮어쓰기"
        description={
          applyCluster
            ? `${applyCluster.name} · ${applyField.label}: 현재 ${applyCurrentValue || '없음'} → ${curCidr}, 겹침 ${applyConflicts.length}건`
            : undefined
        }
        confirmLabel="저장"
        danger={applyConflicts.length > 0}
        busy={updateCluster.isPending}
        onConfirm={doApply}
        onCancel={() => setConfirmOpen(false)}
      >
        {applyConflicts.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
            {applyConflicts.slice(0, 8).map((r, i) => (
              <li key={`${r.clusterId}-${r.field}-${i}`}>
                {r.clusterName} · {r.band}: <span className="font-mono tabular-nums">{r.cidr}</span>
              </li>
            ))}
            {applyConflicts.length > 8 && <li>외 {applyConflicts.length - 8}건</li>}
          </ul>
        )}
      </ConfirmDialog>
    </div>
  );
}
