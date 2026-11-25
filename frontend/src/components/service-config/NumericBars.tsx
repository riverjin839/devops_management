// 수치형(int·size) 설정의 막대 비교 — 설정 값(편집 막대, 끌거나 키보드로 변경) · 노드 현재 값 · 기본값을 위아래로 나란히,
// 수치는 막대 오른쪽에 가로로. 막대 폭은 동적이라 인라인 스타일 대신 SVG `<rect width>` 로 그린다(DESIGN_SYSTEM §12 — Tailwind 만).
// 눈금은 0(또는 항목 최소) ~ 값들의 2배를 보기 좋은 수로 올린 값(또는 항목 최대). 끌어서 끝에 닿으면 눈금이 한 단계 늘어난다.
import { useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { ServiceConfigRow } from '@/types';
import { formatNum, GIB, MIB, parseNum } from './numericFormat';

/** 0 이상 값을 1·2·5 × 10ⁿ(size 는 2의 거듭제곱 MiB) 로 올림. */
function niceCeil(x: number, size: boolean): number {
  if (x <= 0) return size ? GIB : 10;
  if (size) {
    let v = MIB;
    while (v < x) v *= 2;
    return v;
  }
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

/** 끌 때 단위 — 눈금 폭의 약 1/200 을 1·2·5 × 10ⁿ(size 는 MiB 배수)로. 키보드 ←/→ 도 이 단위. */
function stepFor(span: number, size: boolean): number {
  const raw = span / 200;
  if (size) return Math.max(MIB, 2 ** Math.round(Math.log2(Math.max(raw, MIB) / MIB)) * MIB);
  if (raw <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
}

interface BarRowProps {
  label: string;
  value: number;
  lo: number;
  hi: number;
  text: string;
  tone: 'edit' | 'node' | 'default';
  warn?: boolean;
}

function frac(v: number, lo: number, hi: number): number {
  return Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1)));
}

function BarRow({ label, value, lo, hi, text, tone, warn }: BarRowProps) {
  const w = frac(value, lo, hi) * 300;
  const fill = tone === 'edit' ? 'fill-primary' : tone === 'node' ? 'fill-muted-foreground opacity-60' : 'fill-muted-foreground opacity-30';
  return (
    <div className="grid grid-cols-[2.25rem_1fr_7.5rem] items-center gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <svg viewBox="0 0 300 8" preserveAspectRatio="none" className="h-2 w-full" aria-hidden>
        <rect x="0" y="0" width="300" height="8" rx="4" className="fill-muted" />
        <rect x="0" y="0" width={w} height="8" rx="4" className={fill} />
      </svg>
      <span className={`font-mono text-xs truncate ${warn ? 'text-status-warning' : 'text-foreground'}`} title={text}>{text}</span>
    </div>
  );
}

interface Props {
  row: ServiceConfigRow;
  /** 지금 입력 값(초안 — 그룹 화면이면 비었을 때 기본 그룹 값). */
  value: string;
  editable: boolean;
  onChange: (v: string) => void;
}

