import { type ComponentType, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  /** 페이지 제목 — 화면당 `<h1>` 은 이것 하나뿐이어야 한다. */
  title: ReactNode;
  /** 한 줄 부제(선택). 여러 줄이 필요하면 fragment 로 넘긴다. */
  description?: ReactNode;
  /** h1 앞 lucide 아이콘(선택). 색은 `text-muted-foreground` 고정 — 아이콘 타일(배경 박스) 금지. */
  icon?: ComponentType<{ className?: string }>;
  /** 뒤로가기 텍스트 링크 1종. pill/버튼 모양 뒤로가기는 쓰지 않는다. */
  back?: { to: string; label: string };
  /** 제목 옆 배지·상태 등(선택). */
  titleExtra?: ReactNode;
  /** 우측 액션 영역(선택). */
  actions?: ReactNode;
  className?: string;
  /** 제목 heading 레벨 — 기본 1. 다른 페이지 안에 임베드돼 바깥에 이미 `<h1>` 이 있을 때만 2 로 낮춘다
   *  (예: 홈 배치잡 탭의 `BatchJobsPage`, §12.12-1 — 화면당 h1 1개). 시각 크기는 같다. */
  level?: 1 | 2;
}

/**
 * 페이지 헤더 표준 (DESIGN_SYSTEM.md §12.12-1, D-117).
 * 이전엔 페이지마다 `w-10 h-10 rounded-2xl bg-primary/10` 아이콘 타일 + `text-xl font-bold` + 회색 부제,
 * 또는 pill 모양 뒤로가기 + `text-lg font-semibold` 를 손으로 그려 h1 이 22가지 class 로 흩어져 있었다.
 * 제목 크기·굵기·아이콘 톤·뒤로가기 모양을 여기 한 곳에 고정한다.
 */
export function PageHeader({ title, description, icon: Icon, back, titleExtra, actions, className, level = 1 }: PageHeaderProps) {
  const Heading = level === 2 ? 'h2' : 'h1';
  return (
    <header className={cn('flex items-start justify-between gap-x-4 gap-y-2 flex-wrap', className)}>
      <div className="flex items-start gap-3 min-w-0 flex-1">
        {back && (
          <Link
            to={back.to}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground shrink-0 mt-1 whitespace-nowrap"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            {back.label}
          </Link>
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            {Icon && <Icon className="w-5 h-5 text-muted-foreground shrink-0" aria-hidden="true" />}
            <Heading className="text-xl font-semibold leading-tight min-w-0">{title}</Heading>
            {titleExtra}
          </div>
          {description && <div className="text-sm text-muted-foreground mt-0.5">{description}</div>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0 flex-wrap">{actions}</div>}
    </header>
  );
}
