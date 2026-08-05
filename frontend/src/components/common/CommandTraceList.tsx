import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { ExecOutputTabs } from './ExecOutputTabs';
import type { BatchJobCommandTrace } from '@/services/api';

/** 실측 명령 trace — 설계(런북/계획) 대비 실제로 나간 명령을 exit/duration/출력
 *  발췌와 함께 보여준다. 원래 BatchJobLogDetail 전용 로컬 컴포넌트였으나, SCP
 *  "다른 노드에서 불러오기" 등 다른 화면에서도 같은 shape(kind/command/exitCode/…)
 *  의 명령 trace 를 그대로 재사용하기 위해 공용으로 뺐다. */
export function CommandTraceList({ commands }: { commands: BatchJobCommandTrace[] }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  if (commands.length === 0) return null;
  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
        실행된 명령 ({commands.length})
      </p>
      <div className="space-y-1">
        {commands.map((c, i) => {
          const open = openIdx === i;
          const failed = c.exitCode !== 0 && c.exitCode !== null && c.exitCode !== undefined;
          const hasOutput = Boolean((c.stdout || '').trim() || (c.stderr || '').trim());
          return (
            <div key={i} className="border border-border rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => hasOutput && setOpenIdx(open ? null : i)}
                className={`w-full px-2 py-1.5 flex items-center gap-2 text-left ${hasOutput ? 'hover:bg-secondary/50 cursor-pointer' : 'cursor-default'}`}
              >
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground uppercase flex-shrink-0">
                  {c.kind}
                </span>
                <code className="flex-1 min-w-0 text-xs font-mono truncate" title={c.command}>
                  {c.command}
                </code>
                <span className={`text-[10px] font-mono flex-shrink-0 ${failed ? 'text-red-500 font-semibold' : 'text-muted-foreground'}`}>
                  {c.exitCode === null || c.exitCode === undefined ? 'exit —' : `exit ${c.exitCode}`}
                </span>
                <span className="text-[10px] font-mono text-muted-foreground tabular-nums flex-shrink-0">
                  {c.durationMs}ms
                </span>
                {hasOutput && (open
                  ? <ChevronUp className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                  : <ChevronDown className="w-3 h-3 text-muted-foreground flex-shrink-0" />)}
              </button>
              {open && (
                <div className="px-2 pb-2 border-t border-border pt-2">
                  <ExecOutputTabs stdout={c.stdout || ''} stderr={c.stderr} maxHeight="max-h-[160px]" />
                  {c.truncated && (
                    <p className="mt-1 text-[10px] text-muted-foreground">… 출력이 길어 발췌만 저장됨</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
