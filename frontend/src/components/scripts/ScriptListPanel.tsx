import { Plus, Search, FileCode, Boxes, Terminal } from 'lucide-react';
import type { ExecutableScript, ScriptKind } from '@/types';
import { EmptyState, ErrorState, LoadingState } from '@/components/common';
import { useCanEditScripts } from '@/hooks/useScripts';

const KIND_META: Record<ScriptKind, { label: string; icon: typeof FileCode; cls: string }> = {
  python: { label: 'Python', icon: FileCode, cls: 'text-chart-2-text border-chart-2/40 bg-chart-2/10' },
  ansible_playbook: { label: 'Ansible', icon: Boxes, cls: 'text-chart-3-text border-chart-3/40 bg-chart-3/10' },
  shell: { label: 'Shell', icon: Terminal, cls: 'text-chart-1-text border-chart-1/40 bg-chart-1/10' },
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
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] font-medium ${meta.cls}`}>
      <Icon className="w-3 h-3" /> {meta.label}
    </span>
  );
}

interface Props {
  scripts: ExecutableScript[];
  isLoading: boolean;
  /** 조회 실패(D-137) — 빈 목록("새 스크립트를 만들어 시작하세요")으로 보여주지 않는다. */
  error?: unknown;
  onRetry?: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  kind: ScriptKind | null;
  onKindChange: (kind: ScriptKind | null) => void;
  search: string;
  onSearchChange: (q: string) => void;
  onCreateNew: () => void;
}

export function ScriptListPanel({
  scripts, isLoading, error, onRetry, selectedId, onSelect, kind, onKindChange, search, onSearchChange, onCreateNew,
}: Props) {
  // §12.9 — 생성은 operator 이상(관리자 전용 설정 시 admin). 숨기지 않고 비활성+사유(D-145).
  const { canEdit, withHint, ariaWithHint } = useCanEditScripts();
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-shrink-0 p-2 space-y-2 border-b border-border">
        <button
          onClick={onCreateNew}
          disabled={!canEdit}
          title={withHint('새 스크립트 만들기')}
          aria-label={ariaWithHint('새 스크립트')}
          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus className="w-3.5 h-3.5" /> 새 스크립트
        </button>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            aria-label="스크립트 이름 검색"
            placeholder="이름 검색"
            className="w-full pl-7 pr-2 py-1.5 text-xs rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div role="group" aria-label="종류 필터" className="flex flex-wrap gap-1">
          {KIND_FILTERS.map((f) => (
            <button
              key={f.label}
              type="button"
              aria-pressed={kind === f.value}
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
          <LoadingState compact />
        ) : error ? (
          <ErrorState compact error={error} title="스크립트 목록을 불러오지 못했습니다" onRetry={onRetry} />
        ) : scripts.length === 0 ? (
          <EmptyState
            compact
            title="스크립트가 없습니다"
            description={search || kind ? '검색/필터 조건에 맞는 스크립트가 없습니다.' : canEdit ? '새 스크립트를 만들어 시작하세요.' : '등록된 스크립트가 없습니다.'}
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
                      <span className="flex-shrink-0 text-[11px] px-1 py-px rounded border border-border text-muted-foreground">시스템</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    <ScriptKindBadge kind={s.kind} />
                    {(s.tags ?? []).slice(0, 3).map((t) => (
                      <span key={t} className="text-[11px] px-1 py-px rounded bg-secondary text-muted-foreground">{t}</span>
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
