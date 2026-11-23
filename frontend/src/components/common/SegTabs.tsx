import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * 공용 분절 선택기 — 탭·토글 모양을 하나로 맞춘다(K8s 자원 관리에서 승격, K8s 클러스터 허브 탭바도 사용).
 * - `mode="tabs"`: 아래 내용을 통째로 바꾸는 탭(`role="tablist"`/`tab` + `aria-selected`, ←/→ 로 이동).
 * - `mode="toggle"`(기본): 같은 내용의 기준값만 바꾸는 토글(`role="group"` + `aria-pressed`).
 * - 옵션의 3번째 요소(선택)는 그 탭의 설명 — 마우스오버·포커스 툴팁으로 보여 준다.
 */
export function SegTabs<T extends string>({ value, onChange, options, label, mode = 'toggle', size = 'sm', className = '' }: {
  value: T; onChange: (v: T) => void; options: readonly (readonly [T, ReactNode] | readonly [T, ReactNode, string])[];
  label: string; mode?: 'tabs' | 'toggle'; size?: 'sm' | 'md'; className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const isTabs = mode === 'tabs';
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (!isTabs || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End')) return;
    e.preventDefault();
    const n = options.length;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n;
    onChange(options[next][0]);
    refs.current[next]?.focus();
  };
  const pad = size === 'md' ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-xs';
  return (
    <div role={isTabs ? 'tablist' : 'group'} aria-label={label}
      className={`inline-flex rounded-xl border border-border bg-muted/20 p-0.5 ${className}`}>
      {options.map((opt, i) => {
        const [k, l] = opt;
        const hint = opt.length > 2 ? opt[2] : undefined;
        const on = value === k;
        const props = {
          type: 'button' as const,
          ref: (el: HTMLButtonElement | null) => { refs.current[i] = el; },
          role: isTabs ? 'tab' : undefined,
          'aria-selected': isTabs ? on : undefined,
          'aria-pressed': isTabs ? undefined : on,
          tabIndex: isTabs && !on ? -1 : undefined,
          onClick: () => onChange(k),
          onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => onKey(e, i),
          className: `inline-flex items-center gap-1 rounded-lg ${pad} ${on ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`,
        };
        if (!hint) return <button key={k} {...props}>{l}</button>;
        return (
          <Tooltip key={k}>
            <TooltipTrigger {...props}>{l}</TooltipTrigger>
            <TooltipContent className="max-w-[320px]">{hint}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
