import { Node, mergeAttributes } from '@tiptap/core';

/**
 * 콜아웃(강조 박스) — info / warning / success / note 변형.
 * `<div data-callout="info">…</div>` 로 직렬화. NodeView 없이 스타일만 입히는 정적 블록이라
 * 공용 에디터에 추가해도 안전(기존 콘텐츠 영향 없음).
 */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      variant: {
        default: 'info',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-callout') || 'info',
        renderHTML: (attrs) => ({ 'data-callout': attrs.variant }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'callout' }), 0];
  },

  addCommands() {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setCallout: (variant = 'info') => ({ commands }: any) =>
        commands.wrapIn(this.name, { variant }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toggleCallout: (variant = 'info') => ({ commands }: any) =>
        commands.toggleWrap(this.name, { variant }),
    } as never;
  },
});

/**
 * 토글(접기/펼치기) — 네이티브 `<details>`/`<summary>` 로 직렬화해 편집·읽기 양쪽에서
 * 브라우저 기본 토글로 동작(별도 NodeView 불필요 → 공용 에디터 안정).
 * 본문은 `div.toggle-body` 안에 들어가고, summary 텍스트는 attribute 로 보관.
 */
export const ToggleBlock = Node.create({
  name: 'toggleBlock',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (el) => (el as HTMLElement).hasAttribute('open'),
        renderHTML: (attrs) => (attrs.open ? { open: 'open' } : {}),
      },
      summary: {
        default: '토글',
        parseHTML: (el) => el.querySelector('summary')?.textContent || '토글',
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'details', contentElement: 'div.toggle-body' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const open = HTMLAttributes.open ? { open: 'open' } : {};
    return [
      'details',
      mergeAttributes(open),
      ['summary', { contenteditable: 'false' }, node.attrs.summary || '토글'],
      ['div', { class: 'toggle-body' }, 0],
    ];
  },

  addCommands() {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      insertToggle: (summary = '토글') => ({ commands }: any) =>
        commands.insertContent({
          type: this.name,
          attrs: { open: true, summary },
          content: [{ type: 'paragraph' }],
        }),
    } as never;
  },
});
