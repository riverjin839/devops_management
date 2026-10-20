/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, CheckCircle2, Copy, Info, SearchCode, X } from 'lucide-react';
import { extractRequestId, serverErrorsPath } from '@/lib/requestId';
import { useAuthStore } from '@/stores/authStore';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
  durationMs?: number;      // 0 = 수동 dismiss
  action?: { label: string; onClick: () => void };
}

interface ToastInput extends Omit<Toast, 'id'> {
  id?: string;
}

interface ToastContextValue {
  toasts: Toast[];
  show: (t: ToastInput) => string;
  success: (title: string, desc?: string) => string;
  error: (title: string, desc?: string) => string;
  warning: (title: string, desc?: string) => string;
  info: (title: string, desc?: string) => string;
  dismiss: (id: string) => void;
  dismissAll: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 3000,
  info:    4000,
  warning: 6000,
  error:   7000,
};

// D-119/D-132: 카드 면은 중립(bg-card + border-border), 상태 신호는 아이콘 색 하나.
// 성공 아이콘의 녹색은 "방금 한 행동의 결과"(예외 ①)라 유지한다.
const VARIANT_META: Record<ToastVariant, { iconCls: string; icon: typeof CheckCircle2 }> = {
  success: { iconCls: 'text-status-healthy', icon: CheckCircle2 },
  error: { iconCls: 'text-status-critical', icon: AlertCircle },
  warning: { iconCls: 'text-status-warning', icon: AlertTriangle },
  info: { iconCls: 'text-status-info', icon: Info },
};

const MAX_STACK = 5;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // dismiss timers
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setToasts((xs) => xs.filter((x) => x.id !== id));
  }, []);

  const show = useCallback((input: ToastInput): string => {
    const id = input.id ?? `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const t: Toast = {
      id,
      variant: input.variant,
      title: input.title,
      description: input.description,
      durationMs: input.durationMs ?? DEFAULT_DURATION[input.variant],
      action: input.action,
    };
    setToasts((xs) => {
      const next = [...xs, t];
      // 넘치면 오래된 것 제거 (FIFO)
      while (next.length > MAX_STACK) next.shift();
      return next;
    });
    if (t.durationMs && t.durationMs > 0) {
      const handle = setTimeout(() => dismiss(id), t.durationMs);
      timers.current.set(id, handle);
    }
    return id;
  }, [dismiss]);

  const success = useCallback((title: string, description?: string) => show({ variant: 'success', title, description }), [show]);
  const error   = useCallback((title: string, description?: string) => show({ variant: 'error',   title, description }), [show]);
  const warning = useCallback((title: string, description?: string) => show({ variant: 'warning', title, description }), [show]);
  const info    = useCallback((title: string, description?: string) => show({ variant: 'info',    title, description }), [show]);

  const dismissAll = useCallback(() => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current.clear();
    setToasts([]);
  }, []);

  // 언마운트 시 타이머 정리
  useEffect(() => () => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current.clear();
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ toasts, show, success, error, warning, info, dismiss, dismissAll }),
    [toasts, show, success, error, warning, info, dismiss, dismissAll],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}

/** ToastProvider 미설치 환경에서도 죽지 않는 safe 버전 — fallback console.log */
export function useToastSafe(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx) return ctx;
  const noop = () => '';
  const warn = (title: string, desc?: string) => {
    console.warn('[toast fallback]', title, desc);
    return '';
  };
  return {
    toasts: [],
    show: warn as unknown as ToastContextValue['show'],
    success: warn,
    error: warn,
    warning: warn,
    info: warn,
    dismiss: noop,
    dismissAll: noop,
  };
}

// ── Viewport (포털로 body 끝에 렌더) ───────────────────────────────────
function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="fixed top-4 right-4 z-[70] flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
      aria-atomic="true"
    >
      {toasts.map((t) => <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />)}
    </div>,
    document.body,
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const meta = VARIANT_META[toast.variant];
  const Icon = meta.icon;
  const rid = extractRequestId(toast.description);
  return (
    <div
      className={`toast-enter pointer-events-auto w-[360px] max-w-[calc(100vw-2rem)] shadow-lg rounded-md border border-border overflow-hidden bg-card`}
      role="status"
    >
      <div className="flex items-start gap-2 px-3 py-2.5">
        <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${meta.iconCls}`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground leading-snug">{toast.title}</p>
          {toast.description && (
            <p className="text-xs text-foreground/70 mt-0.5 break-words whitespace-pre-wrap">
              {toast.description}
            </p>
          )}
          {rid && <RequestIdActions requestId={rid} onNavigate={() => onDismiss(toast.id)} />}
          {toast.action && (
            <button
              onClick={() => { toast.action?.onClick(); onDismiss(toast.id); }}
              className="mt-1 text-xs font-medium underline hover:no-underline"
            >
              {toast.action.label}
            </button>
          )}
        </div>
        <button
          onClick={() => onDismiss(toast.id)}
          className="p-0.5 rounded hover:bg-foreground/10 text-foreground/60 hover:text-foreground flex-shrink-0"
          aria-label="닫기"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

/**
 * 오류 문구에 "요청 ID" 가 있으면 복사·원인 보기를 붙인다. 원인 보기는 admin 만(서버 오류 화면이 admin 전용).
 * 토스트는 Router 밖이라 history 에 넣고 popstate 로 라우터를 깨운다.
 */
function RequestIdActions({ requestId, onNavigate }: { requestId: string; onNavigate: () => void }) {
  const { t } = useTranslation();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(requestId).then(() => setCopied(true), () => setCopied(false));
  };
  const open = () => {
    window.history.pushState({}, '', serverErrorsPath(requestId));
    window.dispatchEvent(new PopStateEvent('popstate'));
    onNavigate();
  };
  return (
    <div className="mt-1 flex items-center gap-2 text-xs">
      <button type="button" onClick={copy} className="inline-flex items-center gap-1 underline hover:no-underline" title={t('common.requestId.copy')} aria-label={t('common.requestId.copy')}>
        <Copy className="w-3 h-3" aria-hidden="true" />{copied ? t('common.requestId.copied') : t('common.requestId.copy')}
      </button>
      {isAdmin && (
        <button type="button" onClick={open} className="inline-flex items-center gap-1 underline hover:no-underline">
          <SearchCode className="w-3 h-3" aria-hidden="true" />{t('common.requestId.openCause')}
        </button>
      )}
    </div>
  );
}
