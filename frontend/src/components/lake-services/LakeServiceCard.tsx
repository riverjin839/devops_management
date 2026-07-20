import { Play, ChevronRight } from 'lucide-react';
import { StatusBadge, statusToVariant } from '@/components/common/StatusBadge';
import { ServiceTypeIcon } from './ServiceTypeIcon';
import type { LakeService } from '@/types';

interface LakeServiceCardProps {
  service: LakeService;
  typeLabel?: string;
  onClick: (service: LakeService) => void;
  onRunCheck: (service: LakeService) => void;
  isChecking?: boolean;
}

export function LakeServiceCard({
  service, typeLabel, onClick, onRunCheck, isChecking,
}: LakeServiceCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onClick(service)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(service);
        }
      }}
      aria-label={`${service.name} 상세 보기`}
      className="group text-left bg-card border border-border rounded-md p-4 hover:border-primary/40 transition-all cursor-pointer"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-md bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
            <ServiceTypeIcon serviceType={service.serviceType} className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate group-hover:text-primary transition-colors">
              {service.name}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {typeLabel ?? service.serviceType} · {service.category}
            </p>
          </div>
        </div>
        <StatusBadge variant={statusToVariant(service.status)} />
      </div>

      {/* Endpoint + meta */}
      <p className="text-xs text-muted-foreground font-mono truncate mb-2" title={service.endpointUrl}>
        {service.endpointUrl}
      </p>
      {service.namespace && (
        <p className="text-xs text-muted-foreground/80 mb-2">
          namespace: <span className="font-mono">{service.namespace}</span>
        </p>
      )}

      {/* Last check + action */}
      <div className="flex items-center justify-between text-xs mt-3">
        <span className="text-muted-foreground">
          {service.lastCheckedAt
            ? `마지막 점검: ${new Date(service.lastCheckedAt).toLocaleString('ko-KR')}`
            : '점검 기록 없음'}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={isChecking}
            onClick={(e) => {
              e.stopPropagation();
              if (!isChecking) onRunCheck(service);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
              }
            }}
            aria-label={`${service.name} 지금 점검`}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5
              ${isChecking ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-secondary'}`}
          >
            <Play className="w-3 h-3" />
            {isChecking ? '실행 중…' : '지금 점검'}
          </button>
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground opacity-50" />
        </div>
      </div>

      {service.lastMessage && (
        <p className="mt-2 text-xs text-muted-foreground/70 italic truncate">
          {service.lastMessage}
        </p>
      )}
    </div>
  );
}
