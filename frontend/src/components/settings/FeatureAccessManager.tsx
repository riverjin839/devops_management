import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, EyeOff, Save, Lock, Users as UsersIcon } from 'lucide-react';
import { authApi } from '@/services/api';
import { useFeatureAccess, useUpdateFeatureAccess } from '@/hooks/useFeatureAccess';
import { useNavCatalog } from '@/hooks/useNavCatalog';
import { ScreenCatalogList, useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import type { FeatureAccessMap, FeatureAccessRule } from '@/types';

/** 화면별 노출 토글 대상에서 제외 — 자기 자신이거나 이미 다른 방식(RequireAdmin)으로
 *  admin 전용인 화면. 여기 포함해도 동작엔 영향 없지만(admin 전용은 어차피 non-admin 이
 *  못 들어감) 토글해도 아무 효과가 없어 혼란만 준다. */
const SCREEN_ACCESS_EXCLUDED = new Set(['/', '/island', '/settings', '/daily-check/settings']);

/** 세부 역할/사용자 제한(고급)을 걸 수 있는 기능 목록 (확장 가능). */
const FEATURES: { key: string; label: string; path: string }[] = [
  { key: '/wbs', label: 'WBS 작업흐름', path: '/wbs' },
];
const ROLES: { v: string; label: string }[] = [
  { v: 'operator', label: 'operator' },
  { v: 'viewer', label: 'viewer' },
];

export function FeatureAccessManager() {
  const { data: access } = useFeatureAccess();
  const { getLabel } = useNavCatalog();
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

  /** 화면 노출 on/off — 끄면 admin 외 전체 차단(roles/users 세부 제한과 무관하게 최우선).
   *  다시 켜면 enabled 플래그만 지우고, roles/users 도 비어있으면 키 자체를 지워 payload 를
   *  "설정 없음 = 기본 열림" 상태로 되돌린다. */
  const toggleScreenDisabled = (path: string) => {
    const rule = ruleOf(path);
    if (rule.enabled === false) {
      setDraft((d) => {
        const next = { ...d };
        if (!rule.roles.length && !rule.users.length) {
          delete next[path];
        } else {
          next[path] = { roles: rule.roles, users: rule.users };
        }
        return next;
      });
    } else {
      setRule(path, { enabled: false });
    }
  };

  const save = () =>
    update.mutate(draft, {
      onSuccess: () => toast.success('접근 제어 저장됨'),
      onError: (e) => toast.error('저장 실패', formatApiError(e)),
    });

  const nonAdmin = users.filter((u) => u.role !== 'admin');
  const disabledCount = Object.values(draft).filter((r) => r.enabled === false).length;

  return (
    <div className="space-y-4">
      {/* ── 화면별 노출 — 단순 on/off ──────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-3">
        <div className="flex items-center gap-2">
          <EyeOff className="w-5 h-5 text-primary" />
          <h2 className="text-base font-semibold">화면별 노출</h2>
          {disabledCount > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-status-warning-soft text-status-warning">
              비활성화 {disabledCount}개
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          admin 은 항상 모든 화면에 접근할 수 있습니다. <b>비활성화</b>로 체크한 화면은
          일반 사용자(operator·viewer)의 사이드바 메뉴·Your Island 화면 추가 목록에서 사라지고,
          주소를 직접 입력해도 홈으로 돌아갑니다. 기본값은 <b>열림</b>입니다.
        </p>
        <ScreenCatalogList
          filter={(path) => !SCREEN_ACCESS_EXCLUDED.has(path)}
          searchPlaceholder="화면 이름으로 검색"
          maxHeight="50vh"
          renderTrailing={(path) => {
            const rule = ruleOf(path);
            const disabled = rule.enabled === false;
            const roleRestricted = !disabled && (rule.roles.length > 0 || rule.users.length > 0);
            return (
              <span className="flex items-center gap-2 flex-shrink-0">
                {roleRestricted && (
                  <span className="px-1.5 py-0.5 text-[11px] rounded-full border bg-amber-500/10 text-amber-600 border-amber-500/30 whitespace-nowrap">
                    역할 제한
                  </span>
                )}
                <label
                  className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={disabled}
                    onChange={() => toggleScreenDisabled(path)}
                    aria-label={`${getLabel(path)} 비활성화`}
                    className="w-4 h-4 rounded border-border accent-primary"
                  />
                  비활성화
                </label>
              </span>
            );
          }}
        />
      </div>

      {/* ── 세부 역할/사용자 제한 (고급) ───────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-primary" />
          <h2 className="text-base font-semibold">세부 역할 제한 (고급)</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          특정 역할·사용자에게만 열어주고 싶은 화면은 여기서 지정합니다. <b>역할 또는 사용자를
          하나라도 지정하면</b> 그 대상(+admin)만 접근할 수 있고, <b>아무것도 지정하지 않으면
          위 "화면별 노출" 설정을 따릅니다</b>(기본 열림).
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
      </div>

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