/** 수치형이면 막대를 그린다. 값이 숫자가 아니면 null(호출자가 입력만 보여 준다). */
export function NumericBars({ row, value, editable, onChange }: Props) {
  const size = row.valueType === 'size';
  const cur = parseNum(value);
  const def = parseNum(row.defaultValue);
  const nodeGroups = row.current.groups
    .map((g) => ({ n: parseNum(g.value), nodes: g.nodes }))
    .filter((g): g is { n: number; nodes: string[] } => g.n != null);
  const minV = parseNum(row.minValue ?? null);
  const maxV = parseNum(row.maxValue ?? null);
  const lo = minV ?? 0;
  const peak = Math.max(cur ?? 0, def ?? 0, ...nodeGroups.map((g) => g.n));
  const [bump, setBump] = useState(0);  // 끌어서 끝에 닿을 때마다 눈금 한 단계 늘림
  const hi = maxV ?? niceCeil(Math.max(peak * 2, lo + 1) * 2 ** bump, size);
  const step = stepFor(hi - lo, size);
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  if (cur == null && def == null && nodeGroups.length === 0) return null;

  const clamp = (n: number) => Math.max(lo, Math.min(hi, n));
  const snap = (n: number) => clamp(Math.round(n / step) * step);
  const set = (n: number) => onChange(String(snap(n)));
  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r) return;
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    if (f > 0.98 && maxV == null) setBump((b) => Math.min(b + 1, 6));
    set(lo + f * (hi - lo));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const base = cur ?? def ?? lo;
    const delta: Record<string, number> = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: step * 10, PageDown: -step * 10 };
    if (e.key in delta) { e.preventDefault(); set(base + delta[e.key]); }
    else if (e.key === 'Home') { e.preventDefault(); set(lo); }
    else if (e.key === 'End') { e.preventDefault(); set(hi); }
  };
  const editW = frac(cur ?? 0, lo, hi) * 300;
  const shownNodes = nodeGroups.slice(0, 3);

  return (
    <div className="mt-1.5 space-y-1">
      <div className="grid grid-cols-[2.25rem_1fr_7.5rem] items-center gap-2">
        <span className="text-xs text-muted-foreground">설정</span>
        <div
          ref={trackRef}
          role={editable ? 'slider' : undefined}
          tabIndex={editable ? 0 : undefined}
          aria-label={`${row.key} 값 막대`}
          aria-valuemin={editable ? lo : undefined}
          aria-valuemax={editable ? hi : undefined}
          aria-valuenow={editable ? (cur ?? undefined) : undefined}
          aria-valuetext={cur != null ? formatNum(cur, size) : '값 없음'}
          onKeyDown={editable ? onKey : undefined}
          onPointerDown={editable ? (e) => { e.currentTarget.setPointerCapture(e.pointerId); setDragging(true); fromPointer(e); } : undefined}
          onPointerMove={editable && dragging ? fromPointer : undefined}
          onPointerUp={editable ? () => setDragging(false) : undefined}
          className={`relative py-1.5 rounded-xl focus:outline-none focus-visible:ring-1 focus-visible:ring-primary ${editable ? 'cursor-ew-resize touch-none' : ''}`}
        >
          <svg viewBox="0 0 300 8" preserveAspectRatio="none" className="h-2.5 w-full" aria-hidden>
            <rect x="0" y="0" width="300" height="8" rx="4" className="fill-muted" />
            {cur != null && <rect x="0" y="0" width={editW} height="8" rx="4" className="fill-primary" />}
            {editable && cur != null && <rect x={Math.max(0, Math.min(294, editW - 3))} y="0" width="6" height="8" rx="2" className="fill-foreground" />}
          </svg>
        </div>
        <span className="font-mono text-xs text-foreground truncate" title={cur != null ? String(cur) : undefined}>
          {cur != null ? formatNum(cur, size) : '—'}
        </span>
      </div>
      {shownNodes.length === 0 ? (
        <BarRow label="노드" value={lo} lo={lo} hi={hi} text="값 없음" tone="node" />
      ) : shownNodes.map((g) => (
        <BarRow key={g.n} label="노드" value={g.n} lo={lo} hi={hi} tone="node" warn={cur != null && g.n !== cur}
          text={`${formatNum(g.n, size)} · ${nodeGroups.length > 1 ? g.nodes.slice(0, 2).join(',') + (g.nodes.length > 2 ? '…' : '') : `${g.nodes.length}개`}`} />
      ))}
      {nodeGroups.length > shownNodes.length && (
        <p className="pl-[2.75rem] text-xs text-muted-foreground">외 {nodeGroups.length - shownNodes.length}가지 값</p>
      )}
      {def != null && <BarRow label="기본" value={def} lo={lo} hi={hi} text={formatNum(def, size)} tone="default" />}
      <div className="grid grid-cols-[2.25rem_1fr_7.5rem] gap-2 text-xs text-muted-foreground">
        <span />
        <span className="flex justify-between"><span>{formatNum(lo, size)}</span><span>{formatNum(hi, size)}</span></span>
        <span />
      </div>
    </div>
  );
}
