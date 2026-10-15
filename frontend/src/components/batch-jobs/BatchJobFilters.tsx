import { AlertTriangle, CheckCircle2, KeyRound, Play, Search, type LucideIcon } from 'lucide-react';
import type { BatchJob } from '@/services/api';
import type { FilterKey } from './types';
import { FILTER_PREDICATES } from './filters';

interface BatchJobFiltersProps {
  jobs: BatchJob[];
  active: FilterKey;
  onChange: (key: FilterKey) => void;
  search: string;
  onSearchChange: (s: string) => void;
}

interface ChipConfig {
  key: FilterKey;
  label: string;
  Icon?: LucideIcon;
  baseCls: string;       // 비활성 상태 클래스
  activeCls: string;     // 활성 상태 클래스
}

// 정상 칩은 무채색, 비정상(실패·자격증명 누락)·실행 중만 상태 토큰(DESIGN_SYSTEM §12.12-3).
// 활성 칩은 유색 배경 위 흰 글자 대신 진한 틴트 + 같은 색 보더로 표시한다.
const NEUTRAL_BASE = 'bg-card text-foreground border-border hover:bg-secondary';
const NEUTRAL_ACTIVE = 'bg-foreground text-background border-foreground';

const CHIPS: ChipConfig[] = [
  {
    key: 'all',
    label: '전체',
    baseCls: NEUTRAL_BASE,
    activeCls: NEUTRAL_ACTIVE,
  },
  {
    key: 'failed',
    label: '실패',
    Icon: AlertTriangle,
    baseCls: 'bg-status-critical/10 text-status-critical border-status-critical/30 hover:bg-status-critical/15',
    activeCls: 'bg-status-critical/20 text-status-critical border-status-critical',
  },
  {
    key: 'running',
    label: '실행 중',
    Icon: Play,
    baseCls: 'bg-status-info/10 text-status-info border-status-info/30 hover:bg-status-info/15',
    activeCls: 'bg-status-info/20 text-status-info border-status-info',
  },
  {
    key: 'ok',
    label: '정상',
    Icon: CheckCircle2,
    baseCls: NEUTRAL_BASE,
    activeCls: NEUTRAL_ACTIVE,
  },
  {
    key: 'missing_creds',
    label: '자격증명 누락',
    Icon: KeyRound,
    baseCls: 'bg-status-warning/10 text-status-warning border-status-warning/30 hover:bg-status-warning/15',
    activeCls: 'bg-status-warning/20 text-status-warning border-status-warning',
  },
];

export function BatchJobFilters({ jobs, active, onChange, search, onSearchChange }: BatchJobFiltersProps) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {CHIPS.map((chip) => {
        const count = jobs.filter(FILTER_PREDICATES[chip.key]).length;
        const isActive = active === chip.key;
        return (
          <button
            key={chip.key}
            type="button"
            onClick={() => onChange(chip.key)}
            aria-pressed={isActive}
            className={`inline-flex items-center gap-1 px-3 py-1 rounded-full border text-sm font-medium transition-colors ${
              isActive ? chip.activeCls : chip.baseCls
            }`}
          >
            {chip.Icon && <chip.Icon className="w-3.5 h-3.5" aria-hidden />}
            <span>{chip.label}</span>
            <span
              className={`px-1.5 rounded-full text-xs ${
                isActive ? 'bg-background/25' : 'bg-foreground/10 text-foreground/70'
              }`}
            >
              {count}
            </span>
          </button>
        );
      })}
      <div className="relative ml-auto">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="이름 / cron / 호스트 / 타입 검색"
          className="pl-8 pr-3 py-1.5 text-sm bg-background border border-border rounded-xl w-64 focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>
    </div>
  );
}
