import { useEffect, useRef } from 'react';

interface ResizeHandleProps {
  width: number;
  onResize: (next: number) => void;
  onReset?: () => void;
  /** 핸들이 붙는 가장자리. 'right'(기본) = 좌측 고정 패널의 오른쪽 가장자리(오른쪽 드래그=확대).
   *  'left' = 우측 고정 패널(예: SidePane)의 왼쪽 가장자리(왼쪽 드래그=확대). */
  side?: 'right' | 'left';
  className?: string;
}

/** 사이드바/패널 가장자리에 붙여서 가로 폭 드래그 리사이즈.
 *  부모는 position:relative 또는 fixed 여야 absolute 핸들이 보임.
 *  더블클릭 → onReset (기본값으로).
 */
export function ResizeHandle({
  width, onResize, onReset, side = 'right', className = '',
}: ResizeHandleProps) {
  const startXRef = useRef(0);
  const startWRef = useRef(0);
  const draggingRef = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const dx = e.clientX - startXRef.current;
      const next = side === 'right' ? startWRef.current + dx : startWRef.current - dx;
      onResize(next);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [onResize, side]);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startWRef.current = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={handleMouseDown}
      onDoubleClick={() => onReset?.()}
      title="드래그해서 폭 조절 · 더블클릭으로 기본값 리셋"
      className={`absolute top-0 ${side === 'right' ? 'right-0 -mr-0.5' : 'left-0 -ml-0.5'} w-1.5 h-full cursor-col-resize group z-[60] ${className}`}
    >
      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-border group-hover:bg-primary/60 group-hover:w-[2px] transition-all" />
    </div>
  );
}
