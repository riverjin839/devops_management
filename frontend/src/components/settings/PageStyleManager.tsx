import { useEffect, useMemo, useState } from 'react';
import { RotateCcw, Save, X } from 'lucide-react';
import { useUiSettings, useUpdateUiSettings } from '@/hooks/useUiSettings';
import { useServiceCatalog } from '@/hooks/useServiceCatalog';
import { useToast } from '@/components/common';
import { NAV_MAP, GROUPS } from '@/components/layout/navConfig';
import {
  PAGE_STYLE_DEFAULT_KEY,
  PAGE_FONT_OPTIONS,
  PAGE_FONT_SCALES,
  pageStyleToCss,
  hasAnyStyle,
} from '@/lib/pageStyles';
import type { PageStyle } from '@/types';

/** 빈 문자열 / scale 1 / undefined 제거 → 실제 지정된 필드만 남긴다. */
function cleanStyle(s: PageStyle): PageStyle {
  const out: PageStyle = {};
  if (s.fontFamily) out.fontFamily = s.fontFamily;
  if (s.fontScale && s.fontScale !== 1) out.fontScale = s.fontScale;
  if (s.textColor) out.textColor = s.textColor;
  if (s.bgColor) out.bgColor = s.bgColor;
  return out;
}

/**
 * 페이지(라우트)별 화면 스타일 편집 — 전체 기본(__default__) + 페이지별 덮어쓰기.
 * ui_settings.pageStyles(서버)에 저장된다(모든 사용자 공통).
 */
