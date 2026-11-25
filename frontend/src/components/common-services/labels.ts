// 공통 서비스 화면 표시 이름 — 실행 상태 배지 · 수집 컴포넌트 이름.
import type { StatusVariant } from '@/components/common';
import type { CommonServiceRun } from '@/types';

export const RUN_STATUS: Record<CommonServiceRun['status'], { label: string; variant: StatusVariant }> = {
  running: { label: '진행 중', variant: 'loading' },
  succeeded: { label: '성공', variant: 'healthy' },
  partial: { label: '일부 실패', variant: 'warning' },
  failed: { label: '실패', variant: 'critical' },
};

/** 컴포넌트 이름 → 화면 이름. */
export function componentLabel(c: string): string {
  if (c === 'deploy') return 'K8S 워크로드';
  if (c === 'podman:inspect') return 'Podman 컨테이너';
  if (c.startsWith('configmap:')) return `ConfigMap ${c.slice(10)}`;
  if (c.startsWith('file:')) return `파일 ${c.slice(5)}`;
  if (c.startsWith('app:realm:')) {
    const [realm, part] = c.slice(10).split(':');
    return `realm ${realm}${part === 'clients' ? ' · 클라이언트' : part === 'idp' ? ' · ID 공급자' : ''}`;
  }
  if (c === 'ldap:rootdse') return 'rootDSE';
  if (c === 'ldap:domain') return '도메인 정책';
  if (c.startsWith('app:')) return c.slice(4);
  return c;
}
