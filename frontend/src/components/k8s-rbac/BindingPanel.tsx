/**
 * RoleBinding / ClusterRoleBinding 목록 — "누가 어떤 권한을 어디서 갖는가" 를 한 표로.
 *
 * "새 바인딩 추가" 는 **기존** ServiceAccount 에 **기존** Role/ClusterRole 을 새로 묶는
 * 전용 경로다. `nodes` 조회처럼 클러스터 스코프 리소스는 ClusterRoleBinding 이 있어야만
 * 실제로 권한이 발동한다(RoleBinding 은 네임스페이스 스코프라 노드처럼 네임스페이스가
 * 없는 리소스엔 적용되지 않는다) — Role/ClusterRole 탭에서 규칙만 추가해선 끝나지 않는
 * 케이스라 이 폼이 그 마지막 조각을 메운다.
 */
import { useMemo, useState } from 'react';
import { Link2, Plus, Search, Trash2 } from 'lucide-react';
import { ConfirmDialog, EmptyState, useToastSafe } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useCreateBinding, useDeleteBinding } from '@/hooks/useK8sRbac';
import { formatApiError } from '@/lib/utils';
import type { RbacBinding, RbacNamespace, RbacRole, RbacServiceAccount } from '@/types';
import { Tag } from './RbacTags';

interface Props {
  clusterId: string;
  bindings: RbacBinding[];
  roles: RbacRole[];
  clusterRoles: RbacRole[];
  serviceAccounts: RbacServiceAccount[];
  namespaces: RbacNamespace[];
  includeSystem: boolean;
  onIncludeSystemChange: (v: boolean) => void;
  isLoading: boolean;
}

type BindingKind = 'RoleBinding' | 'ClusterRoleBinding';
type RoleKind = 'Role' | 'ClusterRole';

const inputCls =
  'px-3 py-2 bg-card border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/50';

