/** ServiceAccount 목록 — 연결된 권한을 함께 보여주고, kubeconfig 재발급·삭제를 한다. */
import { useMemo, useState } from 'react';
import { KeyRound, Search, Trash2, UserPlus } from 'lucide-react';
import { ConfirmDialog, EmptyState, useToastSafe } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { useCanOperate } from '@/hooks/useCanOperate';
import {
  useCreateServiceAccount,
  useDeleteServiceAccount,
  useIssueKubeconfig,
} from '@/hooks/useK8sRbac';
import { formatApiError } from '@/lib/utils';
import type { RbacBindingSummary, RbacNamespace, RbacServiceAccount } from '@/types';
import { shortDate } from './rbacShared';
import { Tag } from './RbacTags';

interface Props {
  clusterId: string;
  serviceAccounts: RbacServiceAccount[];
  namespaces: RbacNamespace[];
  isLoading: boolean;
  /** "연결된 권한" 태그 클릭 — Role/ClusterRole 탭으로 이동해 그 롤을 바로 연다. */
  onSelectRole: (binding: RbacBindingSummary) => void;
}

export function ServiceAccountPanel({
  clusterId,
  serviceAccounts,
  namespaces,
  isLoading,
  onSelectRole,
}: Props) {
  const { canOperate, withHint } = useCanOperate();
  const toast = useToastSafe();
  const [query, setQuery] = useState('');
  const [nsFilter, setNsFilter] = useState('');
  const [pepOnly, setPepOnly] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newNs, setNewNs] = useState('');
  const [newName, setNewName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<RbacServiceAccount | null>(null);
  const [kubeconfig, setKubeconfig] = useState<string | null>(null);

  const createSa = useCreateServiceAccount(clusterId);
  const deleteSa = useDeleteServiceAccount(clusterId);
  const issue = useIssueKubeconfig(clusterId);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return serviceAccounts.filter((sa) => {
      if (nsFilter && sa.namespace !== nsFilter) return false;
      if (pepOnly && !sa.managedByPep) return false;
      if (!q) return true;
      return (
        sa.name.toLowerCase().includes(q) ||
        sa.namespace.toLowerCase().includes(q) ||
        sa.bindings.some((b) => b.roleName.toLowerCase().includes(q))
      );
    });
  }, [serviceAccounts, query, nsFilter, pepOnly]);

  const handleCreate = async () => {
    try {
      await createSa.mutateAsync({ namespace: newNs || namespaces[0]?.name || '', name: newName.trim() });
      toast.success('ServiceAccount 생성됨', `${newNs}/${newName}`);
      setCreating(false);
      setNewName('');
    } catch (e) {
      toast.error('생성 실패', formatApiError(e));
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    try {
      await deleteSa.mutateAsync({ namespace: pendingDelete.namespace, name: pendingDelete.name });
      toast.success('ServiceAccount 삭제됨', `${pendingDelete.namespace}/${pendingDelete.name}`);
    } catch (e) {
      toast.error('삭제 실패', formatApiError(e));
    } finally {
      setPendingDelete(null);
    }
  };

  const handleKubeconfig = async (sa: RbacServiceAccount) => {
    try {
      const res = await issue.mutateAsync({ namespace: sa.namespace, serviceAccount: sa.name });
      setKubeconfig(res.kubeconfig);
      toast.success('kubeconfig 발급됨', res.expiresAt ? `만료 ${res.expiresAt.slice(0, 16)}` : '만료 없음');
    } catch (e) {
      toast.error('발급 실패', formatApiError(e));
    }
  };

  const inputCls =
    'px-3 py-2 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/50';

  return (
    <div className="space-y-3">
      <MacCard title="ServiceAccount">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="relative flex-1 min-w-[180px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <input
              id="rbac-sa-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="네임스페이스 / 이름 / 롤 검색…"
              className={`${inputCls} w-full pl-9`}
            />
          </div>
          <select
            id="rbac-sa-ns-filter"
            value={nsFilter}
            onChange={(e) => setNsFilter(e.target.value)}
            className={`${inputCls} font-mono`}
          >
            <option value="">모든 네임스페이스</option>
            {namespaces.map((ns) => (
              <option key={ns.name} value={ns.name}>
                {ns.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setPepOnly(!pepOnly)}
            aria-pressed={pepOnly}
            title="PEP 가 만든 ServiceAccount 만 보기"
            aria-label="PEP 가 만든 ServiceAccount 만 보기"
            className={`px-3 py-2 rounded-xl border text-xs ${
              pepOnly ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'
            }`}
          >
            PEP 생성분만
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setCreating(!creating)}
            disabled={!canOperate}
            title={withHint('ServiceAccount 추가')}
            aria-label={withHint('ServiceAccount 추가')}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <UserPlus className="w-3.5 h-3.5" /> ServiceAccount 추가
          </button>
        </div>

        {creating && (
          <div className="flex flex-wrap items-end gap-2 mb-3 p-3 rounded-xl border border-border bg-secondary">
            <label className="flex flex-col gap-1.5 text-xs text-muted-foreground font-medium">
              네임스페이스
              <select
                id="rbac-new-sa-ns"
                value={newNs}
                onChange={(e) => setNewNs(e.target.value)}
                className={`${inputCls} font-mono bg-card`}
              >
                <option value="">선택…</option>
                {namespaces.map((ns) => (
                  <option key={ns.name} value={ns.name}>
                    {ns.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-xs text-muted-foreground font-medium">
              이름
              <input
                id="rbac-new-sa-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="dev-hjkim"
                spellCheck={false}
                className={`${inputCls} font-mono bg-card`}
              />
            </label>
            <button
              type="button"
              onClick={handleCreate}
              disabled={!newNs || !newName.trim() || createSa.isPending}
              title="ServiceAccount 생성"
              aria-label="ServiceAccount 생성"
              className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
            >
              생성
            </button>
          </div>
        )}

        {rows.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title={isLoading ? '불러오는 중…' : 'ServiceAccount 가 없다'}
            description={isLoading ? undefined : '액세스 발급 탭에서 개발자용 SA 를 만들 수 있다.'}
            compact
          />
        ) : (
          <div className="overflow-x-auto border border-border rounded-md">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="bg-secondary">
                  {['네임스페이스', '이름', '연결된 권한', '생성', ''].map((h, i) => (
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
                {rows.map((sa) => {
                  const protectedSa = sa.name === 'default';
                  return (
                    <tr key={`${sa.namespace}/${sa.name}`} className="border-t border-border hover:bg-secondary/60">
                      <td className="px-3 py-2">
                        <Tag>{sa.namespace}</Tag>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {sa.name}
                        {sa.managedByPep && (
                          <span className="ml-1.5 text-[10px] px-1.5 py-px rounded-full border border-primary/30 bg-primary/10 text-primary font-medium">
                            PEP
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {sa.bindings.length === 0 ? (
                          <span className="text-xs text-muted-foreground">연결된 권한 없음</span>
                        ) : (
                          sa.bindings.slice(0, 3).map((b, i) => (
                            <Tag
                              key={i}
                              onClick={() => onSelectRole(b)}
                              title={`${b.roleKind}/${b.roleName} 상세 보기 — Role/ClusterRole 탭으로 이동`}
                            >
                              {b.kind === 'ClusterRoleBinding' ? '전역' : b.namespace} → {b.roleKind}/{b.roleName}
                            </Tag>
                          ))
                        )}
                        {sa.bindings.length > 3 && <Tag tone="muted">+{sa.bindings.length - 3}</Tag>}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                        {shortDate(sa.createdAt)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {protectedSa ? (
                          <span className="text-xs text-muted-foreground">기본 SA — 편집 불가</span>
                        ) : (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleKubeconfig(sa)}
                              disabled={!canOperate || issue.isPending}
                              title={withHint('kubeconfig 발급')}
                              aria-label={withHint(`${sa.name} kubeconfig 발급`)}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-xs hover:border-primary hover:text-primary disabled:opacity-50"
                            >
                              <KeyRound className="w-3.5 h-3.5" /> kubeconfig
                            </button>
                            <button
                              type="button"
                              onClick={() => setPendingDelete(sa)}
                              disabled={!canOperate}
                              title={withHint('ServiceAccount 삭제')}
                              aria-label={withHint(`${sa.name} 삭제`)}
                              className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-50"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          삭제는 ServiceAccount 만 지운다 — 롤과 바인딩은 각 탭에서 따로 정리한다.
        </p>
      </MacCard>

      {kubeconfig && (
        <MacCard title="발급된 kubeconfig">
          <pre className="bg-secondary border border-border rounded-md p-3 text-[11px] font-mono overflow-x-auto max-h-72 text-foreground">
            {kubeconfig}
          </pre>
          <button
            type="button"
            onClick={() => setKubeconfig(null)}
            title="닫기"
            aria-label="kubeconfig 닫기"
            className="mt-2 px-3 py-1.5 rounded-xl border border-border text-xs hover:border-primary"
          >
            닫기
          </button>
        </MacCard>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title="ServiceAccount 를 삭제할까요?"
        description={
          pendingDelete
            ? `${pendingDelete.namespace}/${pendingDelete.name} 을(를) 지우면 이 SA 토큰으로 접속 중인 개발자와 파드가 즉시 인증에 실패한다.`
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
