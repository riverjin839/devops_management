import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, RotateCcw, Save, Search, Users as UsersIcon } from 'lucide-react';
import { authApi } from '@/services/api';
import { useClusterGrantSummary, useSaveClusterGrants, useUserClusterAccess } from '@/hooks/useClusterAccessGrants';
import { EmptyState, useToast } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { formatApiError } from '@/lib/utils';
import type { ClusterAccessLevel, ClusterAccessRow, ClusterGrantLevel } from '@/types';

/** 세그먼트 값 — 'inherit' = 직접 지정 없음(테넌트·기본 규칙에 따름). */
type Choice = 'inherit' | ClusterGrantLevel;

const CHOICES: { id: Choice; label: string; help: string }[] = [
  { id: 'inherit', label: '기본', help: '직접 지정하지 않음 — 테넌트 바인딩·기본 규칙에 따릅니다' },
  { id: 'none', label: '숨김', help: '이 사용자에게 클러스터가 보이지 않습니다' },
  { id: 'read', label: '읽기', help: '조회만 할 수 있고 실행·변경은 할 수 없습니다' },
  { id: 'operate', label: '편집', help: '조회와 실행·변경을 할 수 있습니다(전역 역할이 operator 이상일 때)' },
];

const ROLE_LABEL: Record<string, string> = { admin: 'admin', operator: 'operator', viewer: 'viewer' };

const INPUT = 'w-full rounded-xl border border-border bg-background pl-8 pr-3 py-2 text-sm';
const BTN = 'inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium disabled:opacity-50';

const toChoice = (g: ClusterGrantLevel | null): Choice => g ?? 'inherit';

function levelLabel(level: ClusterAccessLevel | null, roleLimited: boolean): string {
  if (level === null) return '숨김';
  if (level === 'read') return '읽기';
  return roleLimited ? '읽기(역할 제한)' : '편집';
}

function sourceLabel(source: string): string {
  if (source === 'admin') return 'admin';
  if (source === 'grant') return '직접 지정';
  if (source === 'restricted') return '지정 없음(제한된 클러스터)';
  if (source === 'open') return '제한 없음';
  if (source.startsWith('tenant:')) return `테넌트 ${source.slice('tenant:'.length)}`;
  return source;
}

/**
 * Settings ▸ 클러스터 권한 — admin 이 사용자 한 명 단위로 클러스터별 숨김/읽기/편집을 지정한다.
 *
 * 판정(backend `services/cluster_access.py`): admin → 직접 지정(우선) → 제한된 클러스터면 테넌트 판정 →
 * 제한 없음. 읽기·편집 지정이 하나라도 있는 클러스터는 지정되지 않은 사용자에게 숨겨진다.
 * 「편집」은 범위만 연다 — viewer 역할은 여전히 실행할 수 없다.
 */
