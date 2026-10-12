/**
 * 5필드 cron(분 시 일 월 요일) 해석 — 점검 매트릭스 주기 입력의 즉시 검증·사람 말 설명·다음 실행 미리보기.
 *
 * 서버(croniter, `check_matrix_service.validate_cron_min_interval`)가 최종 판정을 하지만, 예전엔 저장을
 * 눌러야만 오류 토스트로 알 수 있었고 "이 식이 언제 도는지" 를 화면에서 볼 방법이 없었다.
 * 계산은 기준 시간대(디스패처와 같은 `grid.timezone`, 기본 Asia/Seoul)의 벽시계 기준이다.
 */

export const MIN_CRON_INTERVAL_MINUTES = 5;
export const DEFAULT_CRON_TIMEZONE = 'Asia/Seoul';

interface FieldSpec { min: number; max: number; name: string }
const FIELDS: FieldSpec[] = [
  { min: 0, max: 59, name: '분' },
  { min: 0, max: 23, name: '시' },
  { min: 1, max: 31, name: '일' },
  { min: 1, max: 12, name: '월' },
  { min: 0, max: 7, name: '요일' },
];

export interface ParsedCron {
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
  raw: string[];
}

function parseField(token: string, spec: FieldSpec): number[] {
  const out = new Set<number>();
  for (const part of token.split(',')) {
    if (!part) throw new Error(`${spec.name} 필드가 비어 있습니다.`);
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`${spec.name} 간격 "${stepPart}" 이(가) 올바르지 않습니다.`);
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = spec.min; hi = spec.max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number);
      lo = a; hi = b;
    } else {
      lo = Number(rangePart);
      hi = stepPart === undefined ? lo : spec.max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < spec.min || hi > spec.max || lo > hi) {
      throw new Error(`${spec.name} 값 "${part}" 은(는) ${spec.min}~${spec.max} 범위여야 합니다.`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): ParsedCron {
  const raw = expr.trim().split(/\s+/);
  if (raw.length !== 5) throw new Error('cron 은 "분 시 일 월 요일" 5개 필드여야 합니다 (예: 15 9,13,18 * * *).');
  const [m, h, dom, mon, dow] = raw.map((t, i) => parseField(t, FIELDS[i]));
  return {
    minutes: m,
    hours: h,
    days: new Set(dom),
    months: new Set(mon),
    weekdays: new Set(dow.map((d) => (d === 7 ? 0 : d))),
    domRestricted: raw[2] !== '*',
    dowRestricted: raw[4] !== '*',
    raw,
  };
}

interface WallClock { y: number; mo: number; d: number; h: number; mi: number }

function nowInTimezone(tz: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute') };
}

/** 기준 시간대 벽시계로 다음 실행 시각 n 개 — UTC Date 를 "벽시계 값 그릇" 으로만 쓴다. */
export function nextRuns(expr: string, n = 3, tz = DEFAULT_CRON_TIMEZONE): Date[] {
  const c = parseCron(expr);
  const now = nowInTimezone(tz);
  const out: Date[] = [];
  const start = Date.UTC(now.y, now.mo - 1, now.d);
  for (let dayOffset = 0; dayOffset < 400 && out.length < n; dayOffset += 1) {
    const day = new Date(start + dayOffset * 86400000);
    const mo = day.getUTCMonth() + 1;
    if (!c.months.has(mo)) continue;
    const domOk = c.days.has(day.getUTCDate());
    const dowOk = c.weekdays.has(day.getUTCDay());
    // cron 규칙: 일·요일이 둘 다 지정되면 OR, 하나만 지정되면 그 하나만 본다.
    const dateOk = c.domRestricted && c.dowRestricted ? domOk || dowOk
      : c.domRestricted ? domOk : c.dowRestricted ? dowOk : true;
    if (!dateOk) continue;
    for (const h of c.hours) {
      for (const mi of c.minutes) {
        if (dayOffset === 0 && (h < now.h || (h === now.h && mi <= now.mi))) continue;
        out.push(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, mi)));
        if (out.length >= n) return out;
      }
    }
  }
  return out;
}

/** 서버와 같은 기준의 최소 간격 검사(연속 실행 표본의 최소 간격). */
export function minIntervalMinutes(expr: string, tz = DEFAULT_CRON_TIMEZONE): number | null {
  const runs = nextRuns(expr, 30, tz);
  if (runs.length < 2) return null;
  let min = Infinity;
  for (let i = 1; i < runs.length; i += 1) min = Math.min(min, (runs[i].getTime() - runs[i - 1].getTime()) / 60000);
  return min;
}

