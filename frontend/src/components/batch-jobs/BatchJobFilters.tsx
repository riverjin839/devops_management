import { Search } from 'lucide-react';
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
  baseCls: string;       // 비활성 상태 클래스
  activeCls: string;     // 활성 상태 클래스
}

const CHIPS: ChipConfig[] = [
  {
    key: 'all',
    label: '전체',
    baseCls: 'bg-card text-foreground border-border hover:bg-secondary',
    activeCls: 'bg-foreground text-background border-foreground',
  },
  {
    key: 'failed',
    label: '⚠ 실패',
    baseCls: 'bg-red-500/10 text-red-600 border-red-500/30 hover:bg-red-500/15',
    activeCls: 'bg-red-500 text-white border-red-500',
  },
  {
    key: 'running',
    label: '▶ 실행 중',
    baseCls: 'bg-blue-500/10 text-blue-600 border-blue-500/30 hover:bg-blue-500/15',
    activeCls: 'bg-blue-500 text-white border-blue-500',
  },
  {
    key: 'ok',
    label: '✓ 정상',
    baseCls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30 hover:bg-emerald-500/15',
    activeCls: 'bg-emerald-500 text-white border-emerald-500',
  },
  {
    key: 'missing_creds',
    label: '⚠ 자격증명 누락',
    baseCls: 'bg-amber-500/10 text-amber-600 border-amber-500/30 hover:bg-amber-500/15',
    activeCls: 'bg-amber-500 text-white border-amber-500',
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
            className={`inline-flex items-center gap-1 px-3 py-1 rounded-full border text-xs font-medium transition-colors ${
              isActive ? chip.activeCls : chip.baseCls
            }`}
          >
            <span>{chip.label}</span>
            <span
              className={`px-1.5 rounded-full text-[10px] ${
                isActive ? 'bg-white/25 text-white' : 'bg-foreground/10 text-foreground/70'
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
          className="pl-8 pr-3 py-1.5 text-xs bg-background border border-border rounded-xl w-64 focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>
    </div>
  );
}
