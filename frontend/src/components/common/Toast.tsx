/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

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

const VARIANT_META: Record<ToastVariant, { cls: string; icon: typeof CheckCircle2; bar: string }> = {
  success: {
    cls: 'border-[hsl(var(--status-healthy))] bg-[hsl(var(--status-healthy-bg))] text-[hsl(var(--status-healthy))]',
    icon: CheckCircle2,
    bar: 'bg-[hsl(var(--status-healthy))]',
  },
  error: {
    cls: 'border-[hsl(var(--status-critical))] bg-[hsl(var(--status-critical-bg))] text-[hsl(var(--status-critical))]',
    icon: AlertCircle,
    bar: 'bg-[hsl(var(--status-critical))]',
  },
  warning: {
    cls: 'border-[hsl(var(--status-warning))] bg-[hsl(var(--status-warning-bg))] text-[hsl(var(--status-warning))]',
    icon: AlertTriangle,
    bar: 'bg-[hsl(var(--status-warning))]',
  },
  info: {
    cls: 'border-[hsl(var(--status-info))] bg-[hsl(var(--status-info-bg))] text-[hsl(var(--status-info))]',
    icon: Info,
    bar: 'bg-[hsl(var(--status-info))]',
  },
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
  return (
    <div
      className={`toast-enter pointer-events-auto w-[360px] max-w-[calc(100vw-2rem)] shadow-lg rounded-xl border overflow-hidden bg-card ${meta.cls}`}
      role="status"
    >
      <div className="flex items-start gap-2 px-3 py-2.5">
        <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground leading-snug">{toast.title}</p>
          {toast.description && (
            <p className="text-xs text-foreground/70 mt-0.5 break-words whitespace-pre-wrap">
              {toast.description}
            </p>
          )}
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
