import { Loader2, Play, Settings2 } from 'lucide-react';
import type { IsilonCommand } from '@/types';
import { useIsilonCommands } from '@/hooks/useIsilonNfs';
import { ISILON_SECTION_LABEL } from './sectionLabels';

interface Props {
  serverId?: string;
  selectedKeys: Set<string>;
  onToggle: (key: string) => void;
  onSelectAll: (keys: string[]) => void;
  onClear: () => void;
  onRun: () => void;
  onManage: () => void;
  running: boolean;
}

/** 글로벌 기본 + 서버 오버라이드를 key 기준으로 병합(서버 전용 우선), enabled 만, sortOrder 순 — 백엔드 `effective_commands` 와 동일한 규칙. */
function mergeEffective(commands: IsilonCommand[]): IsilonCommand[] {
  const byKey = new Map<string, IsilonCommand>();
  for (const c of commands) {
    const existing = byKey.get(c.key);
    if (!existing || (existing.serverId == null && c.serverId != null)) {
      byKey.set(c.key, c);
    }
  }
  return [...byKey.values()]
    .filter((c) => c.enabled)
    .sort((a, b) => (a.sortOrder - b.sortOrder) || a.key.localeCompare(b.key));
}

/**
 * mc 클라이언트의 프리셋 선택 패턴 — 등록된 isi 명령(§UI-First 로 DB/화면에서 관리)을
 * 일괄 실행하지 않고, 체크박스로 원하는 것만 골라(중복 선택 가능) "선택 실행" 한다.
 */
export function IsilonCommandSelector({
  serverId, selectedKeys, onToggle, onSelectAll, onClear, onRun, onManage, running,
}: Props) {
  const { data: commands = [], isLoading } = useIsilonCommands(serverId);
  const effective = mergeEffective(commands);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">등록된 isi 명령 중 선택 (복수 선택 가능)</span>
        <button
          onClick={onManage}
          className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-border hover:bg-muted"
        >
          <Settings2 className="w-3.5 h-3.5" /> 명령 관리
        </button>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-6 text-center"><Loader2 className="w-4 h-4 animate-spin inline" /> 불러오는 중…</div>
      ) : effective.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">활성화된 명령이 없습니다. 명령 관리에서 등록/활성화하세요.</p>
      ) : (
        <ul className="space-y-1.5 max-h-[420px] overflow-y-auto pr-0.5">
          {effective.map((c) => (
            <li key={c.key}>
              <label
                aria-label={c.label}
                className="flex items-start gap-2 rounded-xl border border-border px-2.5 py-2 hover:bg-muted transition cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selectedKeys.has(c.key)}
                  onChange={() => onToggle(c.key)}
                  className="mt-0.5 accent-primary"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium truncate">{c.label}</span>
                    <span className="ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      {ISILON_SECTION_LABEL[c.section] ?? c.section}
                    </span>
                  </div>
                  <code className="block text-[11px] text-muted-foreground truncate mt-0.5">{c.command}</code>
                </div>
              </label>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button onClick={() => onSelectAll(effective.map((c) => c.key))} disabled={effective.length === 0}
          className="text-xs px-2 py-1 rounded-lg border border-border hover:bg-muted disabled:opacity-50">
          전체 선택
        </button>
        <button onClick={onClear} disabled={selectedKeys.size === 0}
          className="text-xs px-2 py-1 rounded-lg border border-border hover:bg-muted disabled:opacity-50">
          선택 해제
        </button>
      </div>

      <div className="flex justify-end pt-2 border-t border-border">
        <button
          onClick={onRun}
          disabled={selectedKeys.size === 0 || running}
          className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors disabled:opacity-50"
        >
          {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          선택 실행 ({selectedKeys.size})
        </button>
      </div>
    </div>
  );
}
