// 외부 서비스 표시 헬퍼 — 도메인은 [Ingress 선언 host → LB 호스트명 → nslookup 역조회] 순으로 고른다.
import type { ExternalServiceEntry, ExternalServiceKind } from '@/types';

export const KIND_OPTIONS: { value: ExternalServiceKind; label: string; help: string }[] = [
  { value: 'Ingress', label: 'Ingress', help: 'Ingress rule 의 host(선언 도메인) × Ingress 컨트롤러 LB 주소' },
  { value: 'LoadBalancer', label: 'LoadBalancer', help: 'type=LoadBalancer Service 의 외부 IP:Port' },
  { value: 'ExternalIP', label: 'ExternalIP', help: 'Service spec.externalIPs' },
  { value: 'NodePort', label: 'NodePort', help: '모든 노드 주소 × nodePort' },
];

export interface DomainInfo { primary: string | null; source: string | null; extra: string[] }

export function domainOf(e: ExternalServiceEntry): DomainInfo {
  const ptr = e.ptrNames ?? [];
  const ptrSource = e.ptrSource === 'ssh' ? 'nslookup(노드)' : e.ptrSource === 'backend' ? 'PTR(backend)' : null;
  if (e.host) return { primary: e.host, source: 'Ingress 선언', extra: ptr.filter((n) => n !== e.host) };
  if (e.hostname) return { primary: e.hostname, source: 'LB 호스트명', extra: ptr };
  if (ptr.length) return { primary: ptr[0], source: ptrSource, extra: ptr.slice(1) };
  return { primary: null, source: null, extra: [] };
}

export function addressOf(e: ExternalServiceEntry): string {
  if (e.ip) return `${e.ip}:${e.port}`;
  if (e.hostname) return `${e.hostname}:${e.port}`;
  if (e.kind === 'NodePort') return `<노드 IP>:${e.port}`;
  return `(주소 미할당):${e.port}`;
}

/** 정방향 검증 표시 — 비정상(불일치·조회 안 됨)만 상태색. */
export function fwdView(e: ExternalServiceEntry): { text: string; cls: string; title?: string } | null {
  const f = e.fwd;
  if (!f) return null;
  const where = f.source === 'node' ? '노드' : 'backend';
  if (f.status === 'match') return { text: '일치', cls: 'text-muted-foreground', title: `${f.domain} → ${f.ips.join(', ')} (${where})` };
  if (f.status === 'mismatch') {
    return { text: `불일치 → ${f.ips.join(', ')}`, cls: 'text-status-warning font-medium',
      title: `${f.domain} 의 A 레코드가 이 엔드포인트(${e.ip ?? ''})가 아닌 곳을 가리킨다 (${where})` };
  }
  return { text: '조회 안 됨', cls: 'text-status-warning font-medium', title: `${f.domain} 이 ${where} DNS 에서 조회되지 않는다` };
}

/** 응답 확인 표시 — 응답 없음·5xx 만 상태색. */
export function probeView(e: ExternalServiceEntry): { text: string; cls: string; title?: string } | null {
  const p = e.probe;
  if (!p) return null;
  const where = p.source === 'node' ? '노드에서' : 'backend 에서';
  const ms = p.latencyMs != null ? ` · ${p.latencyMs}ms` : '';
  if (!p.reachable) return { text: p.error || '응답 없음', cls: 'text-status-critical font-medium', title: `${where} ${p.method.toUpperCase()} 확인` };
  if (p.httpStatus) {
    return { text: `HTTP ${p.httpStatus}${ms}`, cls: p.httpStatus >= 500 ? 'text-status-warning font-medium' : 'text-muted-foreground',
      title: `${where} Host 헤더를 실어 GET /` };
  }
  return { text: `열림${ms}`, cls: 'text-muted-foreground', title: `${where} TCP 연결` };
}

export function hasIssue(e: ExternalServiceEntry): boolean {
  return e.fwd?.status === 'mismatch' || e.fwd?.status === 'nxdomain' || (e.probe != null && !e.probe.reachable);
}

export function matches(e: ExternalServiceEntry, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  const hay = [e.host, e.hostname, e.ip, String(e.port), e.namespace, e.name, ...(e.ptrNames ?? []), ...(e.paths ?? [])];
  return hay.some((v) => v && v.toLowerCase().includes(t));
}

export function toCsv(rows: ExternalServiceEntry[]): string {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['domain', 'domain_source', 'ptr_names', 'ip', 'port', 'protocol', 'scheme', 'kind', 'namespace', 'name', 'target', 'paths',
    'forward_status', 'forward_ips', 'reachable', 'http_status', 'latency_ms', 'probe_error'];
  const lines = rows.map((e) => {
    const d = domainOf(e);
    return [d.primary, d.source, (e.ptrNames ?? []).join(' '), e.ip ?? e.hostname, e.port, e.protocol, e.scheme,
      e.kind, e.namespace, e.name, e.target, (e.paths ?? []).join(' | '),
      e.fwd?.status, (e.fwd?.ips ?? []).join(' '), e.probe ? String(e.probe.reachable) : '', e.probe?.httpStatus,
      e.probe?.latencyMs, e.probe?.error].map(esc).join(',');
  });
  return [head.join(','), ...lines].join('\n');
}
