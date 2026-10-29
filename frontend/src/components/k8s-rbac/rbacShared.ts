/** `/k8s-rbac` 화면이 공유하는 순수 헬퍼·상수. 컴포넌트는 `RbacTags.tsx` 에 둔다
 *  (한 파일이 컴포넌트와 상수를 함께 export 하면 react-refresh 가 경고한다). */
import type { RbacBinding, RbacBindingMode, RbacPolicyRule, RbacRole, RbacServiceAccount } from '@/types';

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

/**
 * 네임스페이스가 없는(=클러스터 스코프) 대표 리소스들.
 *
 * K8s RBAC 는 리소스가 네임스페이스에 속하는지를 API discovery 로만 알 수 있어 프론트가
 * 완전한 판정을 할 수는 없다 — 이건 "자주 걸리는 것들" 만 담은 휴리스틱 목록이다.
 * 이 목록에 있는 리소스는 RoleBinding(네임스페이스 스코프)으로는 아무리 규칙을 추가해도
 * 권한이 발동하지 않는다 — ClusterRoleBinding 이 있어야 한다.
 */
export const CLUSTER_SCOPED_RESOURCE_HINTS = new Set([
  'nodes',
  'namespaces',
  'persistentvolumes',
  'storageclasses',
  'clusterroles',
  'clusterrolebindings',
  'customresourcedefinitions',
  'certificatesigningrequests',
  'componentstatuses',
  'priorityclasses',
  'runtimeclasses',
  'ingressclasses',
  'volumeattachments',
  'csidrivers',
  'csinodes',
  'mutatingwebhookconfigurations',
  'validatingwebhookconfigurations',
]);

/** 이 규칙에 RoleBinding 으로는 발동하지 않는 클러스터 스코프 리소스가 섞여 있는지. */
export function ruleHasClusterScopedResource(rule: RbacPolicyRule): boolean {
  return rule.resources.some((r) => CLUSTER_SCOPED_RESOURCE_HINTS.has(r.split('/')[0]));
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

/** PEP 가 만든 오브젝트에 붙이는 라벨 — 회수 대상 롤을 고를 때 쓴다(백엔드 `k8s_rbac_service`). */
export const PEP_MANAGED_LABEL = 'app.kubernetes.io/managed-by';

export function isPepManaged(labels: Record<string, string> | undefined): boolean {
  return labels?.[PEP_MANAGED_LABEL] === 'pep';
}

const has = (list: string[], ...wanted: string[]) => list.some((v) => v === '*' || wanted.includes(v));
const READ_VERBS = ['get', 'list', 'watch'];
const RBAC_RESOURCES = ['roles', 'rolebindings', 'clusterroles', 'clusterrolebindings'];

/**
 * 권한을 넓히는 쓰기 동작 직전에 한 번 더 확인받아야 하는 이유 목록 — 비어 있으면 바로 실행한다.
 * 발급 마법사·바인딩 생성·롤 저장·kubeconfig 재발급이 **같은 판정**을 쓴다(경로마다 통제가 다르면
 * 가장 약한 경로가 실제 보안 수준이 된다).
 * 기준: 모든 네임스페이스에 걸리는 바인딩, `*` 와일드카드, Secret 조회, Pod exec/attach/port-forward,
 * 권한 상승 동작(impersonate/escalate/bind)·RBAC 오브젝트 쓰기, 만료 없는 토큰, 프리셋 위험도 높음.
 */
export function grantRiskReasons(opts: {
  /** ClusterRoleBinding 처럼 네임스페이스를 가리지 않고 걸리는가. */
  clusterWide: boolean;
  rules: RbacPolicyRule[];
  longLivedToken?: boolean;
  presetRisk?: 'low' | 'medium' | 'high';
}): string[] {
  const { clusterWide, rules, longLivedToken = false, presetRisk } = opts;
  const out: string[] = [];
  const writeVerbs = Array.from(new Set(rules.flatMap((r) => r.verbs.filter(isWriteVerb))));
  if (clusterWide) {
    out.push(
      writeVerbs.length > 0
        ? `모든 네임스페이스에서 ${writeVerbs.join('/')} 가능 — ClusterRoleBinding 은 네임스페이스를 가리지 않습니다`
        : '모든 네임스페이스에서 조회 가능 — ClusterRoleBinding 은 네임스페이스를 가리지 않습니다',
    );
  }
  if (rules.some((r) => r.verbs.includes('*') || r.resources.includes('*') || r.apiGroups.includes('*'))) {
    out.push('와일드카드(*) 규칙 — 지금 없는 리소스·동작까지 앞으로 생기는 대로 허용됩니다');
  }
  if (rules.some((r) => has(r.resources, 'secrets') && has(r.verbs, ...READ_VERBS))) {
    out.push('Secret 조회 — 같은 네임스페이스의 다른 토큰·비밀번호까지 읽을 수 있습니다');
  }
  if (rules.some((r) => has(r.resources, 'pods/exec', 'pods/attach', 'pods/portforward') && has(r.verbs, 'create', 'get'))) {
    out.push('Pod 접속(exec·attach·port-forward) — 컨테이너 안에서 명령을 실행할 수 있습니다');
  }
  if (rules.some((r) => has(r.verbs, 'impersonate', 'escalate', 'bind')
    || (has(r.resources, ...RBAC_RESOURCES) && r.verbs.some(isWriteVerb)))) {
    out.push('권한 상승 — 롤·바인딩을 고치거나 다른 사용자로 행세해 스스로 권한을 넓힐 수 있습니다');
  }
  if (longLivedToken) {
    out.push('만료 없는 토큰 — Secret 을 지우기 전까지 이 kubeconfig 는 계속 유효합니다');
  }
  if (presetRisk === 'high' && out.length === 0) {
    out.push('위험도 높음 프리셋 — 쓰기 권한이 넓게 열립니다');
  }
  return out;
}

/** 바인딩 방식이 네임스페이스를 가리지 않는가(마법사용). */
export const isClusterWideMode = (m: RbacBindingMode) => m === 'clusterrole-clusterrolebinding';

/** 규칙 변경 전후 비교 — `그룹/리소스: verb` 단위로 더해진 것·빠진 것. 롤 저장 확인에 쓴다. */
export function ruleDiff(before: RbacPolicyRule[], after: RbacPolicyRule[]): { added: string[]; removed: string[] } {
  const flat = (rules: RbacPolicyRule[]) => {
    const out = new Set<string>();
    for (const r of rules) {
      const names = r.resourceNames.length ? ` (${r.resourceNames.join(', ')})` : '';
      for (const g of r.apiGroups.length ? r.apiGroups : ['']) {
        for (const res of r.resources) {
          for (const v of r.verbs) out.add(`${groupLabel(g)}/${res}${names}: ${v}`);
        }
      }
    }
    return out;
  };
  const a = flat(before);
  const b = flat(after);
  return {
    added: [...b].filter((x) => !a.has(x)).sort(),
    removed: [...a].filter((x) => !b.has(x)).sort(),
  };
}

/** ServiceAccount 이름 형식(DNS-1123 서브도메인) — 틀리면 실행 전에 알려준다(서버 오류를 기다리지 않게). */
export function saNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return null;
  if (n.length > 253) return 'ServiceAccount 이름은 253자를 넘을 수 없습니다.';
  if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(n)) {
    return 'ServiceAccount 이름은 영문 소문자·숫자·하이픈(-)·점(.)만 쓰고, 영문 소문자나 숫자로 시작하고 끝나야 합니다.';
  }
  return null;
}

