/**
 * 공용 켜기/끄기 스위치(`role="switch"`) — 화면마다 손으로 만든 스위치를 하나로 맞춘다.
 * 권한이 없으면 `disabled` + `hint`(사유)를 title·aria-label 에 함께 싣는다(§12.9).
 */
export function SwitchToggle({ checked, onChange, label, disabled, hint, title }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  /** 비활성 사유. */
  hint?: string;
  /** 활성 상태의 설명(없으면 label). */
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      title={disabled ? hint : (title ?? label)}
      aria-label={disabled && hint ? `${label} — ${hint}` : label}
      className="inline-flex items-center gap-2 text-sm text-foreground disabled:opacity-60 disabled:cursor-not-allowed"
    >
      <span
        className={`w-9 h-5 shrink-0 rounded-full border relative transition-colors ${
          checked ? 'bg-primary border-primary' : 'bg-secondary border-border'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-card shadow-sm transition-transform ${
            checked ? 'translate-x-4' : ''
          }`}
        />
      </span>
      {label}
    </button>
  );
}
