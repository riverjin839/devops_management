/** Role / ClusterRole 목록 + 규칙 편집. 빌트인(system:*, cluster-admin …)은 읽기 전용이다. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Save, Search, Shield, Trash2, Undo2 } from 'lucide-react';
import { ConfirmDialog, EmptyState, useToastSafe } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useDeleteRole, useUpsertRole } from '@/hooks/useK8sRbac';
import { formatApiError } from '@/lib/utils';
import type { RbacBinding, RbacPolicyRule, RbacRole } from '@/types';
import { emptyRule, ruleHasClusterScopedResource } from './rbacShared';
import { Tag } from './RbacTags';
import { RuleEditor } from './RuleEditor';

/** ServiceAccount 탭의 "연결된 권한" 클릭 한 건 — 그 롤을 찾아 바로 선택시킨다.
 *  같은 롤을 두 번 연달아 눌러도 다시 반응하도록 매 클릭마다 새 객체(token)로 보낸다. */
export interface RbacRoleFocusRequest {
  scope: 'namespace' | 'cluster';
  namespace: string | null;
  name: string;
  token: number;
}

interface Props {
  clusterId: string;
  roles: RbacRole[];
  clusterRoles: RbacRole[];
  bindings: RbacBinding[];
  includeSystem: boolean;
  onIncludeSystemChange: (v: boolean) => void;
  isLoading: boolean;
  /** 다른 탭(ServiceAccount)에서 "이 롤 보기" 를 눌렀을 때 전달되는 대상. */
  focusRequest?: RbacRoleFocusRequest | null;
}

function roleKey(r: RbacRole): string {
  return `${r.scope}:${r.namespace ?? '-'}:${r.name}`;
}

