/**
 * Subject colour coding mirrors the printed timetable everyone already reads,
 * so the on-screen grid is recognisable at a glance.
 */
const PALETTE = [
  { bg: 'bg-sky-50', border: 'border-sky-200', text: 'text-sky-700', dot: 'bg-sky-500' },
  { bg: 'bg-slate-50', border: 'border-slate-300', text: 'text-slate-700', dot: 'bg-slate-500' },
  { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700', dot: 'bg-amber-500' },
  { bg: 'bg-fuchsia-50', border: 'border-fuchsia-200', text: 'text-fuchsia-700', dot: 'bg-fuchsia-500' },
  { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  { bg: 'bg-violet-50', border: 'border-violet-200', text: 'text-violet-700', dot: 'bg-violet-500' },
];

const FIXED = { WAD: 0, OSP: 1, DL: 2, CPS: 3 };

export function subjectStyle(code) {
  if (!code) return { bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-600', dot: 'bg-slate-400' };
  if (code in FIXED) return PALETTE[FIXED[code]];
  let hash = 0;
  for (let i = 0; i < code.length; i += 1) hash = (hash * 31 + code.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

/** How a deviation from the plan is labelled in the grid. */
export const ORIGIN_BADGE = {
  extra: { label: 'Extra', cls: 'bg-indigo-600 text-white' },
  'moved-in': { label: 'Moved here', cls: 'bg-amber-500 text-white' },
  'swapped-in': { label: 'Swapped', cls: 'bg-violet-600 text-white' },
  'moved-out': { label: 'Moved', cls: 'bg-slate-200 text-slate-500' },
  cancelled: { label: 'Cancelled', cls: 'bg-rose-100 text-rose-600' },
};

export const KIND_LABEL = {
  'office-hours': 'Office hours',
  event: 'Event',
  lecture: '',
};

/**
 * "Practical", "Tutorial", "Lab" — the printed timetable distinguishes these
 * from an ordinary lecture, so the grid has to as well. It is read back out of
 * the cell's own text rather than stored separately, which keeps what is shown
 * tied to what the uploaded file actually said.
 */
export function sessionQualifier(occurrence) {
  const m = String(occurrence?.title || '').match(/\b(tutorial|practical|lab)\b/i);
  if (!m) return '';
  return m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
}

export const isGone = (o) => o.origin === 'moved-out' || o.origin === 'cancelled';

export function addDaysKey(dateKey, n) {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function startOfWeekKey(dateKey) {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  return addDaysKey(dateKey, -(dow - 1));
}

/** 'Mon 10 Aug' */
export function shortDate(dateKey) {
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

export function weekLabel(startKey) {
  const end = addDaysKey(startKey, 4);
  const a = new Date(`${startKey}T00:00:00`);
  const b = new Date(`${end}T00:00:00`);
  const sameMonth = a.getMonth() === b.getMonth();
  const opts = { day: 'numeric', month: 'short' };
  return `${a.toLocaleDateString('en-IN', sameMonth ? { day: 'numeric' } : opts)} – ${b.toLocaleDateString(
    'en-IN',
    { ...opts, year: 'numeric' }
  )}`;
}

export const todayKey = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

export function dayOfWeekKey(dateKey) {
  const js = new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
  return js === 0 ? 7 : js;
}

/**
 * Which calendar date does a recurring weekday land on for a swap?
 *
 * Use the same week as the class being offered, so the two sides stay close
 * together. If that date has already passed — the common case late in a week —
 * roll forward, because a swap can only be arranged for a class still to come.
 */
export function occurrenceDateFor(dayOfWeek, referenceDateKey) {
  let date = addDaysKey(startOfWeekKey(referenceDateKey), dayOfWeek - 1);
  while (date < todayKey()) date = addDaysKey(date, 7);
  return date;
}
