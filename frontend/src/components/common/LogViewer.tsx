import { useMemo, useState } from 'react';
import { Copy, Check, Search, WrapText } from 'lucide-react';
import { useLogTheme } from '@/hooks/useTerminalAppearance';
import { LogThemeButton } from './LogThemeButton';

type LogFormat = 'json' | 'journal' | 'table' | 'plain';

interface LogViewerProps {
  text: string;
  maxHeight?: string;         // 기본 max-h-96
  asError?: boolean;          // stderr 느낌으로 (붉은 톤)
  collapsible?: boolean;      // 긴 로그 접기 (기본 false)
  className?: string;
  filterOverride?: string;    // 외부에서 강제 필터 (상위 페이지의 global filter)
  hideToolbar?: boolean;      // 툴바 감춤 (상위가 직접 관리할 때)
}

// ── 포맷 자동 감지 ──────────────────────────────────────────────────────────

function detectFormat(text: string): LogFormat {
  const t = text.trim();
  if (!t) return 'plain';

  // JSON — { 또는 [ 로 시작 + 파싱 가능
  if (t[0] === '{' || t[0] === '[') {
    try {
      JSON.parse(t);
      return 'json';
    } catch { /* not valid json */ }
  }

  // etcdctl ASCII 테이블 — +---+---+ 또는 여러 줄이 | 로 시작
  const firstFewLines = t.split('\n', 5);
  if (firstFewLines.some((l) => /^\+[-+]+\+\s*$/.test(l.trim()))) {
    return 'table';
  }

  // journalctl — "Mon DD HH:MM:SS host unit[pid]: ..." 패턴
  //            또는 "-- Journal begins at ..."
  const journalHead = /^(?:--\s*(?:Journal|Logs)|[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s)/;
  if (firstFewLines.some((l) => journalHead.test(l))) {
    return 'journal';
  }

  return 'plain';
}

// ── ANSI 이스케이프 제거 ──────────────────────────────────────────────────────
// SSH/journalctl 결과에 ESC[31m 같은 컬러 코드가 섞여 들어오는 경우가 많아
// 시각적 노이즈를 만든다. 우리가 자체 syntax highlight 를 입히므로 strip.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*[A-Za-z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// ── 토큰 단위 inline 컬러 (PlainView / JournalView 에서 공용) ────────────────
// IP / 상태코드 / true·false / boolean-ish 키워드 / 경로 / UUID / 숫자 등을
// 함께 칠해 가독성을 끌어올린다. 라인 분류색(에러/경고)이 있으면 그 라인은
// 그 색을 우선시키되, 라벨/숫자 같은 "강조 후보" 만 토큰 색을 덮어쓴다.

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

// 색상은 LogViewer 컨테이너에 주입된 CSS 변수(--log-*)를 참조한다 (터미널 테마 연동).
function classifyToken(tok: string): string {
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

function tokenize(line: string): React.ReactNode[] {
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



function renderJsonLine(line: string, key: number): React.ReactNode {
  // 간단 토큰화 — key(파랑), string(초록), number/boolean(앰버), null(회색), punctuation
  const tokens: { cls: string; text: string }[] = [];
  const re = /"([^"\\]|\\.)*"\s*:|"([^"\\]|\\.)*"|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|[{}[\],]/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > lastIndex) {
      tokens.push({ cls: '', text: line.slice(lastIndex, m.index) });
    }
    const tok = m[0];
    if (tok.endsWith(':')) {
      tokens.push({ cls: 'text-[color:var(--log-sky)]', text: tok });
    } else if (tok.startsWith('"')) {
      tokens.push({ cls: 'text-[color:var(--log-green)]', text: tok });
    } else if (tok === 'true' || tok === 'false') {
      tokens.push({ cls: 'text-[color:var(--log-amber)]', text: tok });
    } else if (tok === 'null') {
      tokens.push({ cls: 'text-[color:var(--log-muted)]', text: tok });
    } else if (/^-?\d/.test(tok)) {
      tokens.push({ cls: 'text-[color:var(--log-amber)]', text: tok });
    } else {
      tokens.push({ cls: 'text-[color:var(--log-muted)]', text: tok });
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < line.length) {
    tokens.push({ cls: '', text: line.slice(lastIndex) });
  }
  return (
    <div key={key}>
      {tokens.map((t, i) => <span key={i} className={t.cls}>{t.text}</span>)}
    </div>
  );
}

function JsonView({ text }: { text: string }) {
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch { /* fall through with raw text */ }
  return (
    <>
      {pretty.split('\n').map(renderJsonLine)}
    </>
  );
}

// ── Journalctl highlight ───────────────────────────────────────────────────

const LEVEL_STYLE: Array<{ re: RegExp; cls: string }> = [
  { re: /\b(FATAL|PANIC)\b/, cls: 'text-[color:var(--log-red)] font-semibold' },
  { re: /\b(ERROR|ERR)\b/,   cls: 'text-[color:var(--log-red)]' },
  { re: /\b(WARN(?:ING)?)\b/, cls: 'text-[color:var(--log-amber)]' },
  { re: /\b(INFO)\b/,         cls: 'text-[color:var(--log-sky)]' },
  { re: /\b(DEBUG|TRACE)\b/,  cls: 'text-[color:var(--log-muted)]' },
  { re: /\b(NOTICE)\b/,       cls: 'text-[color:var(--log-green)]' },
];

function classifyLine(line: string): { cls: string } {
  for (const { re, cls } of LEVEL_STYLE) {
    if (re.test(line)) return { cls };
  }
  return { cls: '' };
}

function renderJournalLine(line: string, key: number): React.ReactNode {
  const { cls } = classifyLine(line);
  // 타임스탬프 / 호스트 / unit 색칠
  // 예: "Apr 21 14:23:01 node-01 etcd[1234]: ..."
  const m = line.match(/^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+([^:]+):\s?(.*)$/);
  if (m) {
    const [, ts, host, unit, rest] = m;
    return (
      <div key={key} className={cls}>
        <span className="text-[color:var(--log-muted)]">{ts}</span>{' '}
        <span className="text-[color:var(--log-muted)]">{host}</span>{' '}
        <span className="text-[color:var(--log-purple)]">{unit}:</span>{' '}
        <span>{tokenize(rest)}</span>
      </div>
    );
  }
  return <div key={key} className={cls}>{line ? tokenize(line) : ' '}</div>;
}

function JournalView({ text }: { text: string }) {
  return <>{text.split('\n').map(renderJournalLine)}</>;
}

// ── ASCII Table — 보더는 흐리게, 헤더는 강조 ──────────────────────────────

function renderTableLine(line: string, key: number, isHeader: boolean): React.ReactNode {
  // +---+ 구분선 약하게
  if (/^\+[-+]+\+\s*$/.test(line.trim())) {
    return <div key={key} className="text-border">{line}</div>;
  }
  if (line.trim().startsWith('|')) {
    // | col1 | col2 | → 구분자만 약하게
    const parts = line.split('|');
    return (
      <div key={key} className={isHeader ? 'text-foreground font-semibold' : ''}>
        {parts.map((p, i) => (
          <span key={i}>
            {i > 0 && <span className="text-border">|</span>}
            <span>{p}</span>
          </span>
        ))}
      </div>
    );
  }
  return <div key={key}>{line || ' '}</div>;
}

function TableView({ text }: { text: string }) {
  const lines = text.split('\n');
  // etcdctl 테이블은 첫 `+---+` 다음 줄이 header
  let borderCount = 0;
  return (
    <>
      {lines.map((l, i) => {
        if (/^\+[-+]+\+\s*$/.test(l.trim())) borderCount++;
        const isHeader = borderCount === 1 && /^\s*\|/.test(l);
        return renderTableLine(l, i, isHeader);
      })}
    </>
  );
}

// ── Plain + keyword highlight ──────────────────────────────────────────────

function PlainView({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, i) => {
        const { cls } = classifyLine(line);
        return <div key={i} className={cls}>{line ? tokenize(line) : ' '}</div>;
      })}
    </>
  );
}

