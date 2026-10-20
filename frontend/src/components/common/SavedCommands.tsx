import { useEffect, useState } from 'react';
import { Save, Star, Trash2, Check, X, ShieldAlert } from 'lucide-react';
import { containsSecret, maskCommand } from '@/lib/commandMask';
import { ConfirmDialog } from './ConfirmDialog';

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

/** 비밀값이 든 명령을 저장하지 않는 이유 — 저장 버튼 title·안내 줄에 같이 쓴다. */
const SECRET_REFUSE_HINT = '비밀값(비밀번호·키·토큰)이 들어 있어 저장할 수 없습니다 — 인증정보는 env 파일·alias 로 두고 명령에서 빼세요';

/** 커스텀 명령을 localStorage 에 이름-값 쌍으로 저장/재사용.
 *  백엔드 저장 없이 브라우저 로컬에서만 관리.
 *  D-176: 비밀값 패턴(`lib/commandMask` — 서버 `command_mask.py` 와 같은 규칙)이 든 명령은 저장을 거부하고,
 *  예전에 저장된 항목은 툴팁을 마스킹해 보여주며 삭제를 권한다.
 */
export function SavedCommands({
  storageKey, currentValue, onPick, canSave = true, className = '',
}: SavedCommandsProps) {
  const [items, setItems] = useState<SavedCommand[]>(() => loadAll(storageKey));
  const [adding, setAdding] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SavedCommand | null>(null);
  const [nameInput, setNameInput] = useState('');

  useEffect(() => {
    setItems(loadAll(storageKey));
  }, [storageKey]);

  const persist = (next: SavedCommand[]) => {
    setItems(next);
    saveAll(storageKey, next);
  };

  const hasSecret = containsSecret(currentValue);

  const add = () => {
    const name = nameInput.trim();
    if (!name || !currentValue.trim() || containsSecret(currentValue)) return;
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
            disabled={!canSave || !currentValue.trim() || hasSecret}
            className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 disabled:opacity-40 disabled:cursor-not-allowed"
            title={!currentValue.trim() ? '먼저 명령을 입력하세요' : hasSecret ? SECRET_REFUSE_HINT : '현재 입력된 명령 저장'}
            aria-label={hasSecret ? `현재 명령 저장 — ${SECRET_REFUSE_HINT}` : '현재 명령 저장'}
          >
            <Save className="w-3 h-3" />
            현재 명령 저장
          </button>
        )}
      </div>

      {hasSecret && (
        <p className="mb-1.5 text-xs text-muted-foreground flex items-start gap-1">
          <ShieldAlert className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
          {SECRET_REFUSE_HINT}
        </p>
      )}

      {adding && !hasSecret && (
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
            aria-label="저장"
            className="p-1 rounded bg-primary text-primary-foreground disabled:opacity-40">
            <Check className="w-3 h-3" />
          </button>
          <button onClick={() => { setAdding(false); setNameInput(''); }}
            aria-label="취소"
            className="p-1 rounded bg-secondary text-muted-foreground">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground italic py-1">
          저장된 명령이 없습니다. 자주 쓰는 명령을 저장하면 다음에 클릭 한 번으로 불러올 수 있어요.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((it) => {
            // 이전 버전이 비밀값째 저장한 항목 — 툴팁은 마스킹, 삭제 권고 아이콘.
            const legacySecret = containsSecret(it.value);
            return (
            <div key={it.id} className="flex items-center gap-0.5 bg-secondary/50 border border-border rounded-md overflow-hidden">
              <button
                onClick={() => onPick(it.value)}
                title={legacySecret ? `${maskCommand(it.value)}\n(비밀값이 들어 있는 이전 저장 항목 — 삭제를 권장합니다)` : it.value}
                aria-label={legacySecret ? `${it.name} — 비밀값이 들어 있는 이전 저장 항목, 삭제 권장` : it.name}
                className="px-2 py-1 text-xs font-medium hover:bg-secondary max-w-[240px] truncate inline-flex items-center gap-1"
              >
                {legacySecret && <ShieldAlert className="w-3 h-3 shrink-0 text-status-warning" aria-hidden="true" />}
                {it.name}
              </button>
              <button
                onClick={() => setPendingDelete(it)}
                title="삭제"
                aria-label={`${it.name} 삭제`}
                className="px-1.5 py-1 text-muted-foreground hover:text-status-critical hover:bg-status-critical/10"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
            );
          })}
        </div>
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title="저장된 명령 삭제"
        description={pendingDelete ? `"${pendingDelete.name}" 저장된 명령을 삭제합니다.` : ''}
        confirmLabel="삭제"
        onConfirm={() => { if (pendingDelete) remove(pendingDelete.id); setPendingDelete(null); }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
