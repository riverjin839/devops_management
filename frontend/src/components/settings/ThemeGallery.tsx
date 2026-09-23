import { Check, Monitor } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { useThemeStore, type Theme } from '@/stores/themeStore';
import { THEME_SWATCH } from '@/lib/themeSwatches';

const GALLERY_ORDER: Theme[] = [
  'light', 'dark', 'system',
  'default', 'comfort', 'burnt-sienna', 'tuscan-sunset', 'electropop',
  'summer-breeze', 'wildflower-meadow', 'tropical-punch',
];

const THEME_LABEL: Record<Theme, string> = {
  default: '코랄', comfort: '컴포트', 'burnt-sienna': '번트 시에나', 'tuscan-sunset': '토스카나 선셋',
  electropop: '일렉트로팝', 'summer-breeze': '서머 브리즈', 'wildflower-meadow': '와일드플라워 메도우',
  'tropical-punch': '트로피컬 펀치', light: '라이트 (기본)', dark: '다크', system: '시스템',
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

/** D-072 — 사용자 메뉴 목록의 1클릭 선택과 별개로, 테마 10종을 한 화면에서 비교하고 고르는 갤러리. */
export function ThemeGallery() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  return (
    <MacCard title="테마 갤러리" bodyPadding="p-4">
      <p className="text-xs text-muted-foreground mb-3">
        미리보기를 클릭하면 바로 적용된다 — 사이드바 사용자 메뉴의 테마 목록과 같은 선택을 공유한다.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
        {GALLERY_ORDER.map((t) => {
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
    </MacCard>
  );
}
