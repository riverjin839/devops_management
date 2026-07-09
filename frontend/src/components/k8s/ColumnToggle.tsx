import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Columns3, Check } from 'lucide-react';

export interface ToggleColumn {
  key: string;
  label: string;
}

interface ColumnToggleProps {
  columns: ToggleColumn[];
  hidden: Set<string>;
  onToggle: (key: string) => void;
}

/** 테이블 컬럼 표시/숨김 드롭다운 (freelens 파리티). 이름/동작 등 필수 컬럼은 목록에 넣지 않는다. */
export function ColumnToggle({ columns, hidden, onToggle }: ColumnToggleProps) {
  if (columns.length === 0) return null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          title="컬럼 표시/숨김"
          className={`p-1.5 rounded-lg hover:bg-secondary ${hidden.size > 0 ? 'text-primary' : 'text-muted-foreground'}`}
        >
          <Columns3 className="w-3.5 h-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-[60] min-w-[180px] rounded-xl border border-border bg-card p-1 shadow-lg mac-shadow"
        >
          <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">컬럼</div>
          {columns.map((c) => (
            <DropdownMenu.CheckboxItem
              key={c.key}
              checked={!hidden.has(c.key)}
              onCheckedChange={() => onToggle(c.key)}
              onSelect={(e) => e.preventDefault()} // 체크해도 메뉴 유지
              className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-lg cursor-pointer outline-none data-[highlighted]:bg-secondary"
            >
              <span className="w-3.5 h-3.5 inline-flex items-center justify-center">
                {!hidden.has(c.key) && <Check className="w-3.5 h-3.5 text-primary" />}
              </span>
              <span className="truncate">{c.label}</span>
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
