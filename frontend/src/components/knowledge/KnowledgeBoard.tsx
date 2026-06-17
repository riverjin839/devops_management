import type { KnowledgePageNode } from '@/types';

const COLUMNS: { key: string; label: string; tone: string }[] = [
  { key: 'draft', label: '예정', tone: 'text-slate-500' },
  { key: 'active', label: '진행', tone: 'text-sky-600' },
  { key: 'archived', label: '완료', tone: 'text-emerald-600' },
];

interface Props {
  items: KnowledgePageNode[];
  onOpen: (id: string) => void;
  onStatusChange: (id: string, status: string) => void;
}

/**
 * 지식베이스 보드(kind=board) — 하위 문서를 status(예정/진행/완료) 칼럼으로 보여주는 칸반.
 * 카드를 드롭하면 status 변경(AppFlowy "row=document" 차용 — 카드 클릭 시 문서 오픈).
 */
export function KnowledgeBoard({ items, onOpen, onStatusChange }: Props) {
  const byStatus = (s: string) => items.filter((p) => (p.status || 'active') === s);

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {COLUMNS.map((col) => {
        const cards = byStatus(col.key);
        return (
          <div
            key={col.key}
            className="bg-muted/20 border border-border rounded-xl p-2 min-h-[120px]"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData('text/plain');
              if (id) onStatusChange(id, col.key);
            }}
          >
            <div className={`flex items-center justify-between px-1 py-1 mb-1 text-sm font-medium ${col.tone}`}>
              <span>{col.label}</span>
              <span className="text-xs text-muted-foreground">{cards.length}</span>
            </div>
            <div className="space-y-1.5">
              {cards.map((p) => (
                <button
                  key={p.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', p.id)}
                  onClick={() => onOpen(p.id)}
                  className="w-full text-left bg-card border border-border rounded-lg px-2.5 py-1.5 hover:border-primary/40 hover:shadow-sm transition-all cursor-pointer"
                >
                  <p className="text-sm font-medium truncate">{p.title}</p>
                  {p.summary && <p className="text-xs text-muted-foreground truncate">{p.summary}</p>}
                </button>
              ))}
              {cards.length === 0 && <p className="text-xs text-muted-foreground/60 px-1 py-2">비어 있음</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
