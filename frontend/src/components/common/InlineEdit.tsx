import { useState } from 'react';
import { Check, X } from 'lucide-react';

interface InlineEditProps {
  value: string;
  onSave: (val: string) => void;
  onCancel: () => void;
  placeholder?: string;
  inputClassName?: string;
  className?: string;
}

export function InlineEdit({ value: initial, onSave, onCancel, placeholder, inputClassName = '', className = '' }: InlineEditProps) {
  const [val, setVal] = useState(initial);

  const save = () => onSave(val.trim());
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') onCancel();
  };

  return (
    <div className={`flex items-center gap-1 ${className}`}>
      <input
        type="text"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        // 전역 CSS 가 input 의 focus-visible 아웃라인을 벗기므로 ring 으로 opt-in —
        // 인라인 편집 중 포커스가 어디 있는지 키보드 사용자도 볼 수 있어야 한다.
        className={`flex-1 min-w-0 bg-transparent rounded px-0.5 focus:outline-none focus:ring-1 focus:ring-primary ${inputClassName}`}
        autoFocus
      />
      <button type="button" onClick={save} title="저장" aria-label="저장" className="p-0.5 text-primary hover:text-primary/80 flex-shrink-0">
        <Check className="w-3.5 h-3.5" />
      </button>
      <button type="button" onClick={onCancel} title="취소" aria-label="취소" className="p-0.5 text-muted-foreground hover:text-foreground flex-shrink-0">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
