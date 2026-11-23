// 서비스 레일 — 클러스터 레일 오른쪽에 붙는 세로 서비스 목록(ETCD·CONTAINERD·CILIUM·LINUX … NIC).
// 아이콘 아래 짧은 이름을 함께 둬
// 툴팁 없이도 읽힌다. 드리프트·알람·실패한 적용이 있는 서비스는 아이콘에 상태 점(사유는 title·aria-label). 목록은 서버 서비스 정의(`/service-config/services`) 순서 그대로 — 서비스는 추후 서버 쪽에서 늘린다.
import type { ComponentType } from 'react';
import { Box, Boxes, CalendarClock, Cable, Cog, Cpu, Database, Network, Server } from 'lucide-react';
import type { ServiceConfigLevel, ServiceConfigServiceDef } from '@/types';

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  database: Database, box: Box, network: Network, cpu: Cpu, server: Server, cog: Cog, calendar: CalendarClock, boxes: Boxes,
  cable: Cable,
};


interface Props {
  services: ServiceConfigServiceDef[];
  selected: string;
  onSelect: (key: string) => void;
  /** 서비스별 상태(정상이면 점 없음 — 비정상만 상태색). */
  levels?: Record<string, { level: ServiceConfigLevel; reasons: string[] }>;
}

export function ServiceConfigRail({ services, selected, onSelect, levels }: Props) {
  return (
    <nav aria-label="서비스" className="w-[96px] shrink-0 flex flex-col items-center gap-1 py-2 border-r border-border">
      {services.map((s) => {
        const Icon = ICONS[s.icon] ?? Server;
        const active = s.key === selected;
        const lv = levels?.[s.key];
        const flagged = lv && lv.level !== 'ok';
        const why = flagged ? ` — ${lv.level === 'critical' ? '위험' : '확인 필요'}: ${lv.reasons.join(', ')}` : '';
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onSelect(s.key)}
            aria-current={active ? 'page' : undefined}
            title={`${s.description}${why}`}
            aria-label={`${s.label}${why}`}
            className={`w-[88px] flex flex-col items-center gap-1 py-2 rounded-xl text-xs font-semibold transition-colors ${
              active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
            }`}
          >
            <span className="relative">
              <Icon className="w-5 h-5" />
              {flagged && (
                <span className={`absolute -top-1 -right-1.5 w-2.5 h-2.5 rounded-full ring-2 ring-card ${lv.level === 'critical' ? 'bg-status-critical' : 'bg-status-warning'}`} />
              )}
            </span>
            <span className="leading-tight text-center">{s.short ?? s.label.replace(' (OS)', '')}</span>
          </button>
        );
      })}
    </nav>
  );
}
