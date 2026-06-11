import { ExternalLink, Link2 } from 'lucide-react';

interface ConfluenceUrlInputProps {
  /** 현재 값 — 비어있으면 빈 문자열. 부모에서 trim 후 undefined 변환 권장. */
  value: string;
  onChange: (next: string) => void;
  /** label 표시 — "Confluence 링크" 기본. */
  label?: string;
  /** input id (a11y) — 미지정 시 'confluence-url'. */
  id?: string;
  /** 비활성화 */
  disabled?: boolean;
  /** 헬프 텍스트 표시 — 기본 true. 외부에서 보일 표준 안내문 사용. */
  showHint?: boolean;
  /** 힌트 텍스트 오버라이드. showHint=true 일 때 적용. */
  hint?: string;
  /** input 추가 클래스. */
  className?: string;
  /** 한 줄(라벨+입력 가로 배치) 컴팩트 모드. true 면 hint 는 숨긴다. */
  inline?: boolean;
}

const URL_RE = /^https?:\/\//i;

/**
 * 모든 게시글 (작업 / 이슈 / 운영노트 / 표준 작업 가이드) 등록 폼에서 공통으로
 * 쓰이는 Confluence URL 입력 필드. 빈 값을 허용하고, 채워져 있으면 `http(s)://`
 * 형태인지만 가벼운 검증을 한다 (무효 URL 도 저장은 허용 — 사용자 입력 신뢰).
 */
export function ConfluenceUrlInput({
  value,
  onChange,
  label = 'Confluence 링크',
  id = 'confluence-url',
  disabled,
  showHint = true,
  hint,
  className = '',
  inline = false,
}: ConfluenceUrlInputProps) {
  const trimmed = value.trim();
  const isValid = !trimmed || URL_RE.test(trimmed);
  const showOpen = isValid && trimmed.length > 0;

  if (inline) {
    return (
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground whitespace-nowrap shrink-0">
          <Link2 className="w-3.5 h-3.5 text-primary" />
          {label}
        </label>
        <div className="relative flex-1 min-w-0">
          <input
            id={id}
            type="url"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder="https://confluence.example.com/pages/..."
            inputMode="url"
            className={`w-full pl-3 pr-9 py-1.5 bg-background border ${
              isValid ? 'border-border' : 'border-red-500/60'
            } rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60 ${className}`}
          />
          {showOpen && (
            <a
              href={trimmed}
              target="_blank"
              rel="noopener noreferrer"
              title="새 창에서 열기"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-muted-foreground hover:text-primary hover:bg-secondary transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <label htmlFor={id} className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Link2 className="w-3.5 h-3.5 text-primary" />
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type="url"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder="https://confluence.example.com/pages/..."
          inputMode="url"
          className={`w-full pl-3 pr-9 py-2 bg-background border ${
            isValid ? 'border-border' : 'border-red-500/60'
          } rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60 ${className}`}
        />
        {showOpen && (
          <a
            href={trimmed}
            target="_blank"
            rel="noopener noreferrer"
            title="새 창에서 열기"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-muted-foreground hover:text-primary hover:bg-secondary transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
      </div>
      {showHint && (
        <p className={`text-[11px] ${isValid ? 'text-muted-foreground' : 'text-red-500'}`}>
          {isValid
            ? (hint ?? '관련 Confluence 문서가 있다면 URL 을 붙여넣으세요. (선택)')
            : 'http:// 또는 https:// 로 시작해야 합니다.'}
        </p>
      )}
    </div>
  );
}
