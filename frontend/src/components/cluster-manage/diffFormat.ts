// 재수집(auto-update) 필드 라벨·값 표기 — 미리보기 다이얼로그와 페이지 실행 로그(적용 결과)가 같은 표기를 쓴다.

const FIELD_LABELS: Record<string, string> = {
  nodeCount: '노드 수',
  hostname: '마스터 호스트명',
  maxPod: '노드당 최대 Pod',
  cidr: '내부 IP (집계 CIDR)',
  firstHost: '노드 첫 호스트',
  lastHost: '노드 마지막 호스트',
  svcCidr: 'Service CIDR',
  svcFirstHost: 'Service 첫 호스트',
  svcLastHost: 'Service 마지막 호스트',
  podCidr: 'Pod CIDR',
  podFirstHost: 'Pod 첫 호스트',
  podLastHost: 'Pod 마지막 호스트',
  ciliumConfig: 'Cilium 설정',
  bgpEnabled: 'BGP 활성화',
  asNumber: 'AS 번호',
  k8sVersion: 'K8s 버전',
  ciliumVersion: 'Cilium 버전',
  nodeIps: '노드 IP 목록',
  bond0Ip:  'bond0 IP (마스터)',
  bond0Mac: 'bond0 MAC (마스터)',
  bond1Ip:  'bond1 IP (마스터)',
  bond1Mac: 'bond1 MAC (마스터)',
};

/** 재수집 필드명의 화면 라벨 — 미리보기 표와 실행 로그가 같은 이름을 쓴다. */
export function diffFieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/** 재수집 값의 화면 표기 — 미리보기 표와 실행 로그(적용 결과)가 같은 표기를 쓴다. */
export function renderDiffValue(v: unknown, field?: string): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? '켜짐' : '꺼짐';
  if (field === 'nodeIps' && typeof v === 'string') {
    try {
      const arr = JSON.parse(v) as { name: string; ip?: string; ips?: string[] }[];
      if (Array.isArray(arr)) {
        const multi = arr.filter((n) => (n.ips?.length ?? 0) > 1).length;
        const preview = arr.slice(0, 3).map((n) => {
          const ips = n.ips && n.ips.length > 0 ? n.ips : (n.ip ? [n.ip] : []);
          return `${n.name}(${ips.join(',') || '?'})`;
        }).join(', ');
        const suffix = arr.length > 3 ? ' …' : '';
        const multiHint = multi > 0 ? ` · 다중 IP ${multi}대` : '';
        return `${arr.length}개 노드${multiHint} · ${preview}${suffix}`;
      }
    } catch { /* JSON 아님 */ }
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
