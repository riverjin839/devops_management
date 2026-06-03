import { useEffect, useCallback, useRef, useState } from 'react';
import { useEditor, EditorContent, Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import TextAlign from '@tiptap/extension-text-align';
import Highlight from '@tiptap/extension-highlight';
import Color from '@tiptap/extension-color';
import { TextStyle } from '@tiptap/extension-text-style';
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  Heading1, Heading2, Heading3,
  List, ListOrdered, CheckSquare,
  Code, FileCode,
  Quote, Minus, Link as LinkIcon, Image as ImageIcon,
  Table as TableIcon, AlignLeft, AlignCenter, AlignRight,
  Highlighter, Undo, Redo, Type, LayoutTemplate, FileUp, Palette, Eraser,
} from 'lucide-react';
import { marked } from 'marked';
import { compressImageFile } from '@/lib/imageCompress';
import { DOC_TEMPLATES } from './docTemplates';

const EDITOR_BG_KEY = 'k8s:editor-bg';
const BG_PRESETS = ['#ffffff', '#faf7f0', '#f4f4f5', '#eef2ff', '#ecfdf5', '#1f2937'];

/** hex(#rrggbb) 의 상대 밝기로 어두운 배경이면 true → 밝은 글자색 사용 */
function isDarkColor(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  // perceived luminance (0~255)
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}

interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minHeight?: string;
  onImagePaste?: (dataUrl: string) => void;
  /** 편집 영역 배경을 흰색으로 (기본은 테마 배경). 어두운 테마에서도 본문 글자가 보이도록 검은 글자색 적용. */
  whiteBg?: boolean;
}

interface ToolbarButtonProps {
  onClick: () => void;
  active?: boolean;
  title: string;
  children: React.ReactNode;
  disabled?: boolean;
}

