import { useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Check, LayoutGrid, Plus, RotateCcw, Save } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { useToast } from '@/components/common';
import { useHomePrefsDefaults, useUpdateHomePrefsDefaults } from '@/hooks/useHomePrefs';
import { sidebarAppSections, topbarAppSections, useInstallableAppText } from '@/components/layout/installableApps';
import { formatApiError } from '@/lib/utils';

/**
 * Settings → 화면 UI 설정 — 사이드바/상단바 **조직 기본 앱 구성**.
 *
 * 개인화하지 않은 계정(home_prefs.installed_apps = 기본값 따름)은 여기서 고른 목록을 그대로 본다.
 * 이미 앱을 직접 추가·제거한 계정은 영향을 받지 않는다 — 각자 "앱 추가" 창의 "기본값으로 초기화"
 * 로 이 구성을 다시 따를 수 있다. 저장은 admin 전용이고 감사 로그에 추가/제거 항목이 남는다.
 * 순서는 고른 순서 그대로 레일/상단바 표시 순서가 된다.
 *
 * R-6 i18n — 앱·섹션 이름은 "앱 추가" 창과 같은 `useInstallableAppText()` 경로(관리자 커스텀 메뉴 이름 우선).
 */
export function DefaultAppsManager() {
  const { t } = useTranslation();
  const { appLabel, sectionLabel } = useInstallableAppText();
  const { data, isLoading } = useHomePrefsDefaults();
  const update = useUpdateHomePrefsDefaults();
  const toast = useToast();

  const sections = useMemo(
    () => [
      ...sidebarAppSections(true).map((s) => ({
        ...s,
        key: `sidebar:${s.sectionId}`,
        heading: t('settings.defaultApps.sidebarSection', { group: sectionLabel(s) }),
      })),
      ...topbarAppSections().map((s) => ({
        ...s,
        key: `topbar:${s.sectionId}`,
        heading: t('settings.defaultApps.topbarSection', { group: sectionLabel(s) }),
      })),
    ],
    [t, sectionLabel],
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
      onSuccess: () => { setDraft(null); toast.success(t('settings.defaultApps.saved')); },
      onError: (e) => toast.error(t('settings.defaultApps.saveFailed'), formatApiError(e)),
    });

  return (
    <MacCard
      title={t('settings.defaultApps.title')}
      icon={LayoutGrid}
      actions={
        <>
          <button
            type="button"
            onClick={() => setDraft(null)}
            disabled={!dirty || update.isPending}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-border text-xs text-muted-foreground hover:bg-secondary disabled:opacity-50"
          >
            <RotateCcw className="w-3.5 h-3.5" aria-hidden />
            {t('settings.defaultApps.revert')}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || update.isPending}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary text-primary-foreground text-xs hover:bg-primary/90 disabled:opacity-50"
          >
            <Save className="w-3.5 h-3.5" aria-hidden />
            {t('settings.defaultApps.save')}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          <Trans i18nKey="settings.defaultApps.intro" components={{ b: <b /> }} />
        </p>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('common.status.loading')}</p>
        ) : (
          sections.map((section) => (
            <div key={section.key}>
              <p className="px-0.5 pb-1.5 text-xs font-medium text-muted-foreground">
                {section.heading}
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
                      {appLabel(app)}
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
