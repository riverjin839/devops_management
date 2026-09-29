import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Building2, Plus, Save, Trash2, Users as UsersIcon, Server, Bot } from 'lucide-react';
import { authApi, llmApi } from '@/services/api';
import { useClusters } from '@/hooks/useCluster';
import { useTenantLlmUsage, useTenantMutations, useTenants } from '@/hooks/useTenants';
import { ConfirmDialog, useToast } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { formatApiError } from '@/lib/utils';
import type { ClusterAccessLevel, Tenant, TenantLlmRouting } from '@/types';

type BindingChoice = 'none' | ClusterAccessLevel;

const INPUT = 'w-full rounded-xl border border-border bg-background px-3 py-2 text-sm';
const BTN = 'inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium disabled:opacity-50';

/**
 * Settings ▸ 테넌트 — 멀티테넌시 1단계.
 *
 * 테넌트(팀)에 사용자를 넣고 클러스터를 바인딩하면, 그 클러스터의 실행·변경(exec, etcdctl,
 * bulk-exec, 리소스 변경, 배치잡/플레이북 실행 등)은 바인딩된 테넌트 멤버만 할 수 있다.
 * 바인딩이 하나도 없는 클러스터는 지금처럼 열려 있다. 서버 판정은 backend
 * `services/cluster_access.py`. Settings 라우트 자체가 RequireAdmin 이라 admin 만 들어온다.
 */
