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
        className={`flex-1 min-w-0 bg-transparent focus:outline-none ${inputClassName}`}
        autoFocus
      />
      <button type="button" onClick={save} aria-label="저장" className="p-0.5 text-primary hover:text-primary/80 flex-shrink-0">
        <Check className="w-3.5 h-3.5" />
      </button>
      <button type="button" onClick={onCancel} aria-label="취소" className="p-0.5 text-muted-foreground hover:text-foreground flex-shrink-0">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
