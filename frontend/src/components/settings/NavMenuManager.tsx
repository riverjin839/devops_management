import { useMemo, useState } from 'react';
import { Pencil } from 'lucide-react';
import { useUiSettings, useUpdateUiSettings } from '@/hooks/useUiSettings';
import { InlineEdit } from '@/components/common';
import { NAV_MAP, GROUPS, DEFAULT_TITLE } from '@/components/layout/navConfig';

/**
 * 사이드바 메뉴 이름 / 앱 타이틀 편집 — 기존 사이드바 오버레이에서 Settings("화면 UI 설정")로 이동.
 * navLabels / appTitle 은 ui_settings(서버)에 저장된다(모든 사용자 공통).
 */
export function NavMenuManager() {
  const { data: settings } = useUiSettings();
  const updateSettings = useUpdateUiSettings();

  const title = settings?.appTitle || DEFAULT_TITLE;
  const navLabels = useMemo(() => settings?.navLabels || {}, [settings?.navLabels]);
  const getLabel = (path: string) => navLabels[path] || NAV_MAP[path]?.defaultLabel || path;

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editingNavPath, setEditingNavPath] = useState<string | null>(null);

  const handleTitleSave = (val: string) => {
    updateSettings.mutate({ appTitle: val || DEFAULT_TITLE, navLabels });
    setIsEditingTitle(false);
  };
  const handleNavSave = (path: string, val: string) => {
    const updated = { ...navLabels, [path]: val };
    if (!val) delete updated[path];
    updateSettings.mutate({ appTitle: title, navLabels: updated });
    setEditingNavPath(null);
  };

  return (
    <div className="rounded-md border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-muted/40">
        <h3 className="text-sm font-semibold">메뉴 이름 편집</h3>
        <p className="text-xs text-muted-foreground mt-0.5">사이드바 메뉴 이름과 앱 타이틀을 변경합니다. 이름만 바뀌며 모든 사용자에게 적용됩니다.</p>
      </div>

      {/* 앱 타이틀 */}
      <div className="px-4 py-3 border-b border-border">
        <p className="text-xs text-muted-foreground/70 mb-1 uppercase tracking-wider">앱 타이틀</p>
        {isEditingTitle ? (
          <InlineEdit value={title} onSave={handleTitleSave} onCancel={() => setIsEditingTitle(false)}
            inputClassName="text-sm font-semibold w-full max-w-xs px-1.5 py-0.5 bg-secondary border border-primary rounded" />
        ) : (
          <button onClick={() => setIsEditingTitle(true)}
            className="flex items-center gap-2 px-2 py-1 rounded hover:bg-secondary text-left">
            <span className="font-semibold text-sm truncate">{title}</span>
            <Pencil className="w-3 h-3 text-muted-foreground flex-shrink-0" />
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
              <p className="px-1 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">{g.label}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                {paths.map((path) => {
                  const navItem = NAV_MAP[path];
                  if (!navItem) return null;
                  const { icon: Icon } = navItem;
                  const itemLabel = getLabel(path);
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
                      className="group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary text-left text-sm">
                      <Icon className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
                      <span className="flex-1 min-w-0 truncate">{itemLabel}</span>
                      <Pencil className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 flex-shrink-0" />
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
