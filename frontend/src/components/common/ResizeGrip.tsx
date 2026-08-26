import { memo } from 'react';

interface Props {
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  /** 호버시 보이는 두께 px (기본 4) */
  width?: number;
  className?: string;
}

/** 테이블 헤더 우측에 절대 위치로 두는 드래그 핸들.
 *  부모 <th> 에 `relative` 가 있어야 정렬 보장. */
function ResizeGripBase({ onMouseDown, onDoubleClick, width = 4, className = '' }: Props) {
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label="컬럼 너비 조정"
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onClick={(e) => e.stopPropagation()}
      className={`absolute top-0 right-0 h-full select-none cursor-col-resize group/grip ${className}`}
      style={{ width: `${width + 4}px`, marginRight: `-${width / 2}px` }}
      title="드래그로 너비 조정 · 더블클릭으로 자동 맞춤"
    >
      {/* 시각적 막대 (가운데) */}
      <span
        className="absolute top-1.5 bottom-1.5 left-1/2 -translate-x-1/2 rounded-full bg-border/70 group-hover/grip:bg-primary/50 transition-colors"
        style={{ width: `${width}px` }}
      />
    </span>
  );
}

export const ResizeGrip = memo(ResizeGripBase);
