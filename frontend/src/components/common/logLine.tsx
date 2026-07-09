// 로그 라인 공용 렌더 헬퍼 — LogViewer 와 실시간 스트림 뷰(PodLogStream)가 공유.
// ANSI strip + 라인 레벨 분류 + 토큰 단위 inline 컬러. 색상은 컨테이너에 주입된
// CSS 변수(--log-*)를 참조한다 (터미널 테마 연동, useLogTheme).

// ── ANSI 이스케이프 제거 ──────────────────────────────────────────────────────
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// ── 토큰 단위 inline 컬러 ────────────────────────────────────────────────────
// IP / 상태코드 / true·false / boolean-ish 키워드 / 경로 / UUID / 숫자 등을
// 함께 칠해 가독성을 끌어올린다.

const TOKEN_RE = new RegExp([
  // boolean / null 류
  '\\b(true|false|null|None|nil)\\b',
  // 시간 — HH:MM:SS(.ms)
  '\\b\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?\\b',
  // ISO date — 2024-05-08 또는 2024-05-08T...
  '\\b\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)?\\b',
  // IPv4 (선택적 prefix /24)
  '\\b(?:\\d{1,3}\\.){3}\\d{1,3}(?:\\/\\d{1,2})?\\b',
  // HTTP status code 200~599 (단어 경계, 옆에 / 가 없는)
  '(?<![\\w/])[1-5]\\d{2}(?![\\w/])',
  // UUID
  '\\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\b',
  // 16진수 hash / id (8자 이상)
  '\\b0x[0-9a-fA-F]+\\b|\\b[0-9a-fA-F]{12,40}\\b',
  // 절대경로 — /usr/bin/foo, /var/log/...
  '(?<![\\w])/(?:[\\w.+\\-@]+/)+[\\w.+\\-@]+',
  // 강조 키워드 — 운영 도구 결과에서 자주 등장
  '\\b(ERROR|ERR|FATAL|PANIC|FAIL(?:ED)?|REFUSED|DENIED|TIMEOUT|UNAVAILABLE|CRITICAL)\\b',
  '\\b(WARN(?:ING)?|DEPRECATED|RETRY)\\b',
  '\\b(SUCCESS|SUCCESSFUL|SUCCEEDED|OK|READY|ACTIVE|RUNNING|HEALTHY|UP|STARTED|COMPLETED|ENABLED)\\b',
  '\\b(STOPPED|INACTIVE|DOWN|DISABLED|TERMINATED|EVICTED|KILLED|UNKNOWN)\\b',
  '\\b(INFO|NOTICE)\\b',
  '\\b(DEBUG|TRACE)\\b',
  // 따옴표로 감싼 문자열 (적당히 짧게)
  '"[^"\\n]{0,200}"',
  "'[^'\\n]{0,200}'",
  // 일반 정수/실수
  '\\b\\d+(?:\\.\\d+)?(?:ms|s|m|h|d|MB|GB|KB|B|%)?\\b',
].join('|'), 'g');

const TOKEN_GREEN  = /^(true|SUCCESS|SUCCESSFUL|SUCCEEDED|OK|READY|ACTIVE|RUNNING|HEALTHY|UP|STARTED|COMPLETED|ENABLED|NOTICE)$/;
const TOKEN_RED    = /^(false|ERROR|ERR|FATAL|PANIC|FAIL|FAILED|REFUSED|DENIED|TIMEOUT|UNAVAILABLE|CRITICAL)$/;
const TOKEN_AMBER  = /^(WARN|WARNING|DEPRECATED|RETRY|STOPPED|INACTIVE|DOWN|DISABLED|TERMINATED|EVICTED|KILLED|UNKNOWN)$/;
const TOKEN_SKY    = /^(INFO)$/;
const TOKEN_MUTED  = /^(DEBUG|TRACE|null|None|nil)$/;

export function classifyToken(tok: string): string {
  if (TOKEN_GREEN.test(tok))  return 'text-[color:var(--log-green)]';
  if (TOKEN_RED.test(tok))    return 'text-[color:var(--log-red)] font-semibold';
  if (TOKEN_AMBER.test(tok))  return 'text-[color:var(--log-amber)]';
  if (TOKEN_SKY.test(tok))    return 'text-[color:var(--log-sky)]';
  if (TOKEN_MUTED.test(tok))  return 'text-[color:var(--log-muted)]';
  // IPv4
  if (/^(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$/.test(tok)) return 'text-[color:var(--log-sky)]';
  // ISO date / time
  if (/^\d{4}-\d{2}-\d{2}/.test(tok) || /^\d{2}:\d{2}:\d{2}/.test(tok)) return 'text-[color:var(--log-muted)]';
  // HTTP status
  if (/^[1-5]\d{2}$/.test(tok)) {
    const n = parseInt(tok, 10);
    if (n >= 500) return 'text-[color:var(--log-red)] font-semibold';
    if (n >= 400) return 'text-[color:var(--log-amber)]';
    if (n >= 300) return 'text-[color:var(--log-sky)]';
    return 'text-[color:var(--log-green)]';
  }
  // UUID / hash
  if (/^[0-9a-fA-F]{12,}$/.test(tok) || /^0x[0-9a-fA-F]+$/.test(tok) || /^[0-9a-fA-F]{8}-/.test(tok)) {
    return 'text-[color:var(--log-purple)]';
  }
  // 경로
  if (tok.startsWith('/')) return 'text-[color:var(--log-cyan)]';
  // 따옴표 문자열
  if (tok.startsWith('"') || tok.startsWith("'")) return 'text-[color:var(--log-green)]';
  // 숫자 (단위 포함)
  if (/^\d/.test(tok)) return 'text-[color:var(--log-amber)]';
  return '';
}

export function tokenize(line: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(line)) !== null) {
    const start = m.index;
    if (start > last) out.push(line.slice(last, start));
    const tok = m[0];
    const cls = classifyToken(tok);
    out.push(cls ? <span key={`${start}-${tok}`} className={cls}>{tok}</span> : tok);
    last = TOKEN_RE.lastIndex;
    // 0-width match 방지 (정규식 특성)
    if (last === start) TOKEN_RE.lastIndex = start + 1;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

// ── 라인 레벨 분류 (에러/경고 라인 색) ───────────────────────────────────────

const LEVEL_STYLE: Array<{ re: RegExp; cls: string }> = [
  { re: /\b(FATAL|PANIC)\b/, cls: 'text-[color:var(--log-red)] font-semibold' },
  { re: /\b(ERROR|ERR)\b/,   cls: 'text-[color:var(--log-red)]' },
  { re: /\b(WARN(?:ING)?)\b/, cls: 'text-[color:var(--log-amber)]' },
  { re: /\b(INFO)\b/,         cls: 'text-[color:var(--log-sky)]' },
  { re: /\b(DEBUG|TRACE)\b/,  cls: 'text-[color:var(--log-muted)]' },
  { re: /\b(NOTICE)\b/,       cls: 'text-[color:var(--log-green)]' },
];

export function classifyLine(line: string): { cls: string } {
  for (const { re, cls } of LEVEL_STYLE) {
    if (re.test(line)) return { cls };
  }
  return { cls: '' };
}
