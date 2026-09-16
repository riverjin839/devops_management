/** `/k8s-rbac` 의 작은 표시 컴포넌트 — 위험도 뱃지와 리소스·verb 태그. */
import { isWriteVerb } from './rbacShared';

const RISK_LABEL: Record<string, string> = { low: '낮음', medium: '보통', high: '높음' };
const RISK_CLASS: Record<string, string> = {
  low: 'text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  medium: 'text-amber-700 dark:text-amber-400 bg-amber-500/10 border-amber-500/30',
  high: 'text-rose-700 dark:text-rose-400 bg-rose-500/10 border-rose-500/30',
};

export function RiskBadge({ risk }: { risk: 'low' | 'medium' | 'high' }) {
  return (
    <span
      className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded border ${RISK_CLASS[risk]}`}
    >
      위험도 {RISK_LABEL[risk]}
    </span>
  );
}

/** 리소스·verb 를 작은 태그로. verb 는 쓰기 여부로 색을 가른다. */
export function Tag({
  children,
  tone = 'default',
}: {
  children: React.ReactNode;
  tone?: 'default' | 'read' | 'write' | 'muted';
}) {
  const cls =
    tone === 'write'
      ? 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400'
      : tone === 'read'
        ? 'bg-primary/10 border-primary/30 text-primary'
        : tone === 'muted'
          ? 'bg-secondary border-border text-muted-foreground italic'
          : 'bg-secondary border-border text-foreground';
  return (
    <span className={`inline-block font-mono text-[11px] px-1.5 py-px rounded border mr-1 mb-1 ${cls}`}>
      {children}
    </span>
  );
}

export function VerbTags({ verbs }: { verbs: string[] }) {
  return (
    <>
      {verbs.map((v) => (
        <Tag key={v} tone={isWriteVerb(v) ? 'write' : 'read'}>
          {v}
        </Tag>
      ))}
    </>
  );
}
