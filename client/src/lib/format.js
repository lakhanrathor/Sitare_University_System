/**
 * Percentage display rules, kept in one place so every screen agrees:
 *  - null  -> "—"  (no class conducted yet; NEVER shown as 0%)
 *  - whole numbers drop the decimals: 100, not 100.00
 */
export function formatPct(pct) {
  if (pct === null || pct === undefined) return '—';
  return Number.isInteger(pct) ? String(pct) : pct.toFixed(2).replace(/0$/, '');
}

export const STATUS_STYLES = {
  good: {
    label: 'On track',
    text: 'text-emerald-700',
    bg: 'bg-emerald-50',
    border: 'border-emerald-200',
    ring: 'stroke-emerald-500',
    dot: 'bg-emerald-500',
    bar: 'bg-emerald-500',
  },
  warning: {
    label: 'Needs attention',
    text: 'text-amber-700',
    bg: 'bg-amber-50',
    border: 'border-amber-200',
    ring: 'stroke-amber-500',
    dot: 'bg-amber-500',
    bar: 'bg-amber-500',
  },
  critical: {
    label: 'Shortage',
    text: 'text-rose-700',
    bg: 'bg-rose-50',
    border: 'border-rose-200',
    ring: 'stroke-rose-500',
    dot: 'bg-rose-500',
    bar: 'bg-rose-500',
  },
  'no-data': {
    label: 'Not started',
    text: 'text-slate-500',
    bg: 'bg-slate-50',
    border: 'border-slate-200',
    ring: 'stroke-slate-300',
    dot: 'bg-slate-300',
    bar: 'bg-slate-300',
  },
};

export const styleFor = (status) => STATUS_STYLES[status] || STATUS_STYLES['no-data'];

/**
 * Client-side mirror of the server's status rule, for views that receive a raw
 * percentage without a precomputed status.
 */
export function attendanceStatusFromPct(pct, min = 75) {
  if (pct === null || pct === undefined) return 'no-data';
  if (pct >= min) return 'good';
  if (pct >= min - 10) return 'warning';
  return 'critical';
}

/**
 * The name to greet someone by. Faculty are stored with their title —
 * "Ms Chhavi Sharma", "Dr Purnendu" — so taking the first word verbatim
 * greets them as "Ms".
 */
export function firstName(fullName) {
  const parts = String(fullName || '')
    .trim()
    .split(/\s+/)
    .filter((w) => !/^(mr|mrs|ms|miss|dr|prof|sir|shri|smt)\.?$/i.test(w));
  return parts[0] || String(fullName || '').split(' ')[0] || '';
}

/**
 * How a cohort reads. A semester that runs one undivided batch has no section
 * name, and printing "Section " with nothing after it looks like a bug.
 */
export function sectionLabel(section) {
  const name = typeof section === 'string' ? section : section?.name;
  return name ? `Section ${name}` : 'All students';
}

/**
 * The one-line identity of a subject offering: code, semester and cohort.
 * Two offerings of the same subject share a name, so the semester and section
 * are what actually tell a teacher which class they are looking at.
 */
export function cohortLine(subject) {
  if (!subject) return '';
  return [
    subject.code,
    subject.semester ? `Semester ${subject.semester}` : null,
    sectionLabel(subject.section),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Compact form for table cells and chips: 'A' or '—'. */
export function sectionShort(section) {
  const name = typeof section === 'string' ? section : section?.name;
  return name || '—';
}

/** '2026-08-05' -> 'Wed, 5 Aug' */
export function formatDate(dateKey, withYear = false) {
  if (!dateKey) return '';
  const d = new Date(`${dateKey}T00:00:00`);
  return d.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

export function todayKey() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

/**
 * How many more consecutive classes must be attended to reach the requirement.
 * Solves (present + x) / (conducted + x) >= min/100.
 */
export function classesNeeded(present, conducted, min = 75) {
  if (!conducted) return 0;
  if ((present / conducted) * 100 >= min) return 0;
  const m = min / 100;
  return Math.ceil((m * conducted - present) / (1 - m));
}

/** How many classes can still be missed while staying at/above the requirement. */
export function classesCanMiss(present, conducted, min = 75) {
  if (!conducted) return 0;
  const m = min / 100;
  if ((present / conducted) * 100 < min) return 0;
  return Math.floor(present / m - conducted);
}