// ── 메인 컴포넌트 ────────────────────────────────────────────────────────────

export function LogViewer({
  text, maxHeight = 'max-h-96', asError = false, collapsible = false, className = '',
  filterOverride, hideToolbar = false,
}: LogViewerProps) {
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);
  const [localFilter, setLocalFilter] = useState('');
  const [collapsed, setCollapsed] = useState(collapsible);
  const { style: themeStyle } = useLogTheme();

  // 상위가 제어하면 그걸 쓰고, 아니면 자체 필터
  const filter = filterOverride !== undefined ? filterOverride : localFilter;

  // ANSI escape 제거된 텍스트를 한 번만 계산해 모든 view 가 공유.
  const cleanText = useMemo(() => stripAnsi(text), [text]);
  const fmt = useMemo(() => detectFormat(cleanText), [cleanText]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return cleanText;
    const q = filter.toLowerCase();
    return cleanText.split('\n').filter((l) => l.toLowerCase().includes(q)).join('\n');
  }, [cleanText, filter]);

  const formatLabel = (
    { json: 'JSON', journal: 'journal', table: 'table', plain: 'plain' } as const
  )[fmt];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard 거절 */ }
  };

  const lineCount = text.split('\n').length;
  const isEmpty = !text.trim();

  if (isEmpty) {
    return (
      <div className={`rounded-md border border-border bg-background p-3 text-sm text-muted-foreground ${className}`}>
        (empty)
      </div>
    );
  }

  return (
    <div className={`rounded-md border border-border bg-background overflow-hidden ${className}`}>
      {/* 툴바 */}
      {!hideToolbar && (
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border bg-muted/30 text-xs">
        <span className="px-1.5 py-0.5 rounded bg-secondary text-muted-foreground uppercase tracking-wider">
          {formatLabel}
        </span>
        <span className="text-muted-foreground">{lineCount} lines · {text.length}B</span>
        {filterOverride !== undefined && filterOverride.trim() && (
          <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/30">
            global filter: "{filterOverride}"
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {filterOverride === undefined && (
            <div className="relative">
              <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
              <input
                value={localFilter}
                onChange={(e) => setLocalFilter(e.target.value)}
                placeholder="필터..."
                className="pl-6 pr-2 py-0.5 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary w-32"
              />
            </div>
          )}
          <button
            onClick={() => setWrap((v) => !v)}
            title={wrap ? '줄바꿈 해제' : '줄바꿈'}
            className={`p-1 rounded hover:bg-secondary ${wrap ? 'text-primary' : 'text-muted-foreground'}`}
          >
            <WrapText className="w-3 h-3" />
          </button>
          <button
            onClick={copy}
            title="복사"
            className="p-1 rounded hover:bg-secondary text-muted-foreground"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          </button>
          <LogThemeButton />
          {collapsible && (
            <button
              onClick={() => setCollapsed((v) => !v)}
              className="px-1.5 py-0.5 text-xs rounded border border-border bg-secondary hover:bg-secondary/80"
            >
              {collapsed ? '펼치기' : '접기'}
            </button>
          )}
        </div>
      </div>
      )}

      {/* 본문 */}
      {!collapsed && (
        <pre
          style={themeStyle}
          className={`text-xs font-mono leading-relaxed px-3 py-2 overflow-auto ${maxHeight} ${
            wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'
          } ${asError ? 'text-[color:var(--log-red)]' : 'text-foreground/90'}`}
        >
          {fmt === 'json'    ? <JsonView    text={filtered} />
          : fmt === 'journal' ? <JournalView text={filtered} />
          : fmt === 'table'   ? <TableView   text={filtered} />
          :                     <PlainView   text={filtered} />}
        </pre>
      )}
    </div>
  );
}
