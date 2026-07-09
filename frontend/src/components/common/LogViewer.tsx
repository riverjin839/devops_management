import { useMemo, useState } from 'react';
import { Copy, Check, Search, WrapText } from 'lucide-react';
import { useLogTheme } from '@/hooks/useTerminalAppearance';
import { LogThemeButton } from './LogThemeButton';
import { classifyLine, stripAnsi, tokenize } from './logLine';

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

// ANSI strip / 토큰 컬러 / 라인 분류는 logLine.tsx 공용 헬퍼 사용 (스트림 뷰와 공유).

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