export function TenantManager() {
  const toast = useToast();
  const { data: tenants = [], isLoading } = useTenants();
  const { data: clusters = [] } = useClusters();
  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => authApi.listUsers().then((r) => r.data),
  });
  const m = useTenantMutations();
  const { data: llmUsage = [] } = useTenantLlmUsage();
  const usageBy = useMemo(() => new Map(llmUsage.map((u) => [u.tenantId, u])), [llmUsage]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const selected = tenants.find((t) => t.id === selectedId) ?? tenants[0] ?? null;

  const boundCount = useMemo(
    () => new Set(tenants.flatMap((t) => t.bindings.map((b) => b.clusterId))).size,
    [tenants],
  );

  const create = () => {
    const name = newName.trim();
    if (!name) return;
    m.create.mutate({ name }, {
      onSuccess: (r) => {
        setNewName('');
        setSelectedId(r.data.id);
        toast.success(`테넌트 생성됨: ${name}`);
      },
      onError: (e) => toast.error('생성 실패', formatApiError(e)),
    });
  };

  return (
    <div className="space-y-4">
      <MacCard title="클러스터 실행 권한 (테넌트)">
        <p className="text-sm text-muted-foreground">
          테넌트에 클러스터를 <b>바인딩</b>하면 그 클러스터의 실행·변경(Pod exec, k9s, 노드 SSH, etcdctl, 일괄 실행,
          리소스 변경, 배치잡·플레이북 실행 등)은 <b>바인딩된 테넌트의 멤버</b>만 할 수 있습니다.
          <b> operate</b> 는 실행·변경까지, <b>read</b> 는 조회만 허용합니다. 바인딩이 없는 클러스터는 지금처럼
          전역 역할(operator)만으로 실행할 수 있고, admin 은 항상 허용됩니다. 테넌트 멤버십은 권한을 좁힐 뿐
          넓히지 않습니다 — viewer 를 operate 테넌트에 넣어도 실행할 수 없습니다.
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          현재 제한된 클러스터: <b>{boundCount}</b> / {clusters.length}
        </p>
      </MacCard>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
        <MacCard title="테넌트" bodyPadding="p-3">
          <div className="flex gap-2 mb-3">
            <input
              className={INPUT}
              placeholder="새 테넌트 이름"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
              aria-label="새 테넌트 이름"
            />
            <button
              type="button"
              className={`${BTN} bg-primary text-primary-foreground`}
              onClick={create}
              disabled={!newName.trim() || m.create.isPending}
              title="테넌트 추가"
              aria-label="테넌트 추가"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
          {isLoading && <p className="text-sm text-muted-foreground px-1">불러오는 중…</p>}
          {!isLoading && tenants.length === 0 && (
            <p className="text-sm text-muted-foreground px-1">테넌트가 없습니다. 모든 클러스터가 열려 있습니다.</p>
          )}
          <ul className="space-y-1">
            {tenants.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(t.id)}
                  className={`w-full text-left rounded-xl px-3 py-2 text-sm transition-colors ${
                    selected?.id === t.id ? 'bg-primary/10 text-foreground' : 'hover:bg-secondary text-muted-foreground'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <Building2 className="w-4 h-4 shrink-0" />
                    <span className="truncate font-medium">{t.name}</span>
                  </span>
                  <span className="block text-xs text-muted-foreground mt-0.5 pl-6">
                    멤버 {t.members.length} · 클러스터 {t.bindings.length}
                    {usageBy.get(t.id) ? ` · LLM 24h ${usageBy.get(t.id)?.count}회` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </MacCard>

        {selected ? (
          <TenantDetail key={selected.id} tenant={selected} users={users} clusters={clusters} />
        ) : (
          <MacCard>
            <p className="text-sm text-muted-foreground">왼쪽에서 테넌트를 추가하거나 선택하세요.</p>
          </MacCard>
        )}
      </div>
    </div>
  );
}

interface DetailProps {
  tenant: Tenant;
  users: { id: string; username: string; displayName?: string | null; role: string }[];
  clusters: { id: string; name: string }[];
}

function TenantDetail({ tenant, users, clusters }: DetailProps) {
  const toast = useToast();
  const m = useTenantMutations();
  const [name, setName] = useState(tenant.name);
  const [description, setDescription] = useState(tenant.description ?? '');
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [bindings, setBindings] = useState<Record<string, BindingChoice>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setName(tenant.name);
    setDescription(tenant.description ?? '');
    setMemberIds(new Set(tenant.members.map((x) => x.userId)));
    setBindings(Object.fromEntries(tenant.bindings.map((b) => [b.clusterId, b.access])));
  }, [tenant]);

  // admin 은 바인딩과 무관하게 항상 허용되므로 멤버 후보에서 뺀다(넣어도 의미 없음).
  const candidates = users.filter((u) => u.role !== 'admin');

  const toggleMember = (id: string) =>
    setMemberIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const saveInfo = () =>
    m.update.mutate({ id: tenant.id, name: name.trim(), description: description || null }, {
      onSuccess: () => toast.success('테넌트 정보 저장됨'),
      onError: (e) => toast.error('저장 실패', formatApiError(e)),
    });

  const saveMembers = () =>
    m.putMembers.mutate({ id: tenant.id, userIds: [...memberIds] }, {
      onSuccess: () => toast.success('멤버 저장됨'),
      onError: (e) => toast.error('저장 실패', formatApiError(e)),
    });

  const saveBindings = () => {
    const payload = Object.entries(bindings)
      .filter(([, v]) => v !== 'none')
      .map(([clusterId, access]) => ({ clusterId, access: access as ClusterAccessLevel }));
    m.putBindings.mutate({ id: tenant.id, bindings: payload }, {
      onSuccess: () => toast.success('클러스터 바인딩 저장됨'),
      onError: (e) => toast.error('저장 실패', formatApiError(e)),
    });
  };

  const remove = () =>
    m.remove.mutate(tenant.id, {
      onSuccess: () => { setConfirmDelete(false); toast.success(`테넌트 삭제됨: ${tenant.name}`); },
      onError: (e) => toast.error('삭제 실패', formatApiError(e)),
    });

  return (
    <div className="space-y-4">
      <MacCard title="정보">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr_auto] gap-2 items-end">
          <label className="text-xs text-muted-foreground">
            이름
            <input className={`${INPUT} mt-1`} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="text-xs text-muted-foreground">
            설명
            <input className={`${INPUT} mt-1`} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              className={`${BTN} bg-primary text-primary-foreground`}
              onClick={saveInfo}
              disabled={!name.trim() || m.update.isPending}
            >
              <Save className="w-4 h-4" /> 저장
            </button>
            <button
              type="button"
              className={`${BTN} border border-border text-status-critical hover:bg-status-critical/10`}
              onClick={() => setConfirmDelete(true)}
              title="테넌트 삭제"
              aria-label="테넌트 삭제"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      </MacCard>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <MacCard title={`멤버 (${memberIds.size})`}>
          <div className="max-h-[50vh] overflow-y-auto space-y-1">
            {candidates.length === 0 && (
              <p className="text-sm text-muted-foreground">로그인 계정이 있는 operator/viewer 사용자가 없습니다.</p>
            )}
            {candidates.map((u) => (
              <label key={u.id} className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-secondary cursor-pointer text-sm">
                <input type="checkbox" checked={memberIds.has(u.id)} onChange={() => toggleMember(u.id)} />
                <UsersIcon className="w-4 h-4 text-muted-foreground" />
                <span className="font-medium">{u.displayName || u.username}</span>
                <span className="text-xs text-muted-foreground">{u.username} · {u.role}</span>
              </label>
            ))}
          </div>
          <div className="flex justify-end mt-3">
            <button
              type="button"
              className={`${BTN} bg-primary text-primary-foreground`}
              onClick={saveMembers}
              disabled={m.putMembers.isPending}
            >
              <Save className="w-4 h-4" /> 멤버 저장
            </button>
          </div>
        </MacCard>

        <MacCard title={`클러스터 바인딩 (${Object.values(bindings).filter((v) => v !== 'none').length})`}>
          <div className="max-h-[50vh] overflow-y-auto space-y-1">
            {clusters.map((c) => (
              <div key={c.id} className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-secondary text-sm">
                <Server className="w-4 h-4 text-muted-foreground" />
                <span className="flex-1 truncate font-medium">{c.name}</span>
                <select
                  className="rounded-xl border border-border bg-background px-2 py-1 text-sm"
                  value={bindings[c.id] ?? 'none'}
                  onChange={(e) => setBindings((cur) => ({ ...cur, [c.id]: e.target.value as BindingChoice }))}
                  aria-label={`${c.name} 접근 수준`}
                >
                  <option value="none">바인딩 없음</option>
                  <option value="read">read (조회)</option>
                  <option value="operate">operate (실행·변경)</option>
                </select>
              </div>
            ))}
          </div>
          <div className="flex justify-end mt-3">
            <button
              type="button"
              className={`${BTN} bg-primary text-primary-foreground`}
              onClick={saveBindings}
              disabled={m.putBindings.isPending}
            >
              <Save className="w-4 h-4" /> 바인딩 저장
            </button>
          </div>
        </MacCard>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="테넌트 삭제"
        description={`'${tenant.name}' 테넌트와 멤버·클러스터 바인딩을 모두 삭제합니다. 이 테넌트로만 제한되던 클러스터는 다시 열립니다.`}
        confirmLabel="삭제"
        danger
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />

      <TenantLlmRoutingCard tenant={tenant} />
    </div>
  );
}

// 테넌트별로 바꿀 수 있는 LLM 용도 — 임베딩은 제외(pgvector 에 저장된 벡터와 호환이 깨진다).
// axios 인터셉터가 키를 camelCase 로 바꾸므로 purpose 키도 camelCase 로 다룬다.
const TENANT_LLM_PURPOSES: { key: string; label: string }[] = [
  { key: 'chat', label: 'AI 챗봇' },
  { key: 'incidentAnalysis', label: '장애 분석' },
  { key: 'reviewSummary', label: '점검 리뷰/요약' },
  { key: 'archDoc', label: '아키텍처 문서' },
  { key: 'trends', label: '기술 트렌드 요약' },
];

/**
 * 멀티테넌시 4단계 — 이 테넌트 멤버가 사용자 요청(현재 Agent 채팅)으로 LLM 을 부를 때 쓰는
 * 용도별 프로필. 비우면 전역 라우팅(Settings ▸ AI / LLM)을 따른다. 테넌트 전용 키
 * (`credential:<name>`)를 쓰는 프로필로 보내면 비용이 분리된다.
 */
function TenantLlmRoutingCard({ tenant }: { tenant: Tenant }) {
  const toast = useToast();
  const m = useTenantMutations();
  const { data: llm } = useQuery({
    queryKey: ['tenant-manager', 'llm-profiles'],
    queryFn: () => llmApi.getSettings().then((r) => r.data.data),
  });
  const profiles = (llm?.profiles ?? []).map((p) => p.name);
  const [routing, setRouting] = useState<TenantLlmRouting>({});
  useEffect(() => { setRouting(tenant.llmRouting ?? {}); }, [tenant]);

  const setRoute = (purpose: string, field: 'primary' | 'fallback', value: string) =>
    setRouting((cur) => ({ ...cur, [purpose]: { ...cur[purpose], [field]: value || null } }));

  const save = () =>
    m.putLlmRouting.mutate({ id: tenant.id, routing }, {
      onSuccess: () => toast.success('LLM 라우팅 저장됨'),
      onError: (e) => toast.error('저장 실패', formatApiError(e)),
    });

  const selectCls = 'rounded-xl border border-border bg-background px-2 py-1 text-sm';
  return (
    <MacCard title="LLM 라우팅 (테넌트 전용)">
      <p className="text-xs text-muted-foreground mb-3">
        이 테넌트 멤버가 Agent 채팅을 쓸 때 용도별로 보낼 LLM 프로필입니다. 비워 두면 전역 라우팅을 따릅니다.
        여러 테넌트에 속한 사용자는 라우팅을 지정한 테넌트 중 이름순 첫 테넌트를 따릅니다.
      </p>
      <div className="space-y-1.5">
        {TENANT_LLM_PURPOSES.map(({ key, label }) => (
          <div key={key} className="grid grid-cols-[140px_1fr_1fr] gap-2 items-center text-sm">
            <span className="flex items-center gap-1.5 font-medium">
              <Bot className="w-4 h-4 text-muted-foreground" />
              {label}
            </span>
            <select
              className={selectCls}
              value={routing[key]?.primary ?? ''}
              onChange={(e) => setRoute(key, 'primary', e.target.value)}
              aria-label={`${label} primary 프로필`}
            >
              <option value="">전역 라우팅 따름</option>
              {profiles.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select
              className={selectCls}
              value={routing[key]?.fallback ?? ''}
              onChange={(e) => setRoute(key, 'fallback', e.target.value)}
              disabled={!routing[key]?.primary}
              aria-label={`${label} fallback 프로필`}
            >
              <option value="">fallback 없음</option>
              {profiles.filter((p) => p !== routing[key]?.primary).map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        ))}
      </div>
      <div className="flex justify-end mt-3">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium bg-primary text-primary-foreground disabled:opacity-50"
          onClick={save}
          disabled={m.putLlmRouting.isPending}
        >
          <Save className="w-4 h-4" /> 라우팅 저장
        </button>
      </div>
    </MacCard>
  );
}
