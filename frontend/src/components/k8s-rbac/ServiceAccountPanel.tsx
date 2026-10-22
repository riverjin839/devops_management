/** ServiceAccount 목록 — 연결된 권한을 함께 보여주고, kubeconfig 재발급·액세스 회수·삭제를 한다. */
import { useMemo, useState } from 'react';
import { AlertTriangle, KeyRound, Search, ShieldOff, Trash2, UserPlus } from 'lucide-react';
import { ConfirmDialog, EmptyState, ErrorState, LoadingState, RunLogPanel, useToastSafe } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { useCanOperate } from '@/hooks/useCanOperate';
import {
  useCreateServiceAccount,
  useDeleteBinding,
  useDeleteRole,
  useDeleteServiceAccount,
  useIssueKubeconfig,
} from '@/hooks/useK8sRbac';
import { useLogPref } from '@/hooks/useLogPref';
import { runLogged, useRunLog } from '@/hooks/useRunLog';
import { formatApiError } from '@/lib/utils';
import type {
  RbacBinding,
  RbacBindingSummary,
  RbacKubeconfigResult,
  RbacNamespace,
  RbacRole,
  RbacServiceAccount,
} from '@/types';
import { CredentialResult } from './CredentialResult';
import { buildRevokePlan, shortDate } from './rbacShared';
import { Tag } from './RbacTags';

interface Props {
  clusterId: string;
  serviceAccounts: RbacServiceAccount[];
  namespaces: RbacNamespace[];
  /** 액세스 회수 계획(이 SA 만 묶인 바인딩 + PEP 가 만든 롤)을 세우는 데 쓴다. */
  bindings: RbacBinding[];
  roles: RbacRole[];
  clusterRoles: RbacRole[];
  isLoading: boolean;
  /** 목록 조회 실패(kubeconfig·API 미도달·RBAC 403) — 있으면 빈 상태 대신 오류를 보인다(D-139). */
  error?: unknown;
  onRetry?: () => void;
  /** "연결된 권한" 태그 클릭 — Role/ClusterRole 탭으로 이동해 그 롤을 바로 연다. */
  onSelectRole: (binding: RbacBindingSummary) => void;
  /** 재발급한 kubeconfig — 페이지가 들고 있어 탭을 옮겨도 사라지지 않는다. */
  issued: RbacKubeconfigResult | null;
  onIssuedChange: (v: RbacKubeconfigResult | null) => void;
}

const TTL_OPTIONS = [
  { label: '1일', value: 24 * 3600 },
  { label: '7일', value: 7 * 24 * 3600 },
  { label: '30일', value: 30 * 24 * 3600 },
  { label: '90일', value: 90 * 24 * 3600 },
];

const inputCls =
  'px-3 py-2 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/50';

const bindingLabel = (b: RbacBinding) => `${b.kind} ${b.namespace ? `${b.namespace}/` : ''}${b.name}`;
const roleLabel = (r: RbacRole) => (r.scope === 'cluster' ? `ClusterRole ${r.name}` : `Role ${r.namespace}/${r.name}`);

