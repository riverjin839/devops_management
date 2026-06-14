import { useMemo, useState } from 'react';
import { X, Download, Loader2, FileSpreadsheet } from 'lucide-react';
import { versionsApi } from '@/services/api';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import { useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import type { ComponentSnapshot } from '@/services/api';

interface Props {
  open: boolean;
  clusterId: string;
  clusterName: string;
  components: ComponentSnapshot[];
  onClose: () => void;
}

type Detail = 'summary' | 'full' | 'none';

const DETAIL_META: Record<Detail, { label: string; description: string }> = {
  none:    { label: '메타만',  description: 'cluster · component · category · version · collected_at' },
  summary: { label: '요약',     description: '메타 + host · config_path · 주요 필드 brief (가장 자주 쓰는 옵션)' },
  full:    { label: '전체',     description: '요약 + data 전체를 JSON 으로 한 컬럼에' },
};

/** 현재 스냅샷을 CSV 로 내보낸다.
 *  - 디테일 레벨: none / summary / full
 *  - 카테고리 필터 (control_plane, kubelet, cni, os, storage, …)
 *  - 컴포넌트 멀티셀렉트는 카테고리만으로도 충분해 생략 (필요시 향후 확장)
 */
export function CsvExportModal({ open, clusterId, clusterName, components, onClose }: Props) {
  const toast = useToast();
  const [detail, setDetail] = useState<Detail>('summary');

  // 보유 카테고리 + 각 카테고리의 컴포넌트 개수
  const categoryStats = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of components) m.set(c.category || 'other', (m.get(c.category || 'other') ?? 0) + 1);
    return Array.from(m.entries()).sort();
  }, [components]);

  const [pickedCategories, setPickedCategories] = useState<Set<string>>(new Set());
  const toggleCat = (cat: string) => setPickedCategories((prev) => {
    const next = new Set(prev);
    if (next.has(cat)) next.delete(cat);
    else next.add(cat);
    return next;
  });
  const allCatsPicked = pickedCategories.size === 0; // empty = all

  const filteredCount = useMemo(() => {
    if (allCatsPicked) return components.length;
    return components.filter((c) => pickedCategories.has(c.category || 'other')).length;
  }, [components, pickedCategories, allCatsPicked]);

  const exportMut = useAbortableMutation({
    mutationFn: async (_: void, signal) => {
      const res = await versionsApi.exportCsv(clusterId, {
        detail,
        categories: allCatsPicked ? undefined : Array.from(pickedCategories),
      }, signal);
      return res.data as Blob;
    },
    onSuccess: (blob) => {
      const ts = new Date().toISOString().slice(0, 19).replace(/[:]/g, '-');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `versions-${clusterName}-${ts}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('CSV 다운로드', `${filteredCount}개 컴포넌트 · 디테일 ${DETAIL_META[detail].label}`);
      onClose();
    },
    onError: (e: unknown) => toast.error('CSV 내보내기 실패', formatApiError(e)),
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={() => !exportMut.isPending && onClose()} />
      <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-xl mx-4">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border bg-muted/30">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary/10 text-primary">
            <FileSpreadsheet className="w-4 h-4" />
          </div>
          <div className="flex-1">
            <h2 className="text-sm font-semibold">CSV 내보내기</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              현재 스냅샷을 CSV 한 파일로 다운로드. 한글 호환 UTF-8 BOM 포함.
            </p>
          </div>
          <button onClick={onClose} disabled={exportMut.isPending}
            className="p-1 rounded hover:bg-secondary text-muted-foreground disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* 디테일 레벨 */}
          <fieldset>
            <legend className="text-xs uppercase tracking-wider text-muted-foreground mb-2 block">
              디테일 레벨
            </legend>
            <div className="space-y-1.5">
              {(['summary', 'full', 'none'] as Detail[]).map((d) => (
                <label key={d}
                  className={`flex items-start gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                    detail === d
                      ? 'border-primary/50 bg-primary/5'
                      : 'border-border hover:bg-muted/30'
                  }`}>
                  <input type="radio" name="detail" checked={detail === d}
                    onChange={() => setDetail(d)} className="mt-0.5"
                    aria-label={DETAIL_META[d].label} />
                  <div className="flex-1">
                    <p className="text-sm font-semibold">{DETAIL_META[d].label}</p>
                    <p className="text-xs text-muted-foreground">{DETAIL_META[d].description}</p>
                  </div>
                </label>
              ))}
            </div>
          </fieldset>

          {/* 카테고리 필터 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs uppercase tracking-wider text-muted-foreground">
                카테고리 필터 ({allCatsPicked ? '전체' : `${pickedCategories.size}개`})
              </label>
              {!allCatsPicked && (
                <button onClick={() => setPickedCategories(new Set())}
                  className="text-xs text-primary hover:underline">전체로</button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {categoryStats.map(([cat, n]) => {
                const on = pickedCategories.has(cat);
                return (
                  <button key={cat} onClick={() => toggleCat(cat)}
                    className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                      on
                        ? 'bg-primary/10 text-primary border-primary/40'
                        : 'bg-secondary text-muted-foreground border-border hover:text-foreground'
                    }`}>
                    {cat} <span className="opacity-60">{n}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            예상 행수: <strong className="font-mono text-foreground">{filteredCount}</strong> 개 · 파일명{' '}
            <code className="font-mono text-foreground/80">versions-{clusterName}-…csv</code>
          </p>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/10">
          <button onClick={onClose} disabled={exportMut.isPending}
            className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg disabled:opacity-40">
            취소
          </button>
          {exportMut.isPending ? (
            <button onClick={exportMut.abort}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-red-500 text-primary-foreground rounded-lg">
              <Loader2 className="w-3 h-3 animate-spin" /> 중지
            </button>
          ) : (
            <button onClick={() => exportMut.mutate()}
              disabled={filteredCount === 0}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50">
              <Download className="w-3 h-3" /> 다운로드
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
