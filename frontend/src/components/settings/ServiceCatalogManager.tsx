import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Save, Loader2, BookOpen, ArrowUp, ArrowDown, Pencil } from 'lucide-react';
import type { ServiceCatalogEntry } from '@/types';
import { useUiSettings, useUpdateUiSettings } from '@/hooks/useUiSettings';
import { useToast, ClusterIconPicker } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import { SERVICE_CATALOG } from '@/components/services/serviceCatalog';
import { getServiceIcon, colorBadgeClass } from '@/hooks/useServiceCatalog';

const COLOR_OPTIONS = [
  'sky', 'amber', 'blue', 'orange', 'purple', 'red', 'cyan', 'emerald',
  'pink', 'violet', 'slate',
];

function deriveSlug(label: string): string {
  return label.trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 통합지식 메뉴와 task/issue 의 service tag 가 사용하는 서비스 카탈로그 편집기.
 *  ui_settings.serviceCatalog 에 저장된다. 비어있으면 정적 SERVICE_CATALOG 가 폴백. */
export function ServiceCatalogManager() {
  const toast = useToast();
  const { data: settings, isLoading } = useUiSettings();
  const updateMut = useUpdateUiSettings();

  const [draft, setDraft] = useState<ServiceCatalogEntry[]>([]);
  const [dirty, setDirty] = useState(false);
  const [slugTouched, setSlugTouched] = useState<Set<number>>(new Set());
  // ClusterIconPicker 를 띄울 대상 row 와 anchor 좌표 — null 이면 picker 닫힘.
  const [iconPickerIdx, setIconPickerIdx] = useState<number | null>(null);
  const [iconAnchor, setIconAnchor] = useState<DOMRect | null>(null);
  const iconButtonRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  // 서버 동기화 — 비어있으면 static 카탈로그를 시드.
  useEffect(() => {
    if (!settings || dirty) return;
    const list = settings.serviceCatalog;
    if (list && list.length > 0) {
      setDraft(list.map((s, i) => ({ ...s, sortOrder: s.sortOrder ?? i })));
    } else {
      setDraft(SERVICE_CATALOG.map((s, i) => ({
        slug: s.key,
        label: s.label,
        icon: s.icon?.displayName ?? '',
        color: s.color,
        description: s.description ?? '',
        sortOrder: i,
      })));
    }
  }, [settings, dirty]);

  const update = (idx: number, patch: Partial<ServiceCatalogEntry>) => {
    setDraft((d) => d.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
    setDirty(true);
  };
  const remove = (idx: number) => { setDraft((d) => d.filter((_, i) => i !== idx)); setDirty(true); };
  const add = () => {
    setDraft((d) => [...d, { slug: '', label: '', icon: '', color: 'slate', description: '', sortOrder: d.length }]);
    setDirty(true);
  };
  const move = (idx: number, dir: -1 | 1) => {
    setDraft((d) => {
      const next = [...d];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return d;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next.map((s, i) => ({ ...s, sortOrder: i }));
    });
    setDirty(true);
  };

  const handleSave = async () => {
    const seen = new Set<string>();
    const cleaned: ServiceCatalogEntry[] = [];
    for (let i = 0; i < draft.length; i++) {
      const s = draft[i];
      const label = (s.label || '').trim();
      if (!label) continue;
      const slug = ((s.slug || deriveSlug(label)) || '').trim();
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      cleaned.push({
        slug,
        label,
        icon: s.icon?.trim() || undefined,
        color: s.color || 'slate',
        description: s.description?.trim() || undefined,
        sortOrder: i,
      });
    }
    try {
      await updateMut.mutateAsync({ serviceCatalog: cleaned });
      toast.success('서비스 카탈로그 저장됨', `${cleaned.length}개 항목`);
      setDirty(false);
      setSlugTouched(new Set());
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  const handleReset = () => {
    if (settings?.serviceCatalog && settings.serviceCatalog.length > 0) {
      setDraft(settings.serviceCatalog.map((s) => ({ ...s })));
    } else {
      setDraft(SERVICE_CATALOG.map((s, i) => ({
        slug: s.key, label: s.label, icon: s.icon?.displayName ?? '',
        color: s.color, description: s.description ?? '', sortOrder: i,
      })));
    }
    setDirty(false);
    setSlugTouched(new Set());
  };

  const inputCls = 'w-full px-2 py-1 text-xs bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary';

  const usedSlugs = useMemo(() => {
    const m = new Map<string, number>();
    draft.forEach((s) => { const k = s.slug?.trim(); if (k) m.set(k, (m.get(k) ?? 0) + 1); });
    return m;
  }, [draft]);

  if (isLoading) {
    return <div className="bg-card border border-border rounded-xl p-4 text-xs text-muted-foreground">로딩 중…</div>;
  }

  return (
    <div className="bg-card border border-border rounded-xl">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold">서비스 카탈로그</h3>
          <span className="text-[10px] text-muted-foreground">
            통합지식 사이드바·task/issue 의 service tag 에 사용됨
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleReset} disabled={!dirty}
            className="px-3 py-1.5 text-xs bg-secondary hover:bg-secondary/80 border border-border rounded-lg disabled:opacity-40">
            되돌리기
          </button>
          <button onClick={handleSave} disabled={!dirty || updateMut.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50">
            {updateMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            저장
          </button>
        </div>
      </div>

      <div className="p-3 space-y-2 max-h-[60vh] overflow-y-auto">
        {draft.map((s, idx) => {
          const Icon = getServiceIcon(s.icon);
          const slugConflict = (s.slug || '').trim() && (usedSlugs.get(s.slug.trim()) ?? 0) > 1;
          return (
            <div key={idx} className={`grid grid-cols-12 gap-2 items-start p-2.5 border rounded-lg ${slugConflict ? 'border-red-500/40 bg-red-500/5' : 'border-border'}`}>
              <div className="col-span-1 flex items-center justify-center pt-1">
                <button
                  type="button"
                  ref={(el) => {
                    if (el) iconButtonRefs.current.set(idx, el);
                    else iconButtonRefs.current.delete(idx);
                  }}
                  onClick={(e) => {
                    setIconAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
                    setIconPickerIdx(idx);
                  }}
                  className={`inline-flex items-center justify-center w-7 h-7 rounded-lg border transition-all hover:ring-2 hover:ring-primary/30 ${colorBadgeClass(s.color || 'slate')}`}
                  title="아이콘 변경 (lucide / 이모지 / 이미지 업로드)"
                  aria-label="아이콘 변경"
                >
                  <Icon className="w-4 h-4" />
                </button>
              </div>
              <label className="col-span-3 block">
                <span className="block text-[10px] text-muted-foreground mb-0.5">라벨</span>
                <input value={s.label} onChange={(e) => {
                  update(idx, { label: e.target.value, slug: slugTouched.has(idx) ? s.slug : deriveSlug(e.target.value) });
                }}
                  placeholder="Kubernetes" className={inputCls} />
              </label>
              <label className="col-span-2 block">
                <span className="block text-[10px] text-muted-foreground mb-0.5">slug</span>
                <input value={s.slug} onChange={(e) => {
                  setSlugTouched((t) => new Set(t).add(idx));
                  update(idx, { slug: e.target.value });
                }}
                  placeholder="k8s" className={`${inputCls} font-mono`} />
                {slugConflict && <p className="text-[10px] text-red-500 mt-0.5">중복</p>}
              </label>
              <div className="col-span-2 block">
                <span className="block text-[10px] text-muted-foreground mb-0.5">아이콘</span>
                <button
                  type="button"
                  onClick={(e) => {
                    setIconAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
                    setIconPickerIdx(idx);
                  }}
                  className={`${inputCls} flex items-center gap-1.5 text-left hover:bg-secondary/40`}
                  title="아이콘 변경"
                >
                  <Pencil className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                  <span className="truncate text-[11px] font-mono">
                    {s.icon
                      ? s.icon.startsWith('data:image/')
                        ? '(업로드 이미지)'
                        : s.icon.length > 14
                          ? `${s.icon.slice(0, 14)}…`
                          : s.icon
                      : '기본'}
                  </span>
                </button>
              </div>
              <label className="col-span-2 block">
                <span className="block text-[10px] text-muted-foreground mb-0.5">색상</span>
                <select value={s.color || 'slate'} onChange={(e) => update(idx, { color: e.target.value })}
                  className={inputCls}>
                  {COLOR_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <div className="col-span-2 flex items-end justify-end gap-1 pt-4">
                <button onClick={() => move(idx, -1)} disabled={idx === 0}
                  className="p-1 rounded hover:bg-secondary text-muted-foreground disabled:opacity-30" title="위로">
                  <ArrowUp className="w-3 h-3" />
                </button>
                <button onClick={() => move(idx, 1)} disabled={idx === draft.length - 1}
                  className="p-1 rounded hover:bg-secondary text-muted-foreground disabled:opacity-30" title="아래로">
                  <ArrowDown className="w-3 h-3" />
                </button>
                <button onClick={() => remove(idx)}
                  className="p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-500" title="삭제">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="col-span-12 -mt-1">
                <input value={s.description ?? ''} onChange={(e) => update(idx, { description: e.target.value })}
                  placeholder="짧은 설명 (드롭다운 툴팁용)"
                  className={`${inputCls} text-[11px] text-muted-foreground`} />
              </div>
            </div>
          );
        })}
        <button onClick={add}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-primary/5 border border-dashed border-border hover:border-primary/40 rounded-lg">
          <Plus className="w-3.5 h-3.5" /> 서비스 추가
        </button>
      </div>

      {/* 아이콘 picker — 행의 아이콘 버튼 클릭 시 우측에 popover 로 노출 */}
      {iconPickerIdx !== null && (
        <ClusterIconPicker
          title="서비스 아이콘 선택"
          clusterName={draft[iconPickerIdx]?.label}
          value={draft[iconPickerIdx]?.icon}
          anchorRect={iconAnchor}
          onChange={(next) => {
            update(iconPickerIdx, { icon: next ?? '' });
          }}
          onClose={() => {
            setIconPickerIdx(null);
            setIconAnchor(null);
          }}
        />
      )}
    </div>
  );
}
