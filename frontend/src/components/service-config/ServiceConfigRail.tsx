// 서비스 레일 — 클러스터 레일 오른쪽에 붙는 세로 서비스 목록(ETCD·CONTAINERD·CILIUM·LINUX). 아이콘 아래 짧은 이름을 함께 둬
// 툴팁 없이도 읽힌다. 목록은 서버 서비스 정의(`/service-config/services`) 순서 그대로 — 서비스는 추후 서버 쪽에서 늘린다.
import type { ComponentType } from 'react';
import { Box, Cpu, Database, Network, Server } from 'lucide-react';
import type { ServiceConfigServiceDef } from '@/types';

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  database: Database, box: Box, network: Network, cpu: Cpu,
};

interface Props {
  services: ServiceConfigServiceDef[];
  selected: string;
  onSelect: (key: string) => void;
}

export function ServiceConfigRail({ services, selected, onSelect }: Props) {
  return (
    <nav aria-label="서비스" className="w-[96px] shrink-0 flex flex-col items-center gap-1 py-2 border-r border-border">
      {services.map((s) => {
        const Icon = ICONS[s.icon] ?? Server;
        const active = s.key === selected;
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onSelect(s.key)}
            aria-current={active ? 'page' : undefined}
            title={s.description}
            className={`w-[88px] flex flex-col items-center gap-1 py-2 rounded-xl text-xs font-semibold transition-colors ${
              active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
            }`}
          >
            <Icon className="w-5 h-5" />
            <span className="leading-tight text-center">{s.label.replace(' (OS)', '')}</span>
          </button>
        );
      })}
    </nav>
  );
}
