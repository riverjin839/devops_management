import { Check, Monitor } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { useThemeStore, accentApplies, ACCENTS, THEMES, type Theme } from '@/stores/themeStore';
import { THEME_SWATCH, ACCENT_SWATCH, ACCENT_LABEL } from '@/lib/themeSwatches';

const THEME_LABEL: Record<Theme, string> = {
  light: '라이트 (기본)', dark: '다크', comfort: '컴포트', 'high-contrast': '고대비',
  umber: '움버', 'umber-light': '움버 라이트', plaster: '플래스터',
  journal: '저널', relief: '릴리프', harlequin: '할리퀸', system: '시스템',
};

/** 테마 하나의 미리보기 카드 — 실제 전환 없이 배경/카드/버튼 색을 그대로 보여준다. */
function PreviewChip({ theme }: { theme: Theme }) {
  const swatch = THEME_SWATCH[theme];
  if (!swatch) {
    // system — OS 설정을 따라가 고정 색이 없다.
    return (
      <div className="w-full h-14 rounded-md border border-border bg-gradient-to-br from-muted to-foreground/10 flex items-center justify-center">
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
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const accent = useThemeStore((s) => s.accent);
  const setAccent = useThemeStore((s) => s.setAccent);
  const accentOn = accentApplies(theme);

  return (
    <MacCard title="테마 갤러리" bodyPadding="p-4">
      <p className="text-xs text-muted-foreground mb-3">
        미리보기를 클릭하면 바로 적용된다 — 사이드바 사용자 메뉴의 테마·강조색 목록과 같은 선택을 공유한다.
      </p>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">바탕</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
        {THEMES.map((t) => {
          const active = theme === t;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTheme(t)}
              aria-pressed={active}
              title={`${THEME_LABEL[t]} 테마로 변경`}
              className={`relative rounded-lg border p-1.5 text-left transition-colors ${
                active ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-primary/50'
              }`}
            >
              <PreviewChip theme={t} />
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-xs font-medium truncate">{THEME_LABEL[t]}</span>
                {active && <Check className="w-3.5 h-3.5 text-primary flex-shrink-0" aria-hidden="true" />}
              </div>
            </button>
          );
        })}
      </div>

      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mt-4 mb-1.5">강조색</p>
      <p className="text-xs text-muted-foreground mb-2">
        버튼·링크·선택 탭·활성 메뉴에만 쓰인다. 라이트·다크(시스템 포함) 바탕에 적용되고, 컴포트·고대비와 그림 테마(움버·플래스터·저널·릴리프·할리퀸)는 자체 색을 쓴다.
      </p>
      <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="강조색">
        {ACCENTS.map((a) => {
          const active = accent === a;
          return (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={!accentOn}
              onClick={() => setAccent(a)}
              title={accentOn ? `강조색 ${ACCENT_LABEL[a]}` : '그림 테마(움버·플래스터·저널·릴리프·할리퀸)와 컴포트·고대비 바탕은 자체 색을 써서 강조색을 바꿀 수 없다'}
              className="flex flex-col items-center gap-1 rounded-xl p-1 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span
                className={`w-8 h-8 rounded-full ring-offset-2 ring-offset-card ${active ? 'ring-2 ring-foreground' : 'ring-1 ring-border'}`}
                style={{ backgroundColor: `hsl(${ACCENT_SWATCH[a]})` }}
                aria-hidden="true"
              />
              <span className={`text-xs ${active ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>{ACCENT_LABEL[a]}</span>
            </button>
          );
        })}
      </div>
    </MacCard>
  );
}
