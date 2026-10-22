import { type ComponentType, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

type StatTone = 'neutral' | 'info' | 'warning' | 'critical';

interface StatTileProps {
  label: string;
  value: ReactNode;
  /** 값 뒤 보조 표기(단위·분모 등). */
  hint?: ReactNode;
  /** 라벨 오른쪽 lucide 아이콘(선택) — 회색 고정, 색 배경 타일 없음. */
  icon?: ComponentType<{ className?: string }>;
  /** 비정상·주의일 때만 지정한다. 정상·일반 수치는 중립(미지정). 값이 0 이면 톤을 무시한다(0 은 알릴 게 없다). */
  tone?: StatTone;
  /** 지정하면 버튼(필터 타일)이 된다. */
  onClick?: () => void;
  /** 필터 타일의 선택 상태. */
  active?: boolean;
  /** 값 아래 추가 내용(분해 배지·진행바 등). */
  children?: ReactNode;
  className?: string;
}

const TONE_TEXT: Record<StatTone, string> = {
  neutral: 'text-foreground',
  info: 'text-status-info',
  warning: 'text-status-warning',
  critical: 'text-status-critical',
};
const TONE_BORDER: Partial<Record<StatTone, string>> = {
  warning: 'border-status-warning/60',
  critical: 'border-status-critical/60',
};

function isZero(v: ReactNode): boolean {
  return v === 0 || v === '0' || v === '0%';
}

/**
 * 요약 수치 타일 표준 (DESIGN_SYSTEM.md §12.12-2, D-118).
 * 14개 화면이 각자 "아이콘 타일 + 큰 숫자" 를 손으로 그려(3곳은 바이트 동일 복붙) 랜딩 페이지 문법이 됐다.
 * 여기서는 라벨 `text-xs`, 값 `text-xl tabular-nums`, 카드 `rounded-md` 로 고정하고 색은 비정상에만 준다.
 * 한 줄에 4개 이하. 페이지 상단 KPI 행 자체는 두지 않는 것이 원칙이다.
 */
export function StatTile({ label, value, hint, icon: Icon, tone, onClick, active, children, className }: StatTileProps) {
  const toned = tone != null && tone !== 'neutral' && !isZero(value);
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground truncate">{label}</p>
        {Icon && <Icon className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />}
      </div>
      <p className={cn('text-xl font-semibold tabular-nums leading-tight mt-0.5', toned ? TONE_TEXT[tone] : 'text-foreground')}>
        {value}
        {hint != null && <span className="ml-1 text-xs font-normal text-muted-foreground">{hint}</span>}
      </p>
      {children}
    </>
  );
  const base = cn('rounded-md border bg-card px-4 py-3 text-left min-w-0', toned ? TONE_BORDER[tone] ?? 'border-border' : 'border-border', className);
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className={cn(base, 'w-full hover:bg-secondary/50 transition-colors', active && 'ring-1 ring-primary/40')}
      >
        {body}
      </button>
    );
  }
  return <div className={base}>{body}</div>;
}

/** StatTile 묶음 — 2열(모바일)/4열 격자. 타일은 4개 이하로 둔다. */
export function StatTileRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-2 md:grid-cols-4 gap-3', className)}>{children}</div>;
}
