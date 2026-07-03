import { useEffect, useRef, useState } from 'react';
import { FileSpreadsheet, Loader2, ChevronDown } from 'lucide-react';
import { nodeImagesApi } from '@/services/api';
import { useToast } from '@/components/common/Toast';
import { formatApiError } from '@/lib/utils';

type SortOption = 'default' | 'size' | 'lines';

const OPTIONS: { value: SortOption; label: string; hint: string }[] = [
  { value: 'default', label: '노드 순서', hint: '수집된 순서 그대로' },
  { value: 'size', label: '용량 기준', hint: '이미지 용량(bytes) 내림차순' },
  { value: 'lines', label: '라인 수 기준', hint: '노드당 이미지 개수 내림차순' },
];

/** "CSV ▾" — 노드 이미지 목록을 CSV 로 내보낸다. 정렬 기준(노드 순서/용량/라인 수) 선택. */
export function NodeImagesCsvExportMenu({ clusterId, disabled }: { clusterId: string; disabled?: boolean }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<SortOption | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const run = async (sort: SortOption) => {
    setBusy(sort);
    setOpen(false);
    try {
      const res = await nodeImagesApi.exportCsv(clusterId, sort);
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `node-images-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error('CSV 내보내기 실패', formatApiError(e, '노드 이미지 CSV 내보내기 중 오류가 발생했습니다.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={boxRef} className="relative" data-export-ignore>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || busy !== null}
        title="노드 이미지 목록을 CSV 로 내보내기"
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-border bg-card disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />}
        CSV <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute right-0 mt-1 z-50 min-w-[200px] rounded-lg border border-border bg-card shadow-lg py-1">
          {OPTIONS.map(({ value, label, hint }) => (
            <button
              key={value}
              onClick={() => run(value)}
              title={hint}
              className="w-full flex flex-col items-start gap-0.5 px-3 py-1.5 text-left hover:bg-muted/40"
            >
              <span className="text-sm text-foreground">{label}</span>
              <span className="text-xs text-muted-foreground">{hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
