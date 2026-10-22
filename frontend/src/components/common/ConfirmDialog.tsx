import { useCallback, useEffect, useId, useRef } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useModalA11y } from './useModalA11y';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  /** 기본 `common.action.run`("실행"). */
  confirmLabel?: string;
  /** 기본 `common.action.cancel`("취소"). */
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;  // 추가 상세 (실행 대상 요약 등)
  /** true = 확인 처리 중 — 버튼을 잠가 연타·Enter 로 같은 작업이 두 번 나가지 않게 한다. */
  busy?: boolean;
  /** true = 확인 조건 미충족(예: 이름 재입력 불일치) — 확인 버튼·Enter 를 막는다. */
  confirmDisabled?: boolean;
}

/** 중요 액션(ssh/etcdctl 실행 등) 실행 전에 확인을 받는 모달.
 *  Enter = 확인 / Escape = 취소. 포커스 트랩·복원은 useModalA11y 가 담당.
 */
export function ConfirmDialog({
  open, title, description, confirmLabel, cancelLabel,
  danger = false, onConfirm, onCancel, children, busy = false, confirmDisabled = false,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  // 확인 처리 중(busy)에는 Escape·뒤로가기·배경 클릭으로 닫지 않는다 — 맨 위 모달이 Escape 를 삼키므로
  // 부모 모달로 새지도 않는다(modalStack). 취소·X 버튼은 명시적 조작이라 그대로 둔다.
  const dismiss = () => { if (!busy) onCancel(); };
  const dialogRef = useModalA11y(open, dismiss);
  const titleId = useId();
  const descId = useId();

  // 확인은 짧은 시간 안에 한 번만 — 예전엔 확인 버튼에 autoFocus 가 있는 상태에서 Enter 를 누르면
  // 창 전체 keydown 핸들러와 버튼의 기본 click 이 함께 발화해 onConfirm 이 두 번 불렸다
  // (운영 클러스터에 일괄 실행이 두 번 나감). 버튼 위 Enter 는 브라우저 click 에 맡기고,
  // 그래도 겹치는 호출은 시간 창으로 한 번 더 걸러낸다.
  const lastFiredAt = useRef(0);
  const fire = useCallback(() => {
    if (busy || confirmDisabled) return;
    const now = Date.now();
    if (now - lastFiredAt.current < 800) return;
    lastFiredAt.current = now;
    onConfirm();
  }, [busy, confirmDisabled, onConfirm]);

  // Enter = 확인 (Escape/포커스 트랩은 useModalA11y)
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'BUTTON' || target.tagName === 'TEXTAREA' || target.tagName === 'A')) return;
      e.preventDefault();
      fire();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, fire]);

  if (!open) return null;

  return (
    // z-[60] — 다른 모달(shadcn/base-ui Dialog, z-50) 위에서 최종 확인을 받는 용도로도
    // 쓰이므로(예: JiraLinkDialog) 그 모달들보다 항상 위에 그려져야 한다. 같은 z-50 이면
    // DOM 순서(포탈로 나중에 붙는 쪽이 위)에 따라 뒤로 숨어 클릭이 먹지 않는 문제가 있었다.
    // 클릭 전파를 여기서 끊는다 — 다른 모달 안에 중첩될 때 확인창 안의 클릭(취소·확인·배경)이
    // 바깥 모달의 "배경 클릭 = 닫기" 핸들러까지 올라가 바깥 모달까지 함께 닫히던 문제(D-029 실측).
    <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/60" onClick={dismiss} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className="relative bg-card border border-border rounded-md shadow-card w-full max-w-lg mx-4 overflow-hidden"
      >
        <div className={`flex items-start gap-3 px-5 py-4 border-b border-border ${
          danger ? 'bg-status-critical/5' : 'bg-muted/30'
        }`}>
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
            danger ? 'bg-status-critical/10 text-status-critical' : 'bg-primary/10 text-primary'
          }`}>
            <AlertTriangle className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 id={titleId} className="text-sm font-semibold">{title}</h2>
            {description && <p id={descId} className="text-sm text-muted-foreground mt-0.5">{description}</p>}
          </div>
          <button
            onClick={onCancel}
            aria-label={t('common.action.close')}
            className="p-1 rounded hover:bg-secondary text-muted-foreground flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {children && <div className="px-5 py-4 text-sm">{children}</div>}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/10">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl"
          >
            {cancelLabel ?? t('common.action.cancel')}
          </button>
          <button
            onClick={fire}
            autoFocus
            disabled={busy || confirmDisabled}
            aria-busy={busy || undefined}
            className={`px-4 py-1.5 text-sm font-semibold rounded-xl text-primary-foreground disabled:opacity-60 ${busy ? 'disabled:cursor-wait' : 'disabled:cursor-not-allowed'} ${
              danger
                ? 'bg-status-critical hover:bg-status-critical/90'
                : 'bg-primary hover:bg-primary/90'
            }`}
          >
            {busy ? t('common.status.processing') : (confirmLabel ?? t('common.action.run'))}
          </button>
        </div>
      </div>
    </div>
  );
}
