import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Save, Loader2, Layers, ChevronDown, Palette, X, Sparkles } from 'lucide-react';
import type { OperationLevelItem } from '@/types';
import {
  COLOR_OPTIONS,
  EMOJI_OPTIONS,
  levelBadgeClass,
  levelIcon,
  useOperationLevels,
  useUpdateOperationLevels,
} from '@/hooks/useOperationLevels';
import { deriveToneSet, isValidHex } from '@/lib/colorTone';
import { COLOR_PATTERNS } from '@/lib/colorPatterns';
import { useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';

/** 큐레이션 배색 프리셋(Burnt Sienna 등)에서 커스텀 hex 를 고르는 팝오버. */
function PatternColorPicker({ onPick }: { onPick: (hex: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="배색 패턴에서 선택"
        aria-label="배색 패턴에서 선택"
        className="flex items-center justify-center w-6 h-6 rounded border border-border text-muted-foreground hover:text-foreground hover:border-primary/40"
      >
        <Sparkles className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 left-0 w-64 p-2 bg-card border border-border rounded-lg shadow-lg space-y-2">
          {COLOR_PATTERNS.map((pattern) => (
            <div key={pattern.key}>
              <p className="text-[10px] text-muted-foreground mb-1">{pattern.label}</p>
              <div className="flex items-center gap-1">
                {pattern.colors.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    onClick={() => { onPick(hex); setOpen(false); }}
                    title={hex}
                    aria-label={`${pattern.label} ${hex}`}
                    style={{ backgroundColor: hex }}
                    className="w-5 h-5 rounded-full border border-border/60 hover:scale-110 transition-transform"
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EmojiPicker({
  value,
  fallback,
  onChange,
}: {
  value: string | undefined;
  fallback: string;
  onChange: (v: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const shown = value || fallback;
  const isAuto = !value;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-2 py-1 text-sm bg-background border border-border rounded hover:border-primary/40 transition-colors"
        title={isAuto ? `자동(${fallback}) — 클릭하여 변경` : `${shown} — 클릭하여 변경`}
      >
        <span className="text-base leading-none">{shown}</span>
        {isAuto && <span className="text-[10px] text-muted-foreground/70">auto</span>}
        <ChevronDown className="w-3 h-3 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 left-0 w-56 p-2 bg-card border border-border rounded-lg shadow-lg">
          <div className="grid grid-cols-5 gap-1">
            {EMOJI_OPTIONS.map((opt) => (
              <button
                key={opt.emoji}
                type="button"
                onClick={() => { onChange(opt.emoji); setOpen(false); }}
                title={opt.description}
                className={`p-1.5 text-lg rounded hover:bg-primary/10 transition-colors ${
                  value === opt.emoji ? 'bg-primary/15 ring-1 ring-primary/40' : ''
                }`}
              >
                {opt.emoji}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => { onChange(undefined); setOpen(false); }}
            className="mt-2 w-full px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary rounded"
          >
            자동 (운영레벨 기반 추론)
          </button>
        </div>
      )}
    </div>
  );
}

function deriveValue(label: string): string {
  return label.trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function OperationLevelsManager() {
  const toast = useToast();
  const { data: serverLevels, isLoading } = useOperationLevels();
  const updateMut = useUpdateOperationLevels();

  // 로컬 편집 버퍼 — 저장 전까지 서버에 반영되지 않음
  const [draft, setDraft] = useState<OperationLevelItem[]>([]);
  const [dirty, setDirty] = useState(false);
  const [valueTouched, setValueTouched] = useState<Set<number>>(new Set());

  // 서버 데이터 동기화 (저장 후 또는 첫 로드)
  useEffect(() => {
    if (serverLevels && !dirty) {
      setDraft(serverLevels.map((l) => ({ ...l })));
    }
  }, [serverLevels, dirty]);

  const update = (idx: number, patch: Partial<OperationLevelItem>) => {
    setDraft((d) => d.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
    setDirty(true);
  };

  const remove = (idx: number) => {
    setDraft((d) => d.filter((_, i) => i !== idx));
    setDirty(true);
  };

  const add = () => {
    setDraft((d) => [...d, { value: '', label: '', color: 'slate', icon: undefined }]);
    setDirty(true);
  };

  const move = (idx: number, dir: -1 | 1) => {
    setDraft((d) => {
      const next = [...d];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return d;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
    setDirty(true);
  };

  const handleSave = async () => {
    // value 자동 채우기
    const seen = new Set<string>();
    const cleaned: OperationLevelItem[] = [];
    for (const l of draft) {
      const label = l.label.trim();
      if (!label) continue;
      const value = (l.value || deriveValue(label)).trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      cleaned.push({
        value, label, color: l.color || 'slate', icon: l.icon || undefined,
        customHex: isValidHex(l.customHex) ? l.customHex : undefined,
      });
    }
    try {
      await updateMut.mutateAsync(cleaned);
      toast.success('운영레벨 저장됨', `${cleaned.length}개 항목`);
      setDirty(false);
      setValueTouched(new Set());
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  const handleReset = () => {
    if (serverLevels) setDraft(serverLevels.map((l) => ({ ...l })));
    setDirty(false);
    setValueTouched(new Set());
  };

  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-4">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
          <Layers className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold">운영레벨 관리</h2>
          <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
            클러스터 운영 단계 라벨/색상/이모지를 자유롭게 정의합니다. 여기서 정의한 항목은 클러스터 관리 페이지의
            "운영레벨" 컬럼/필터/모달과 클러스터 카드 이모지, 클러스터 아이콘 빌더의 테두리·배경 색에
            즉시 반영됩니다. <strong>value</strong> 는 저장된 식별자(라벨이 비어 있으면 자동 생성),
            <strong> label</strong> 은 화면 표시 이름, <strong>이모지</strong>는 클러스터 카드 앞에
            표시됩니다(자동 = 운영레벨 이름으로 추론). <Sparkles className="w-3 h-3 inline -mt-0.5" /> 아이콘을
            누르면 큐레이션 배색 패턴(Burnt Sienna 등)에서 커스텀 색을 바로 고를 수 있습니다.
          </p>
        </div>
      </div>

      <div className="border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-left">
            <tr className="text-xs text-muted-foreground uppercase">
              <th className="px-2 py-1.5 w-8"><span className="sr-only">순서</span></th>
              <th className="px-2 py-1.5">표시 라벨</th>
              <th className="px-2 py-1.5">value (식별자)</th>
              <th className="px-2 py-1.5">색상</th>
              <th className="px-2 py-1.5 w-24">이모지</th>
              <th className="px-2 py-1.5">미리보기</th>
              <th className="px-2 py-1.5 w-10"><span className="sr-only">작업</span></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={7} className="text-center py-6 text-sm text-muted-foreground">
                <Loader2 className="w-3 h-3 inline animate-spin mr-1" /> 로딩...
              </td></tr>
            )}
            {!isLoading && draft.map((l, idx) => (
              <tr key={idx} className="border-t border-border align-top">
                <td className="px-1 py-1 text-muted-foreground/60 text-center">
                  <div className="flex flex-col">
                    <button onClick={() => move(idx, -1)} disabled={idx === 0}
                      aria-label="위로 이동"
                      className="hover:text-foreground disabled:opacity-30 text-xs leading-none">▲</button>
                    <button onClick={() => move(idx, 1)} disabled={idx === draft.length - 1}
                      aria-label="아래로 이동"
                      className="hover:text-foreground disabled:opacity-30 text-xs leading-none">▼</button>
                  </div>
                </td>
                <td className="px-2 py-1">
                  <input value={l.label}
                    onChange={(e) => update(idx, { label: e.target.value })}
                    onBlur={() => {
                      // value 가 비어있으면 label 에서 자동 생성 (단, 사용자가 value 를 직접 만진 적 없을 때)
                      if (!l.value && !valueTouched.has(idx) && l.label.trim()) {
                        update(idx, { value: deriveValue(l.label) });
                      }
                    }}
                    placeholder="운영 (Production)"
                    aria-label="표시 라벨 입력"
                    className="w-full px-2 py-1 text-sm bg-background border border-border rounded" />
                </td>
                <td className="px-2 py-1">
                  <input value={l.value}
                    onChange={(e) => { setValueTouched((s) => new Set(s).add(idx)); update(idx, { value: e.target.value }); }}
                    placeholder="production"
                    aria-label="value 입력"
                    className="w-full px-2 py-1 text-xs font-mono bg-background border border-border rounded" />
                </td>
                <td className="px-2 py-1">
                  <select value={l.color}
                    onChange={(e) => update(idx, { color: e.target.value })}
                    className="w-full px-1 py-1 text-sm bg-background border border-border rounded">
                    {COLOR_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <div className="flex items-center gap-1 mt-1">
                    <label
                      className="relative flex items-center justify-center w-6 h-6 rounded border border-border cursor-pointer flex-shrink-0"
                      style={{ background: isValidHex(l.customHex) ? l.customHex : undefined }}
                      title="커스텀 색상 — 프리셋 대신 임의 hex 로 톤 자동 생성"
                    >
                      {!isValidHex(l.customHex) && <Palette className="w-3 h-3 text-muted-foreground" />}
                      <input
                        type="color"
                        value={isValidHex(l.customHex) ? l.customHex : '#94a3b8'}
                        onChange={(e) => update(idx, { customHex: e.target.value })}
                        className="absolute inset-0 opacity-0 cursor-pointer"
                      />
                    </label>
                    <PatternColorPicker onPick={(hex) => update(idx, { customHex: hex })} />
                    {isValidHex(l.customHex) && (
                      <>
                        <span className="text-[10px] font-mono text-muted-foreground">{l.customHex}</span>
                        <button type="button" onClick={() => update(idx, { customHex: undefined })}
                          title="커스텀 색상 해제 → 프리셋 사용"
                          className="p-0.5 rounded hover:bg-secondary text-muted-foreground hover:text-foreground">
                          <X className="w-3 h-3" />
                        </button>
                      </>
                    )}
                  </div>
                </td>
                <td className="px-2 py-1">
                  <EmojiPicker
                    value={l.icon}
                    fallback={levelIcon([{ value: l.value || 'auto', label: l.label, color: l.color }], l.value || 'auto')}
                    onChange={(v) => update(idx, { icon: v })}
                  />
                </td>
                <td className="px-2 py-1">
                  <span
                    className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${levelBadgeClass(l.color)}`}
                    style={isValidHex(l.customHex) ? (() => {
                      const { bg, ring, text } = deriveToneSet(l.customHex);
                      return { backgroundColor: bg, color: text, borderColor: ring };
                    })() : undefined}
                    aria-label={l.label || l.value || '미리보기'}
                  >
                    <span className="text-sm leading-none">
                      {l.icon || levelIcon([{ value: l.value || 'auto', label: l.label, color: l.color }], l.value || 'auto')}
                    </span>
                    <span>{l.label || l.value || '?'}</span>
                  </span>
                </td>
                <td className="px-2 py-1 text-right">
                  <button onClick={() => remove(idx)}
                    className="p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
            {!isLoading && draft.length === 0 && (
              <tr><td colSpan={7} className="text-center py-6 text-sm text-muted-foreground">
                운영레벨이 비어있습니다. "항목 추가" 로 시작하세요.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-2">
        <button onClick={add}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded-lg">
          <Plus className="w-3 h-3" /> 항목 추가
        </button>
        <div className="flex items-center gap-2">
          {dirty && (
            <button onClick={handleReset}
              className="px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg">
              되돌리기
            </button>
          )}
          <button onClick={handleSave}
            disabled={!dirty || updateMut.isPending}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50">
            {updateMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
