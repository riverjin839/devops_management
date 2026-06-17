import { useEffect, useRef, useState, type RefObject } from 'react';
import { FileDown, FileText, Image, Presentation, Loader2, ChevronDown } from 'lucide-react';
import { exportElement, type ExportFormat } from '@/lib/exportView';
import { useToast } from '@/components/common/Toast';

interface ExportMenuProps {
  /** 캡처할 화면 요소 ref. */
  targetRef: RefObject<HTMLElement | null>;
  /** 파일명 베이스(날짜는 자동 부여). */
  filenameBase: string;
  disabled?: boolean;
}

const ITEMS: { fmt: ExportFormat; label: string; icon: typeof FileText }[] = [
  { fmt: 'pdf', label: 'PDF', icon: FileText },
  { fmt: 'pptx', label: 'PPT', icon: Presentation },
  { fmt: 'png', label: 'PNG 이미지', icon: Image },
];

/** "내보내기 ▾" — 현재 화면을 PDF/PPT/PNG 로 추출(화면 디자인 그대로). 어느 페이지서든 재사용. */
export function ExportMenu({ targetRef, filenameBase, disabled }: ExportMenuProps) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const run = async (fmt: ExportFormat) => {
    const el = targetRef.current;
    if (!el) return;
    setBusy(fmt);
    setOpen(false);
    try {
      const today = new Date().toISOString().slice(0, 10);
      await exportElement(el, fmt, `${filenameBase}-${today}`);
    } catch (e) {
      toast.error('내보내기 실패', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={boxRef} className="relative" data-export-ignore>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || busy !== null}
        title="현재 화면을 PDF/PPT/PNG 로 추출"
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-border bg-card disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />}
        내보내기 <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute right-0 mt-1 z-50 min-w-[140px] rounded-lg border border-border bg-card shadow-lg py-1">
          {ITEMS.map(({ fmt, label, icon: Icon }) => (
            <button
              key={fmt}
              onClick={() => run(fmt)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-foreground hover:bg-muted/40 text-left"
            >
              <Icon className="w-3.5 h-3.5 text-muted-foreground" /> {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