/** kubeconfig 의 토큰 값을 가린다(끝 4자만 남김) — 화면 표시용. 복사·저장은 원문을 쓴다. */
export function maskKubeconfig(text: string): string {
  return text.replace(
    /^(\s*(?:token|client-key-data|password):\s*)(\S+)\s*$/gm,
    (_m, head: string, value: string) => `${head}${'•'.repeat(12)}${value.slice(-4)}`,
  );
}

/** ServiceAccount 한 개의 액세스를 통째로 거둘 때 지울 것·남길 것. */
export interface RevokePlan {
  /** 이 SA 만 subject 로 가진 바인딩 — 지운다. */
  bindings: RbacBinding[];
  /** 다른 subject 도 함께 묶인 바인딩 — 지우면 남의 권한까지 사라져 남긴다. */
  sharedBindings: RbacBinding[];
  /** PEP 가 만든 롤 중 지울 바인딩 말고는 참조하는 곳이 없는 것 — 지운다. */
  roles: RbacRole[];
}

export function buildRevokePlan(
  sa: RbacServiceAccount,
  bindings: RbacBinding[],
  roles: RbacRole[],
  clusterRoles: RbacRole[],
): RevokePlan {
  const isMe = (b: RbacBinding) =>
    b.subjects.some((s) => s.kind === 'ServiceAccount' && s.name === sa.name && s.namespace === sa.namespace);
  const mine = bindings.filter((b) => !b.builtin && isMe(b));
  const sole = mine.filter((b) => b.subjects.length === 1);
  const sharedBindings = mine.filter((b) => b.subjects.length > 1);
  const removing = new Set(sole.map((b) => `${b.kind}/${b.namespace ?? ''}/${b.name}`));
  const remaining = bindings.filter((b) => !removing.has(`${b.kind}/${b.namespace ?? ''}/${b.name}`));

  const roleOf = (b: RbacBinding) =>
    b.roleKind === 'ClusterRole'
      ? clusterRoles.find((r) => r.name === b.roleName)
      : roles.find((r) => r.name === b.roleName && r.namespace === b.namespace);
  const stillUsed = (r: RbacRole) =>
    remaining.some((b) =>
      r.scope === 'cluster'
        ? b.roleKind === 'ClusterRole' && b.roleName === r.name
        : b.roleKind === 'Role' && b.roleName === r.name && b.namespace === r.namespace,
    );
  const seen = new Set<string>();
  const out: RbacRole[] = [];
  for (const b of sole) {
    const r = roleOf(b);
    if (!r || r.builtin || !isPepManaged(r.labels) || stillUsed(r)) continue;
    const key = `${r.scope}/${r.namespace ?? ''}/${r.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return { bindings: sole, sharedBindings, roles: out };
}
