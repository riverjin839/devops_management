/**
 * 넓은 권한 확인 — 위험 사유 + 영향 범위를 보여주고 대상 이름을 다시 입력받는다.
 *
 * 발급 마법사·바인딩 생성·롤 저장·kubeconfig 재발급이 같은 대화상자를 쓴다. 사유는
 * `grantRiskReasons()` 가 정하고, 비어 있으면 호출부가 이 대화상자 없이 바로 실행한다.
 * 재입력 칸에는 placeholder 로 정답을 깔지 않는다 — 따라 치기만 하면 확인의 의미가 없다.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ConfirmDialog } from '@/components/common';

export interface GrantRiskDetail {
  label: string;
  value: ReactNode;
}

interface Props {
  open: boolean;
  title: string;
  description: string;
  reasons: string[];
  details: GrantRiskDetail[];
  /** 다시 입력받을 이름(보통 ServiceAccount·롤 이름). */
  confirmName: string;
  /** 재입력 칸 라벨의 대상 — 예: "ServiceAccount 이름". */
  confirmNameLabel: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** 사유 아래에 덧붙일 내용(예: 롤 규칙 비교). */
  children?: ReactNode;
}

const inputCls =
  'w-full px-3 py-2 bg-secondary border border-border rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50';

export function GrantRiskDialog({
  open, title, description, reasons, details, confirmName, confirmNameLabel, confirmLabel, onConfirm, onCancel, children,
}: Props) {
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  return (
    <ConfirmDialog
      open={open}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      danger
      confirmDisabled={typed.trim() !== confirmName.trim()}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <div className="space-y-3 text-sm">
        <ul className="space-y-1.5" aria-label="확인이 필요한 이유">
          {reasons.map((r) => (
            <li key={r} className="flex items-start gap-2 text-foreground">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-status-warning" aria-hidden="true" />
              <span>{r}</span>
            </li>
          ))}
        </ul>
        {details.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            {details.map((d) => (
              <div key={d.label} className="contents">
                <dt className="text-muted-foreground">{d.label}</dt>
                <dd className="font-mono break-all">{d.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {children}
        <label className="flex flex-col gap-1.5 text-xs text-muted-foreground font-medium">
          <span>
            확인을 위해 {confirmNameLabel} <span className="font-mono text-foreground">{confirmName}</span> 을(를) 입력하세요
          </span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-label={`확인용 ${confirmNameLabel}`}
            className={inputCls}
          />
        </label>
      </div>
    </ConfirmDialog>
  );
}

/** 롤 규칙 비교 블록 — 롤 저장 확인에서 무엇이 바뀌는지 보여준다. */
export function RuleDiffList({ added, removed }: { added: string[]; removed: string[] }) {
  if (added.length === 0 && removed.length === 0) {
    return <p className="text-xs text-muted-foreground">규칙 내용은 같습니다(순서·표기만 바뀜).</p>;
  }
  return (
    <div className="text-xs space-y-2">
      {added.length > 0 && (
        <div>
          <div className="text-muted-foreground mb-1">추가되는 권한 {added.length}개</div>
          <ul className="font-mono space-y-0.5 max-h-32 overflow-y-auto">
            {added.map((x) => <li key={x} className="text-foreground font-semibold">+ {x}</li>)}
          </ul>
        </div>
      )}
      {removed.length > 0 && (
        <div>
          <div className="text-muted-foreground mb-1">빠지는 권한 {removed.length}개</div>
          <ul className="font-mono space-y-0.5 max-h-32 overflow-y-auto">
            {removed.map((x) => <li key={x} className="text-muted-foreground">− {x}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
