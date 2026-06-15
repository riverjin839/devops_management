import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, Save, Lock, Users as UsersIcon } from 'lucide-react';
import { authApi } from '@/services/api';
import { useFeatureAccess, useUpdateFeatureAccess } from '@/hooks/useFeatureAccess';
import { useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import type { FeatureAccessMap, FeatureAccessRule } from '@/types';

/** 접근 제어를 걸 수 있는 기능 목록 (확장 가능). */
const FEATURES: { key: string; label: string; path: string }[] = [
  { key: 'wbs', label: 'WBS 작업흐름', path: '/wbs' },
];
const ROLES: { v: string; label: string }[] = [
  { v: 'operator', label: 'operator' },
  { v: 'viewer', label: 'viewer' },
];

export function FeatureAccessManager() {
  const { data: access } = useFeatureAccess();
  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => authApi.listUsers().then((r) => r.data),
  });
  const update = useUpdateFeatureAccess();
  const toast = useToast();
  const [draft, setDraft] = useState<FeatureAccessMap>({});

  useEffect(() => { setDraft(access ?? {}); }, [access]);

  const ruleOf = (k: string): FeatureAccessRule => draft[k] ?? { roles: [], users: [] };
  const setRule = (k: string, patch: Partial<FeatureAccessRule>) =>
    setDraft((d) => ({ ...d, [k]: { ...ruleOf(k), ...patch } }));
  const toggleRole = (k: string, r: string) => {
    const cur = ruleOf(k).roles;
    setRule(k, { roles: cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r] });
  };
  const toggleUser = (k: string, u: string) => {
    const cur = ruleOf(k).users;
    setRule(k, { users: cur.includes(u) ? cur.filter((x) => x !== u) : [...cur, u] });
  };

  const save = () =>
    update.mutate(draft, {
      onSuccess: () => toast.success('접근 제어 저장됨'),
      onError: (e) => toast.error('저장 실패', formatApiError(e)),
    });

  const nonAdmin = users.filter((u) => u.role !== 'admin');

  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-5 h-5 text-primary" />
        <h2 className="text-base font-semibold">기능 접근 제어</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        admin 은 항상 접근 가능합니다. 아래에서 <b>역할 또는 사용자를 하나라도 지정하면</b> 그 대상(+admin)만
        해당 기능을 사용할 수 있고, <b>아무것도 지정하지 않으면 전체 공개</b>됩니다.
      </p>

      {FEATURES.map((f) => {
        const rule = ruleOf(f.key);
        const restricted = rule.roles.length > 0 || rule.users.length > 0;
        return (
          <div key={f.key} className="rounded-lg border border-border p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">{f.label}</span>
              <span className="text-xs text-muted-foreground font-mono">{f.path}</span>
              <span className={`ml-auto inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${
                restricted ? 'bg-amber-500/10 text-amber-600 border-amber-500/30' : 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30'
              }`}>
                <Lock className="w-3 h-3" />{restricted ? '제한됨' : '전체 공개'}
              </span>
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">허용 역할</p>
              <div className="flex flex-wrap gap-1.5">
                {ROLES.map((r) => (
                  <button
                    key={r.v}
                    type="button"
                    onClick={() => toggleRole(f.key, r.v)}
                    className={`px-2.5 py-1 text-sm rounded-lg border transition-colors ${
                      rule.roles.includes(r.v)
                        ? 'bg-primary/10 text-primary border-primary/30'
                        : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5 inline-flex items-center gap-1">
                <UsersIcon className="w-3 h-3" /> 허용 사용자
              </p>
              {nonAdmin.length === 0 ? (
                <p className="text-xs text-muted-foreground/70">등록된 (admin 외) 사용자가 없습니다.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {nonAdmin.map((u) => {
                    const on = rule.users.includes(u.username);
                    return (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => toggleUser(f.key, u.username)}
                        title={`${u.username} · ${u.role}`}
                        className={`px-2.5 py-1 text-sm rounded-lg border transition-colors ${
                          on
                            ? 'bg-primary/10 text-primary border-primary/30'
                            : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {u.displayName || u.username}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={save}
          disabled={update.isPending}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors disabled:opacity-50"
        >
          <Save className="w-4 h-4" /> 저장
        </button>
      </div>
    </div>
  );
}
