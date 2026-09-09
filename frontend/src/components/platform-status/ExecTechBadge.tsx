import { EXEC_TECH_META } from './execTechMeta';

export function ExecTechBadge({ execTech }: { execTech?: string | null }) {
  if (!execTech) return null;
  const meta = EXEC_TECH_META[execTech];
  const Icon = meta?.icon;
  return (
    <span
      title={meta?.hint ?? execTech}
      className="flex-shrink-0 inline-flex items-center gap-0.5 px-1 py-px rounded border border-border text-[9px] font-medium text-muted-foreground select-none"
    >
      {Icon && <Icon className="w-2.5 h-2.5" />}
      {meta?.label ?? execTech}
    </span>
  );
}
