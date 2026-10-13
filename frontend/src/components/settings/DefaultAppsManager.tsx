import { useMemo, useState } from 'react';
import { Check, LayoutGrid, Plus, RotateCcw, Save } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { useToast } from '@/components/common';
import { useHomePrefsDefaults, useUpdateHomePrefsDefaults } from '@/hooks/useHomePrefs';
import { sidebarAppSections, topbarAppSections } from '@/components/layout/installableApps';
import { formatApiError } from '@/lib/utils';

/**
 * Settings → 화면 UI 설정 — 사이드바/상단바 **조직 기본 앱 구성**.
 *
 * 개인화하지 않은 계정(home_prefs.installed_apps = 기본값 따름)은 여기서 고른 목록을 그대로 본다.
 * 이미 앱을 직접 추가·제거한 계정은 영향을 받지 않는다 — 각자 "앱 추가" 창의 "기본값으로 초기화"
 * 로 이 구성을 다시 따를 수 있다. 저장은 admin 전용이고 감사 로그에 추가/제거 항목이 남는다.
 * 순서는 고른 순서 그대로 레일/상단바 표시 순서가 된다.
 */
export function DefaultAppsManager() {
  const { data, isLoading } = useHomePrefsDefaults();
  const update = useUpdateHomePrefsDefaults();
  const toast = useToast();

  const sections = useMemo(
    () => [
      ...sidebarAppSections(true).map((s) => ({ ...s, label: `사이드바 · ${s.label}` })),
      ...topbarAppSections().map((s) => ({ ...s, label: `상단바 · ${s.label}` })),
    ],
    [],
  );

  // 편집 중 초안 — 저장/되돌리기 전까지만 존재하고, 없으면 서버 값을 그대로 보여준다.
  const [draft, setDraft] = useState<string[] | null>(null);
  const saved = data?.installedApps ?? [];
  const current = draft ?? saved;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);

  const toggle = (id: string) =>
    setDraft(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);

  const save = () =>
    update.mutate({ installedApps: current }, {
      onSuccess: () => { setDraft(null); toast.success('조직 기본 앱 구성 저장됨'); },
      onError: (e) => toast.error('저장 실패', formatApiError(e)),
    });

  return (
    <MacCard title="기본 앱 구성 (사이드바·상단바)">
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <LayoutGrid className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" aria-hidden />
          <p className="flex-1 text-sm text-muted-foreground">
            앱을 직접 고른 적이 없는 사용자의 사이드바·상단바 구성입니다. 이미 직접 고른 사용자는 바뀌지 않으며,
            각자 "앱 추가" 창의 <b>기본값으로 초기화</b>로 이 구성을 따를 수 있습니다. 고른 순서가 표시 순서입니다.
          </p>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={() => setDraft(null)}
              disabled={!dirty || update.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-border text-xs text-muted-foreground hover:bg-secondary disabled:opacity-50"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden />
              되돌리기
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!dirty || update.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary text-primary-foreground text-xs hover:bg-primary/90 disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" aria-hidden />
              저장
            </button>
          </div>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">불러오는 중…</p>
        ) : (
          sections.map((section) => (
            <div key={section.label}>
              <p className="px-0.5 pb-1.5 text-xs font-medium text-muted-foreground">
                {section.label}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {section.apps.map((app) => {
                  const on = current.includes(app.id);
                  return (
                    <button
                      key={app.id}
                      type="button"
                      onClick={() => toggle(app.id)}
                      aria-pressed={on}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border text-xs transition-colors ${
                        on
                          ? 'border-primary/40 bg-primary/10 text-foreground'
                          : 'border-border text-muted-foreground hover:bg-secondary'
                      }`}
                    >
                      {on ? <Check className="w-3 h-3" aria-hidden /> : <Plus className="w-3 h-3" aria-hidden />}
                      {app.label}
                      {on && <span className="text-[11px] text-muted-foreground">#{current.indexOf(app.id) + 1}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </MacCard>
  );
}
