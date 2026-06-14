import { useState } from 'react';
import { Bug, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { useDebugStore, type DebugPageKey } from '@/stores/debugStore';

interface Props {
  pageKey: DebugPageKey;
  /** 부가 정보로 렌더할 상태 — 객체를 그대로 JSON 덤프 */
  extra?: Record<string, unknown>;
}

const KIND_CLS: Record<string, string> = {
  request:  'text-sky-400',
  response: 'text-emerald-400',
  error:    'text-red-400',
  info:     'text-muted-foreground',
};

/** React child 로 안전하게 렌더 가능한 형태로 변환.
 *  객체/배열이 message·url 등에 들어오면 minified error #31 을 일으키므로 방어. */
function safeText(v: unknown, fallback = '-'): string {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return fallback;
  }
}

/** 페이지 상단 또는 하단에 부착하는 접이식 debug 패널.
 *  `settings → Debug` 탭에서 해당 페이지가 켜져야만 렌더된다.
 *  global 도 같이 켜져 있어야 API 호출 로그가 흐른다 (interceptor가 전역 플래그 기반).
 */
export function DebugLogPanel({ pageKey, extra }: Props) {
  const enabledMap = useDebugStore((s) => s.enabled);
  const events = useDebugStore((s) => s.events);
  const clearEvents = useDebugStore((s) => s.clearEvents);
  const [collapsed, setCollapsed] = useState(false);

  if (!enabledMap[pageKey]) return null;
  const globalOn = !!enabledMap.global;

  return (
    <div className="bg-card border border-amber-500/30 rounded-xl overflow-hidden mb-3">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/5 border-b border-amber-500/20">
        <Bug className="w-3.5 h-3.5 text-amber-400" />
        <span className="text-xs font-semibold text-amber-400">Debug — {pageKey}</span>
        {!globalOn && (
          <span className="text-xs text-muted-foreground">
            (Settings → Debug → "전역" 을 켜야 API 호출이 기록됩니다)
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button onClick={clearEvents}
            className="px-1.5 py-0.5 text-xs rounded hover:bg-secondary flex items-center gap-1 text-muted-foreground">
            <Trash2 className="w-3 h-3" /> clear
          </button>
          <button onClick={() => setCollapsed((c) => !c)}
            className="p-0.5 rounded hover:bg-secondary text-muted-foreground">
            {collapsed ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
          </button>
        </div>
      </div>
      {!collapsed && (
        <>
          {extra && Object.keys(extra).length > 0 && (
            <div className="px-3 py-2 border-b border-border/50 bg-muted/10">
              <p className="text-xs text-muted-foreground uppercase mb-1">context</p>
              <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-all">
                {JSON.stringify(extra, null, 2)}
              </pre>
            </div>
          )}
          <div className="max-h-64 overflow-auto">
            {events.length === 0 ? (
              <div className="text-center py-4 text-xs text-muted-foreground">
                이벤트 없음. API 호출을 실행해 보세요.
              </div>
            ) : (
              <table className="w-full text-xs font-mono">
                <thead className="bg-muted/30 text-left text-xs text-muted-foreground sticky top-0">
                  <tr>
                    <th className="px-2 py-1">time</th>
                    <th className="px-2 py-1">kind</th>
                    <th className="px-2 py-1">method</th>
                    <th className="px-2 py-1">url</th>
                    <th className="px-2 py-1">status</th>
                    <th className="px-2 py-1">ms</th>
                    <th className="px-2 py-1">message</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => {
                    const urlText = safeText(e.url);
                    const messageText = safeText(e.message);
                    return (
                      <tr key={e.id} className="border-b border-border/30">
                        <td className="px-2 py-0.5 text-muted-foreground">
                          {new Date(e.ts).toISOString().slice(11, 23)}
                        </td>
                        <td className={`px-2 py-0.5 ${KIND_CLS[e.kind] ?? ''}`}>{e.kind}</td>
                        <td className="px-2 py-0.5">{safeText(e.method)}</td>
                        <td className="px-2 py-0.5 max-w-[280px] truncate" title={urlText}>
                          {urlText}
                        </td>
                        <td className="px-2 py-0.5">{safeText(e.status)}</td>
                        <td className="px-2 py-0.5">{safeText(e.durationMs)}</td>
                        <td className="px-2 py-0.5 max-w-[300px] truncate" title={messageText}>
                          {messageText}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
