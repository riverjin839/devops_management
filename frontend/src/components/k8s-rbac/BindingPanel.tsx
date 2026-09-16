/** RoleBinding / ClusterRoleBinding 목록 — "누가 어떤 권한을 어디서 갖는가" 를 한 표로. */
import { useMemo, useState } from 'react';
import { Link2, Search, Trash2 } from 'lucide-react';
import { ConfirmDialog, EmptyState, useToastSafe } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useDeleteBinding } from '@/hooks/useK8sRbac';
import { formatApiError } from '@/lib/utils';
import type { RbacBinding } from '@/types';
import { Tag } from './RbacTags';

interface Props {
  clusterId: string;
  bindings: RbacBinding[];
  includeSystem: boolean;
  onIncludeSystemChange: (v: boolean) => void;
  isLoading: boolean;
}

export function BindingPanel({
  clusterId,
  bindings,
  includeSystem,
  onIncludeSystemChange,
  isLoading,
}: Props) {
  const { canOperate, withHint } = useCanOperate();
  const toast = useToastSafe();
  const [query, setQuery] = useState('');
  const [pendingDelete, setPendingDelete] = useState<RbacBinding | null>(null);
  const remove = useDeleteBinding(clusterId);

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
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Link2}
          title={isLoading ? '불러오는 중…' : '바인딩이 없다'}
          description={isLoading ? undefined : '액세스 발급 탭에서 만들면 여기에 나타난다.'}
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
