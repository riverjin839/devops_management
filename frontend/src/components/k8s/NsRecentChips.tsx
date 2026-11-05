import { useNsRecent } from '@/hooks/useNsPrefs';

interface Props {
  clusterId: string;
  /** 지금 선택된 NS — 칩이 눌린 상태로 보이게 한다. */
  selected: ReadonlySet<string>;
  /** 칩을 누르면 그 NS 하나로 선택을 바꾼다(다른 선택을 대체). */
  onPick: (ns: string) => void;
  className?: string;
}

/** 최근 선택한 NS(기본 3개) 바로가기. NS 가 천 개 단위여도 드롭다운을 열어 검색하지 않고 한 번 눌러 선택한다. */
export function NsRecentChips({ clusterId, selected, onPick, className = '' }: Props) {
  const recent = useNsRecent(clusterId);
  if (recent.length === 0) return null;
  return (
    <div role="group" aria-label="최근 선택한 네임스페이스" className={`inline-flex items-center gap-1 flex-wrap ${className}`}>
      <span className="text-xs text-muted-foreground">최근</span>
      {recent.map((ns) => {
        const active = selected.has(ns);
        return (
          <button
            key={ns}
            type="button"
            onClick={() => onPick(ns)}
            aria-pressed={active}
            title={`${ns} 선택`}
            className={`max-w-[160px] truncate rounded-xl border px-2 py-1 text-xs transition-colors ${
              active
                ? 'border-primary/40 bg-primary/10 text-foreground'
                : 'border-border bg-card text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
            }`}
          >
            {ns}
          </button>
        );
      })}
    </div>
  );
}
