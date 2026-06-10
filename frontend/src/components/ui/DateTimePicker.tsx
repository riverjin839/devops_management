/**
 * Date (+ optional time) picker (popover).
 *
 *  - Trigger button shows the current value (or placeholder) with an icon.
 *  - Popover: mini calendar (left) + time controls (right).
 *  - **시간 포함 토글** — 켜면 시:분 선택, 끄면 날짜만. 시간 UX 는 드롭다운(시/분) +
 *    빠른 프리셋(09:00 / 13:00 / 18:00)으로 단순화.
 *  - Value format:
 *      "YYYY-MM-DDTHH:mm"  (시간 포함)
 *      "YYYY-MM-DD"        (날짜 전용 — 'T' 없음으로 인코딩)
 *    → datetime-local drop-in. 날짜 전용도 서버 datetime 으로 자정 파싱됨.
 *  - Outside click & ESC close; arrow keys navigate the calendar grid.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  KeyboardEvent,
} from 'react';
import { Calendar, Clock, X } from 'lucide-react';

interface DateTimePickerProps {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Allow clearing to an empty string. Default true. */
  clearable?: boolean;
  className?: string;
}

const KOR_DOW = ['일', '월', '화', '수', '목', '금', '토'];
const KOR_MONTH = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];
const TIME_PRESETS: { label: string; h: number; m: number }[] = [
  { label: '09:00', h: 9, m: 0 },
  { label: '13:00', h: 13, m: 0 },
  { label: '18:00', h: 18, m: 0 },
];

const pad = (n: number) => String(n).padStart(2, '0');

function hasTime(v: string): boolean {
  return /T\d{2}:\d{2}/.test(v);
}

function formatValue(d: Date, withTime: boolean): string {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
}

function parseValue(v: string): Date | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(v);
  if (!m) return null;
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
  );
  return isNaN(d.getTime()) ? null : d;
}

