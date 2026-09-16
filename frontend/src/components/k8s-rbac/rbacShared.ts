/** `/k8s-rbac` 화면이 공유하는 순수 헬퍼·상수. 컴포넌트는 `RbacTags.tsx` 에 둔다
 *  (한 파일이 컴포넌트와 상수를 함께 export 하면 react-refresh 가 경고한다). */
import type { RbacPolicyRule } from '@/types';

/** 쿠버네티스에서 core 그룹은 빈 문자열이라 화면에는 'core' 로 적는다. */
export const CORE_GROUP_LABEL = 'core';

/** 쓰기 verb — 화면에서 읽기와 색을 다르게 줘 위험도가 한눈에 보이게 한다. */
const WRITE_VERBS = new Set(['create', 'update', 'patch', 'delete', 'deletecollection', '*']);

export const VERB_OPTIONS = [
  'get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'deletecollection', '*',
];

export const COMMON_API_GROUPS = [
  '', 'apps', 'batch', 'networking.k8s.io', 'autoscaling', 'policy',
  'rbac.authorization.k8s.io', 'storage.k8s.io', 'metrics.k8s.io', 'apiextensions.k8s.io', '*',
];

export function isWriteVerb(verb: string): boolean {
  return WRITE_VERBS.has(verb);
}

export function groupLabel(group: string): string {
  return group === '' ? CORE_GROUP_LABEL : group;
}

/** 규칙 한 줄에 쓰기 권한이 있는지 — 프리셋/롤의 위험도 표시에 쓴다. */
export function ruleHasWrite(rule: RbacPolicyRule): boolean {
  return rule.verbs.some(isWriteVerb);
}

export function emptyRule(): RbacPolicyRule {
  return { apiGroups: [''], resources: [], verbs: [], resourceNames: [], nonResourceUrls: [] };
}

/** 쉼표/공백 구분 입력을 배열로 — 규칙 편집기의 텍스트 입력 공통 파서. */
export function splitList(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** core 그룹의 빈 문자열이 사라지지 않도록 별도 파서를 쓴다. */
export function splitGroups(value: string): string[] {
  const parts = value.split(',').map((v) => v.trim());
  const out = parts.map((p) => (p === CORE_GROUP_LABEL ? '' : p));
  return out.length ? out : [''];
}

export function groupsToText(groups: string[]): string {
  return (groups.length ? groups : ['']).map(groupLabel).join(', ');
}

/** 상대 시각 — 목록 컬럼용 짧은 표기. */
export function shortDate(iso: string | null): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return '-';
  }
}
