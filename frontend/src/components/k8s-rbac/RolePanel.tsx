/** Role / ClusterRole 목록 + 규칙 편집. 빌트인(system:*, cluster-admin …)은 읽기 전용이다. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Save, Search, Shield, Trash2, Undo2 } from 'lucide-react';
import { ConfirmDialog, EmptyState, ErrorState, LoadingState, RunLogPanel, useToastSafe } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useDeleteRole, useUpsertRole } from '@/hooks/useK8sRbac';
import { useLogPref } from '@/hooks/useLogPref';
import { runLogged, useRunLog } from '@/hooks/useRunLog';
import { useUrlParams } from '@/hooks/useUrlParams';
import { formatApiError } from '@/lib/utils';
import type { RbacBinding, RbacPolicyRule, RbacRole } from '@/types';
import { emptyRule, grantRiskReasons, isPepManaged, ruleDiff, ruleHasClusterScopedResource } from './rbacShared';
import { GrantRiskDialog, RuleDiffList } from './GrantRiskDialog';
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
  /** Role/ClusterRole 조회 실패 — 있으면 "롤이 없습니다" 대신 오류를 보인다(D-139). */
  error?: unknown;
  onRetry?: () => void;
  /** 다른 탭(ServiceAccount)에서 "이 롤 보기" 를 눌렀을 때 전달되는 대상. */
  focusRequest?: RbacRoleFocusRequest | null;
}

function roleKey(r: RbacRole): string {
  return `${r.scope}:${r.namespace ?? '—'}:${r.name}`;
}