function displayValue(v: string): string {
  const d = parseValue(v);
  if (!d) return '';
  const base = `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
  return hasTime(v) ? `${base} ${pad(d.getHours())}:${pad(d.getMinutes())}` : base;
}

function buildMonthGrid(year: number, month: number): Date[] {
  // 6 rows × 7 cols starting from the Sunday of the first week.
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function DateTimePicker({
  value,
  onChange,
  id,
  required,
  disabled,
  placeholder = '날짜 선택',
  clearable = true,
  className = '',
}: DateTimePickerProps) {
  const auto = useId();
  const triggerId = id ?? auto;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const parsed = useMemo(() => parseValue(value), [value]);
  const [viewYear, setViewYear] = useState(() => (parsed ?? new Date()).getFullYear());
  const [viewMonth, setViewMonth] = useState(() => (parsed ?? new Date()).getMonth());
  const [hour, setHour] = useState(() => (parsed ?? new Date()).getHours());
  const [minute, setMinute] = useState(() => (parsed ?? new Date()).getMinutes());
  // 시간 포함 여부 — 값에 'T' 가 있으면 포함. 빈 값/신규는 기본 미포함(날짜만).
  // 시간이 필요하면 "시간 포함" 체크박스로 옵션 추가.
  const [withTime, setWithTime] = useState(() => (value ? hasTime(value) : false));

  // Sync internal state when external value changes (e.g., form reset / hydrate).
  useEffect(() => {
    if (parsed) {
      setViewYear(parsed.getFullYear());
      setViewMonth(parsed.getMonth());
      setHour(parsed.getHours());
      setMinute(parsed.getMinutes());
    }
    if (value) setWithTime(hasTime(value));
  }, [parsed, value]);

  // Outside click + ESC.
  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDocPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const grid = useMemo(() => buildMonthGrid(viewYear, viewMonth), [viewYear, viewMonth]);
  const today = new Date();

  const minuteOptions = useMemo(() => {
    const base = Array.from({ length: 12 }, (_, i) => i * 5);
    return base.includes(minute) ? base : [...base, minute].sort((a, b) => a - b);
  }, [minute]);

  /** 현재 선택 날짜(parsed)에 h:m 을 적용해 emit. 날짜 미선택이면 no-op. */
  const emit = (h: number, m: number, withT: boolean) => {
    if (!parsed) return;
    const d = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), h, m);
    onChange(formatValue(d, withT));
  };

  const commit = (d: Date) => {
    const next = new Date(d);
    next.setHours(hour, minute, 0, 0);
    onChange(formatValue(next, withTime));
  };

  const pickDay = (d: Date) => {
    if (d.getMonth() !== viewMonth) {
      setViewYear(d.getFullYear());
      setViewMonth(d.getMonth());
    }
    commit(d);
  };

  const setNow = () => {
    const now = new Date();
    setViewYear(now.getFullYear());
    setViewMonth(now.getMonth());
    setHour(now.getHours());
    setMinute(now.getMinutes());
    setWithTime(true);
    onChange(formatValue(now, true));
  };

  const toggleWithTime = (on: boolean) => {
    setWithTime(on);
    emit(on ? hour : 0, on ? minute : 0, on);
  };

  const clear = () => {
    onChange('');
    setOpen(false);
    triggerRef.current?.focus();
  };

  const stepMonth = (delta: number) => {
    const m = viewMonth + delta;
    const y = viewYear + Math.floor(m / 12);
    setViewMonth(((m % 12) + 12) % 12);
    setViewYear(y);
  };

  const onGridKeyDown = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    let next = idx;
    if (e.key === 'ArrowLeft') next = idx - 1;
    else if (e.key === 'ArrowRight') next = idx + 1;
    else if (e.key === 'ArrowUp') next = idx - 7;
    else if (e.key === 'ArrowDown') next = idx + 7;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pickDay(grid[idx]);
      return;
    } else return;
    e.preventDefault();
    if (next < 0 || next > 41) return;
    const cell = rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-day-cell]')[next];
    cell?.focus();
  };

  const display = displayValue(value);
  const selectClass =
    'h-7 px-1.5 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary tabular-nums';

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        id={triggerId}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-center gap-2 px-2.5 py-1.5 bg-background border rounded-md text-xs text-left transition-colors ${
          open ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-border'
        } focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        <Calendar className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        <span className={`flex-1 ${display ? '' : 'text-muted-foreground/60'}`}>
          {display || placeholder}
        </span>
        {clearable && display && !disabled && (
          <span
            role="button"
            tabIndex={-1}
            aria-label="지우기"
            onClick={(e) => {
              e.stopPropagation();
              clear();
            }}
            className="p-0.5 text-muted-foreground hover:text-foreground rounded"
          >
            <X className="w-3 h-3" />
          </span>
        )}
      </button>

      {/* Hidden input keeps native form-required validation working. */}
      {required && (
        <input
          tabIndex={-1}
          aria-hidden
          required
          value={value}
          onChange={() => {}}
          className="sr-only absolute inset-0 opacity-0 pointer-events-none"
        />
      )}

      {open && (
        <div
          role="dialog"
          aria-label="날짜 선택"
          className="absolute z-50 mt-1.5 bg-card border border-border rounded-xl mac-shadow p-3 w-[340px] flex gap-3"
          style={{ left: 0 }}
        >
          {/* Calendar */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-2">
              <button
                type="button"
                onClick={() => stepMonth(-1)}
                className="px-2 py-1 text-xs rounded hover:bg-secondary text-muted-foreground"
                aria-label="이전 달"
              >
                ‹
              </button>
              <span className="text-sm font-semibold">
                {viewYear}년 {KOR_MONTH[viewMonth]}
              </span>
              <button
                type="button"
                onClick={() => stepMonth(1)}
                className="px-2 py-1 text-xs rounded hover:bg-secondary text-muted-foreground"
                aria-label="다음 달"
              >
                ›
              </button>
            </div>
            <div className="grid grid-cols-7 gap-0.5 mb-1">
              {KOR_DOW.map((d, i) => (
                <div
                  key={d}
                  className={`text-center text-[10px] font-medium ${
                    i === 0 ? 'text-red-400' : i === 6 ? 'text-blue-400' : 'text-muted-foreground'
                  }`}
                >
                  {d}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-0.5">
              {grid.map((d, i) => {
                const isCurMonth = d.getMonth() === viewMonth;
                const isToday = isSameDay(d, today);
                const isSelected = parsed && isSameDay(d, parsed);
                const dow = d.getDay();
                return (
                  <button
                    key={i}
                    type="button"
                    data-day-cell
                    onClick={() => pickDay(d)}
                    onKeyDown={(e) => onGridKeyDown(e, i)}
                    className={`text-xs h-7 rounded transition-colors ${
                      isSelected
                        ? 'bg-primary text-primary-foreground font-semibold'
                        : isToday
                          ? 'bg-secondary text-foreground font-semibold ring-1 ring-primary/40'
                          : isCurMonth
                            ? `hover:bg-secondary ${dow === 0 ? 'text-red-400' : dow === 6 ? 'text-blue-400' : 'text-foreground'}`
                            : 'text-muted-foreground/40 hover:bg-secondary/40'
                    }`}
                  >
                    {d.getDate()}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Time */}
          <div className="flex-shrink-0 w-[116px] border-l border-border pl-3 flex flex-col">
            {/* 시간 포함 토글 */}
            <label className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground mb-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={withTime}
                onChange={(e) => toggleWithTime(e.target.checked)}
                className="accent-primary"
              />
              <Clock className="w-3 h-3" /> 시간 포함
            </label>

            {withTime ? (
              <div className="space-y-2">
                <div className="flex items-center gap-1">
                  <select
                    aria-label="시"
                    value={hour}
                    onChange={(e) => { const h = Number(e.target.value); setHour(h); emit(h, minute, true); }}
                    className={`${selectClass} flex-1`}
                  >
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>{pad(h)}시</option>
                    ))}
                  </select>
                  <select
                    aria-label="분"
                    value={minute}
                    onChange={(e) => { const m = Number(e.target.value); setMinute(m); emit(hour, m, true); }}
                    className={`${selectClass} flex-1`}
                  >
                    {minuteOptions.map((m) => (
                      <option key={m} value={m}>{pad(m)}분</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-wrap gap-1">
                  {TIME_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => { setHour(p.h); setMinute(p.m); setWithTime(true); emit(p.h, p.m, true); }}
                      className="px-1.5 py-0.5 text-[10px] rounded bg-secondary hover:bg-secondary/80 text-muted-foreground hover:text-foreground"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground/70 leading-relaxed">날짜만 저장됩니다. 시간이 필요하면 위 체크박스를 켜세요.</p>
            )}

            <div className="mt-auto pt-2 border-t border-border space-y-1">
              <button
                type="button"
                onClick={setNow}
                className="w-full px-2 py-1 text-[11px] rounded bg-primary/10 hover:bg-primary/20 text-primary font-medium"
              >
                지금
              </button>
              {clearable && (
                <button
                  type="button"
                  onClick={clear}
                  className="w-full px-2 py-1 text-[11px] rounded hover:bg-secondary text-muted-foreground"
                >
                  지우기
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                className="w-full px-2 py-1 text-[11px] rounded bg-secondary hover:bg-secondary/80 font-medium"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