export function ClusterAccessManager() {
  const { data: users = [], isLoading: usersLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => authApi.listUsers().then((r) => r.data),
  });
  const { data: summary = [] } = useClusterGrantSummary();
  const countBy = useMemo(() => new Map(summary.map((s) => [s.userId, s.grants])), [summary]);

  const loginUsers = useMemo(() => users.filter((u) => Boolean(u.username)), [users]);
  const [userQuery, setUserQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const filteredUsers = useMemo(() => {
    const q = userQuery.trim().toLowerCase();
    if (!q) return loginUsers;
    return loginUsers.filter((u) =>
      `${u.username} ${u.displayName ?? ''}`.toLowerCase().includes(q));
  }, [loginUsers, userQuery]);
  const selected = loginUsers.find((u) => u.id === selectedId) ?? loginUsers[0] ?? null;

  return (
    <div className="space-y-4">
      <MacCard title="사용자별 클러스터 권한">
        <p className="text-sm text-muted-foreground">
          사용자마다 등록된 클러스터를 <b>숨김</b> · <b>읽기</b> · <b>편집</b> 중 하나로 지정합니다. 직접 지정은 테넌트에서
          받은 권한보다 우선합니다. 어떤 클러스터에 한 명에게라도 읽기·편집을 지정하면, 지정되지 않은 사용자에게는
          그 클러스터가 숨겨집니다(테넌트 바인딩 멤버는 제외). 「편집」을 줘도 전역 역할이 viewer 면 실행할 수 없고,
          admin 은 항상 모든 클러스터를 편집할 수 있습니다.
        </p>
      </MacCard>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
        <MacCard title="사용자" icon={UsersIcon} bodyPadding="p-3">
          <div className="relative mb-3">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              className={INPUT}
              placeholder="사용자 검색"
              value={userQuery}
              onChange={(e) => setUserQuery(e.target.value)}
              aria-label="사용자 검색"
            />
          </div>
          {usersLoading && <p className="text-sm text-muted-foreground px-1">불러오는 중…</p>}
          {!usersLoading && filteredUsers.length === 0 && (
            <p className="text-sm text-muted-foreground px-1">일치하는 사용자가 없습니다.</p>
          )}
          <ul className="space-y-1 max-h-[560px] overflow-y-auto">
            {filteredUsers.map((u) => {
              const count = countBy.get(u.id) ?? 0;
              return (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(u.id)}
                    aria-current={selected?.id === u.id ? 'true' : undefined}
                    className={`w-full text-left rounded-xl px-3 py-2 text-sm transition-colors ${
                      selected?.id === u.id ? 'bg-primary/10 text-foreground' : 'hover:bg-secondary text-muted-foreground'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium flex-1">{u.displayName || u.username}</span>
                      <span className="text-xs text-muted-foreground">{ROLE_LABEL[u.role] ?? u.role}</span>
                      <span className="text-xs tabular-nums text-muted-foreground w-8 text-right">
                        {u.role === 'admin' ? '전체' : count > 0 ? count : ''}
                      </span>
                    </span>
                    {u.displayName && (
                      <span className="block text-xs text-muted-foreground mt-0.5 truncate">{u.username}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted-foreground mt-3 px-1">오른쪽 숫자 = 직접 지정한 클러스터 수</p>
        </MacCard>

        {selected ? (
          <UserGrantEditor key={selected.id} userId={selected.id} />
        ) : (
          <EmptyState
            icon={KeyRound}
            compact
            title="사용자가 없습니다"
            description="로그인 계정이 있는 사용자를 추가하면 클러스터별 권한을 지정할 수 있습니다."
          />
        )}
      </div>
    </div>
  );
}

function UserGrantEditor({ userId }: { userId: string }) {
  const toast = useToast();
  const { data, isLoading, isError, error, refetch } = useUserClusterAccess(userId);
  const save = useSaveClusterGrants();
  const [draft, setDraft] = useState<Record<string, Choice>>({});
  const [clusterQuery, setClusterQuery] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);

  useEffect(() => {
    if (!data) return;
    setDraft(Object.fromEntries(data.clusters.map((c) => [c.clusterId, toChoice(c.grant)])));
  }, [data]);

  const rows = useMemo(() => data?.clusters ?? [], [data]);
  const changed = useMemo(
    () => rows.filter((r) => (draft[r.clusterId] ?? toChoice(r.grant)) !== toChoice(r.grant)),
    [rows, draft],
  );
  const changedIds = useMemo(() => new Set(changed.map((r) => r.clusterId)), [changed]);
  const visible = useMemo(() => {
    const q = clusterQuery.trim().toLowerCase();
    return rows.filter((r) =>
      (!q || r.clusterName.toLowerCase().includes(q)) && (!changedOnly || changedIds.has(r.clusterId)));
  }, [rows, clusterQuery, changedOnly, changedIds]);

  if (isLoading) {
    return <MacCard title="클러스터"><p className="text-sm text-muted-foreground">불러오는 중…</p></MacCard>;
  }
  if (isError || !data) {
    return (
      <MacCard title="클러스터">
        <EmptyState
          icon={KeyRound}
          compact
          title="권한 정보를 불러오지 못했습니다"
          description={formatApiError(error)}
          action={{ label: '다시 시도', onClick: () => { void refetch(); } }}
        />
      </MacCard>
    );
  }

  const isAdmin = data.role === 'admin';
  const isViewer = data.role === 'viewer';
  const who = data.displayName ? `${data.displayName} (${data.username})` : (data.username ?? data.userId);

  /** 저장 전 미리보기 — 바뀐 행은 지정 값으로, 기본으로 되돌린 행은 서버 계산을 알 수 없어 "저장 후 계산". */
  const preview = (r: ClusterAccessRow): { level: string; source: string } => {
    const choice = draft[r.clusterId] ?? toChoice(r.grant);
    if (!changedIds.has(r.clusterId)) {
      return { level: levelLabel(r.effective, r.roleLimited), source: sourceLabel(r.source) };
    }
    if (choice === 'inherit') return { level: '저장 후 계산', source: '기본 규칙' };
    const lvl: ClusterAccessLevel | null = choice === 'none' ? null : choice;
    return { level: levelLabel(lvl, lvl === 'operate' && isViewer), source: '직접 지정' };
  };

  const onSave = () => {
    const changes = changed.map((r) => {
      const c = draft[r.clusterId];
      return { userId, clusterId: r.clusterId, access: c === 'inherit' ? null : c };
    });
    save.mutate(changes, {
      onSuccess: (res) => {
        const { created, updated, removed } = res.data;
        toast.success('클러스터 권한 저장됨', `추가 ${created} · 변경 ${updated} · 해제 ${removed}`);
      },
      onError: (e) => toast.error('저장 실패', formatApiError(e)),
    });
  };

  const reset = () => setDraft(Object.fromEntries(rows.map((c) => [c.clusterId, toChoice(c.grant)])));

  return (
    <MacCard
      title={who}
      icon={KeyRound}
      description={`역할 ${ROLE_LABEL[data.role] ?? data.role}`}
      actions={
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={`${BTN} bg-secondary text-foreground`}
            onClick={reset}
            disabled={changed.length === 0 || save.isPending}
          >
            <RotateCcw className="w-4 h-4" /> 되돌리기
          </button>
          <button
            type="button"
            className={`${BTN} bg-primary text-primary-foreground`}
            onClick={onSave}
            disabled={changed.length === 0 || save.isPending || isAdmin}
          >
            <Save className="w-4 h-4" /> 저장{changed.length > 0 ? ` (${changed.length})` : ''}
          </button>
        </div>
      }
    >
      {isAdmin && (
        <p className="text-sm text-muted-foreground mb-3">
          admin 은 항상 모든 클러스터를 편집할 수 있어 지정할 필요가 없습니다.
        </p>
      )}
      {isViewer && !isAdmin && (
        <p className="text-sm text-muted-foreground mb-3">
          이 사용자는 viewer 역할입니다. 「편집」을 지정해도 실행·변경은 할 수 없고 조회만 됩니다.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            className={INPUT}
            placeholder="클러스터 검색"
            value={clusterQuery}
            onChange={(e) => setClusterQuery(e.target.value)}
            aria-label="클러스터 검색"
          />
        </div>
        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} />
          변경된 항목만
        </label>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={KeyRound} compact title="등록된 클러스터가 없습니다" description="클러스터 관리에서 클러스터를 먼저 등록하세요." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="py-2 pr-3 font-medium">클러스터</th>
                <th className="py-2 pr-3 font-medium">직접 지정</th>
                <th className="py-2 pr-3 font-medium">실제 적용</th>
                <th className="py-2 font-medium">근거</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const choice = draft[r.clusterId] ?? toChoice(r.grant);
                const p = preview(r);
                const isChanged = changedIds.has(r.clusterId);
                return (
                  <tr key={r.clusterId} className="border-b border-border/60 last:border-0">
                    <td className="py-2 pr-3 font-medium text-foreground whitespace-nowrap">{r.clusterName}</td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <div
                          role="radiogroup"
                          aria-label={`${r.clusterName} 권한`}
                          className="inline-flex items-center bg-secondary rounded-xl p-[3px] gap-px"
                        >
                          {CHOICES.map((c) => (
                            <button
                              key={c.id}
                              type="button"
                              role="radio"
                              aria-checked={choice === c.id}
                              title={c.help}
                              disabled={isAdmin}
                              onClick={() => setDraft((d) => ({ ...d, [r.clusterId]: c.id }))}
                              className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-colors whitespace-nowrap disabled:opacity-50 ${
                                choice === c.id
                                  ? 'bg-background text-foreground shadow-sm'
                                  : 'text-muted-foreground hover:text-foreground'
                              }`}
                            >
                              {c.label}
                            </button>
                          ))}
                        </div>
                        {isChanged && <span className="text-xs text-primary whitespace-nowrap">변경됨</span>}
                      </div>
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <span
                        className={p.level === '숨김' ? 'text-muted-foreground' : 'text-foreground'}
                        title={p.level.includes('역할 제한') ? 'viewer 역할은 실행·변경을 할 수 없습니다' : undefined}
                      >
                        {p.level}
                      </span>
                    </td>
                    <td className="py-2 text-muted-foreground whitespace-nowrap">{p.source}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {visible.length === 0 && (
            <p className="text-sm text-muted-foreground py-4">조건에 맞는 클러스터가 없습니다.</p>
          )}
        </div>
      )}
    </MacCard>
  );
}
