import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil } from 'lucide-react';
import { useUiSettings, useUpdateUiSettings } from '@/hooks/useUiSettings';
import { InlineEdit } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { NAV_MAP, GROUPS, DEFAULT_TITLE } from '@/components/layout/navConfig';
import { useNavLabel } from '@/i18n/useNavLabel';

/**
 * 사이드바 메뉴 이름 / 앱 타이틀 편집 — 기존 사이드바 오버레이에서 Settings("화면 UI 설정")로 이동.
 * navLabels / appTitle 은 ui_settings(서버)에 저장된다(모든 사용자 공통).
 *
 * R-6 i18n — 표시는 사이드바와 같은 `useNavLabel()` 경로(커스텀 이름 우선, 없으면 `nav.page.*` 번역).
 * 관리자가 입력한 커스텀 이름은 번역하지 않는다. 기본 이름(한국어 원문 또는 지금 언어의 번역)을 그대로
 * 저장하면 오버라이드로 남기지 않는다 — 다른 언어 화면이 그 문자열로 고정되지 않게.
 */
export function NavMenuManager() {
  const { t } = useTranslation();
  const navLabel = useNavLabel();
  const { data: settings } = useUiSettings();
  const updateSettings = useUpdateUiSettings();

  const title = settings?.appTitle || DEFAULT_TITLE;
  const navLabels = useMemo(() => settings?.navLabels || {}, [settings?.navLabels]);

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editingNavPath, setEditingNavPath] = useState<string | null>(null);

  const handleTitleSave = (val: string) => {
    updateSettings.mutate({ appTitle: val || DEFAULT_TITLE, navLabels });
    setIsEditingTitle(false);
  };
  const handleNavSave = (path: string, val: string) => {
    const entry = NAV_MAP[path];
    const isDefault = !!entry && (val === entry.defaultLabel || val === t(`nav.page.${entry.labelKey}`));
    const updated = { ...navLabels, [path]: val };
    if (!val || isDefault) delete updated[path];
    updateSettings.mutate({ appTitle: title, navLabels: updated });
    setEditingNavPath(null);
  };

  return (
    <MacCard title={t('settings.navMenu.title')} bodyPadding="p-0">
      <p className="px-4 py-2 text-xs text-muted-foreground border-b border-border">{t('settings.navMenu.intro')}</p>

      {/* 앱 타이틀 */}
      <div className="px-4 py-3 border-b border-border">
        <p className="text-xs text-muted-foreground mb-1">{t('settings.navMenu.appTitle')}</p>
        {isEditingTitle ? (
          <InlineEdit value={title} onSave={handleTitleSave} onCancel={() => setIsEditingTitle(false)}
            inputClassName="text-sm font-semibold w-full max-w-xs px-1.5 py-0.5 bg-secondary border border-primary rounded" />
        ) : (
          <button onClick={() => setIsEditingTitle(true)} title={t('settings.navMenu.editTitle')}
            className="flex items-center gap-2 px-2 py-1 rounded hover:bg-secondary text-left">
            <span className="font-semibold text-sm truncate">{title}</span>
            <Pencil className="w-3 h-3 text-muted-foreground flex-shrink-0" aria-hidden />
          </button>
        )}
      </div>

      {/* 그룹별 메뉴 항목 */}
      <div className="px-4 py-3 space-y-4">
        {GROUPS.map((g) => {
          const paths = g.paths;
          if (paths.length === 0) return null;
          return (
            <div key={g.id}>
              <p className="px-1 py-1 text-xs font-medium text-muted-foreground">{t(`nav.group.${g.labelKey}`)}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                {paths.map((path) => {
                  const navItem = NAV_MAP[path];
                  if (!navItem) return null;
                  const { icon: Icon } = navItem;
                  const itemLabel = navLabel(path);
                  const isEditing = editingNavPath === path;
                  if (isEditing) {
                    return (
                      <div key={path} className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-secondary/50 border border-primary/30">
                        <Icon className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
                        <InlineEdit value={itemLabel} onSave={(v) => handleNavSave(path, v)} onCancel={() => setEditingNavPath(null)}
                          className="flex-1 min-w-0" inputClassName="text-sm w-full" />
                      </div>
                    );
                  }
                  return (
                    <button key={path} onClick={() => setEditingNavPath(path)}
                      title={t('settings.navMenu.editItem', { label: itemLabel })}
                      className="group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary text-left text-sm">
                      <Icon className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
                      <span className="flex-1 min-w-0 truncate">{itemLabel}</span>
                      <Pencil className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 flex-shrink-0" aria-hidden />
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </MacCard>
  );
}
