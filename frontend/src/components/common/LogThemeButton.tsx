import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Palette, Minus, Plus } from 'lucide-react';
import {
  useTerminalAppearance,
  useUpdateTerminalAppearance,
} from '@/hooks/useTerminalAppearance';
import { useTerminalEnvStore } from '@/stores/terminalEnvStore';
import {
  BUILTIN_TEMPLATES,
  DEFAULT_APPEARANCE,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  resolveActiveEnv,
} from '@/lib/terminalThemes';
import type { TerminalAppearance, TerminalEnv, TerminalMode, TerminalTemplate } from '@/types';

/** LogViewer 툴바의 빠른 Appearance 전환 버튼(기어). 전역 개인 설정을 수정한다. */
export function LogThemeButton() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  // 패널을 document.body 로 portal 렌더(fixed)한다. LogViewer 루트가 `overflow-hidden`
  // 이라 inline absolute 패널이 잘리던 버그를 회피 — SearchableSelect(menuPortal) 와 동일 패턴.
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const { data } = useTerminalAppearance();
  const saveMut = useUpdateTerminalAppearance();
  const currentEnv = useTerminalEnvStore((s) => s.currentEnv);

  // 열릴 때 버튼 위치를 측정해 fixed 앵커링(스크롤/리사이즈 추적)
  useEffect(() => {
    if (!open) { setPos(null); return; }
    const update = () => {
      const el = btnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // 버튼 우측 정렬 · 바로 아래에 패널을 띄운다
      setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  const appearance: TerminalAppearance = data?.appearance ?? DEFAULT_APPEARANCE;
  const shared: TerminalTemplate[] = data?.shared ?? [];
  const env: TerminalEnv = resolveActiveEnv(appearance, currentEnv);
  const profile = appearance.profiles[env];

  const allTemplates = [...BUILTIN_TEMPLATES, ...shared, ...(appearance.customTemplates ?? [])];
  const groups = Array.from(new Set(allTemplates.map((t) => t.group)));

  const patch = (next: Partial<TerminalAppearance>) => {
    saveMut.mutate({ ...appearance, ...next });
  };
  const patchProfile = (changes: Partial<typeof profile>) => {
    patch({
      profiles: { ...appearance.profiles, [env]: { ...profile, ...changes } },
    });
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        title="화면 색상/글꼴 (Appearance)"
        aria-label="화면 색상/글꼴 (Appearance)"
        className={`p-1 rounded hover:bg-secondary ${open ? 'text-primary' : 'text-muted-foreground'}`}
      >
        <Palette className="w-3 h-3" />
      </button>

      {open && pos && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            style={{ position: 'fixed', top: pos.top, right: pos.right }}
            className="z-50 w-64 max-h-[80vh] overflow-y-auto rounded-lg border border-border bg-card shadow-lg p-3 space-y-3 text-xs"
          >
            {/* mode */}
            <div>
              <p className="text-muted-foreground mb-1">적용 기준</p>
              <div className="flex items-center bg-secondary/60 rounded-md p-[2px] gap-px">
                {(['auto', 'dev', 'ops'] as TerminalMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => patch({ mode: m })}
                    className={`flex-1 px-2 py-1 rounded font-medium transition-colors ${
                      appearance.mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground/70 hover:text-foreground'
                    }`}
                  >
                    {m === 'auto' ? '자동' : m === 'dev' ? '개발' : '운영'}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                현재 적용 프로파일: <span className="text-foreground font-medium">{env === 'ops' ? '운영' : '개발'}</span>
                {appearance.mode === 'auto' && ' (클러스터 운영등급 기준)'}
              </p>
            </div>

            {/* template */}
            <div>
              <p className="text-muted-foreground mb-1">색상 템플릿</p>
              <select
                value={profile.templateId}
                onChange={(e) => patchProfile({ templateId: e.target.value })}
                className="w-full px-2 py-1.5 bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {groups.map((g) => (
                  <optgroup key={g} label={g}>
                    {allTemplates.filter((t) => t.group === g).map((t) => (
                      <option key={t.id || 'default'} value={t.id}>{t.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            {/* font size */}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">글꼴 크기</span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => patchProfile({ fontSize: Math.max(FONT_SIZE_MIN, profile.fontSize - 1) })}
                  aria-label="글꼴 크기 줄이기"
                  className="p-1 rounded border border-border bg-secondary hover:bg-secondary/70"
                >
                  <Minus className="w-3 h-3" />
                </button>
                <span className="w-9 text-center font-mono text-foreground">{profile.fontSize}px</span>
                <button
                  onClick={() => patchProfile({ fontSize: Math.min(FONT_SIZE_MAX, profile.fontSize + 1) })}
                  aria-label="글꼴 크기 키우기"
                  className="p-1 rounded border border-border bg-secondary hover:bg-secondary/70"
                >
                  <Plus className="w-3 h-3" />
                </button>
              </div>
            </div>

            <p className="text-[10px] text-muted-foreground border-t border-border pt-2">
              세부 색상·커스텀 템플릿·공용 배포는 <span className="text-foreground">설정 → 화면 UI 설정</span> 에서.
            </p>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
