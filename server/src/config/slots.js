/**
 * Period grid for the whole institute. Slots are referenced by number
 * everywhere (timetable entries, attendance sessions, schedule changes), so
 * these definitions are the single source of truth for clock times.
 */
export const SLOTS = [
  { slot: 1, label: '9:00 - 9:55', start: '09:00', end: '09:55' },
  { slot: 2, label: '10:00 - 10:55', start: '10:00', end: '10:55' },
  { slot: 3, label: '11:00 - 11:55', start: '11:00', end: '11:55' },
  { slot: 4, label: '1:30 - 2:25', start: '13:30', end: '14:25' },
  { slot: 5, label: '2:30 - 3:25', start: '14:30', end: '15:25' },
  { slot: 6, label: '3:30 - 4:25', start: '15:30', end: '16:25' },
];

/** Rendered between slot 3 and slot 4; never bookable. */
export const LUNCH = { label: 'LUNCH', start: '12:30', end: '13:30', afterSlot: 3 };

export const SLOT_NUMBERS = SLOTS.map((s) => s.slot);
export const getSlot = (n) => SLOTS.find((s) => s.slot === Number(n)) || null;
export const isValidSlot = (n) => SLOT_NUMBERS.includes(Number(n));

/** 1 = Monday … 7 = Sunday (ISO). */
export const DAYS = [
  { day: 1, name: 'Monday', short: 'Mon', teaching: true },
  { day: 2, name: 'Tuesday', short: 'Tue', teaching: true },
  { day: 3, name: 'Wednesday', short: 'Wed', teaching: true },
  { day: 4, name: 'Thursday', short: 'Thu', teaching: true },
  { day: 5, name: 'Friday', short: 'Fri', teaching: true },
  /*
   * Not part of the recurring weekly grid — no PDF timetable schedules a
   * regular class here — but still a real day for an extra class or a class
   * shifted off a weekday, so it needs to be bookable and visible like any
   * other teaching day rather than hidden from the week view entirely.
   */
  { day: 6, name: 'Saturday', short: 'Sat', teaching: true },
  { day: 7, name: 'Sunday', short: 'Sun', teaching: false },
];

export const TEACHING_DAYS = DAYS.filter((d) => d.teaching).map((d) => d.day);
export const dayName = (n) => DAYS.find((d) => d.day === n)?.name || '';
export const isTeachingDay = (n) => TEACHING_DAYS.includes(Number(n));

/** Accepts 'Monday' | 'Mon' | '1' and returns the ISO day number. */
export function parseDay(input) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim();
  if (/^[1-7]$/.test(raw)) return Number(raw);
  const lower = raw.toLowerCase();
  const hit = DAYS.find((d) => d.name.toLowerCase() === lower || d.short.toLowerCase() === lower);
  return hit ? hit.day : null;
}