export function BindingPanel({
  clusterId,
  bindings,
  roles,
  clusterRoles,
  serviceAccounts,
  namespaces,
  includeSystem,
  onIncludeSystemChange,
  isLoading,
}: Props) {
  const { canOperate, withHint } = useCanOperate();
  const toast = useToastSafe();
  const [query, setQuery] = useState('');
  const [pendingDelete, setPendingDelete] = useState<RbacBinding | null>(null);
  const remove = useDeleteBinding(clusterId);
  const create = useCreateBinding(clusterId);

  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<BindingKind>('RoleBinding');
  const [name, setName] = useState('');
  const [namespace, setNamespace] = useState('');
  const [roleKind, setRoleKind] = useState<RoleKind>('ClusterRole');
  const [roleName, setRoleName] = useState('');
  const [subjectKey, setSubjectKey] = useState(''); // `${sa.namespace}/${sa.name}`

  // ClusterRoleBinding 은 ClusterRole 만 참조할 수 있다(백엔드도 이걸 거부한다) —
  // 애초에 화면에서 고를 수 없는 조합을 없앤다.
  const effectiveRoleKind: RoleKind = kind === 'ClusterRoleBinding' ? 'ClusterRole' : roleKind;

  const roleOptions = useMemo(() => {
    if (effectiveRoleKind === 'ClusterRole') return clusterRoles;
    // RoleBinding 이 참조하는 Role 은 바인딩과 같은 네임스페이스에 있어야 한다.
    return roles.filter((r) => r.namespace === namespace);
  }, [effectiveRoleKind, clusterRoles, roles, namespace]);

  const subjectOptions = useMemo(
    () => serviceAccounts.filter((sa) => sa.name !== 'default'),
    [serviceAccounts],
  );

  const resetForm = () => {
    setKind('RoleBinding');
    setName('');
    setNamespace('');
    setRoleKind('ClusterRole');
    setRoleName('');
    setSubjectKey('');
  };

  const problems = useMemo(() => {
    const out: string[] = [];
    if (!name.trim()) out.push('바인딩 이름을 입력하세요.');
    if (kind === 'RoleBinding' && !namespace) out.push('RoleBinding 은 네임스페이스가 필요합니다.');
    if (!roleName) out.push('참조할 Role/ClusterRole 을 고르세요.');
    if (!subjectKey) out.push('권한을 받을 ServiceAccount 를 고르세요.');
    return out;
  }, [name, kind, namespace, roleName, subjectKey]);

  const handleCreate = async () => {
    const subject = subjectOptions.find((sa) => `${sa.namespace}/${sa.name}` === subjectKey);
    if (problems.length > 0 || !subject) return;
    try {
      await create.mutateAsync({
        kind,
        name: name.trim(),
        namespace: kind === 'RoleBinding' ? namespace : null,
        roleKind: effectiveRoleKind,
        roleName,
        subjects: [{ kind: 'ServiceAccount', name: subject.name, namespace: subject.namespace }],
      });
      toast.success(
        `${kind} 생성됨`,
        `${subject.namespace}/${subject.name} → ${effectiveRoleKind}/${roleName}`,
      );
      setCreating(false);
      resetForm();
    } catch (e) {
      toast.error('생성 실패', formatApiError(e));
    }
  };

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return bindings;
    return bindings.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        (b.namespace ?? '').toLowerCase().includes(q) ||
        b.roleName.toLowerCase().includes(q) ||
        b.subjects.some((s) => s.name.toLowerCase().includes(q)),
    );
  }, [bindings, query]);

  const handleDelete = async () => {
    if (!pendingDelete) return;
    try {
      await remove.mutateAsync({
        kind: pendingDelete.kind,
        name: pendingDelete.name,
        namespace: pendingDelete.namespace,
      });
      toast.success('바인딩 삭제됨', pendingDelete.name);
    } catch (e) {
      toast.error('삭제 실패', formatApiError(e));
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <MacCard title="Binding">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            id="rbac-binding-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="SA / 롤 / 네임스페이스 검색…"
            className="w-full pl-9 pr-3 py-2 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        <button
          type="button"
          onClick={() => onIncludeSystemChange(!includeSystem)}
          aria-pressed={includeSystem}
          title="쿠버네티스 빌트인(system:*) 바인딩도 함께 보기"
          aria-label="빌트인 바인딩 포함"
          className={`px-3 py-2 rounded-xl border text-xs ${
            includeSystem ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'
          }`}
        >
          system:* 포함
        </button>
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">{rows.length}건</span>
        <button
          type="button"
          onClick={() => setCreating(!creating)}
          disabled={!canOperate}
          title={withHint('새 바인딩 추가 — 기존 SA 에 기존 Role/ClusterRole 을 묶는다')}
          aria-label={withHint('새 바인딩 추가')}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus className="w-3.5 h-3.5" /> 바인딩 추가
        </button>
      </div>

      {creating && (
        <div className="mb-3 p-3 rounded-xl border border-border bg-secondary space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1.5 text-xs text-muted-foreground font-medium">
              종류
              <select
                id="rbac-new-binding-kind"
                value={kind}
                onChange={(e) => {
                  const next = e.target.value as BindingKind;
                  setKind(next);
                  if (next === 'ClusterRoleBinding') {
                    setRoleKind('ClusterRole');
                    setNamespace('');
                  }
                  setRoleName('');
                }}
                className={inputCls}
              >
                <option value="RoleBinding">RoleBinding (네임스페이스 스코프)</option>
                <option value="ClusterRoleBinding">ClusterRoleBinding (전체 네임스페이스)</option>
              </select>
            </label>
            {kind === 'RoleBinding' && (
              <label className="flex flex-col gap-1.5 text-xs text-muted-foreground font-medium">
                네임스페이스
                <select
                  id="rbac-new-binding-namespace"
                  value={namespace}
                  onChange={(e) => {
                    setNamespace(e.target.value);
                    setRoleName('');
                  }}
                  className={`${inputCls} font-mono`}
                >
                  <option value="">선택…</option>
                  {namespaces.map((ns) => (
                    <option key={ns.name} value={ns.name}>
                      {ns.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex flex-col gap-1.5 text-xs text-muted-foreground font-medium">
              바인딩 이름
              <input
                id="rbac-new-binding-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="pep-dev-hjkim-nodes"
                spellCheck={false}
                className={`${inputCls} font-mono`}
              />
            </label>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            {kind === 'RoleBinding' && (
              <label className="flex flex-col gap-1.5 text-xs text-muted-foreground font-medium">
                참조 롤 종류
                <select
                  id="rbac-new-binding-rolekind"
                  value={roleKind}
                  onChange={(e) => {
                    setRoleKind(e.target.value as RoleKind);
                    setRoleName('');
                  }}
                  className={inputCls}
                >
                  <option value="ClusterRole">ClusterRole</option>
                  <option value="Role">Role (이 네임스페이스 전용)</option>
                </select>
              </label>
            )}
            <label className="flex flex-col gap-1.5 text-xs text-muted-foreground font-medium">
              {effectiveRoleKind} 선택
              <select
                id="rbac-new-binding-rolename"
                value={roleName}
                onChange={(e) => setRoleName(e.target.value)}
                disabled={effectiveRoleKind === 'Role' && !namespace}
                className={`${inputCls} font-mono disabled:opacity-50`}
              >
                <option value="">선택…</option>
                {roleOptions.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-xs text-muted-foreground font-medium">
              대상 ServiceAccount
              <select
                id="rbac-new-binding-subject"
                value={subjectKey}
                onChange={(e) => setSubjectKey(e.target.value)}
                className={`${inputCls} font-mono`}
              >
                <option value="">선택…</option>
                {subjectOptions.map((sa) => (
                  <option key={`${sa.namespace}/${sa.name}`} value={`${sa.namespace}/${sa.name}`}>
                    {sa.namespace} / {sa.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={handleCreate}
              disabled={problems.length > 0 || create.isPending}
              title={problems.length > 0 ? problems[0] : '바인딩 생성'}
              aria-label="바인딩 생성"
              className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
            >
              {create.isPending ? '생성 중…' : '생성'}
            </button>
          </div>

          {kind === 'ClusterRoleBinding' && (
            <p className="text-[11.5px] leading-relaxed rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 px-3 py-2">
              nodes·namespaces·persistentvolumes 처럼 네임스페이스가 없는(클러스터 스코프) 리소스는
              RoleBinding 으로는 권한이 발동하지 않는다 — 이 조합(ClusterRoleBinding)이 필요한 이유다.
              선택한 롤에 해당 규칙이 이미 있는지 Role/ClusterRole 탭에서 먼저 확인한다.
            </p>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={Link2}
          title={isLoading ? '불러오는 중…' : '바인딩이 없다'}
          description={isLoading ? undefined : '액세스 발급 탭에서 만들거나, 위 "바인딩 추가" 로 직접 만든다.'}
          compact
        />
      ) : (
        <div className="overflow-x-auto border border-border rounded-md">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="bg-secondary">
                {['종류', '이름', '적용 범위', '대상(subject)', '참조 롤', ''].map((h, i) => (
                  <th
                    key={h || i}
                    className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr
                  key={`${b.kind}:${b.namespace ?? '-'}:${b.name}`}
                  className="border-t border-border hover:bg-secondary/60"
                >
                  <td className="px-3 py-2">
                    <Tag tone={b.kind === 'ClusterRoleBinding' ? 'write' : 'default'}>{b.kind}</Tag>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{b.name}</td>
                  <td className="px-3 py-2">
                    {b.kind === 'ClusterRoleBinding' ? (
                      <Tag tone="write">전체 네임스페이스</Tag>
                    ) : (
                      <Tag>{b.namespace}</Tag>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {b.subjects.map((s, i) => (
                      <div key={i}>
                        {s.kind === 'ServiceAccount' ? `SA ${s.namespace}/${s.name}` : `${s.kind} ${s.name}`}
                      </div>
                    ))}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {b.roleKind}/{b.roleName}
                  </td>
                  <td className="px-2 py-2">
                    {b.builtin ? (
                      <span className="text-[11px] text-muted-foreground">빌트인</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setPendingDelete(b)}
                        disabled={!canOperate}
                        title={withHint('바인딩 삭제')}
                        aria-label={withHint(`${b.name} 삭제`)}
                        className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-50"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        같은 이름의 RoleBinding 이 네임스페이스마다 하나씩 있는 것은 정상이다 — 하나의 ClusterRole 을 나눠
        쓰는 구조다.
      </p>

      <ConfirmDialog
        open={!!pendingDelete}
        title="바인딩을 삭제할까요?"
        description={
          pendingDelete
            ? `${pendingDelete.kind} ${pendingDelete.name} 을(를) 지우면 대상 ServiceAccount 가 ${
                pendingDelete.namespace ?? '모든 네임스페이스'
              } 에서 권한을 잃는다.`
            : undefined
        }
        confirmLabel="삭제"
        danger
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </MacCard>
  );
}
