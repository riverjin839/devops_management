import React, { useState, useRef, useEffect } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { useTableViewStore, TS, TableStyleConfig } from '@/stores/tableViewStore';

// ── Types ──────────────────────────────────────────────────────────────────────
export interface ViewModeOption {
  id: string;
  label: string;
  icon?: React.ReactNode;
}

interface ViewModeBarProps {
  modes: ViewModeOption[];
  active: string;
  onChange: (id: string) => void;
  showStylePanel?: boolean;
  className?: string;
}

// ── Internal sub-components ────────────────────────────────────────────────────
function StyleRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground/70 w-9 flex-shrink-0 leading-none">{label}</span>
      {children}
    </div>
  );
}

function PillGroup({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center rounded-md bg-secondary/70 p-0.5 gap-px">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-2 py-[3px] text-xs font-medium rounded transition-all duration-100 leading-none ${
            value === o.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground/60 hover:text-muted-foreground'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function MiniToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="flex items-center gap-1.5 group select-none"
    >
      <div
        className={`relative flex-shrink-0 w-7 h-[15px] rounded-full transition-colors duration-150 ${
          checked ? 'bg-primary' : 'bg-border'
        }`}
      >
        <div
          className={`absolute top-[1.5px] w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-150 ${
            checked ? 'translate-x-[13px]' : 'translate-x-[1.5px]'
          }`}
        />
      </div>
      <span className="text-xs text-muted-foreground/70 group-hover:text-muted-foreground transition-colors leading-none">
        {label}
      </span>
    </button>
  );
}

const HEADER_SWATCHES = [
  { value: 'default', color: 'bg-slate-400',   title: '기본' },
  { value: 'blue',    color: 'bg-blue-400',    title: '파랑' },
  { value: 'indigo',  color: 'bg-indigo-400',  title: '인디고' },
  { value: 'emerald', color: 'bg-emerald-400', title: '초록' },
] as const;

// ── Style panel (popover) ──────────────────────────────────────────────────────
function StylePanel({ style, patchStyle }: {
  style: TableStyleConfig;
  patchStyle: (p: Partial<TableStyleConfig>) => void;
}) {
  return (
    <div className="px-3 py-3 space-y-2.5">
      <StyleRow label="크기">
        <PillGroup
          options={[{ value: 'xs', label: 'XS' }, { value: 'sm', label: 'SM' }, { value: 'base', label: 'MD' }]}
          value={style.fontSize}
          onChange={(v) => patchStyle({ fontSize: v as TableStyleConfig['fontSize'] })}
        />
      </StyleRow>

      <StyleRow label="밀도">
        <PillGroup
          options={[
            { value: 'compact',     label: '좁게' },
            { value: 'normal',      label: '보통' },
            { value: 'comfortable', label: '넓게' },
          ]}
          value={style.density}
          onChange={(v) => patchStyle({ density: v as TableStyleConfig['density'] })}
        />
      </StyleRow>

      <StyleRow label="선">
        <PillGroup
          options={[
            { value: 'none',   label: '없음' },
            { value: 'light',  label: '얇게' },
            { value: 'medium', label: '보통' },
          ]}
          value={style.border}
          onChange={(v) => patchStyle({ border: v as TableStyleConfig['border'] })}
        />
      </StyleRow>

      <StyleRow label="헤더">
        <div className="flex items-center gap-2">
          {HEADER_SWATCHES.map((s) => (
            <button
              key={s.value}
              title={s.title}
              aria-label={s.title}
              onClick={() => patchStyle({ headerTheme: s.value })}
              className={`w-[18px] h-[18px] rounded-full transition-all duration-100 ${s.color} ${
                style.headerTheme === s.value
                  ? 'ring-2 ring-primary ring-offset-[2px] ring-offset-card scale-110'
                  : 'opacity-50 hover:opacity-80 hover:scale-105'
              }`}
            />
          ))}
        </div>
      </StyleRow>

      <div className="pt-2 border-t border-border/25 flex items-center gap-4">
        <MiniToggle label="교차행" checked={style.altRow}   onChange={(v) => patchStyle({ altRow: v })} />
        <MiniToggle label="고정폭" checked={style.monoFont} onChange={(v) => patchStyle({ monoFont: v })} />
      </div>
    </div>
  );
}

// ── ViewModeBar (main export) ──────────────────────────────────────────────────
export function ViewModeBar({
  modes,
  active,
  onChange,
  showStylePanel = true,
  className = '',
}: ViewModeBarProps) {
  const [open, setOpen] = useState(false);
  const { style, patchStyle } = useTableViewStore();
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef   = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        !panelRef.current?.contains(e.target as Node) &&
        !btnRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className={`flex items-center gap-1 ${className}`}>
      {/* ── Segmented view toggle ── */}
      <div className="flex items-center bg-secondary/60 backdrop-blur-sm rounded-lg p-[3px] gap-px">
        {modes.map((mode) => (
          <button
            key={mode.id}
            onClick={() => onChange(mode.id)}
            title={mode.label}
            className={`flex items-center gap-1.5 px-2.5 py-[5px] text-sm font-medium rounded-md transition-all duration-150 whitespace-nowrap ${
              active === mode.id
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground/70 hover:text-foreground'
            }`}
          >
            {mode.icon}
            <span>{mode.label}</span>
          </button>
        ))}
      </div>

      {/* ── Style panel trigger ── */}
      {showStylePanel && (
        <div className="relative">
          <button
            ref={btnRef}
            onClick={() => setOpen((v) => !v)}
            title="표 스타일 설정"
            aria-label="표 스타일 설정"
            className={`p-[6px] rounded-lg border transition-all duration-150 ${
              open
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-transparent text-muted-foreground/60 hover:text-foreground hover:border-border/60 hover:bg-secondary/70'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
          </button>

          {/* ── Popover ── */}
          {open && (
            <div
              ref={panelRef}
              className="absolute right-0 top-full mt-1.5 z-50 w-56 bg-card border border-border/50 rounded-xl shadow-2xl overflow-hidden"
              style={{ boxShadow: '0 8px 32px rgba(0,0,0,0.35), 0 1px 0 rgba(255,255,255,0.05)' }}
            >
              {/* header */}
              <div className="px-3 py-2 border-b border-border/25 flex items-center justify-between">
                <span className="text-xs font-semibold tracking-widest uppercase text-muted-foreground/60">
                  표 스타일
                </span>
                <div className="flex items-center gap-1 text-muted-foreground">
                  {/* live preview dot — matches active headerTheme */}
                  <div
                    className={`w-2 h-2 rounded-full ${
                      style.headerTheme === 'blue'
                        ? 'bg-blue-400'
                        : style.headerTheme === 'indigo'
                        ? 'bg-indigo-400'
                        : style.headerTheme === 'emerald'
                        ? 'bg-emerald-400'
                        : 'bg-slate-400'
                    }`}
                  />
                  <span className="text-xs font-mono">
                    {style.fontSize}/{style.density[0]}
                  </span>
                </div>
              </div>

              <StylePanel style={style} patchStyle={patchStyle} />

              {/* Reset */}
              <div className="px-3 pb-2.5">
                <button
                  onClick={() => {
                    patchStyle({
                      fontSize: 'sm',
                      density: 'normal',
                      border: 'light',
                      headerTheme: 'default',
                      altRow: false,
                      monoFont: false,
                    });
                  }}
                  className="w-full text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors text-center py-1"
                >
                  기본값으로 재설정
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Re-export TS so pages can import from one place ───────────────────────────
export { TS };
