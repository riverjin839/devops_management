import { useEffect, useState } from 'react';
import { Save, Star, Trash2, Check, X } from 'lucide-react';

interface SavedCommand {
  id: string;
  name: string;
  value: string;
  createdAt: string;
}

interface SavedCommandsProps {
  /** localStorage 키. 페이지마다 고유하게 (예: "k8s:saved-cmd:bulk-exec") */
  storageKey: string;
  /** 현재 에디터의 값 — "저장" 시 이 값으로 새 항목 생성 */
  currentValue: string;
  /** 저장된 항목 클릭 시 에디터에 주입하는 콜백 */
  onPick: (value: string) => void;
  /** 저장 버튼 disabled 여부 (값 비어있을 때) */
  canSave?: boolean;
  className?: string;
}

function loadAll(key: string): SavedCommand[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw) as SavedCommand[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveAll(key: string, items: SavedCommand[]) {
  try {
    localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // quota/disabled — 조용히 무시
  }
}

/** 커스텀 명령을 localStorage 에 이름-값 쌍으로 저장/재사용.
 *  백엔드 저장 없이 브라우저 로컬에서만 관리.
 */
export function SavedCommands({
  storageKey, currentValue, onPick, canSave = true, className = '',
}: SavedCommandsProps) {
  const [items, setItems] = useState<SavedCommand[]>(() => loadAll(storageKey));
  const [adding, setAdding] = useState(false);
  const [nameInput, setNameInput] = useState('');

  useEffect(() => {
    setItems(loadAll(storageKey));
  }, [storageKey]);

  const persist = (next: SavedCommand[]) => {
    setItems(next);
    saveAll(storageKey, next);
  };

  const add = () => {
    const name = nameInput.trim();
    if (!name || !currentValue.trim()) return;
    const item: SavedCommand = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name, value: currentValue, createdAt: new Date().toISOString(),
    };
    persist([item, ...items]);
    setNameInput('');
    setAdding(false);
  };

  const remove = (id: string) => persist(items.filter((x) => x.id !== id));

  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-sm text-muted-foreground flex items-center gap-1">
          <Star className="w-3 h-3" />
          저장된 명령 <span className="opacity-60">({items.length})</span>
        </p>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            disabled={!canSave || !currentValue.trim()}
            className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 disabled:opacity-40 disabled:cursor-not-allowed"
            title={!currentValue.trim() ? '먼저 명령을 입력하세요' : '현재 입력된 명령 저장'}
          >
            <Save className="w-3 h-3" />
            현재 명령 저장
          </button>
        )}
      </div>

      {adding && (
        <div className="flex items-center gap-1.5 mb-2 p-2 bg-primary/5 border border-primary/30 rounded">
          <input
            autoFocus
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add();
              if (e.key === 'Escape') { setAdding(false); setNameInput(''); }
            }}
            placeholder="저장할 이름 (예: 'pod crashloop 체크')"
            className="flex-1 px-2 py-1 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button onClick={add} disabled={!nameInput.trim()}
            className="p-1 rounded bg-primary text-primary-foreground disabled:opacity-40">
            <Check className="w-3 h-3" />
          </button>
          <button onClick={() => { setAdding(false); setNameInput(''); }}
            className="p-1 rounded bg-secondary text-muted-foreground">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground/70 italic py-1">
          저장된 명령이 없습니다. 자주 쓰는 명령을 저장하면 다음에 클릭 한 번으로 불러올 수 있어요.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((it) => (
            <div key={it.id} className="flex items-center gap-0.5 bg-secondary/50 border border-border rounded-md overflow-hidden">
              <button
                onClick={() => onPick(it.value)}
                title={it.value}
                className="px-2 py-1 text-xs font-medium hover:bg-secondary max-w-[240px] truncate"
              >
                {it.name}
              </button>
              <button
                onClick={() => {
                  if (confirm(`"${it.name}" 저장된 명령을 삭제하시겠습니까?`)) remove(it.id);
                }}
                title="삭제"
                className="px-1.5 py-1 text-muted-foreground hover:text-red-400 hover:bg-red-500/10"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
