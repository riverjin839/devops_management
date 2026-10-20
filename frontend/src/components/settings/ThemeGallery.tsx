import { Check, Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MacCard } from '@/components/ui/MacCard';
import { useThemeStore, accentApplies, ACCENTS, THEMES, type Theme } from '@/stores/themeStore';
import { THEME_SWATCH, ACCENT_SWATCH } from '@/lib/themeSwatches';

/** 테마 하나의 미리보기 카드 — 실제 전환 없이 배경/카드/버튼 색을 그대로 보여준다. */
function PreviewChip({ theme }: { theme: Theme }) {
  const swatch = THEME_SWATCH[theme];
  if (!swatch) {
    // system — OS 설정을 따라가 고정 색이 없다.
    return (
      <div className="w-full h-14 rounded-md border border-border bg-muted flex items-center justify-center">
        <Monitor className="w-5 h-5 text-muted-foreground" />
      </div>
    );
  }
  return (
    <div
      className="w-full h-14 rounded-md border border-border p-1.5 flex flex-col gap-1"
      style={{ backgroundColor: `hsl(${swatch.bg})` }}
    >
      <div className="w-2/3 h-2 rounded-full" style={{ backgroundColor: `hsl(${swatch.secondary})` }} />
      <div className="w-1/3 h-2 rounded-full" style={{ backgroundColor: `hsl(${swatch.primary})` }} />
    </div>
  );
}

/** D-072 / P2 — 바탕 테마(4+시스템)와 강조색(6)을 한 화면에서 비교하고 고르는 갤러리. */
export function ThemeGallery() {
  const { t } = useTranslation();
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const accent = useThemeStore((s) => s.accent);
  const setAccent = useThemeStore((s) => s.setAccent);
  const accentOn = accentApplies(theme);

  return (
    <MacCard title={t('theme.gallery.title')} bodyPadding="p-4">
      <p className="text-xs text-muted-foreground mb-3">
        {t('theme.gallery.intro')}
      </p>
      <p className="text-xs font-medium text-muted-foreground mb-1.5">{t('theme.gallery.background')}</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
        {THEMES.map((th) => {
          const active = theme === th;
          const name = t(`shell.theme.${th}`);
          return (
            <button
              key={th}
              type="button"
              onClick={() => setTheme(th)}
              aria-pressed={active}
              title={t('theme.switchTo', { name })}
              className={`relative rounded-lg border p-1.5 text-left transition-colors ${
                active ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-primary/50'
              }`}
            >
              <PreviewChip theme={th} />
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-xs font-medium truncate">{name}</span>
                {active && <Check className="w-3.5 h-3.5 text-primary flex-shrink-0" aria-hidden="true" />}
              </div>
            </button>
          );
        })}
      </div>

      <p className="text-xs font-medium text-muted-foreground mt-4 mb-1.5">{t('shell.user.accent')}</p>
      <p className="text-xs text-muted-foreground mb-2">
        {t('theme.gallery.accentIntro')}
      </p>
      <div className="flex flex-wrap gap-3" role="radiogroup" aria-label={t('shell.user.accent')}>
        {ACCENTS.map((a) => {
          const active = accent === a;
          const name = t(`shell.accent.${a}`);
          return (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={!accentOn}
              onClick={() => setAccent(a)}
              title={accentOn ? t('theme.accentOption', { name }) : t('shell.user.accentDisabledHint')}
              className="flex flex-col items-center gap-1 rounded-xl p-1 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span
                className={`w-8 h-8 rounded-full ring-offset-2 ring-offset-card ${active ? 'ring-2 ring-foreground' : 'ring-1 ring-border'}`}
                style={{ backgroundColor: `hsl(${ACCENT_SWATCH[a]})` }}
                aria-hidden="true"
              />
              <span className={`text-xs ${active ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>{name}</span>
            </button>
          );
        })}
      </div>
    </MacCard>
  );
}