export function RolePanel({
  clusterId,
  roles,
  clusterRoles,
  bindings,
  includeSystem,
  onIncludeSystemChange,
  isLoading,
  error,
  onRetry,
  focusRequest,
}: Props) {
  const { canOperate, hint, withHint, ariaWithHint } = useCanOperate(clusterId);
  const toast = useToastSafe();
  // 검색어·선택한 롤은 URL 에 둔다(D-029) — 링크로 "이 롤 봐 주세요" 를 공유할 수 있다.
  const [params, setParams] = useUrlParams({ roleQ: '', role: '' });
  const query = params.roleQ;
  const setQuery = (v: string) => setParams({ roleQ: v });
  const selectedKey = params.role || null;
  const setSelectedKey = (k: string | null) => setParams({ role: k ?? '' });
  const [draft, setDraft] = useState<RbacPolicyRule[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<RbacRole | null>(null);
  // 저장하지 않은 변경이 있을 때 다른 롤을 고르면 버릴지 먼저 묻는다.
  const [pendingSelect, setPendingSelect] = useState<RbacRole | null>(null);
  // 저장 확인 — 참조 바인딩이 있거나 권한을 넓히면 무엇이 바뀌는지 보여주고 확인받는다.
  const [confirmSave, setConfirmSave] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());

  const upsert = useUpsertRole(clusterId);
  const remove = useDeleteRole(clusterId);
  // 실행 로그(D-089) — 저장·삭제는 살아 있는 바인딩의 권한을 바로 바꾸므로 무엇이 나갔는지 남긴다.
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('k8s-rbac-roles');

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

  const dirty =
    !!selected && !!draft && JSON.stringify(draft) !== JSON.stringify(selected.rules);

  const select = (r: RbacRole) => {
    setSelectedKey(roleKey(r));
    setDraft(r.rules.map((rule) => ({ ...rule })));
  };
  const requestSelect = (r: RbacRole) => {
    if (dirty && roleKey(r) !== selectedKey) {
      setPendingSelect(r);
      return;
    }
    select(r);
  };

  // URL 로 롤이 정해진 채 열리면(새로고침·공유 링크) 목록이 온 뒤 편집본을 채운다.
  useEffect(() => {
    if (selected && !draft) setDraft(selected.rules.map((rule) => ({ ...rule })));
  }, [selected, draft]);

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
      requestSelect(target);
      rowRefs.current.get(roleKey(target))?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      focusState.current.settled = true;
      return;
    }
    if (focusRequest.scope === 'cluster' && !includeSystem) {
      onIncludeSystemChange(true);
      return; // clusterRoles 재조회 후 다음 렌더에서 다시 찾는다 — 아직 settled 아님
    }
    focusState.current.settled = true;
    toast.warning('롤을 찾을 수 없습니다', `${focusRequest.name} — 삭제됐거나 목록에 없습니다`);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requestSelect/toast/onIncludeSystemChange 는 매 렌더 새 함수라 넣으면 무한 루프
  }, [focusRequest, all, includeSystem]);

  // 저장이 권한을 넓히는지 — 발급 마법사와 같은 판정. 원래 롤에 이미 있던 사유는 빼고
  // 이번 편집으로 **새로 생기는** 위험만 확인받는다(기존 롤을 조금 고칠 때마다 막지 않게).
  const clusterWide = referencingBindings.some((b) => b.kind === 'ClusterRoleBinding');
  const saveRisk = useMemo(() => {
    if (!selected || !draft) return [];
    const before = new Set(grantRiskReasons({ clusterWide, rules: selected.rules }));
    return grantRiskReasons({ clusterWide, rules: draft }).filter((r) => !before.has(r));
  }, [selected, draft, clusterWide]);
  const diff = useMemo(
    () => (selected && draft ? ruleDiff(selected.rules, draft) : { added: [], removed: [] }),
    [selected, draft],
  );
  const affectedScope = Array.from(new Set(referencingBindings.map((b) => b.namespace ?? '전체 네임스페이스')));

  const requestSave = () => {
    if (!selected || !draft) return;
    if (saveRisk.length > 0 || referencingBindings.length > 0) {
      setConfirmSave(true);
      return;
    }
    void save();
  };

  const save = async () => {
    setConfirmSave(false);
    if (!selected || !draft) return;
    const kind = selected.scope === 'cluster' ? 'ClusterRole' : 'Role';
    const target = `${kind} ${selected.namespace ? `${selected.namespace}/` : ''}${selected.name}`;
    const affected = referencingBindings.length;
    const r = await runLogged(runLog, {
      title: '롤 저장',
      first: `${target} — 규칙 ${draft.length}줄 저장 요청`,
      fn: () =>
        upsert.mutateAsync({
          scope: selected.scope,
          namespace: selected.namespace,
          name: selected.name,
          rules: draft,
        }),
      summarize: () => [
        ['info', `저장됨 · ${target}`],
        [affected ? 'warn' : 'info', affected ? `참조 바인딩 ${affected}개의 권한이 즉시 바뀜` : '참조하는 바인딩 없음'],
      ],
    });
    if (r.ok) toast.success('저장됨', target);
    else if (!r.aborted) toast.error('저장 실패', formatApiError(r.error));
  };

  const deleteRefCount = pendingDelete
    ? bindings.filter(
      (b) => b.roleName === pendingDelete.name
        && b.roleKind === (pendingDelete.scope === 'cluster' ? 'ClusterRole' : 'Role')
        && (pendingDelete.scope === 'cluster' || b.namespace === pendingDelete.namespace),
    ).length
    : 0;

  const handleDelete = async () => {
    const role = pendingDelete;
    if (!role) return;
    setPendingDelete(null);
    const target = `${role.scope === 'cluster' ? 'ClusterRole' : 'Role'} ${role.namespace ? `${role.namespace}/` : ''}${role.name}`;
    const r = await runLogged(runLog, {
      title: '롤 삭제',
      first: `${target} 삭제 요청`,
      fn: () => remove.mutateAsync({ scope: role.scope, namespace: role.namespace, name: role.name }),
      summarize: () => [['info', `삭제됨 · ${target}`]],
    });
    if (r.ok) {
      toast.success('삭제됨', role.name);
      if (roleKey(role) === selectedKey) {
        setSelectedKey(null);
        setDraft(null);
      }
    } else if (!r.aborted) {
      toast.error('삭제 실패', formatApiError(r.error));
    }
  };

  // nodes 같은 클러스터 스코프 리소스는 RoleBinding(네임스페이스 스코프)으로는 권한이
  // 발동하지 않는다 — ClusterRoleBinding 이 하나도 없으면(바인딩이 아예 없거나 전부
  // RoleBinding 이면) 저장해도 조용히 무효가 된다.
  const needsClusterRoleBinding =
    !!draft &&
    draft.some(ruleHasClusterScopedResource) &&
    !referencingBindings.some((b) => b.kind === 'ClusterRoleBinding');

  return (
    <div className="space-y-3">
      {(runLog.running || runLog.lines.length > 0) && (
        <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
      )}
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
      <MacCard
        title="Role / ClusterRole"
        actions={<>
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
        </>}
      >
        {isLoading ? (
          <LoadingState compact />
        ) : error ? (
          <ErrorState compact error={error} title="롤 목록을 불러오지 못했습니다" onRetry={onRetry} />
        ) : rows.length === 0 ? (
          <EmptyState icon={Shield} title="롤이 없습니다" compact />
        ) : (
          <div className="overflow-x-auto border border-border rounded-md max-h-[520px] overflow-y-auto">
            <table className="w-full min-w-[460px] text-sm">
              <thead className="sticky top-0">
                <tr className="bg-secondary">
                  {['범위', '이름', '규칙', ''].map((h, i) => (
                    <th
                      key={h || i}
                      className="text-left px-3 py-2 text-[11px] font-semibold text-muted-foreground whitespace-nowrap"
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
                    onClick={() => requestSelect(r)}
                  >
                    <td className="px-3 py-2">
                      <Tag>{r.scope === 'cluster' ? '클러스터' : r.namespace}</Tag>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {/* 행 클릭은 마우스용 — 키보드는 이름 버튼(Tab → Enter)으로 고른다. */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          requestSelect(r);
                        }}
                        aria-pressed={roleKey(r) === selectedKey}
                        title={`${r.name} 규칙 편집`}
                        className="text-left hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 rounded"
                      >
                        {r.name}
                      </button>
                      {isPepManaged(r.labels) && (
                        <span className="ml-1.5 text-[11px] px-1.5 py-px rounded-full border border-border bg-secondary text-muted-foreground font-medium">
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
                          aria-label={ariaWithHint(`${r.name} 삭제`)}
                          className="p-1.5 rounded-xl text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-50"
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
            description="고른 롤의 권한 규칙을 여기서 바로 고칠 수 있습니다."
            compact
          />
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <Tag>{selected.scope === 'cluster' ? 'ClusterRole' : `Role · ${selected.namespace}`}</Tag>
              <span className="font-mono text-sm font-semibold">{selected.name}</span>
              {selected.builtin && (
                <span className="text-[11px] text-muted-foreground">빌트인 — 읽기 전용</span>
              )}
            </div>

            <RuleEditor
              rules={draft}
              onChange={setDraft}
              disabled={!canOperate || selected.builtin}
              disabledHint={selected.builtin ? '쿠버네티스 빌트인 롤은 수정할 수 없습니다' : hint}
            />

            {referencingBindings.length > 0 && (
              <p className="text-xs leading-relaxed rounded-md border border-border bg-secondary text-foreground px-3 py-2">
                저장하면 이 롤을 참조하는 바인딩 {referencingBindings.length}개의 권한이 즉시 바뀝니다 — 영향
                범위: {affectedScope.join(', ')}. 저장 전에 바뀌는 권한을 한 번 더 보여줍니다.
              </p>
            )}

            {needsClusterRoleBinding && (
              <p className="flex items-start gap-2 text-xs leading-relaxed rounded-md border border-status-warning/30 bg-status-warning/10 text-foreground px-3 py-2">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-status-warning" aria-hidden="true" />
                <span>
                  nodes 같은 클러스터 스코프(네임스페이스 없는) 리소스가 규칙에 있습니다. 이 롤은{' '}
                  {referencingBindings.length === 0 ? '아직 어떤 바인딩에도 연결돼 있지 않습니다' : 'RoleBinding 으로만 연결돼 있습니다'}
                  — RoleBinding 으로는 이런 리소스에 권한이 발동하지 않습니다. 저장 후 <b>바인딩 탭</b>에서
                  ClusterRoleBinding 을 추가로 만들어야 실제로 동작합니다.
                </span>
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
                aria-label={ariaWithHint('규칙 추가')}
                className="px-3 py-1.5 rounded-xl border border-border text-xs hover:border-primary disabled:opacity-50"
              >
                규칙 추가
              </button>
              <div className="flex-1" />
              <button
                type="button"
                onClick={requestSave}
                disabled={!canOperate || selected.builtin || !dirty || upsert.isPending}
                title={
                  selected.builtin
                    ? '쿠버네티스 빌트인 롤은 수정할 수 없습니다'
                    : !dirty
                      ? '변경 사항이 없습니다'
                      : withHint('저장')
                }
                aria-label={ariaWithHint('규칙 저장')}
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
            ? deleteRefCount > 0
              ? `${pendingDelete.name} 을(를) 참조하는 바인딩 ${deleteRefCount}개가 있습니다 — 지우면 그 바인딩들이 아무 권한도 주지 못하게 됩니다.`
              : `${pendingDelete.name} 을(를) 참조하는 바인딩은 없습니다.`
            : undefined
        }
        confirmLabel="삭제"
        danger
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={!!pendingSelect}
        title="저장하지 않은 변경을 버릴까요?"
        description={selected ? `${selected.name} 의 규칙 편집 내용이 아직 저장되지 않았습니다. 다른 롤을 열면 편집 내용이 사라집니다.` : undefined}
        confirmLabel="버리고 열기"
        danger
        onConfirm={() => {
          if (pendingSelect) select(pendingSelect);
          setPendingSelect(null);
        }}
        onCancel={() => setPendingSelect(null)}
      />

      {selected && draft && (saveRisk.length > 0 ? (
        <GrantRiskDialog
          open={confirmSave}
          title="권한을 넓히는 저장입니다 — 계속할까요?"
          description={`${selected.scope === 'cluster' ? 'ClusterRole' : 'Role'} ${selected.name} 을(를) 저장하면 참조 바인딩 ${referencingBindings.length}개의 권한이 즉시 바뀝니다.`}
          reasons={saveRisk}
          details={[
            { label: '영향 범위', value: affectedScope.length ? affectedScope.join(', ') : '참조 바인딩 없음' },
          ]}
          confirmName={selected.name}
          confirmNameLabel="롤 이름"
          confirmLabel="저장"
          onConfirm={() => { void save(); }}
          onCancel={() => setConfirmSave(false)}
        >
          <RuleDiffList added={diff.added} removed={diff.removed} />
        </GrantRiskDialog>
      ) : (
        <ConfirmDialog
          open={confirmSave}
          title="롤 규칙을 저장할까요?"
          description={`참조 바인딩 ${referencingBindings.length}개(${affectedScope.join(', ')})의 권한이 즉시 바뀝니다.`}
          confirmLabel="저장"
          onConfirm={() => { void save(); }}
          onCancel={() => setConfirmSave(false)}
        >
          <RuleDiffList added={diff.added} removed={diff.removed} />
        </ConfirmDialog>
      ))}
    </div>
    </div>
  );
}