function ToolbarButton({ onClick, active, title, children, disabled }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault();
        if (!disabled) onClick();
      }}
      title={title}
      disabled={disabled}
      className={`p-1.5 rounded transition-colors text-xs flex items-center justify-center ${
        active
          ? 'bg-primary/20 text-primary'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="w-px h-5 bg-border mx-0.5 flex-shrink-0" />;
}

function Toolbar({ editor, surfaceBg, bgColor, onPickBg }: {
  editor: Editor;
  surfaceBg?: string | null;
  bgColor?: string | null;
  onPickBg?: (color: string | null) => void;
}) {
  const [tplOpen, setTplOpen] = useState(false);
  const setLink = () => {
    const previousUrl = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('URL을 입력하세요:', previousUrl ?? 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  const insertTable = () => {
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  };

  return (
    <div
      className={`flex flex-wrap items-center gap-0.5 px-2 py-1.5 border-b border-border ${surfaceBg ? '' : 'bg-muted/30'}`}
      style={surfaceBg ? { backgroundColor: surfaceBg } : undefined}
    >
      {/* Undo / Redo */}
      <ToolbarButton
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
        title="실행 취소 (Ctrl+Z)"
      >
        <Undo className="w-3.5 h-3.5" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
        title="다시 실행 (Ctrl+Y)"
      >
        <Redo className="w-3.5 h-3.5" />
      </ToolbarButton>
      <Divider />

      {/* Headings */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        active={editor.isActive('heading', { level: 1 })}
        title="제목 1 (H1)"
      >
        <Heading1 className="w-3.5 h-3.5" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        active={editor.isActive('heading', { level: 2 })}
        title="제목 2 (H2)"
      >
        <Heading2 className="w-3.5 h-3.5" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        active={editor.isActive('heading', { level: 3 })}
        title="제목 3 (H3)"
      >
        <Heading3 className="w-3.5 h-3.5" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().setParagraph().run()}
        active={editor.isActive('paragraph')}
        title="본문"
      >
        <Type className="w-3.5 h-3.5" />
      </ToolbarButton>
      <Divider />

      {/* Text formatting */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive('bold')}
        title="굵게 (Ctrl+B)"
      >
        <Bold className="w-3.5 h-3.5" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive('italic')}
        title="기울임 (Ctrl+I)"
      >
        <Italic className="w-3.5 h-3.5" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        active={editor.isActive('underline')}
        title="밑줄 (Ctrl+U)"
      >
        <UnderlineIcon className="w-3.5 h-3.5" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={editor.isActive('strike')}
        title="취소선"
      >
        <Strikethrough className="w-3.5 h-3.5" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHighlight().run()}
        active={editor.isActive('highlight')}
        title="형광펜"
      >
        <Highlighter className="w-3.5 h-3.5" />
      </ToolbarButton>
      <Divider />

      {/* Alignment */}
      <ToolbarButton
        onClick={() => editor.chain().focus().setTextAlign('left').run()}
        active={editor.isActive({ textAlign: 'left' })}
        title="왼쪽 정렬"
      >
        <AlignLeft className="w-3.5 h-3.5" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().setTextAlign('center').run()}
        active={editor.isActive({ textAlign: 'center' })}
        title="가운데 정렬"
      >
        <AlignCenter className="w-3.5 h-3.5" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().setTextAlign('right').run()}
        active={editor.isActive({ textAlign: 'right' })}
        title="오른쪽 정렬"
      >
        <AlignRight className="w-3.5 h-3.5" />
      </ToolbarButton>
      <Divider />

      {/* Lists */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={editor.isActive('bulletList')}
        title="글머리 기호 목록"
      >
        <List className="w-3.5 h-3.5" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={editor.isActive('orderedList')}
        title="번호 매기기 목록"
      >
        <ListOrdered className="w-3.5 h-3.5" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        active={editor.isActive('taskList')}
        title="체크리스트"
      >
        <CheckSquare className="w-3.5 h-3.5" />
      </ToolbarButton>
      <Divider />

      {/* Code */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleCode().run()}
        active={editor.isActive('code')}
        title="인라인 코드 (`)"
      >
        <Code className="w-3.5 h-3.5" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        active={editor.isActive('codeBlock')}
        title="코드 블록"
      >
        <FileCode className="w-3.5 h-3.5" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        active={editor.isActive('blockquote')}
        title="인용문"
      >
        <Quote className="w-3.5 h-3.5" />
      </ToolbarButton>
      <Divider />

      {/* Extras */}
      <ToolbarButton onClick={setLink} active={editor.isActive('link')} title="링크 삽입">
        <LinkIcon className="w-3.5 h-3.5" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => {
          const url = window.prompt('이미지 URL을 입력하세요:');
          if (url) editor.chain().focus().setImage({ src: url }).run();
        }}
        title="이미지 삽입"
      >
        <ImageIcon className="w-3.5 h-3.5" />
      </ToolbarButton>
      <ToolbarButton onClick={insertTable} title="표 삽입">
        <TableIcon className="w-3.5 h-3.5" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        title="구분선"
      >
        <Minus className="w-3.5 h-3.5" />
      </ToolbarButton>

      <Divider />
      {/* 마크다운(.md) 가져오기 — 파일을 읽어 HTML 로 변환 후 커서 위치에 삽입 */}
      <ToolbarButton
        onClick={() => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.md,.markdown,.txt,text/markdown,text/plain';
          input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
              const text = await file.text();
              const html = await marked.parse(text, { async: true });
              editor.chain().focus().insertContent(html).run();
            } catch { /* 변환 실패 시 무시 */ }
          };
          input.click();
        }}
        title="마크다운(.md) 가져오기"
      >
        <FileUp className="w-3.5 h-3.5" />
      </ToolbarButton>

      {/* 문서 템플릿 삽입 (커서 위치에 삽입) */}
      <div className="relative">
        <ToolbarButton onClick={() => setTplOpen((v) => !v)} active={tplOpen} title="템플릿 삽입">
          <LayoutTemplate className="w-3.5 h-3.5" />
        </ToolbarButton>
        {tplOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setTplOpen(false)} aria-hidden />
            <div className="absolute left-0 top-full mt-1 z-50 w-64 rounded-lg border border-border bg-card shadow-lg py-1">
              <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">실무 템플릿</div>
              {DOC_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => {
                    editor.chain().focus().insertContent(tpl.html).run();
                    setTplOpen(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-secondary transition-colors"
                >
                  <div className="text-xs font-medium">{tpl.label}</div>
                  <div className="text-[10px] text-muted-foreground truncate">{tpl.description}</div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <Divider />
      {/* 배경색 선택 — 프리셋 + 커스텀(컬러 피커), localStorage 저장 */}
      <div className="flex items-center gap-0.5">
        {BG_PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            title={`배경색 ${c}`}
            onClick={() => onPickBg?.(c)}
            className={`w-5 h-5 rounded border ${bgColor === c ? 'ring-2 ring-primary ring-offset-1' : 'border-border'}`}
            style={{ backgroundColor: c }}
          />
        ))}
        <label
          title="배경색 직접 선택"
          className="relative inline-flex items-center justify-center w-7 h-7 rounded text-muted-foreground hover:bg-secondary hover:text-foreground cursor-pointer"
        >
          <Palette className="w-3.5 h-3.5" />
          <input
            type="color"
            value={bgColor ?? '#ffffff'}
            onChange={(e) => onPickBg?.(e.target.value)}
            className="absolute inset-0 opacity-0 cursor-pointer"
            aria-label="배경색 직접 선택"
          />
        </label>
        <ToolbarButton onClick={() => onPickBg?.(null)} title="배경 기본(테마)로 되돌리기">
          <Eraser className="w-3.5 h-3.5" />
        </ToolbarButton>
      </div>
    </div>
  );
}

