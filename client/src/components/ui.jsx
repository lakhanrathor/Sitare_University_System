import { createContext, useContext, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Inbox, X, Info } from 'lucide-react';
import { styleFor } from '../lib/format';

/* ---------------------------------------------------------------- */
/* Surfaces                                                          */
/* ---------------------------------------------------------------- */

export function Card({ className = '', children, ...rest }) {
  return (
    <div
      className={`elev-1 rounded-2xl border border-slate-200/70 bg-white ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

/*
 * Tells a Button it is sitting on a violet surface. The alternative was passing
 * a variant at all twelve call sites of PageHeader, which guarantees that the
 * thirteenth is written without one and renders an indigo button on an indigo
 * panel — invisible, and only findable by looking at that page.
 */
const OnViolet = createContext(false);

/**
 * The heading a working page opens with.
 *
 * Deliberately *not* the dashboard's violet panel. A coloured slab on every
 * screen stops reading as emphasis by about the third page, and on the pages
 * people actually work on — a register, a week grid — the height is better
 * spent on the work. The icon tile carries the colour instead: it is small,
 * it differs per page, and it gives the eye somewhere to land.
 */
export function PageHeader({ title, subtitle, actions, icon: Icon, tone = 'indigo' }) {
  const tones = {
    indigo: 'from-indigo-500 to-indigo-700 shadow-indigo-600/25',
    accent: 'from-accent-400 to-accent-600 shadow-accent-600/25',
    emerald: 'from-emerald-400 to-emerald-600 shadow-emerald-600/25',
    sky: 'from-sky-400 to-sky-600 shadow-sky-600/25',
  };
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3.5">
        {Icon && (
          <span
            className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br text-white shadow-md ${
              tones[tone] || tones.indigo
            }`}
          >
            <Icon className="h-5 w-5" strokeWidth={2.1} />
          </span>
        )}
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold tracking-tight text-slate-900 sm:text-[26px]">
            {title}
          </h1>
          {subtitle && <p className="mt-0.5 max-w-2xl text-sm text-slate-500">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * The coloured panel a dashboard opens with.
 *
 * The rail is the only saturated thing in the old layout, which left every
 * page reading as white boxes sitting next to a design rather than part of
 * one. Repeating the rail's violet at the top of the page is what ties the two
 * halves of the screen together; the washes keep it from being a flat slab.
 */
export function HeroPanel({ title, subtitle, actions, children, className = '' }) {
  return (
    <div
      className={`elev-2 relative mb-6 overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-600 via-indigo-700 to-indigo-900 px-6 py-7 text-white sm:px-8 ${className}`}
    >
      <div
        className="pointer-events-none absolute -top-20 -right-12 h-56 w-56 rounded-full bg-white/10 blur-2xl"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -bottom-24 left-1/4 h-48 w-48 rounded-full bg-accent-400/25 blur-3xl"
        aria-hidden="true"
      />
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight sm:text-[28px]">{title}</h1>
          {subtitle && <p className="mt-1.5 max-w-xl text-sm text-indigo-100/85">{subtitle}</p>}
        </div>
        {actions && (
          <OnViolet.Provider value={true}>
            <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
          </OnViolet.Provider>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * A section heading with an accent mark, so a page reads as a set of parts
 * rather than one long column. The mark is the only place accent appears in
 * the content area, which keeps it structural rather than decorative.
 */
export function SectionTitle({ children, action, className = '' }) {
  return (
    <div className={`mb-3 flex items-baseline justify-between gap-3 ${className}`}>
      <h2 className="flex items-center gap-2.5 text-base font-bold tracking-tight text-slate-900">
        <span className="h-4 w-1 rounded-full bg-gradient-to-b from-accent-400 to-accent-600" />
        {children}
      </h2>
      {action}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Controls                                                          */
/* ---------------------------------------------------------------- */

const BTN = {
  /*
   * A gradient rather than a flat fill, and a shadow tinted with the button's
   * own colour rather than black — a grey shadow under a coloured element is
   * one of the things that makes an interface look unfinished.
   */
  primary:
    'bg-gradient-to-b from-indigo-500 to-indigo-600 text-white shadow-md shadow-indigo-600/20 hover:from-indigo-600 hover:to-indigo-700 focus-visible:outline-indigo-600 disabled:from-indigo-300 disabled:to-indigo-300 disabled:shadow-none',
  accent:
    'bg-gradient-to-b from-accent-400 to-accent-500 text-white shadow-md shadow-accent-600/25 hover:from-accent-500 hover:to-accent-600 focus-visible:outline-accent-500 disabled:from-accent-200 disabled:to-accent-200 disabled:shadow-none',
  secondary:
    'bg-white text-slate-700 border border-slate-200 shadow-sm hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-slate-400 disabled:text-slate-400',
  /*
   * For use on the hero panel. A violet primary button on a violet panel is
   * invisible, and a white one is the only fill that stays legible against the
   * gradient at every point along it.
   */
  light:
    'bg-white text-indigo-700 shadow-md shadow-indigo-950/20 hover:bg-indigo-50 focus-visible:outline-white disabled:bg-white/60 disabled:text-indigo-400 disabled:shadow-none',
  translucent:
    'bg-white/15 text-white border border-white/25 backdrop-blur hover:bg-white/25 focus-visible:outline-white disabled:bg-white/5 disabled:text-white/40 disabled:border-white/10',
  ghost: 'text-slate-600 hover:bg-slate-100 focus-visible:outline-slate-400',
  danger:
    'bg-white text-rose-600 border border-rose-200 hover:bg-rose-50 focus-visible:outline-rose-500',
};

/* Only the variants meant for the canvas need a stand-in; `light` and
   `translucent` are already the violet-surface pair and map to themselves. */
const ON_VIOLET = { primary: 'light', secondary: 'translucent', ghost: 'translucent', danger: 'light' };

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className = '',
  children,
  disabled,
  ...rest
}) {
  const onViolet = useContext(OnViolet);
  const v = (onViolet && ON_VIOLET[variant]) || variant;
  const sizes = { sm: 'h-8 px-3.5 text-[13px]', md: 'h-10 px-4 text-sm', lg: 'h-11 px-5 text-sm' };
  return (
    <button
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed ${BTN[v]} ${sizes[size]} ${className}`}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Input({ label, error, className = '', id, ...rest }) {
  return (
    <div className={className}>
      {label && (
        <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-700">
          {label}
        </label>
      )}
      <input
        id={id}
        className={`h-10 w-full rounded-xl border bg-white px-3.5 text-sm text-slate-900 transition placeholder:text-slate-400 focus:ring-4 focus:outline-none ${
          error
            ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-100'
            : 'border-slate-200 focus:border-indigo-400 focus:ring-indigo-100'
        }`}
        {...rest}
      />
      {error && <p className="mt-1.5 text-xs text-rose-600">{error}</p>}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Feedback                                                          */
/* ---------------------------------------------------------------- */

export function Badge({ status, children, className = '' }) {
  const s = styleFor(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${s.bg} ${s.border} ${s.text} ${className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {children ?? s.label}
    </span>
  );
}

export function Spinner({ label = 'Loading' }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-20 text-sm text-slate-500">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}…
    </div>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, description, action }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 rounded-2xl bg-indigo-50 p-3.5">
        <Icon className="h-5 w-5 text-indigo-400" />
      </div>
      <p className="text-sm font-medium text-slate-900">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children }) {
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
      {children}
    </div>
  );
}

export function InfoNote({ children, icon: Icon = Info }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl bg-indigo-50/60 px-3.5 py-2.5">
      <Icon className="mt-px h-4 w-4 shrink-0 text-indigo-400" />
      <p className="text-xs leading-relaxed text-slate-600">{children}</p>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Modal                                                             */
/* ---------------------------------------------------------------- */

export function Modal({ open, onClose, title, subtitle, children, footer, width = 'max-w-lg' }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    document.addEventListener('keydown', onKey);
    // Stop the page behind the dialog from scrolling.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  /*
   * Rendered into <body>. A dialog belongs to the viewport, but `position:
   * fixed` is measured against the nearest ancestor carrying a transform,
   * filter or containment — any of which would anchor it to a page section.
   * Portalling puts it beyond the reach of whatever the page is doing.
   */
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div
        className="absolute inset-0 bg-indigo-950/40 backdrop-blur-[3px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`animate-fade-up elev-2 relative flex max-h-[92vh] w-full ${width} flex-col overflow-hidden rounded-t-3xl bg-white sm:rounded-3xl`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200/70 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-900">{title}</h2>
            {subtitle && <p className="mt-0.5 truncate text-sm text-slate-500">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            className="-mt-1 rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            <X className="h-4.5 w-4.5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-slate-200/70 bg-slate-50/70 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

export function Field({ label, hint, children, className = '' }) {
  return (
    <div className={className}>
      <label className="mb-1.5 block text-sm font-medium text-slate-700">{label}</label>
      {children}
      {hint && <p className="mt-1.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function Select({ className = '', children, ...rest }) {
  return (
    <select
      className={`h-10 w-full rounded-xl border border-slate-200 bg-white px-3.5 text-sm text-slate-900 transition focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100 focus:outline-none ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Textarea({ className = '', ...rest }) {
  return (
    <textarea
      className={`w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 transition placeholder:text-slate-400 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100 focus:outline-none ${className}`}
      {...rest}
    />
  );
}
