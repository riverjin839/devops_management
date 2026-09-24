import { CheckCircle, Clock, Play, ShieldAlert, Wifi, XCircle } from 'lucide-react';

interface StatusMeta {
  label: string;
  cls: string;
  Icon: React.ComponentType<{ className?: string }>;
}

const STATUS_META: Record<string, StatusMeta> = {
  ok:            { label: '정상',      cls: 'bg-status-healthy/10 text-status-healthy border-status-healthy/30', Icon: CheckCircle },
  error:         { label: '에러',      cls: 'bg-status-critical/10 text-status-critical border-status-critical/30',             Icon: XCircle },
  timeout:       { label: '타임아웃',  cls: 'bg-status-warning/10 text-status-warning border-status-warning/30',       Icon: Clock },
  auth_error:    { label: '인증 실패', cls: 'bg-orange-500/10 text-orange-600 border-orange-500/30',    Icon: ShieldAlert },
  connect_error: { label: '연결 실패', cls: 'bg-status-unknown/10 text-status-unknown border-status-unknown/30',       Icon: Wifi },
  running:       { label: '실행 중',   cls: 'bg-blue-500/10 text-blue-600 border-blue-500/30',          Icon: Play },
  unknown:       { label: '미실행',    cls: 'bg-muted text-muted-foreground border-border',             Icon: Clock },
};

interface StatusPillProps {
  status: string;
  /** 기본 사이즈 mini(text-xs) — 표 / 슬라이드오버용. */
  size?: 'mini' | 'sm';
  className?: string;
}

export function StatusPill({ status, size = 'mini', className = '' }: StatusPillProps) {
  const meta = STATUS_META[status] ?? STATUS_META.unknown;
  const { Icon } = meta;
  const sizeCls = size === 'mini' ? 'text-xs px-2 py-0.5' : 'text-sm px-2.5 py-1';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border font-medium ${sizeCls} ${meta.cls} ${className}`}>
      <Icon className="w-3 h-3" />
      {meta.label}
    </span>
  );
}
