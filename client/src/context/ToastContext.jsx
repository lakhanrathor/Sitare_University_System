import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';

const ToastContext = createContext(null);

const VARIANTS = {
  success: { icon: CheckCircle2, ring: 'border-emerald-200', tint: 'text-emerald-600' },
  error: { icon: AlertTriangle, ring: 'border-rose-200', tint: 'text-rose-600' },
  info: { icon: Info, ring: 'border-indigo-200', tint: 'text-indigo-600' },
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const notify = useCallback(
    (message, { variant = 'info', title, duration = 4500 } = {}) => {
      const id = ++idRef.current;
      setToasts((t) => [...t, { id, message, variant, title }]);
      if (duration) setTimeout(() => dismiss(id), duration);
      return id;
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={{ notify, dismiss }}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => {
          const v = VARIANTS[t.variant] || VARIANTS.info;
          const Icon = v.icon;
          return (
            <div
              key={t.id}
              role="status"
              className={`animate-slide-in pointer-events-auto flex items-start gap-3 rounded-xl border ${v.ring} bg-white p-3.5 shadow-lg shadow-slate-900/5`}
            >
              <Icon className={`mt-0.5 h-4.5 w-4.5 shrink-0 ${v.tint}`} strokeWidth={2} />
              <div className="min-w-0 flex-1">
                {t.title && <p className="text-sm font-semibold text-slate-900">{t.title}</p>}
                <p className="text-sm leading-snug text-slate-600">{t.message}</p>
              </div>
              <button
                onClick={() => dismiss(t.id)}
                className="rounded-md p-0.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                aria-label="Dismiss notification"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
