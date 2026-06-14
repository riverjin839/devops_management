import { type ComponentType } from 'react';
import { Inbox } from 'lucide-react';

interface EmptyStateProps {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
    variant?: 'primary' | 'secondary';
  };
  /** 부가 액션 (보조) */
  secondaryAction?: { label: string; onClick: () => void };
  className?: string;
  /** 컴팩트한 형태 (테이블 내부 사용 시) */
  compact?: boolean;
}

/** 빈 상태 — 아이콘 + 제목 + 설명 + (선택) 주요/보조 액션.
 *  데이터 없음, 검색 결과 없음, 연결 안 됨 등 공통 사용. */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  secondaryAction,
  className = '',
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center ${
        compact ? 'py-6 px-4' : 'py-12 px-6'
      } ${className}`}
    >
      <div className={`rounded-full bg-muted/40 ${compact ? 'p-2.5 mb-2' : 'p-3.5 mb-3'}`}>
        <Icon className={compact ? 'w-5 h-5 text-muted-foreground' : 'w-7 h-7 text-muted-foreground'} />
      </div>
      <p className={`font-semibold text-foreground ${compact ? 'text-sm' : 'text-base'}`}>
        {title}
      </p>
      {description && (
        <p className={`text-muted-foreground ${compact ? 'text-sm mt-1 max-w-sm' : 'text-sm mt-1.5 max-w-md leading-relaxed'}`}>
          {description}
        </p>
      )}
      {(action || secondaryAction) && (
        <div className="flex items-center gap-2 mt-4">
          {action && (
            <button
              onClick={action.onClick}
              className={`px-3.5 py-1.5 text-sm font-semibold rounded-lg transition-colors ${
                (action.variant ?? 'primary') === 'primary'
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'bg-secondary text-foreground hover:bg-secondary/80 border border-border'
              }`}
            >
              {action.label}
            </button>
          )}
          {secondaryAction && (
            <button
              onClick={secondaryAction.onClick}
              className="px-3.5 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg"
            >
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
