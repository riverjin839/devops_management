/**
 * INTERNAL_IP 헬퍼 — `cluster.nodeIps` JSON 에서 kubectl InternalIP 들을
 * 추출해 정규식/Glob 형식으로 묶어 표시한다.
 *
 *   [10.0.1.5, 10.0.1.6, 10.0.1.7, 10.0.1.10]  →  10.0.1.[5-7,10]
 *   [10.0.1.5, 10.0.2.5]                        →  10.0.1.5, 10.0.2.5
 *   [10.0.1.5]                                  →  10.0.1.5
 *
 * /24 단위로 그룹핑하고, 마지막 옥텟의 연속 구간은 5-7 처럼 압축한다.
 * grep -E 또는 셸 brace expansion 에 그대로 쓸 수 있는 형태.
 */

export interface NodeIpEntry {
  name: string;
  ip?: string;
  ips?: string[];
  external_ip?: string;
  master?: boolean;
  interfaces?: {
    name: string;
    ips: string[];
    scopes?: string[];
    mac?: string | null;
    operstate?: string | null;
  }[];
}

export function parseNodeIps(json?: string | null): NodeIpEntry[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as NodeIpEntry[]) : [];
  } catch {
    return [];
  }
}

/** `nodeIps` 의 각 노드 InternalIP (`.ip` 우선, 없으면 `.ips[0]`) 만 모음. */
export function extractInternalIps(entries: NodeIpEntry[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const ip = e.ip ?? (e.ips && e.ips.length > 0 ? e.ips[0] : undefined);
    if (!ip) continue;
    if (seen.has(ip)) continue;
    seen.add(ip);
    out.push(ip);
  }
  return out;
}

/**
 * `nodeIps[].interfaces[]` 에서 특정 NIC 이름의 MAC 들을 모두 모은다.
 * 노드별 unique 한 값이라 정규식 그룹화 불가능 — 그대로 나열.
 */
export function extractInterfaceMacs(entries: NodeIpEntry[], name: string): string[] {
  const target = name.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    for (const ifc of e.interfaces ?? []) {
      if (ifc.name?.toLowerCase() !== target) continue;
      const mac = ifc.mac;
      if (!mac) continue;
      if (seen.has(mac)) continue;
      seen.add(mac);
      out.push(mac);
    }
  }
  return out;
}

/**
 * `nodeIps[].interfaces[]` 에서 특정 NIC 이름(예: 'bond0', 'bond1') 의
 * IPv4 주소들을 모두 모은다. NIC 수집(SSH 기반) 이후에만 채워진다.
 */
export function extractInterfaceIps(entries: NodeIpEntry[], name: string): string[] {
  const target = name.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    for (const ifc of e.interfaces ?? []) {
      if (ifc.name?.toLowerCase() !== target) continue;
      for (const ip of ifc.ips ?? []) {
        if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) continue;
        if (seen.has(ip)) continue;
        seen.add(ip);
        out.push(ip);
      }
    }
  }
  return out;
}

/** 한 옥텟 정수 배열을 5,6,7,10 → "5-7,10" 처럼 연속 구간 표기로 압축. */
function compressOctetSet(values: number[]): string[] {
  const sorted = Array.from(new Set(values)).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
    } else {
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = prev = sorted[i];
    }
  }
  ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  return ranges;
}

/**
 * IP 들을 /24 (앞 3 옥텟) 단위로 그룹핑하고, 각 그룹의 마지막 옥텟을
 * 정규식/Glob 형식으로 묶어 반환.
 */
export function groupInternalIps(ips: string[]): string[] {
  const groups = new Map<string, number[]>();
  for (const ip of ips) {
    const parts = ip.split('.');
    if (parts.length !== 4) continue;
    const last = parseInt(parts[3], 10);
    if (!Number.isFinite(last) || last < 0 || last > 255) continue;
    if (parts.slice(0, 3).some((p) => {
      const n = parseInt(p, 10);
      return !Number.isFinite(n) || n < 0 || n > 255;
    })) continue;
    const prefix = parts.slice(0, 3).join('.');
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push(last);
  }

  const sortedPrefixes = Array.from(groups.keys()).sort((a, b) => {
    const an = a.split('.').map((p) => parseInt(p, 10));
    const bn = b.split('.').map((p) => parseInt(p, 10));
    for (let i = 0; i < 3; i++) {
      if (an[i] !== bn[i]) return an[i] - bn[i];
    }
    return 0;
  });

  const result: string[] = [];
  for (const prefix of sortedPrefixes) {
    const ranges = compressOctetSet(groups.get(prefix)!);
    if (ranges.length === 0) continue;
    if (ranges.length === 1 && !ranges[0].includes('-')) {
      // 단일 IP — 대괄호 없이 표시
      result.push(`${prefix}.${ranges[0]}`);
    } else {
      result.push(`${prefix}.[${ranges.join(',')}]`);
    }
  }
  return result;
}