export function ServiceAccountPanel({
  clusterId,
  serviceAccounts,
  namespaces,
  bindings,
  roles,
  clusterRoles,
  isLoading,
  error,
  onRetry,
  onSelectRole,
  issued,
  onIssuedChange,
}: Props) {
  const { canOperate, withHint, ariaWithHint } = useCanOperate(clusterId);
  const toast = useToastSafe();
  const [query, setQuery] = useState('');
  const [nsFilter, setNsFilter] = useState('');
  const [pepOnly, setPepOnly] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newNs, setNewNs] = useState('');
  const [newName, setNewName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<RbacServiceAccount | null>(null);
  const [pendingIssue, setPendingIssue] = useState<RbacServiceAccount | null>(null);
  const [longLived, setLongLived] = useState(false);
  const [ttl, setTtl] = useState(TTL_OPTIONS[1].value);
  const [pendingRevoke, setPendingRevoke] = useState<RbacServiceAccount | null>(null);
  const [revokeName, setRevokeName] = useState('');

  // 실행 로그(D-089) — 생성·재발급·회수·삭제 모두 같은 로그에 남긴다. 펼침 여부는 화면별로 기억한다.
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('k8s-rbac-sa');

  const createSa = useCreateServiceAccount(clusterId);
  const deleteSa = useDeleteServiceAccount(clusterId);
  const deleteBinding = useDeleteBinding(clusterId);
  const deleteRole = useDeleteRole(clusterId);
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

  const revokePlan = useMemo(
    () => (pendingRevoke ? buildRevokePlan(pendingRevoke, bindings, roles, clusterRoles) : null),
    [pendingRevoke, bindings, roles, clusterRoles],
  );

  const handleCreate = async () => {
    const ns = newNs;
    const name = newName.trim();
    const r = await runLogged(runLog, {
      title: 'ServiceAccount 생성',
      first: `${ns}/${name} 생성 요청`,
      fn: () => createSa.mutateAsync({ namespace: ns, name }),
      summarize: () => [['info', `생성됨 · ServiceAccount ${ns}/${name}`]],
    });
    if (r.ok) {
      toast.success('ServiceAccount 생성됨', `${ns}/${name}`);
      setCreating(false);
      setNewName('');
    } else if (!r.aborted) {
      toast.error('생성 실패', formatApiError(r.error));
    }
  };

  const handleDelete = async () => {
    const sa = pendingDelete;
    if (!sa) return;
    setPendingDelete(null);
    const r = await runLogged(runLog, {
      title: 'ServiceAccount 삭제',
      first: `${sa.namespace}/${sa.name} 삭제 요청 — 롤·바인딩은 남습니다`,
      fn: () => deleteSa.mutateAsync({ namespace: sa.namespace, name: sa.name }),
      summarize: () => [['info', `삭제됨 · ServiceAccount ${sa.namespace}/${sa.name}`]],
    });
    if (r.ok) toast.success('ServiceAccount 삭제됨', `${sa.namespace}/${sa.name}`);
    else if (!r.aborted) toast.error('삭제 실패', formatApiError(r.error));
  };

  const openIssue = (sa: RbacServiceAccount) => {
    setLongLived(false);
    setTtl(TTL_OPTIONS[1].value);
    setPendingIssue(sa);
  };

  const handleIssue = async () => {
    const sa = pendingIssue;
    if (!sa) return;
    setPendingIssue(null);
    const tokenText = longLived ? '만료 없는 Secret 토큰' : `단기 토큰 ${TTL_OPTIONS.find((o) => o.value === ttl)?.label ?? ''}`;
    const r = await runLogged(runLog, {
      title: 'kubeconfig 재발급',
      first: `${sa.namespace}/${sa.name} — ${tokenText} 요청`,
      fn: () =>
        issue.mutateAsync({
          namespace: sa.namespace,
          serviceAccount: sa.name,
          longLivedToken: longLived,
          tokenTtlSeconds: longLived ? undefined : ttl,
        }),
      summarize: (res) => [
        ['info', `발급됨 · 서버 ${res.server} · 방식 ${res.mode}`],
        [res.expiresAt ? 'info' : 'warn', res.expiresAt ? `만료 ${res.expiresAt.replace('T', ' ').slice(0, 16)}` : '만료 없음 — Secret 을 지워야 회수됩니다'],
      ],
    });
    if (r.ok) {
      onIssuedChange(r.data);
      toast.success('kubeconfig 발급됨', r.data.expiresAt ? `만료 ${r.data.expiresAt.replace('T', ' ').slice(0, 16)}` : '만료 없음');
    } else if (!r.aborted) {
      toast.error('발급 실패', formatApiError(r.error));
    }
  };

  const openRevoke = (sa: RbacServiceAccount) => {
    setRevokeName('');
    setPendingRevoke(sa);
  };

  /** 액세스 회수 — 바인딩 → PEP 가 만든 롤 → ServiceAccount 순으로 지운다. 하나가 실패해도
   *  나머지는 계속 지우고(남은 권한을 줄이는 게 우선), 실패한 것은 로그에 남긴다. */
  const handleRevoke = async () => {
    const sa = pendingRevoke;
    const plan = revokePlan;
    if (!sa || !plan) return;
    setPendingRevoke(null);
    const total = plan.bindings.length + plan.roles.length + 1;
    const r = await runLogged(runLog, {
      title: '액세스 회수',
      first: `${sa.namespace}/${sa.name} — 바인딩 ${plan.bindings.length} · 롤 ${plan.roles.length} · ServiceAccount 1 삭제`,
      heartbeatMs: 0,
      fn: async (run) => {
        const failed: string[] = [];
        const step = async (name: string, label: string, items: (() => Promise<unknown>)[], names: string[]) => {
          if (items.length === 0) return;
          run.setStep(name, label, 'running');
          let bad = 0;
          for (let i = 0; i < items.length; i += 1) {
            try {
              await items[i]();
              run.log('info', `삭제됨 · ${names[i]}`);
            } catch (e) {
              bad += 1;
              failed.push(names[i]);
              run.log('error', `삭제 실패 · ${names[i]} — ${formatApiError(e)}`);
            }
          }
          run.setStep(name, label, bad ? 'failed' : 'done');
        };
        for (const b of plan.sharedBindings) {
          run.log('warn', `남김 · ${bindingLabel(b)} — 다른 대상(${b.subjects.length - 1}개)도 묶여 있어 지우지 않습니다`);
        }
        await step(
          'bindings',
          `바인딩 ${plan.bindings.length}`,
          plan.bindings.map((b) => () => deleteBinding.mutateAsync({ kind: b.kind, name: b.name, namespace: b.namespace })),
          plan.bindings.map(bindingLabel),
        );
        await step(
          'roles',
          `롤 ${plan.roles.length}`,
          plan.roles.map((x) => () => deleteRole.mutateAsync({ scope: x.scope, namespace: x.namespace, name: x.name })),
          plan.roles.map(roleLabel),
        );
        await step(
          'sa',
          'ServiceAccount',
          [() => deleteSa.mutateAsync({ namespace: sa.namespace, name: sa.name })],
          [`ServiceAccount ${sa.namespace}/${sa.name}`],
        );
        return failed;
      },
      summarize: (failed) => [
        [failed.length ? 'warn' : 'info', `${total}건 중 ${total - failed.length}건 삭제 · 실패 ${failed.length}`],
        ...(failed.length
          ? [['warn', `남은 오브젝트: ${failed.join(', ')} — 각 탭에서 직접 정리하세요`] as ['warn', string]]
          : []),
      ],
    });
    if (r.ok) {
      if (r.data.length === 0) toast.success('액세스 회수됨', `${sa.namespace}/${sa.name}`);
      else toast.warning('일부만 회수됨', `${r.data.length}건 삭제 실패 — 실행 로그를 확인하세요`);
    } else if (!r.aborted) {
      toast.error('회수 실패', formatApiError(r.error));
    }
  };

  const busy = runLog.running;

  return (
    <div className="space-y-3">
      <MacCard
        title="ServiceAccount"
        actions={<>
          <div className="relative flex-1 min-w-[180px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <input
              id="rbac-sa-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="네임스페이스 / 이름 / 롤 검색…"
              aria-label="ServiceAccount 검색"
              className={`${inputCls} w-full pl-9`}
            />
          </div>
          <select
            id="rbac-sa-ns-filter"
            value={nsFilter}
            onChange={(e) => setNsFilter(e.target.value)}
            aria-label="네임스페이스 필터"
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
          <button
            type="button"
            onClick={() => setCreating(!creating)}
            disabled={!canOperate}
            title={withHint('ServiceAccount 추가')}
            aria-label={ariaWithHint('ServiceAccount 추가')}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <UserPlus className="w-3.5 h-3.5" /> ServiceAccount 추가
          </button>
        </>}
      >
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
              disabled={!canOperate || !newNs || !newName.trim() || createSa.isPending}
              title={withHint('ServiceAccount 생성')}
              aria-label={ariaWithHint('ServiceAccount 생성')}
              className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
            >
              {createSa.isPending ? '생성 중…' : '생성'}
            </button>
          </div>
        )}

        {(runLog.running || runLog.lines.length > 0) && (
          <div className="mb-3">
            <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
          </div>
        )}

        {isLoading ? (
          <LoadingState compact />
        ) : error ? (
          <ErrorState compact error={error} title="ServiceAccount 목록을 불러오지 못했습니다" onRetry={onRetry} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="ServiceAccount 가 없습니다"
            description="액세스 발급 탭에서 개발자용 SA 를 만들 수 있습니다."
            compact
          />
        ) : (
          <div className="overflow-x-auto border border-border rounded-md">
            <table className="w-full min-w-[880px] text-sm">
              <thead>
                <tr className="bg-secondary">
                  {['네임스페이스', '이름', '연결된 권한', '생성', ''].map((h, i) => (
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
                          <span className="ml-1.5 text-[11px] px-1.5 py-px rounded-full border border-primary/30 bg-primary/10 text-primary font-medium">
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
                      <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                        {shortDate(sa.createdAt)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {protectedSa ? (
                          <span className="text-xs text-muted-foreground">기본 SA — 편집 불가</span>
                        ) : (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => openIssue(sa)}
                              disabled={!canOperate || busy}
                              title={withHint('kubeconfig 재발급 — 토큰 방식·유효기간을 고른 뒤 발급')}
                              aria-label={ariaWithHint(`${sa.name} kubeconfig 발급`)}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-xl border border-border text-xs hover:border-primary hover:text-primary disabled:opacity-50"
                            >
                              <KeyRound className="w-3.5 h-3.5" /> kubeconfig
                            </button>
                            <button
                              type="button"
                              onClick={() => openRevoke(sa)}
                              disabled={!canOperate || busy}
                              title={withHint('액세스 회수 — 이 SA 의 바인딩·PEP 롤·SA 를 한 번에 삭제')}
                              aria-label={ariaWithHint(`${sa.name} 액세스 회수`)}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-xl border border-border text-xs hover:border-destructive hover:text-destructive disabled:opacity-50"
                            >
                              <ShieldOff className="w-3.5 h-3.5" /> 회수
                            </button>
                            <button
                              type="button"
                              onClick={() => setPendingDelete(sa)}
                              disabled={!canOperate || busy}
                              title={withHint('ServiceAccount 만 삭제 — 롤·바인딩은 남습니다')}
                              aria-label={ariaWithHint(`${sa.name} 삭제`)}
                              className="p-1.5 rounded-xl text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-50"
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
          <span className="text-foreground">회수</span>는 이 SA 에만 묶인 바인딩과 PEP 가 만든 롤까지 함께 지웁니다.
          휴지통은 ServiceAccount 만 지웁니다.
        </p>
      </MacCard>

      {issued && (
        <MacCard
          title="발급된 kubeconfig"
          titleExtra={
            <span className="text-xs text-muted-foreground">
              <span className="font-mono">{issued.namespace}/{issued.serviceAccount}</span> ·{' '}
              {issued.expiresAt ? `만료 ${issued.expiresAt.replace('T', ' ').slice(0, 16)}` : '만료 없음'}
            </span>
          }
          actions={
            <button
              type="button"
              onClick={() => onIssuedChange(null)}
              title="kubeconfig 닫기 — 닫으면 다시 볼 수 없습니다"
              aria-label="kubeconfig 닫기"
              className="px-3 py-1.5 rounded-xl border border-border text-xs hover:border-primary"
            >
              닫기
            </button>
          }
        >
          <CredentialResult
            kubeconfig={issued.kubeconfig}
            fileName={`kubeconfig-${issued.serviceAccount}-${issued.namespace}.yaml`}
            maxHeight="max-h-72"
          />
        </MacCard>
      )}

      <ConfirmDialog
        open={!!pendingIssue}
        title="kubeconfig 를 다시 발급할까요?"
        description={
          pendingIssue
            ? `${pendingIssue.namespace}/${pendingIssue.name} 의 토큰을 새로 만듭니다. 이전에 건넨 단기 토큰은 만료 시각까지 그대로 유효합니다.`
            : undefined
        }
        confirmLabel="발급"
        onConfirm={handleIssue}
        onCancel={() => setPendingIssue(null)}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5 text-xs text-muted-foreground font-medium">
            토큰 방식
            <select
              value={longLived ? 'long' : 'short'}
              onChange={(e) => setLongLived(e.target.value === 'long')}
              className={inputCls}
            >
              <option value="short">단기 토큰 (TokenRequest)</option>
              <option value="long">만료 없는 Secret 토큰</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-muted-foreground font-medium">
            유효기간
            <select
              value={ttl}
              disabled={longLived}
              onChange={(e) => setTtl(Number(e.target.value))}
              className={`${inputCls} disabled:opacity-50`}
            >
              {TTL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {longLived && (
          <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed rounded-md border border-status-warning/40 bg-status-warning/10 text-foreground px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-status-warning" aria-hidden="true" />
            만료 없는 토큰은 Secret 을 지우거나 액세스를 회수하기 전까지 계속 유효합니다.
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={!!pendingRevoke}
        title="액세스를 회수할까요?"
        description={
          pendingRevoke
            ? `${pendingRevoke.namespace}/${pendingRevoke.name} 의 권한을 거둡니다. 이 SA 토큰으로 접속 중인 개발자와 파드는 즉시 인증에 실패합니다.`
            : undefined
        }
        confirmLabel="회수"
        danger
        confirmDisabled={!pendingRevoke || revokeName.trim() !== pendingRevoke.name}
        onConfirm={handleRevoke}
        onCancel={() => setPendingRevoke(null)}
      >
        {revokePlan && pendingRevoke && (
          <div className="space-y-3 text-xs">
            <div>
              <div className="text-muted-foreground mb-1">삭제할 오브젝트 {revokePlan.bindings.length + revokePlan.roles.length + 1}개</div>
              <ul className="space-y-0.5 font-mono max-h-48 overflow-y-auto">
                {revokePlan.bindings.map((b) => (
                  <li key={`b-${b.kind}-${b.namespace}-${b.name}`}>{bindingLabel(b)}</li>
                ))}
                {revokePlan.roles.map((r) => (
                  <li key={`r-${r.scope}-${r.namespace}-${r.name}`}>{roleLabel(r)}</li>
                ))}
                <li>ServiceAccount {pendingRevoke.namespace}/{pendingRevoke.name}</li>
              </ul>
            </div>
            {revokePlan.sharedBindings.length > 0 && (
              <div>
                <div className="text-muted-foreground mb-1">
                  남겨 두는 바인딩 {revokePlan.sharedBindings.length}개 — 다른 대상도 묶여 있어 지우면 그쪽 권한까지 사라집니다
                </div>
                <ul className="space-y-0.5 font-mono">
                  {revokePlan.sharedBindings.map((b) => (
                    <li key={`s-${b.kind}-${b.namespace}-${b.name}`}>{bindingLabel(b)}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-muted-foreground">
              PEP 가 만들지 않은 롤과 다른 바인딩이 함께 쓰는 롤은 지우지 않습니다.
            </p>
            <label className="flex flex-col gap-1.5 text-muted-foreground font-medium">
              확인을 위해 ServiceAccount 이름을 입력하세요
              <input
                value={revokeName}
                onChange={(e) => setRevokeName(e.target.value)}
                placeholder={pendingRevoke.name}
                spellCheck={false}
                autoComplete="off"
                aria-label="확인용 ServiceAccount 이름"
                className={`${inputCls} font-mono`}
              />
            </label>
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={!!pendingDelete}
        title="ServiceAccount 만 삭제할까요?"
        description={
          pendingDelete
            ? `${pendingDelete.namespace}/${pendingDelete.name} 을(를) 지우면 이 SA 토큰으로 접속 중인 개발자와 파드가 즉시 인증에 실패합니다. 롤과 바인딩은 남습니다 — 함께 정리하려면 회수를 쓰세요.`
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
