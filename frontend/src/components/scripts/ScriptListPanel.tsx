import { Plus, Search, FileCode, Boxes, Terminal } from 'lucide-react';
import type { ExecutableScript, ScriptKind } from '@/types';
import { EmptyState } from '@/components/common';

const KIND_META: Record<ScriptKind, { label: string; icon: typeof FileCode; cls: string }> = {
  python: { label: 'Python', icon: FileCode, cls: 'text-status-healthy border-status-healthy/40 bg-status-healthy-soft' },
  ansible_playbook: { label: 'Ansible', icon: Boxes, cls: 'text-status-warning border-status-warning/40 bg-status-warning-soft' },
  shell: { label: 'Shell', icon: Terminal, cls: 'text-status-info border-status-info/40 bg-status-info-soft' },
};

const KIND_FILTERS: { value: ScriptKind | null; label: string }[] = [
  { value: null, label: '전체' },
  { value: 'python', label: 'Python' },
  { value: 'ansible_playbook', label: 'Ansible' },
  { value: 'shell', label: 'Shell' },
];

export function ScriptKindBadge({ kind }: { kind: ScriptKind }) {
  const meta = KIND_META[kind];
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium ${meta.cls}`}>
      <Icon className="w-3 h-3" /> {meta.label}
    </span>
  );
}

interface Props {
  scripts: ExecutableScript[];
  isLoading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  kind: ScriptKind | null;
  onKindChange: (kind: ScriptKind | null) => void;
  search: string;
  onSearchChange: (q: string) => void;
  onCreateNew: () => void;
}

export function ScriptListPanel({
  scripts, isLoading, selectedId, onSelect, kind, onKindChange, search, onSearchChange, onCreateNew,
}: Props) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-shrink-0 p-2 space-y-2 border-b border-border">
        <button
          onClick={onCreateNew}
          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium bg-primary text-primary-foreground rounded-xl hover:bg-primary/90"
        >
          <Plus className="w-3.5 h-3.5" /> 새 스크립트
        </button>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="이름 검색"
            className="w-full pl-7 pr-2 py-1.5 text-xs rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {KIND_FILTERS.map((f) => (
            <button
              key={f.label}
              onClick={() => onKindChange(f.value)}
              className={`px-2 py-1 text-[11px] rounded-lg border transition-colors ${
                kind === f.value
                  ? 'border-primary bg-primary/10 text-primary font-medium'
                  : 'border-border text-muted-foreground hover:bg-secondary'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {isLoading ? (
          <div className="p-3 text-xs text-muted-foreground">불러오는 중…</div>
        ) : scripts.length === 0 ? (
          <EmptyState
            compact
            title="스크립트가 없습니다"
            description={search || kind ? '검색/필터 조건에 맞는 스크립트가 없습니다.' : '새 스크립트를 만들어 시작하세요.'}
          />
        ) : (
          <ul className="p-1.5 space-y-1">
            {scripts.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => onSelect(s.id)}
                  className={`w-full text-left px-2.5 py-2 rounded-xl border transition-colors ${
                    selectedId === s.id
                      ? 'border-primary bg-primary/5'
                      : 'border-transparent hover:bg-secondary/60'
                  }`}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-xs font-medium truncate">{s.name}</span>
                    {s.isSystem && (
                      <span className="flex-shrink-0 text-[9px] px-1 py-px rounded border border-border text-muted-foreground">시스템</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    <ScriptKindBadge kind={s.kind} />
                    {(s.tags ?? []).slice(0, 3).map((t) => (
                      <span key={t} className="text-[10px] px-1 py-px rounded bg-secondary text-muted-foreground">{t}</span>
                    ))}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
