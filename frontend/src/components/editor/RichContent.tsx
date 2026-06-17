import DOMPurify from 'dompurify';

interface RichContentProps {
  content: string;
  className?: string;
}

// G-I7: XSS 방어 — RichTextEditor 가 만든 HTML 을 렌더하기 전 DOMPurify 로 sanitize.
// 화이트리스트 기반 (script/iframe/onerror 등 차단). 일반 텍스트 콘텐츠는 fallback 으로
// 안전하게 표시.
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'code', 'pre',
  'a', 'img', 'ul', 'ol', 'li', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'colgroup', 'col',
  'div', 'span', 'details', 'summary',
];
const ALLOWED_ATTR = ['href', 'title', 'alt', 'src', 'target', 'rel', 'class', 'style', 'data-checked', 'colwidth', 'colspan', 'rowspan', 'data-callout', 'open'];

/**
 * Renders HTML content produced by RichTextEditor — DOMPurify sanitized.
 * Falls back gracefully for plain-text legacy content.
 */
export function RichContent({ content, className = '' }: RichContentProps) {
  if (!content) return null;

  const isHtml = /<[a-z][\s\S]*>/i.test(content);

  if (isHtml) {
    const sanitized = DOMPurify.sanitize(content, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      // 외부 링크는 새 탭 + noopener (DOMPurify hook 으로 보강 가능하나, ALLOWED_ATTR 에
      // target/rel 허용 — RichTextEditor 가 안전한 값으로 emit 한다는 전제).
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input'],
      FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover'],
    });
    return (
      <div
        className={`rich-content text-sm leading-relaxed ${className}`}
        dangerouslySetInnerHTML={{ __html: sanitized }}
      />
    );
  }

  // Plain-text legacy content
  return (
    <p className={`text-sm whitespace-pre-wrap break-words ${className}`}>{content}</p>
  );
}