export interface CronCheck {
  ok: boolean;
  error?: string;
  description?: string;
  next: Date[];
}

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
const pad = (v: number) => String(v).padStart(2, '0');

/** 벽시계 Date(nextRuns 결과)를 "10/13(월) 09:15" 로. */
export function formatWallClock(d: Date): string {
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAY_KO[d.getUTCDay()]}) ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 흔한 형태만 사람 말로 — 그 밖은 "다음 실행" 목록이 설명을 대신한다. */
export function describeCron(expr: string): string | undefined {
  let c: ParsedCron;
  try { c = parseCron(expr); } catch { return undefined; }
  const [mRaw, hRaw, domRaw, monRaw, dowRaw] = c.raw;
  let datePart = '매일';
  if (dowRaw === '1-5' && domRaw === '*') datePart = '평일(월~금)';
  else if (c.dowRestricted && domRaw === '*') datePart = `매주 ${[...c.weekdays].sort().map((d) => WEEKDAY_KO[d]).join('·')}요일`;
  else if (c.domRestricted && dowRaw === '*') datePart = `매월 ${[...c.days].sort((a, b) => a - b).join('·')}일`;
  else if (c.domRestricted || c.dowRestricted) return undefined;
  if (monRaw !== '*') datePart = `${[...c.months].sort((a, b) => a - b).join('·')}월 ${datePart}`;

  const stepMin = /^\*\/(\d+)$/.exec(mRaw);
  if (stepMin && hRaw === '*') return `${datePart} ${stepMin[1]}분마다`;
  if (mRaw === '*' && hRaw === '*') return `${datePart} 매분`;
  const stepHour = /^\*\/(\d+)$/.exec(hRaw);
  if (c.minutes.length === 1 && stepHour) return `${datePart} ${stepHour[1]}시간마다 ${pad(c.minutes[0])}분`;
  if (c.minutes.length === 1 && hRaw === '*') return `${datePart} 매시 ${pad(c.minutes[0])}분`;
  if (c.minutes.length <= 4 && c.hours.length <= 6) {
    const times = c.hours.flatMap((h) => c.minutes.map((m) => `${pad(h)}:${pad(m)}`));
    return `${datePart} ${times.join(', ')}`;
  }
  return undefined;
}

/** 입력 검증 + 설명 + 다음 실행 3회 — 빈 값은 "주기 없음(수동 실행만)" 으로 유효. */
export function checkCron(expr: string, tz = DEFAULT_CRON_TIMEZONE): CronCheck {
  const v = expr.trim();
  if (!v) return { ok: true, next: [], description: '주기 없음 — 자동 실행하지 않습니다(수동 실행만).' };
  try {
    parseCron(v);
  } catch (e) {
    return { ok: false, error: (e as Error).message, next: [] };
  }
  const gap = minIntervalMinutes(v, tz);
  if (gap !== null && gap < MIN_CRON_INTERVAL_MINUTES) {
    return {
      ok: false,
      error: `실행 간격이 ${gap}분입니다 — 최소 ${MIN_CRON_INTERVAL_MINUTES}분 이상이어야 합니다(점검 부하 보호).`,
      next: [],
    };
  }
  const next = nextRuns(v, 3, tz);
  if (next.length === 0) return { ok: false, error: '앞으로 1년 안에 실행되는 시각이 없습니다.', next };
  return { ok: true, next, description: describeCron(v) };
}

export const CRON_PRESETS: { label: string; value: string }[] = [
  { label: '하루 3회 (09·13·18시)', value: '15 9,13,18 * * *' },
  { label: '매일 09:00', value: '0 9 * * *' },
  { label: '평일 09:00', value: '0 9 * * 1-5' },
  { label: '매시 정각', value: '0 * * * *' },
  { label: '30분마다', value: '*/30 * * * *' },
];

/** 시간대 표기용 짧은 이름 — Asia/Seoul → KST. */
export function timezoneLabel(tz = DEFAULT_CRON_TIMEZONE): string {
  if (tz === 'Asia/Seoul') return 'KST';
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
    return part?.value ?? tz;
  } catch {
    return tz;
  }
}
