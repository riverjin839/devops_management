import { useEffect, useMemo, useState } from 'react';
import { Loader2, Save, Plus, Trash2, RotateCcw, Megaphone, Monitor } from 'lucide-react';
import {
  useTerminalAppearance,
  useUpdateTerminalAppearance,
  useUpdateSharedTemplates,
} from '@/hooks/useTerminalAppearance';
import { useAuthStore } from '@/stores/authStore';
import {
  BUILTIN_TEMPLATES,
  DEFAULT_APPEARANCE,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  PALETTE_KEYS,
  PALETTE_LABELS,
  TERMINAL_FONT_OPTIONS,
  resolveProfileTheme,
} from '@/lib/terminalThemes';
import type {
  TerminalAppearance,
  TerminalEnv,
  TerminalMode,
  TerminalPalette,
  TerminalProfile,
  TerminalTemplate,
} from '@/types';

function ThemePreview({ palette, fontSize, fontFamily }: { palette: TerminalPalette; fontSize: number; fontFamily: string }) {
  const bg = palette.bg || 'hsl(var(--background))';
  const fg = palette.fg || 'hsl(var(--foreground))';
  return (
    <pre
      className="rounded-md border border-border p-2.5 overflow-auto leading-relaxed"
      style={{ backgroundColor: bg, color: fg, fontSize: `${fontSize}px`, fontFamily: fontFamily || 'ui-monospace, monospace' }}
    >
      <div><span style={{ color: palette.muted }}>2026-06-17 09:00:01</span> <span style={{ color: palette.sky }}>INFO</span> server <span style={{ color: palette.cyan }}>/var/log/app</span> started</div>
      <div><span style={{ color: palette.muted }}>2026-06-17 09:00:02</span> <span style={{ color: palette.green }}>READY</span> nodes=<span style={{ color: palette.amber }}>3</span> ip=<span style={{ color: palette.sky }}>10.0.0.42</span></div>
      <div><span style={{ color: palette.muted }}>2026-06-17 09:00:03</span> <span style={{ color: palette.amber }}>WARN</span> retry <span style={{ color: palette.purple }}>a1b2c3d4-5e6f</span></div>
      <div><span style={{ color: palette.muted }}>2026-06-17 09:00:04</span> <span style={{ color: palette.red }}>ERROR</span> connection <span style={{ color: palette.red }}>REFUSED</span> (500)</div>
    </pre>
  );
}

