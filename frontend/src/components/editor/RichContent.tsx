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

// style/target 값은 API 로 직접 주입 가능(다른 사용자가 저장)해서 "에디터가 안전한
// 값만 emit 한다"는 전제가 항상 성립하진 않는다. DOMPurify 훅으로 후처리해 방어를
// 한 겹 더 둔다 — 스크립트 실행 자체는 이미 FORBID_ATTR/FORBID_TAGS 로 막혀 있으니
// 여기서 막는 건 (a) target=_blank 의 reverse-tabnabbing, (b) style 을 이용한
// UI 위장(예: position:fixed 오버레이로 피싱 배너 흉내).
const ALLOWED_STYLE_PROPS = new Set([
  'color', 'background-color', 'background',
  'text-align', 'font-weight', 'font-style', 'text-decoration',
  'width', 'min-width', 'max-width', 'height',
]);

let hooksRegistered = false;
function ensureHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('target') === '_blank') {
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (node.hasAttribute('style')) {
      const raw = node.getAttribute('style') || '';
      const safe = raw
        .split(';')
        .map((decl) => decl.trim())
        .filter((decl) => {
          const prop = decl.split(':')[0]?.trim().toLowerCase();
          return prop && ALLOWED_STYLE_PROPS.has(prop);
        })
        .join('; ');
      if (safe) {
        node.setAttribute('style', safe);
      } else {
        node.removeAttribute('style');
      }
    }
  });
}

/**
 * Renders HTML content produced by RichTextEditor — DOMPurify sanitized.
 * Falls back gracefully for plain-text legacy content.
 */
export function RichContent({ content, className = '' }: RichContentProps) {
  if (!content) return null;

  const isHtml = /<[a-z][\s\S]*>/i.test(content);

  if (isHtml) {
    ensureHooks();
    const sanitized = DOMPurify.sanitize(content, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
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
