import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * 상시 설명 문장 대신 쓰는 정보 아이콘 — 마우스를 올리거나 키보드로 포커스하면 툴팁으로 설명을 보여 준다.
 * 화면 본문에는 데이터(값·건수·상태·시각)와 결과·오류 문구만 두고, "이건 무엇이다" 류 설명은 여기로 옮긴다(DESIGN_SYSTEM §12).
 * 스크린리더는 `aria-label`(앞머리 + 설명)로 읽는다. 클릭해도 아무 동작 없음.
 */
export function InfoHint({ text, label, side = 'top', className = '' }: {
  text: string; label?: string; side?: 'top' | 'bottom' | 'left' | 'right'; className?: string;
}) {
  if (!text) return null;
  return (
    <Tooltip>
      <TooltipTrigger type="button" aria-label={label ? `${label}: ${text}` : text}
        className={`inline-flex items-center justify-center w-5 h-5 shrink-0 rounded-xl text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-primary align-middle ${className}`}>
        <Info className="w-3.5 h-3.5" />
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-[320px] whitespace-pre-line">{text}</TooltipContent>
    </Tooltip>
  );
}
