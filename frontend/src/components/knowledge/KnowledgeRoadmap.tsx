import { useMemo, useState } from 'react';
import { useSprints } from '@/hooks/useSprints';
import type { KnowledgePage } from '@/types';

type Bucket = 'year' | 'quarter' | 'month' | 'week' | 'sprint';
const BUCKETS: { value: Bucket; label: string }[] = [
  { value: 'year', label: '년' },
  { value: 'quarter', label: '분기' },
  { value: 'month', label: '월' },
  { value: 'week', label: '주' },
  { value: 'sprint', label: '스프린트' },
];

interface Props {
  items: KnowledgePage[];
  onOpen: (id: string) => void;
}

const DAY = 86_400_000;

function ts(v?: string | null): number | null {
  if (!v) return null;
  const d = new Date(v).getTime();
  return isNaN(d) ? null : d;
}

/** 항목의 기간 [start, end] — 한쪽만 있으면 하루 폭으로 보정. */
function span(p: KnowledgePage): { start: number; end: number } | null {
  const s = ts(p.startAt);
  const e = ts(p.dueAt);
  if (s == null && e == null) return null;
  const start = s ?? (e as number);
  const end = e ?? (s as number);
  return { start: Math.min(start, end), end: Math.max(start, end) + DAY };
}

function startOf(t: number, bucket: Bucket): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  if (bucket === 'year') return new Date(d.getFullYear(), 0, 1).getTime();
  if (bucket === 'quarter') return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1).getTime();
  if (bucket === 'month') return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  // week → 월요일 시작
  const day = (d.getDay() + 6) % 7;
  return d.getTime() - day * DAY;
}

function ticksFor(rangeStart: number, rangeEnd: number, bucket: Bucket): { label: string; pos: number }[] {
  const out: { label: string; pos: number }[] = [];
  const total = rangeEnd - rangeStart || 1;
  let cur = startOf(rangeStart, bucket);
  let guard = 0;
  while (cur <= rangeEnd && guard < 400) {
    const d = new Date(cur);
    let label = '';
    if (bucket === 'year') label = `${d.getFullYear()}`;
    else if (bucket === 'quarter') label = `${d.getFullYear()} Q${Math.floor(d.getMonth() / 3) + 1}`;
    else if (bucket === 'month') label = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
    else label = `${d.getMonth() + 1}/${d.getDate()}`;
    out.push({ label, pos: ((cur - rangeStart) / total) * 100 });
    // 다음 틱
    if (bucket === 'year') cur = new Date(d.getFullYear() + 1, 0, 1).getTime();
    else if (bucket === 'quarter') cur = new Date(d.getFullYear(), d.getMonth() + 3, 1).getTime();
    else if (bucket === 'month') cur = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    else cur += 7 * DAY;
    guard += 1;
  }
  return out;
}

function fmtRange(p: KnowledgePage): string {
  const s = p.startAt?.slice(0, 10);
  const e = p.dueAt?.slice(0, 10);
  if (s && e) return `${s} ~ ${e}`;
  return s || e || '';
}

export function KnowledgeRoadmap({ items, onOpen }: Props) {
  const [bucket, setBucket] = useState<Bucket>('quarter');
  const { data: sprintsData } = useSprints();
  const sprints = sprintsData?.data ?? [];
  const sprintName = (id?: string | null) => sprints.find((s) => s.id === id)?.name ?? '미배정';

  const dated = useMemo(() => items.filter((p) => span(p)), [items]);

  const range = useMemo(() => {
    const spans = dated.map(span).filter(Boolean) as { start: number; end: number }[];
    if (!spans.length) {
      const y = new Date().getFullYear();
      return { start: new Date(y, 0, 1).getTime(), end: new Date(y, 11, 31).getTime() };
    }
    const min = Math.min(...spans.map((s) => s.start));
    const max = Math.max(...spans.map((s) => s.end));
    return { start: startOf(min, bucket === 'sprint' ? 'month' : bucket), end: max + DAY };
  }, [dated, bucket]);

  const ticks = useMemo(
    () => (bucket === 'sprint' ? [] : ticksFor(range.start, range.end, bucket)),
    [range, bucket],
  );
  const total = range.end - range.start || 1;
  const todayPos = ((Date.now() - range.start) / total) * 100;

  // sprint 모드: 스프린트별 그룹(스윔레인)
  const bySprint = useMemo(() => {
    if (bucket !== 'sprint') return [];
    const map = new Map<string, KnowledgePage[]>();
    for (const p of items) {
      const key = p.sprintId ?? '__none__';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return Array.from(map.entries());
  }, [items, bucket]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs text-muted-foreground">보기:</span>
        {BUCKETS.map((b) => (
          <button
            key={b.value}
            type="button"
            onClick={() => setBucket(b.value)}
            className={`px-2.5 py-1 rounded-lg text-sm border transition-colors ${
              bucket === b.value ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border hover:bg-secondary'
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>

      {bucket === 'sprint' ? (
        <div className="space-y-3">
          {bySprint.length === 0 && <p className="text-sm text-muted-foreground py-8 text-center">일정/스프린트가 지정된 고도화 항목이 없습니다.</p>}
          {bySprint.map(([sid, list]) => (
            <div key={sid} className="border border-border rounded-xl overflow-hidden">
              <div className="px-3 py-1.5 bg-muted/40 text-sm font-medium">{sid === '__none__' ? '미배정' : sprintName(sid)} <span className="text-muted-foreground font-normal">({list.length})</span></div>
              <div className="divide-y divide-border/50">
                {list.map((p) => (
                  <button key={p.id} onClick={() => onOpen(p.id)} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-secondary">
                    <span className="truncate flex-1">{p.title}</span>
                    <span className="text-xs text-muted-foreground shrink-0">{fmtRange(p)}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : dated.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">일정(시작/완료 예정일)이 지정된 고도화 항목이 없습니다.<br />문서 메타에서 시작·완료 예정일을 설정하세요.</p>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[640px]">
            {/* 타임라인 헤더 */}
            <div className="relative h-6 border-b border-border mb-1 ml-48">
              {ticks.map((t, i) => (
                <div key={i} className="absolute top-0 text-[11px] text-muted-foreground -translate-x-1/2" style={{ left: `${t.pos}%` }}>
                  <div className="h-2 w-px bg-border mx-auto" />
                  {t.label}
                </div>
              ))}
            </div>
            {/* 막대들 */}
            <div className="space-y-1 relative">
              {/* 오늘 라인 */}
              {todayPos >= 0 && todayPos <= 100 && (
                <div className="absolute top-0 bottom-0 w-px bg-rose-400/70 z-10" style={{ left: `calc(12rem + ${todayPos}% * (100% - 12rem) / 100)` }} aria-hidden />
              )}
              {dated.map((p) => {
                const sp = span(p)!;
                const left = ((sp.start - range.start) / total) * 100;
                const width = Math.max(((sp.end - sp.start) / total) * 100, 1.2);
                return (
                  <div key={p.id} className="flex items-center gap-2 h-7">
                    <button onClick={() => onOpen(p.id)} className="w-48 shrink-0 truncate text-left text-sm hover:text-primary" title={p.title}>
                      {p.title}
                    </button>
                    <div className="relative flex-1 h-5">
                      <button
                        onClick={() => onOpen(p.id)}
                        title={`${p.title}\n${fmtRange(p)}`}
                        className="absolute top-0 h-5 rounded bg-primary/80 hover:bg-primary text-[11px] text-primary-foreground px-1 truncate text-left"
                        style={{ left: `${left}%`, width: `${width}%` }}
                      >
                        {p.title}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
