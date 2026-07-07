import { Link } from 'react-router-dom';
import {
  Layers, Server, Network, Database,
  GitBranch, Users, BookOpen, Settings,
} from 'lucide-react';

const DOMAINS = [
  { id: 'cluster',   label: '클러스터',   icon: Layers,    to: '/cluster-overview' },
  { id: 'server',    label: '서버/인프라', icon: Server,    to: '/node-specs' },
  { id: 'network',   label: '네트워크',   icon: Network,   to: '/cilium-trace' },
  { id: 'storage',   label: '스토리지',   icon: Database,  to: '/mc' },
  { id: 'devops',    label: 'DevOps',     icon: GitBranch, to: '/playbooks' },
  { id: 'collab',    label: '협업',       icon: Users,     to: '/tasks-mgmt' },
  { id: 'knowledge', label: '지식/분석',  icon: BookOpen,  to: '/docs' },
  { id: 'system',    label: '시스템',     icon: Settings,  to: '/settings' },
] as const;

export function DomainQuickAccess() {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <span className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
        플랫폼 도메인
      </span>
      <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-9 gap-1.5">
        {DOMAINS.map(({ id, label, icon: Icon, to }) => (
          <Link
            key={id}
            to={to}
            className="flex flex-col items-center gap-1 px-2 py-2 rounded-lg hover:bg-muted/60 transition-colors group"
          >
            <Icon className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
            <span className="text-xs text-muted-foreground group-hover:text-foreground leading-none text-center">
              {label}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
