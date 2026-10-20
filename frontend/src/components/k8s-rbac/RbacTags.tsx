/** `/k8s-rbac` 의 작은 표시 컴포넌트 — 위험도 뱃지와 리소스·verb 태그. */
import { isWriteVerb } from './rbacShared';

const RISK_LABEL: Record<string, string> = { low: '낮음', medium: '보통', high: '높음' };
// 글자는 text-foreground — 11px 글자를 상태색 틴트(/10) 위에 상태색으로 쓰면 일부 테마에서 대비가
// 4.5:1 아래(axe 실측 ≈4.25:1)로 떨어진다. 위험 신호는 면·보더 틴트와 "위험도 높음" 문구가 전한다.
const RISK_CLASS: Record<string, string> = {
  low: 'text-muted-foreground bg-secondary border-border',
  medium: 'text-foreground bg-status-warning/10 border-status-warning/40',
  high: 'text-foreground bg-status-critical/10 border-status-critical/40',
};

export function RiskBadge({ risk }: { risk: 'low' | 'medium' | 'high' }) {
  return (
    <span
      className={`inline-block text-[11px] font-semibold px-1.5 py-0.5 rounded border ${RISK_CLASS[risk]}`}
    >
      위험도 {RISK_LABEL[risk]}
    </span>
  );
}

/**
 * 리소스·verb 를 작은 태그로. verb 는 쓰기 여부로 색을 가른다.
 * `onClick` 을 주면 `<button>` 로 렌더돼 다른 탭의 대상(예: 연결된 롤)으로 바로 이동하는
 * 링크처럼 동작한다 — hover 밑줄 + focus 링으로 눌리는 요소임을 드러낸다.
 */
export function Tag({
  children,
  tone = 'default',
  onClick,
  title,
}: {
  children: React.ReactNode;
  tone?: 'default' | 'read' | 'write' | 'muted';
  onClick?: () => void;
  title?: string;
}) {
  const cls =
    tone === 'write'
      ? 'bg-status-warning/10 border-status-warning/30 text-status-warning'
      : tone === 'read'
        ? 'bg-primary/10 border-primary/30 text-primary'
        : tone === 'muted'
          ? 'bg-secondary border-border text-muted-foreground italic'
          : 'bg-secondary border-border text-foreground';
  const base = `inline-block font-mono text-[11px] px-1.5 py-px rounded border mr-1 mb-1 ${cls}`;

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        className={`${base} hover:underline hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 cursor-pointer`}
      >
        {children}
      </button>
    );
  }
  return <span className={base}>{children}</span>;
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