export function RolePanel({
  clusterId,
  roles,
  clusterRoles,
  bindings,
  includeSystem,
  onIncludeSystemChange,
  isLoading,
  focusRequest,
}: Props) {
  const { canOperate, hint, withHint } = useCanOperate();
  const toast = useToastSafe();
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<RbacPolicyRule[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<RbacRole | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());

  const upsert = useUpsertRole(clusterId);
  const remove = useDeleteRole(clusterId);

  const all = useMemo(() => [...clusterRoles, ...roles], [clusterRoles, roles]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.namespace ?? '').toLowerCase().includes(q) ||
        r.rules.some((rule) => rule.resources.some((res) => res.toLowerCase().includes(q))),
    );
  }, [all, query]);

  const selected = useMemo(
    () => all.find((r) => roleKey(r) === selectedKey) ?? null,
    [all, selectedKey],
  );

  // 참조 중인 바인딩 — 저장이 어디에 영향을 주는지 먼저 보여준다.
  const referencingBindings = useMemo(() => {
    if (!selected) return [];
    return bindings.filter(
      (b) => b.roleName === selected.name && b.roleKind === (selected.scope === 'cluster' ? 'ClusterRole' : 'Role'),
    );
  }, [bindings, selected]);

  const select = (r: RbacRole) => {
    setSelectedKey(roleKey(r));
    setDraft(r.rules.map((rule) => ({ ...rule })));
  };

  // ServiceAccount 탭에서 "연결된 권한" 을 클릭해 넘어온 요청을 처리한다. 검색어로
  // 가려져 있을 수 있어 먼저 비우고, system:*/cluster-admin 같은 빌트인 롤을 가리키면
  // includeSystem 이 꺼져 있어 목록에 아예 없을 수 있으니 켠 뒤 재조회 후 다시 찾는다.
  // 한 번 찾았거나 포기했으면 그 token 에 대해선 더 반응하지 않는다 — 안 그러면 배경
  // refetch(자동 새로고침 등)로 `all` 참조가 바뀔 때마다 같은 롤을 다시 선택하거나
  // "찾을 수 없다" 토스트를 반복해서 띄운다.
  const focusState = useRef<{ token: number | null; settled: boolean }>({ token: null, settled: false });
  useEffect(() => {
    if (!focusRequest) return;
    if (focusState.current.token !== focusRequest.token) {
      focusState.current = { token: focusRequest.token, settled: false };
    }
    if (focusState.current.settled) return;

    const target = all.find(
      (r) => r.scope === focusRequest.scope && (r.namespace ?? null) === focusRequest.namespace && r.name === focusRequest.name,
    );
    if (target) {
      setQuery('');
      select(target);
      rowRefs.current.get(roleKey(target))?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      focusState.current.settled = true;
      return;
    }
    if (focusRequest.scope === 'cluster' && !includeSystem) {
      onIncludeSystemChange(true);
      return; // clusterRoles 재조회 후 다음 렌더에서 다시 찾는다 — 아직 settled 아님
    }
    focusState.current.settled = true;
    toast.warning('롤을 찾을 수 없다', `${focusRequest.name} — 삭제됐거나 목록에 없다`);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- select/toast/onIncludeSystemChange 는 매 렌더 새 함수라 넣으면 무한 루프
  }, [focusRequest, all, includeSystem]);

  const save = async () => {
    if (!selected || !draft) return;
    try {
      await upsert.mutateAsync({
        scope: selected.scope,
        namespace: selected.namespace,
        name: selected.name,
        rules: draft,
      });
      toast.success('저장됨', `${selected.scope === 'cluster' ? 'ClusterRole' : 'Role'} ${selected.name}`);
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    try {
      await remove.mutateAsync({
        scope: pendingDelete.scope,
        namespace: pendingDelete.namespace,
        name: pendingDelete.name,
      });
      toast.success('삭제됨', pendingDelete.name);
      if (roleKey(pendingDelete) === selectedKey) {
        setSelectedKey(null);
        setDraft(null);
      }
    } catch (e) {
      toast.error('삭제 실패', formatApiError(e));
    } finally {
      setPendingDelete(null);
    }
  };

  const dirty =
    !!selected && !!draft && JSON.stringify(draft) !== JSON.stringify(selected.rules);

  // nodes 같은 클러스터 스코프 리소스는 RoleBinding(네임스페이스 스코프)으로는 권한이
  // 발동하지 않는다 — ClusterRoleBinding 이 하나도 없으면(바인딩이 아예 없거나 전부
  // RoleBinding 이면) 저장해도 조용히 무효가 된다.
  const needsClusterRoleBinding =
    !!draft &&
    draft.some(ruleHasClusterScopedResource) &&
    !referencingBindings.some((b) => b.kind === 'ClusterRoleBinding');

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
      <MacCard title="Role / ClusterRole">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <input
              id="rbac-role-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="이름 / 리소스 검색…"
              className="w-full pl-9 pr-3 py-2 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          <button
            type="button"
            onClick={() => onIncludeSystemChange(!includeSystem)}
            aria-pressed={includeSystem}
            title="쿠버네티스 빌트인(system:*) 롤도 함께 보기"
            aria-label="빌트인 롤 포함"
            className={`px-3 py-2 rounded-xl border text-xs ${
              includeSystem ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'
            }`}
          >
            system:* 포함
          </button>
        </div>

        {rows.length === 0 ? (
          <EmptyState icon={Shield} title={isLoading ? '불러오는 중…' : '롤이 없다'} compact />
        ) : (
          <div className="overflow-x-auto border border-border rounded-md max-h-[520px] overflow-y-auto">
            <table className="w-full min-w-[460px] text-sm">
              <thead className="sticky top-0">
                <tr className="bg-secondary">
                  {['범위', '이름', '규칙', ''].map((h, i) => (
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
                {rows.map((r) => (
                  <tr
                    key={roleKey(r)}
                    ref={(el) => {
                      if (el) rowRefs.current.set(roleKey(r), el);
                      else rowRefs.current.delete(roleKey(r));
                    }}
                    className={`border-t border-border cursor-pointer hover:bg-secondary/60 ${
                      roleKey(r) === selectedKey ? 'bg-primary/5' : ''
                    }`}
                    onClick={() => select(r)}
                  >
                    <td className="px-3 py-2">
                      <Tag tone={r.scope === 'cluster' ? 'read' : 'default'}>
                        {r.scope === 'cluster' ? 'Cluster' : r.namespace}
                      </Tag>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {r.name}
                      {r.labels['app.kubernetes.io/managed-by'] === 'pep' && (
                        <span className="ml-1.5 text-[11px] px-1.5 py-px rounded-full border border-primary/30 bg-primary/10 text-primary font-medium">
                          PEP
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs tabular-nums">{r.ruleCount}</td>
                    <td className="px-2 py-2">
                      {r.builtin ? (
                        <span className="text-[11px] text-muted-foreground">빌트인</span>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPendingDelete(r);
                          }}
                          disabled={!canOperate}
                          title={withHint('롤 삭제')}
                          aria-label={withHint(`${r.name} 삭제`)}
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
      </MacCard>

      <MacCard title="규칙 편집">
        {!selected || !draft ? (
          <EmptyState
            icon={Shield}
            title="왼쪽에서 롤을 고르세요"
            description="고른 롤의 권한 규칙을 여기서 바로 고칠 수 있다."
            compact
          />
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <Tag tone="read">{selected.scope === 'cluster' ? 'ClusterRole' : `Role · ${selected.namespace}`}</Tag>
              <span className="font-mono text-sm font-semibold">{selected.name}</span>
              {selected.builtin && (
                <span className="text-[11px] text-muted-foreground">빌트인 — 읽기 전용</span>
              )}
            </div>

            <RuleEditor
              rules={draft}
              onChange={setDraft}
              disabled={!canOperate || selected.builtin}
              disabledHint={selected.builtin ? '쿠버네티스 빌트인 롤은 수정할 수 없다' : hint}
            />

            {referencingBindings.length > 0 && (
              <p className="text-[11.5px] leading-relaxed rounded-md border border-primary/30 bg-primary/5 text-primary px-3 py-2">
                저장하면 이 롤을 참조하는 바인딩 {referencingBindings.length}개의 권한이 즉시 바뀐다 — 영향
                범위:{' '}
                {Array.from(
                  new Set(referencingBindings.map((b) => b.namespace ?? '전체 네임스페이스')),
                ).join(', ')}
                .
              </p>
            )}

            {needsClusterRoleBinding && (
              <p className="text-[11.5px] leading-relaxed rounded-md border border-status-warning/30 bg-status-warning/10 text-status-warning px-3 py-2">
                nodes 같은 클러스터 스코프(네임스페이스 없는) 리소스가 규칙에 있다. 이 롤은{' '}
                {referencingBindings.length === 0 ? '아직 어떤 바인딩에도 연결돼 있지 않다' : 'RoleBinding 으로만 연결돼 있다'}
                — RoleBinding 으로는 이런 리소스에 권한이 발동하지 않는다. 저장 후 <b>Binding 탭</b>에서
                ClusterRoleBinding 을 추가로 만들어야 실제로 동작한다.
              </p>
            )}

            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => setDraft(selected.rules.map((r) => ({ ...r })))}
                disabled={!dirty}
                title="편집 내용 되돌리기"
                aria-label="편집 내용 되돌리기"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-border text-xs hover:border-primary disabled:opacity-50"
              >
                <Undo2 className="w-3.5 h-3.5" /> 되돌리기
              </button>
              <button
                type="button"
                onClick={() => setDraft([...draft, emptyRule()])}
                disabled={!canOperate || selected.builtin}
                title={withHint('규칙 추가')}
                aria-label={withHint('규칙 추가')}
                className="px-3 py-1.5 rounded-xl border border-border text-xs hover:border-primary disabled:opacity-50"
              >
                규칙 추가
              </button>
              <div className="flex-1" />
              <button
                type="button"
                onClick={save}
                disabled={!canOperate || selected.builtin || !dirty || upsert.isPending}
                title={
                  selected.builtin
                    ? '쿠버네티스 빌트인 롤은 수정할 수 없다'
                    : !dirty
                      ? '변경 사항이 없다'
                      : withHint('저장')
                }
                aria-label={withHint('규칙 저장')}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Save className="w-3.5 h-3.5" /> {upsert.isPending ? '저장 중…' : '저장'}
              </button>
            </div>
          </div>
        )}
      </MacCard>

      <ConfirmDialog
        open={!!pendingDelete}
        title="롤을 삭제할까요?"
        description={
          pendingDelete
            ? `${pendingDelete.name} 을(를) 지우면 이 롤을 참조하는 바인딩이 아무 권한도 주지 못하게 된다.`
            : undefined
        }
        confirmLabel="삭제"
        danger
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
