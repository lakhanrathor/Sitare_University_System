/**
 * Attendance is a calendar-day concept, so every date is reduced to a
 * 'YYYY-MM-DD' key plus a UTC-midnight Date. This keeps a class held on the
 * 7th from drifting to the 6th because of a server timezone offset.
 */

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function toDateKey(input) {
  if (typeof input === 'string' && DATE_KEY_RE.test(input)) return input;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function toUTCDate(input) {
  const key = toDateKey(input);
  if (!key) return null;
  return new Date(`${key}T00:00:00.000Z`);
}

export function todayKey() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export function isFutureKey(key) {
  return key > todayKey();
}

/** ISO weekday for a date key: 1 = Monday … 7 = Sunday. */
export function dayOfWeek(dateKey) {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  const js = d.getUTCDay(); // 0 = Sunday
  return js === 0 ? 7 : js;
}

/** Date key N days after `dateKey` (negative N goes backwards). */
export function addDays(dateKey, n) {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing `dateKey`. */
export function startOfWeek(dateKey) {
  return addDays(dateKey, -(dayOfWeek(dateKey) - 1));
}

/** The seven date keys of the week containing `dateKey`, Monday first. */
export function weekDates(dateKey) {
  const monday = startOfWeek(dateKey);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/**
 * The calendar date a recurring weekday falls on, relative to a reference date.
 * Stays in the reference week so a swap's two halves sit close together, but
 * rolls forward when that date has already passed — you cannot swap a class
 * that has already been taught.
 */
export function occurrenceDateFor(dow, referenceDateKey) {
  let date = addDays(startOfWeek(referenceDateKey), dow - 1);
  const today = todayKey();
  while (date < today) date = addDays(date, 7);
  return date;
}