function ProfileEditor({
  env, profile, custom, shared, onChange,
}: {
  env: TerminalEnv;
  profile: TerminalProfile;
  custom: TerminalTemplate[];
  shared: TerminalTemplate[];
  onChange: (p: TerminalProfile) => void;
}) {
  const allTemplates = [...BUILTIN_TEMPLATES, ...shared, ...custom];
  const groups = Array.from(new Set(allTemplates.map((t) => t.group)));
  const { palette, fontSize, fontFamily } = resolveProfileTheme(profile, custom, shared);

  const setColor = (key: keyof TerminalPalette, value: string | null) => {
    const colors = { ...(profile.colors ?? {}) };
    if (value === null) delete colors[key];
    else colors[key] = value;
    onChange({ ...profile, colors });
  };

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-3 py-2 border-b border-border bg-muted/40 flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${env === 'ops' ? 'bg-red-500' : 'bg-blue-500'}`} />
        <h4 className="text-sm font-semibold">{env === 'ops' ? '운영 (Production)' : '개발 (Dev)'} 프로파일</h4>
      </div>
      <div className="p-3 space-y-3">
        <ThemePreview palette={palette} fontSize={fontSize} fontFamily={fontFamily} />

        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-muted-foreground">
            색상 템플릿
            <select
              value={profile.templateId}
              onChange={(e) => onChange({ ...profile, templateId: e.target.value })}
              className="mt-1 w-full px-2 py-1.5 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {allTemplates.filter((t) => t.group === g).map((t) => (
                    <option key={t.id || 'default'} value={t.id}>{t.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted-foreground">
            글꼴
            <select
              value={profile.fontFamily}
              onChange={(e) => onChange({ ...profile, fontFamily: e.target.value })}
              className="mt-1 w-full px-2 py-1.5 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {TERMINAL_FONT_OPTIONS.map((o) => <option key={o.label} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>

        <label className="block text-xs text-muted-foreground">
          글꼴 크기: <span className="text-foreground font-mono">{fontSize}px</span>
          <input
            type="range" min={FONT_SIZE_MIN} max={FONT_SIZE_MAX} value={fontSize}
            onChange={(e) => onChange({ ...profile, fontSize: Number(e.target.value) })}
            className="mt-1 w-full accent-primary"
          />
        </label>

        <div>
          <p className="text-xs text-muted-foreground mb-1.5">색상 개별 조정 (템플릿 위에 덮어쓰기)</p>
          <div className="grid grid-cols-2 gap-1.5">
            {PALETTE_KEYS.map((key) => {
              const overridden = profile.colors?.[key] !== undefined;
              const eff = palette[key];
              const hex = /^#([0-9a-fA-F]{6})$/.test(eff) ? eff : '#888888';
              return (
                <div key={key} className="flex items-center gap-1.5">
                  <input
                    type="color" value={hex}
                    onChange={(e) => setColor(key, e.target.value)}
                    className="w-6 h-6 rounded border border-border bg-transparent p-0 cursor-pointer shrink-0"
                  />
                  <span className="text-[11px] text-muted-foreground truncate flex-1" title={PALETTE_LABELS[key]}>{PALETTE_LABELS[key]}</span>
                  {overridden && (
                    <button onClick={() => setColor(key, null)} title="기본값으로" className="p-0.5 rounded hover:bg-secondary text-muted-foreground">
                      <RotateCcw className="w-3 h-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export function TerminalAppearanceSettings() {
  const { data, isLoading } = useTerminalAppearance();
  const saveMut = useUpdateTerminalAppearance();
  const sharedMut = useUpdateSharedTemplates();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');

  const [draft, setDraft] = useState<TerminalAppearance>(DEFAULT_APPEARANCE);
  const [newTplName, setNewTplName] = useState('');
  const [newTplFrom, setNewTplFrom] = useState<TerminalEnv>('dev');

  const shared = useMemo<TerminalTemplate[]>(() => data?.shared ?? [], [data]);

  useEffect(() => {
    if (data?.appearance) setDraft(data.appearance);
  }, [data]);

  if (isLoading) {
    return <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> 불러오는 중…</div>;
  }

  const setProfile = (env: TerminalEnv, p: TerminalProfile) =>
    setDraft((d) => ({ ...d, profiles: { ...d.profiles, [env]: p } }));

  const addCustomTemplate = () => {
    const name = newTplName.trim() || '내 템플릿';
    const { palette } = resolveProfileTheme(draft.profiles[newTplFrom], draft.customTemplates, shared);
    const id = `custom-${Date.now()}`;
    setDraft((d) => ({
      ...d,
      customTemplates: [...d.customTemplates, { id, name, group: '내 템플릿', palette }],
    }));
    setNewTplName('');
  };
  const removeCustomTemplate = (id: string) =>
    setDraft((d) => ({ ...d, customTemplates: d.customTemplates.filter((t) => t.id !== id) }));

  return (
    <div className="rounded-md border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-muted/40 flex items-center gap-2">
        <Monitor className="w-4 h-4 text-primary" />
        <div>
          <h3 className="text-sm font-semibold">터미널 / 로그 화면 색상 (Appearance)</h3>
          <p className="text-xs text-muted-foreground mt-0.5">mc 클라이언트 등 모든 로그 출력 화면에 적용 · PuTTY/SecureCRT/Tera Term 스타일 템플릿 · 개발/운영 구분</p>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* 적용 기준 */}
        <div>
          <p className="text-xs text-muted-foreground mb-1">적용 기준</p>
          <div className="inline-flex items-center bg-secondary/60 rounded-md p-[2px] gap-px text-sm">
            {(['auto', 'dev', 'ops'] as TerminalMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setDraft((d) => ({ ...d, mode: m }))}
                className={`px-3 py-1 rounded font-medium transition-colors ${
                  draft.mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground/70 hover:text-foreground'
                }`}
              >
                {m === 'auto' ? '자동 (클러스터 운영등급)' : m === 'dev' ? '항상 개발' : '항상 운영'}
              </button>
            ))}
          </div>
        </div>

        {/* 프로파일 2종 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <ProfileEditor env="dev" profile={draft.profiles.dev} custom={draft.customTemplates} shared={shared} onChange={(p) => setProfile('dev', p)} />
          <ProfileEditor env="ops" profile={draft.profiles.ops} custom={draft.customTemplates} shared={shared} onChange={(p) => setProfile('ops', p)} />
        </div>

        {/* 커스텀 템플릿 */}
        <div className="rounded-lg border border-border p-3 space-y-2">
          <p className="text-xs font-semibold">내 커스텀 템플릿</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {draft.customTemplates.length === 0 && <span className="text-xs text-muted-foreground">아직 없습니다. 현재 프로파일 색상을 저장해 보세요.</span>}
            {draft.customTemplates.map((t) => (
              <span key={t.id} className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-border bg-secondary">
                <span className="w-3 h-3 rounded-sm border border-border" style={{ backgroundColor: t.palette.bg || '#888' }} />
                {t.name}
                {isAdmin && (
                  <button
                    onClick={() => sharedMut.mutate([...shared.filter((s) => s.id !== t.id), { ...t, group: '공용' }])}
                    title="공용으로 배포"
                    className="p-0.5 rounded hover:bg-background text-sky-500"
                  >
                    <Megaphone className="w-3 h-3" />
                  </button>
                )}
                <button onClick={() => removeCustomTemplate(t.id)} className="p-0.5 rounded hover:bg-background text-muted-foreground"><Trash2 className="w-3 h-3" /></button>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              value={newTplName} onChange={(e) => setNewTplName(e.target.value)}
              placeholder="새 템플릿 이름"
              className="w-40 px-2 py-1 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <select value={newTplFrom} onChange={(e) => setNewTplFrom(e.target.value as TerminalEnv)}
              className="px-2 py-1 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary">
              <option value="dev">개발 색상에서</option>
              <option value="ops">운영 색상에서</option>
            </select>
            <button onClick={addCustomTemplate} className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border bg-secondary hover:bg-secondary/80">
              <Plus className="w-3 h-3" /> 현재 색상 저장
            </button>
          </div>
          {isAdmin && shared.length > 0 && (
            <div className="pt-1.5 border-t border-border">
              <p className="text-[11px] text-muted-foreground mb-1">공용 배포된 템플릿 (admin)</p>
              <div className="flex flex-wrap gap-1.5">
                {shared.map((t) => (
                  <span key={t.id} className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-sky-500/30 bg-sky-500/5">
                    <span className="w-3 h-3 rounded-sm border border-border" style={{ backgroundColor: t.palette.bg || '#888' }} />
                    {t.name}
                    <button onClick={() => sharedMut.mutate(shared.filter((s) => s.id !== t.id))} className="p-0.5 rounded hover:bg-background text-muted-foreground"><Trash2 className="w-3 h-3" /></button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-1 border-t border-border">
          <button
            onClick={() => setDraft(DEFAULT_APPEARANCE)}
            className="px-3 py-1.5 text-sm rounded-lg border border-border bg-secondary hover:bg-secondary/80"
          >
            기본값으로 초기화
          </button>
          <button
            onClick={() => saveMut.mutate(draft)}
            disabled={saveMut.isPending}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg disabled:opacity-50"
          >
            {saveMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} 저장
          </button>
        </div>
      </div>
    </div>
  );
}