export function RichTextEditor({
  value,
  onChange,
  placeholder = '내용을 입력하세요...',
  minHeight = '120px',
  onImagePaste,
  whiteBg = false,
}: RichTextEditorProps) {
  const isUpdatingFromProp = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: 'text-primary underline cursor-pointer hover:text-primary/80' },
      }),
      Image.configure({
        HTMLAttributes: { class: 'max-w-full rounded-lg my-2' },
      }),
      Placeholder.configure({ placeholder }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Highlight.configure({ multicolor: false }),
      TextStyle,
      Color,
    ],
    content: value || '',
    onUpdate: ({ editor: ed }) => {
      if (!isUpdatingFromProp.current) {
        const html = ed.getHTML();
        onChange(html === '<p></p>' ? '' : html);
      }
    },
    editorProps: {
      attributes: {
        class: 'focus:outline-none',
        style: `min-height: ${minHeight}; padding: 12px;`,
      },
    },
  });

  // Sync value from outside (edit mode)
  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    const incoming = value || '';
    if (current !== incoming && incoming !== (current === '<p></p>' ? '' : current)) {
      isUpdatingFromProp.current = true;
      editor.commands.setContent(incoming);
      isUpdatingFromProp.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // 에디터 배경색 — 사용자가 고른 색(localStorage). 없으면 whiteBg(흰색) → 테마 순.
  const [bgColor, setBgColor] = useState<string | null>(() => {
    try { return localStorage.getItem(EDITOR_BG_KEY); } catch { return null; }
  });
  const applyBg = useCallback((color: string | null) => {
    setBgColor(color);
    try {
      if (color) localStorage.setItem(EDITOR_BG_KEY, color);
      else localStorage.removeItem(EDITOR_BG_KEY);
    } catch { /* ignore */ }
  }, []);

  // Image paste handler
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData.items);
      const imageItems = items.filter((item) => item.type.startsWith('image/'));
      if (imageItems.length === 0) return;

      e.preventDefault();
      imageItems.forEach((item) => {
        const file = item.getAsFile();
        if (!file) return;
        // base64 가 본문에 박혀 DB 가 비대해지지 않도록 다운스케일+압축 후 삽입.
        compressImageFile(file)
          .then((dataUrl) => {
            if (!dataUrl) return;
            editor?.chain().focus().setImage({ src: dataUrl }).run();
            onImagePaste?.(dataUrl);
          })
          .catch(() => { /* 압축 실패 시 조용히 무시 */ });
      });
    },
    [editor, onImagePaste],
  );

  if (!editor) return null;

  // 우선순위: 사용자가 고른 bgColor > whiteBg(흰색) > 테마 배경
  const surfaceBg = bgColor || (whiteBg ? '#ffffff' : null);
  const surfaceText = surfaceBg ? (isDarkColor(surfaceBg) ? '#f4f4f5' : '#18181b') : undefined;

  return (
    <div
      className={`w-full border border-border rounded-lg overflow-hidden focus-within:ring-1 focus-within:ring-primary ${surfaceBg ? '' : 'bg-background'}`}
      style={surfaceBg ? { backgroundColor: surfaceBg } : undefined}
    >
      <Toolbar editor={editor} surfaceBg={surfaceBg} bgColor={bgColor} onPickBg={applyBg} />
      <div
        onPaste={handlePaste}
        style={surfaceBg ? { backgroundColor: surfaceBg, color: surfaceText } : undefined}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
