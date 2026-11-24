// 서비스 레일 — 클러스터 레일 오른쪽에 붙는 세로 서비스 목록(ETCD·CONTAINERD·CILIUM·LINUX …).
// 구분선 아래 `extras` 는 설정 버전이 없는 읽기 전용 상태 화면(NIC)이다. 아이콘 아래 짧은 이름을 함께 둬
// 툴팁 없이도 읽힌다. 드리프트·알람·실패한 적용이 있는 서비스는 아이콘에 상태 점(사유는 title·aria-label). 목록은 서버 서비스 정의(`/service-config/services`) 순서 그대로 — 서비스는 추후 서버 쪽에서 늘린다.
import type { ComponentType } from 'react';
import { Box, Boxes, CalendarClock, Cable, Cog, Cpu, Database, GitBranch, Lock, Network, Server, Users, Wrench } from 'lucide-react';
import type { ServiceConfigLevel, ServiceConfigServiceDef } from '@/types';

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  database: Database, box: Box, network: Network, cpu: Cpu, server: Server, cog: Cog, calendar: CalendarClock, boxes: Boxes,
  cable: Cable, lock: Lock, users: Users, wrench: Wrench, 'git-branch': GitBranch,
};

/** 레일에 서비스 정의 대신 붙는 읽기 전용 항목. */
export interface ServiceRailExtra {
  key: string;
  label: string;
  icon: string;
  description: string;
}

interface Props {
  /** 서비스 구성(`/service-config/services`) 또는 공통 서비스 카탈로그 — 레일은 표시 필드만 쓴다. */
  services: Pick<ServiceConfigServiceDef, 'key' | 'label' | 'short' | 'icon' | 'description'>[];
  selected: string;
  onSelect: (key: string) => void;
  /** 서비스별 상태(정상이면 점 없음 — 비정상만 상태색). */
  levels?: Record<string, { level: ServiceConfigLevel; reasons: string[] }>;
  /** nav 의 접근 가능한 이름(기본 "서비스"). */
  ariaLabel?: string;
  /** 구분선 아래 읽기 전용 상태 화면(NIC 등). */
  extras?: ServiceRailExtra[];
}

export function ServiceConfigRail({ services, selected, onSelect, levels, extras = [], ariaLabel = '서비스' }: Props) {
  const items: (ServiceRailExtra & { short?: string; divider?: boolean })[] = [
    ...services.map((s) => ({ key: s.key, label: s.label, short: s.short, icon: s.icon, description: s.description })),
    ...extras.map((e, i) => ({ ...e, divider: i === 0 && services.length > 0 })),
  ];
  return (
    <nav aria-label={ariaLabel} className="w-[96px] shrink-0 flex flex-col items-center gap-1 py-2 border-r border-border">
      {items.map((s) => {
        const Icon = ICONS[s.icon] ?? Server;
        const active = s.key === selected;
        const lv = levels?.[s.key];
        const flagged = lv && lv.level !== 'ok';
        const why = flagged ? ` — ${lv.level === 'critical' ? '위험' : '확인 필요'}: ${lv.reasons.join(', ')}` : '';
        return (
          <div key={s.key} className="contents">
          {s.divider && <span aria-hidden className="w-12 my-1 border-t border-border" />}
          <button
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
          </div>
        );
      })}
    </nav>
  );
}
