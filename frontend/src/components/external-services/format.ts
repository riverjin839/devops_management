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

export function matches(e: ExternalServiceEntry, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  const hay = [e.host, e.hostname, e.ip, String(e.port), e.namespace, e.name, ...(e.ptrNames ?? []), ...(e.paths ?? [])];
  return hay.some((v) => v && v.toLowerCase().includes(t));
}

export function toCsv(rows: ExternalServiceEntry[]): string {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['domain', 'domain_source', 'ptr_names', 'ip', 'port', 'protocol', 'scheme', 'kind', 'namespace', 'name', 'target', 'paths'];
  const lines = rows.map((e) => {
    const d = domainOf(e);
    return [d.primary, d.source, (e.ptrNames ?? []).join(' '), e.ip ?? e.hostname, e.port, e.protocol, e.scheme,
      e.kind, e.namespace, e.name, e.target, (e.paths ?? []).join(' | ')].map(esc).join(',');
  });
  return [head.join(','), ...lines].join('\n');
}