export function PageStyleManager() {
  const { data: settings } = useUiSettings();
  const updateSettings = useUpdateUiSettings();
  const services = useServiceCatalog();
  const toast = useToast();

  const navLabels = settings?.navLabels || {};
  const pageStyles = useMemo(() => settings?.pageStyles || {}, [settings?.pageStyles]);

  // 대상 페이지 목록 — 전체 기본 + 그룹별 라우트.
  const servicePaths = useMemo(
    () => services.filter((s) => s.key !== 'other').map((s) => ({ path: `/services/${s.key}`, label: s.label })),
    [services],
  );
  const labelOf = (path: string) => navLabels[path] || NAV_MAP[path]?.defaultLabel || path;

  const targets = useMemo(() => {
    const groups: { group: string; items: { key: string; label: string }[] }[] = [
      { group: '공통', items: [{ key: PAGE_STYLE_DEFAULT_KEY, label: '전체 기본 (모든 페이지)' }] },
    ];
    for (const g of GROUPS) {
      const items = [
        ...g.paths.filter((p) => NAV_MAP[p]).map((p) => ({ key: p, label: labelOf(p) })),
        ...(g.id === 'services' ? servicePaths.map((s) => ({ key: s.path, label: s.label })) : []),
      ];
      if (items.length) groups.push({ group: g.label, items });
    }
    return groups;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servicePaths, navLabels]);

  const [target, setTarget] = useState<string>(PAGE_STYLE_DEFAULT_KEY);
  const [draft, setDraft] = useState<PageStyle>({});

  // 대상 변경 또는 서버 값 변경 시 draft 동기화.
  useEffect(() => {
    setDraft(pageStyles[target] ?? {});
  }, [target, pageStyles]);

  const dirty = JSON.stringify(cleanStyle(draft)) !== JSON.stringify(cleanStyle(pageStyles[target] ?? {}));

  const set = <K extends keyof PageStyle>(key: K, value: PageStyle[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = () => {
    const next = { ...pageStyles };
    const cleaned = cleanStyle(draft);
    if (Object.keys(cleaned).length) next[target] = cleaned;
    else delete next[target];
    updateSettings.mutate(
      { pageStyles: next },
      { onSuccess: () => toast.success('화면 스타일이 저장되었습니다.'), onError: () => toast.error('저장에 실패했습니다.') },
    );
  };

  const resetTarget = () => {
    setDraft({});
    const next = { ...pageStyles };
    delete next[target];
    updateSettings.mutate(
      { pageStyles: next },
      { onSuccess: () => toast.success('이 페이지 설정을 초기화했습니다.') },
    );
  };

  const targetLabel = targets.flatMap((g) => g.items).find((i) => i.key === target)?.label ?? target;

  return (
    <div className="rounded-md border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-muted/40">
        <h3 className="text-sm font-semibold">페이지별 화면 스타일</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          폰트 · 글자 크기 · 글자색 · 배경색을 페이지별로 지정합니다. &lsquo;전체 기본&rsquo; 위에 페이지별 설정이 덮어써집니다. (서버 저장 · 모든 사용자 공통)
        </p>
      </div>

      <div className="px-4 py-3 space-y-4">
        {/* 대상 페이지 선택 */}
        <div>
          <span className="block text-xs text-muted-foreground/70 mb-1 uppercase tracking-wider">대상 페이지</span>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="w-full max-w-md text-sm px-2.5 py-1.5 rounded-lg border border-border bg-background"
          >
            {targets.map((g) => (
              <optgroup key={g.group} label={g.group}>
                {g.items.map((i) => (
                  <option key={i.key} value={i.key}>
                    {i.label}{hasAnyStyle(pageStyles[i.key]) ? ' ●' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
          {/* 폰트 */}
          <div>
            <span className="block text-xs text-muted-foreground/70 mb-1 uppercase tracking-wider">폰트</span>
            <select
              value={draft.fontFamily ?? ''}
              onChange={(e) => set('fontFamily', e.target.value || undefined)}
              className="w-full text-sm px-2.5 py-1.5 rounded-lg border border-border bg-background"
            >
              {PAGE_FONT_OPTIONS.map((f) => (
                <option key={f.label} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>

          {/* 글자 크기 */}
          <div>
            <span className="block text-xs text-muted-foreground/70 mb-1 uppercase tracking-wider">글자 크기</span>
            <select
              value={draft.fontScale != null ? String(draft.fontScale) : ''}
              onChange={(e) => set('fontScale', e.target.value ? Number(e.target.value) : undefined)}
              className="w-full text-sm px-2.5 py-1.5 rounded-lg border border-border bg-background"
            >
              <option value="">기본 (100%)</option>
              {PAGE_FONT_SCALES.filter((s) => s.value !== 1).map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>

          {/* 글자색 */}
          <div>
            <span className="block text-xs text-muted-foreground/70 mb-1 uppercase tracking-wider">글자색</span>
            <ColorField
              value={draft.textColor}
              fallback="#1e293b"
              onChange={(v) => set('textColor', v)}
            />
          </div>

          {/* 배경색 */}
          <div>
            <span className="block text-xs text-muted-foreground/70 mb-1 uppercase tracking-wider">배경색</span>
            <ColorField
              value={draft.bgColor}
              fallback="#ffffff"
              onChange={(v) => set('bgColor', v)}
            />
          </div>
        </div>

        {/* 미리보기 */}
        <div>
          <p className="text-xs text-muted-foreground/70 mb-1 uppercase tracking-wider">미리보기 — {targetLabel}</p>
          <div className="rounded-lg border border-border p-4" style={pageStyleToCss(cleanStyle(draft))}>
            <p className="text-base font-semibold">가나다라 ABCDdefg 0123 — 제목 텍스트</p>
            <p className="text-sm opacity-80 mt-1">이 페이지의 본문은 이렇게 표시됩니다. 폰트 · 크기 · 글자색 · 배경색이 적용됩니다.</p>
          </div>
        </div>

        {/* 액션 */}
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={save}
            disabled={!dirty || updateSettings.isPending}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Save className="w-3.5 h-3.5" /> 저장
          </button>
          <button
            type="button"
            onClick={resetTarget}
            disabled={!hasAnyStyle(pageStyles[target]) || updateSettings.isPending}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-border bg-secondary text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RotateCcw className="w-3.5 h-3.5" /> 이 페이지 초기화
          </button>
        </div>
      </div>
    </div>
  );
}

/** hex 색 입력 — 미지정 시 '+ 지정', 지정 시 color picker + 해제(x). */
function ColorField({ value, fallback, onChange }: { value?: string; fallback: string; onChange: (v: string | undefined) => void }) {
  if (!value) {
    return (
      <button
        type="button"
        onClick={() => onChange(fallback)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-dashed border-border text-sm text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
      >
        + 색 지정
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-9 h-9 rounded-md border border-border bg-transparent cursor-pointer p-0.5"
        aria-label="색 선택"
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-24 text-sm font-mono px-2 py-1.5 rounded-lg border border-border bg-background"
      />
      <button
        type="button"
        onClick={() => onChange(undefined)}
        title="색 해제(기본값 사용)"
        className="p-1 rounded hover:bg-secondary text-muted-foreground"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
