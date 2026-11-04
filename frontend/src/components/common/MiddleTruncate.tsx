import { cn } from '@/lib/utils';

interface MiddleTruncateProps {
  /** 전체 식별자 — 노드·Pod·네임스페이스·이미지 이름처럼 **끝이 다른** 값. */
  text: string;
  /** 끝에 항상 남길 글자 수(기본 12). 이 길이 이하면 일반 말줄임과 같다. */
  tail?: number;
  className?: string;
}

/**
 * 가운데 말줄임 — 앞부분만 줄이고 끝 N글자는 항상 보인다.
 * `truncate` 는 끝을 지우는데, 식별자(`web-7d4f9c6b8-x2k4q` / `…-m7p9z`)는 끝에서 갈리므로 정보 손실이다.
 * 전체 값은 `title` 로도 남기고 스크린리더에는 전체 텍스트를 읽어 준다.
 */
export function MiddleTruncate({ text, tail = 12, className }: MiddleTruncateProps) {
  if (text.length <= tail + 4) {
    return <span className={cn('truncate', className)} title={text}>{text}</span>;
  }
  const head = text.slice(0, text.length - tail);
  const end = text.slice(text.length - tail);
  return (
    <span className={cn('flex min-w-0 max-w-full', className)} title={text}>
      <span className="sr-only">{text}</span>
      <span className="truncate" aria-hidden="true">{head}</span>
      <span className="shrink-0" aria-hidden="true">{end}</span>
    </span>
  );
}
