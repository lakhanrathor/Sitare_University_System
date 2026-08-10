import Timetable from '../models/Timetable.js';
import TimetableEntry from '../models/TimetableEntry.js';
import ScheduleChange from '../models/ScheduleChange.js';
import ClassSession from '../models/ClassSession.js';
import AttendanceDelegation from '../models/AttendanceDelegation.js';
import { dayOfWeek, weekDates } from '../utils/date.js';
import { SLOTS, LUNCH, isTeachingDay } from '../config/slots.js';

/** The one live grid for a semester, or null before anything is published. */
export function getPublishedTimetable(semester) {
  const filter = { status: 'published' };
  if (semester) filter.semester = Number(semester);
  return Timetable.findOne(filter).sort({ publishedAt: -1 }).lean();
}

/** Every live grid — one per semester. */
export function getPublishedTimetables() {
  return Timetable.find({ status: 'published' }).sort({ semester: 1 }).lean();
}

/**
 * The period grid a timetable runs on. Uploaded timetables carry their own
 * times; the built-in list is only a fallback for data created before any
 * file was uploaded.
 */
export const slotsOf = (timetable) =>
  timetable?.slots?.length ? timetable.slots : SLOTS;

/** Period times for a semester, for anywhere that needs to print a label. */
export async function slotsForSemester(semester) {
  const tt = await getPublishedTimetable(semester);
  return slotsOf(tt);
}

/** A label like '9:00-10:00' for a slot number, given a slot list. */
export const labelOf = (slots, n) =>
  slots.find((s) => s.slot === Number(n))?.label || `Period ${n}`;

const personLite = (u) => (u ? { id: String(u._id), name: u.name, email: u.email } : null);
const subjectLite = (s) =>
  s ? { id: String(s._id), code: s.code, name: s.name, minAttendance: s.minAttendance } : null;
const sectionLite = (s) => (s ? { id: String(s._id), name: s.name } : null);

/**
 * Turn a recurring entry (plus the date it lands on) into a dated class.
 * `origin` records where it came from so the UI can label moved classes.
 */
function toOccurrence(entry, dateKey, slot, extras = {}) {
  const sub = entry?.subject || extras.subject;
  const sec = entry?.section || extras.section;
  return {
    // Stable per date+slot so React keys and conflict maps behave.
    id: `${entry?._id || extras.changeId}-${dateKey}-${slot}`,
    entryId: entry ? String(entry._id) : null,
    changeId: extras.changeId || null,
    date: dateKey,
    slot,
    /*
     * Which year is sitting in this period. Conflict checks need it to tell a
     * combined class — one lecturer, two cohorts of the same year — from a
     * genuine double-booking across two different years.
     */
    semester: extras.semester ?? sub?.semester ?? sec?.semester ?? null,
    section: sectionLite(entry?.section || extras.section),
    subject: subjectLite(entry?.subject || extras.subject),
    /*
     * The period's own lecturer if one is set, otherwise whoever owns the
     * subject. Without the fallback, assigning a subject to a lecturer leaves
     * every cell still reading "no teacher" until someone edits each period.
     */
    faculty: personLite(entry?.faculty || extras.faculty || sub?.faculty),
    // Filled in per date once delegations are read — see resolveOccurrences.
    attendanceBy: null,
    kind: extras.kind || entry?.kind || 'lecture',
    title: entry?.title || extras.title || '',
    room: entry?.room || extras.room || '',
    origin: extras.origin || 'scheduled',
    movedFrom: extras.movedFrom || null,
    movedTo: extras.movedTo || null,
    reason: extras.reason || '',
    swapRequest: extras.swapRequest ? String(extras.swapRequest) : null,
    createdBy: extras.createdBy ? String(extras.createdBy) : null,
  };
}

/**
 * Resolve the real classes for a set of dates.
 *
 * The weekly grid is the baseline; ScheduleChange documents then subtract
 * classes that moved away or were cancelled and add the ones that moved in or
 * were booked as extras. Nothing is materialised in the database, so the
 * recurring plan stays clean no matter how many one-off changes pile up.
 */
export async function resolveOccurrences(dateKeys, { timetableId, sectionId, semester } = {}) {
  /*
   * Resolve across every published semester by default. A lecturer can teach
   * semester 3 and semester 5, and a clash between those two is just as real
   * as one inside a single year — so conflict checks must see the whole
   * picture. Callers that are only drawing one semester's grid pass `semester`
   * to narrow it.
   */
  let timetables;
  if (timetableId) {
    const one = await Timetable.findById(timetableId).lean();
    timetables = one ? [one] : [];
  } else {
    timetables = await getPublishedTimetables();
    if (semester) timetables = timetables.filter((t) => t.semester === Number(semester));
  }

  const dates = dateKeys.filter(isTeachingDayKey);
  const timetable = timetables[0] || null;
  if (!timetables.length || !dates.length) return { timetable, timetables, byDate: {} };

  const entryFilter = { timetable: { $in: timetables.map((t) => t._id) } };
  // A section-less period belongs to the whole semester, so it stays visible
  // even when the caller is scoped to one cohort.
  if (sectionId) entryFilter.$or = [{ section: sectionId }, { section: null }];

  const populate = [
    {
      path: 'subject',
      select: 'code name minAttendance section semester faculty',
      // Its owner, so a period with no lecturer of its own can fall back to it.
      populate: { path: 'faculty', select: 'name email' },
    },
    { path: 'faculty', select: 'name email' },
    { path: 'section', select: 'name semester' },
  ];

  // An event names no subject and no cohort, so its year comes from the
  // timetable it was printed on.
  const semesterOfTimetable = new Map(timetables.map((t) => [String(t._id), t.semester]));

  const [entries, changes] = await Promise.all([
    TimetableEntry.find(entryFilter).populate(populate).lean(),
    ScheduleChange.find({
      $and: [
        { $or: [{ dateKey: { $in: dates } }, { toDateKey: { $in: dates } }] },
        ...(sectionId ? [{ $or: [{ section: sectionId }, { section: null }] }] : []),
      ],
    })
      .populate([
        {
          path: 'subject',
          select: 'code name minAttendance section semester faculty',
          populate: { path: 'faculty', select: 'name email' },
        },
        { path: 'faculty', select: 'name email' },
        { path: 'section', select: 'name semester' },
        { path: 'entry', populate },
      ])
      .lean(),
  ]);

  const entriesByDay = new Map();
  for (const e of entries) {
    if (!entriesByDay.has(e.dayOfWeek)) entriesByDay.set(e.dayOfWeek, []);
    entriesByDay.get(e.dayOfWeek).push(e);
  }

  // Classes leaving a date, keyed "<dateKey>|<entryId>".
  const departures = new Map();
  const arrivals = [];
  const extras = [];

  for (const c of changes) {
    if (c.kind === 'cancel' && dates.includes(c.dateKey)) {
      departures.set(`${c.dateKey}|${c.entry?._id}`, c);
    } else if (c.kind === 'move') {
      if (dates.includes(c.dateKey)) departures.set(`${c.dateKey}|${c.entry?._id}`, c);
      if (dates.includes(c.toDateKey)) arrivals.push(c);
    } else if (c.kind === 'extra' && dates.includes(c.dateKey)) {
      extras.push(c);
    }
  }

  const byDate = {};
  for (const dateKey of dates) {
    const dow = dayOfWeek(dateKey);
    const list = [];

    for (const entry of entriesByDay.get(dow) || []) {
      const change = departures.get(`${dateKey}|${entry._id}`);
      if (change) {
        // Leave a tombstone so the grid can show "moved to Thu 2:30" in place.
        list.push(
          toOccurrence(entry, dateKey, entry.slot, {
            origin: change.kind === 'cancel' ? 'cancelled' : 'moved-out',
            movedTo:
              change.kind === 'move' ? { date: change.toDateKey, slot: change.toSlot } : null,
            reason: change.reason,
            changeId: String(change._id),
            swapRequest: change.swapRequest,
            semester: semesterOfTimetable.get(String(entry.timetable)),
          })
        );
        continue;
      }
      list.push(
        toOccurrence(entry, dateKey, entry.slot, {
          semester: semesterOfTimetable.get(String(entry.timetable)),
        })
      );
    }

    for (const c of arrivals.filter((a) => a.toDateKey === dateKey)) {
      if (!c.entry) continue;
      list.push(
        toOccurrence(c.entry, dateKey, c.toSlot, {
          origin: c.swapRequest ? 'swapped-in' : 'moved-in',
          movedFrom: { date: c.dateKey, slot: c.fromSlot ?? c.entry.slot },
          reason: c.reason,
          changeId: String(c._id),
          swapRequest: c.swapRequest,
          createdBy: c.createdBy,
          semester: semesterOfTimetable.get(String(c.entry.timetable)),
        })
      );
    }

    for (const c of extras.filter((e) => e.dateKey === dateKey)) {
      list.push(
        toOccurrence(null, dateKey, c.slot, {
          changeId: String(c._id),
          section: c.section,
          subject: c.subject,
          faculty: c.faculty,
          kind: c.kindOfClass || 'lecture',
          title: c.title,
          room: c.room,
          origin: 'extra',
          reason: c.reason,
          createdBy: c.createdBy,
        })
      );
    }

    list.sort((a, b) => a.slot - b.slot);
    byDate[dateKey] = list;
  }

  /*
   * Stand-ins, applied last because they belong to a dated class rather than
   * to the weekly grid. A hand-over arranged for one Tuesday leaves every
   * other Tuesday alone.
   */
  const delegations = await AttendanceDelegation.find({ dateKey: { $in: dates } })
    .populate('faculty', 'name email')
    .lean();

  if (delegations.length) {
    const bySubject = new Map(
      delegations.map((d) => [`${d.subject}|${d.dateKey}|${d.slot}`, d])
    );
    const byEntry = new Map(
      delegations.filter((d) => d.entry).map((d) => [`${d.entry}|${d.dateKey}|${d.slot}`, d])
    );

    for (const dateKey of dates) {
      for (const o of byDate[dateKey] || []) {
        const hit =
          (o.subject && bySubject.get(`${o.subject.id}|${dateKey}|${o.slot}`)) ||
          (o.entryId && byEntry.get(`${o.entryId}|${dateKey}|${o.slot}`));
        if (hit) o.attendanceBy = personLite(hit.faculty);
      }
    }
  }

  return { timetable, timetables, byDate };
}

const isTeachingDayKey = (k) => isTeachingDay(dayOfWeek(k));

/** Week grid for the UI: 7 dates, each with its resolved classes. */
export async function getWeek(anchorDateKey, opts = {}) {
  const dates = weekDates(anchorDateKey);
  const { timetable, byDate } = await resolveOccurrences(dates, opts);

  // Does this timetable actually split into sections? If nothing carries one,
  // the grid is a single column per day rather than one per cohort.
  const all = Object.values(byDate).flat();
  const sectionSplit = all.some((o) => o.section);

  return {
    sectionSplit,
    timetable: timetable
      ? {
          id: String(timetable._id),
          name: timetable.name,
          semester: timetable.semester,
          status: timetable.status,
          effectiveFrom: timetable.effectiveFromKey,
        }
      : null,
    semester: opts.semester ? Number(opts.semester) : timetable?.semester || null,
    // The grid draws itself from the timetable's own periods.
    slots: slotsOf(timetable),
    lunch: timetable?.lunch || LUNCH,
    weekStart: dates[0],
    days: dates.map((date) => ({
      date,
      dayOfWeek: dayOfWeek(date),
      teaching: isTeachingDayKey(date),
      occurrences: byDate[date] || [],
    })),
  };
}

/**
 * Is (date, slot) usable for `sectionId` / `facultyId`?
 *
 * A cohort clash is always fatal — students cannot be in two rooms.
 *
 * A lecturer appearing twice in one period depends on who is in front of them:
 *
 *   same semester      a combined class. Institutes routinely timetable the
 *                      sections of a year side by side and let the lecturer
 *                      take them together, walking between rooms to mark each
 *                      register. Allowed, and returned as `parallel` so callers
 *                      can mention it — never to block on.
 *   across semesters   a real double-booking. Second-years and third-years do
 *                      not sit in one class, so the lecturer would have to be
 *                      in two places at once. Fatal.
 */
export async function findConflicts({
  dateKey,
  slot,
  sectionId,
  /**
   * The asking cohort is a whole undivided year, which has no section id but
   * is still a cohort — everyone in that year sits in the period. Without this
   * a semester that never split into sections gets no clash checking at all.
   */
  wholeYear = false,
  facultyId,
  semester,
  ignoreEntryIds = [],
}) {
  const { byDate } = await resolveOccurrences([dateKey]);
  const ignore = new Set(ignoreEntryIds.map(String));

  const atSlot = (byDate[dateKey] || []).filter(
    (o) =>
      o.slot === Number(slot) &&
      !['moved-out', 'cancelled'].includes(o.origin) &&
      !(o.entryId && ignore.has(o.entryId))
  );

  /*
   * An unknown year on either side is treated as the same year. Refusing on
   * missing data would block a legitimate booking over a gap in the record.
   */
  const sameYear = (o) =>
    semester == null || o.semester == null || Number(o.semester) === Number(semester);

  /*
   * A period with no section belongs to a whole year sitting together, so it
   * takes that hour from every cohort *of that year* — not from the whole
   * college. An undivided semester 3 must not make semester 5 unbookable.
   */
  const section =
    sectionId || wholeYear
      ? atSlot.find((o) => {
          // An undivided year is every cohort of that year, split or not.
          if (!sectionId) return sameYear(o);
          return o.section ? String(o.section.id) === String(sectionId) : sameYear(o);
        }) || null
      : null;

  const theirs = facultyId
    ? atSlot.filter((o) => o !== section && o.faculty && String(o.faculty.id) === String(facultyId))
    : [];

  return {
    section,
    // Cohorts of this same year the lecturer also has then — informational.
    parallel: theirs.filter(sameYear),
    // Another year entirely: they cannot be in both.
    faculty: theirs.find((o) => !sameYear(o)) || null,
    all: atSlot,
  };
}

/**
 * Free periods on a date — what a teacher looking for a room to run an extra
 * class actually needs. A period is free for a section when that section has
 * nothing scheduled; `facultyFree` additionally reports whether the asking
 * teacher is themselves free then.
 */
export async function getFreeSlots(dateKey, { facultyId, sections, semester } = {}) {
  const { byDate, timetables } = await resolveOccurrences([dateKey]);
  const live = (byDate[dateKey] || []).filter(
    (o) => !['moved-out', 'cancelled'].includes(o.origin)
  );

  // Free periods only mean something against the grid the section runs on.
  const tt = semester
    ? (timetables || []).find((t) => t.semester === Number(semester))
    : (timetables || [])[0];
  const periods = slotsOf(tt);

  /*
   * A period with no section takes that hour from every cohort of its own
   * year. Keyed by year, so an undivided semester does not blank the period
   * out for the rest of the college.
   */
  const wholeSemesterBusy = new Set(
    live.filter((o) => !o.section).map((o) => `${o.semester}|${o.slot}`)
  );
  const busySection = new Set(live.map((o) => `${o.section?.id}|${o.slot}`));
  const busyFaculty = new Set(live.filter((o) => o.faculty).map((o) => `${o.faculty.id}|${o.slot}`));

  const result = [];
  for (const section of sections || []) {
    for (const s of periods) {
      const sectionFree =
        !busySection.has(`${section.id}|${s.slot}`) &&
        !wholeSemesterBusy.has(`${section.semester ?? semester}|${s.slot}`);
      if (!sectionFree) continue;
      result.push({
        date: dateKey,
        slot: s.slot,
        label: s.label,
        section: { id: String(section.id), name: section.name },
        /*
         * Whether the asking teacher already has a cohort then. Informational
         * only — a second cohort in the same period is a combined class, so
         * this must never be used to make a slot unbookable.
         */
        facultyFree: facultyId ? !busyFaculty.has(`${facultyId}|${s.slot}`) : true,
      });
    }
  }
  return result;
}

/**
 * Keep attendance aligned with the timetable.
 *
 * A class that moves keeps its identity, so an attendance sheet already taken
 * for it travels to the new date/slot rather than being recreated — the
 * conducted-class count is unchanged by a reschedule. Nothing is created here:
 * a session still only exists once a teacher has actually taken attendance,
 * which is what keeps the attendance denominator honest.
 */
export async function moveAttendanceSession({
  subjectId,
  fromDateKey,
  fromSlot,
  toDateKey,
  toSlot,
  facultyId,
}) {
  if (!subjectId) return null;

  const session = await ClassSession.findOne({
    subject: subjectId,
    dateKey: fromDateKey,
    slot: fromSlot,
  });
  if (!session) return null;

  // Refuse to collide with a sheet already taken at the destination.
  const clash = await ClassSession.findOne({
    subject: subjectId,
    dateKey: toDateKey,
    slot: toSlot,
    _id: { $ne: session._id },
  });
  if (clash) return { moved: false, reason: 'A sheet already exists at the destination' };

  session.dateKey = toDateKey;
  session.date = new Date(`${toDateKey}T00:00:00.000Z`);
  session.slot = toSlot;
  if (facultyId) session.faculty = facultyId;
  await session.save();

  return { moved: true, sessionId: String(session._id) };
}

/** A cancelled class must not count against students. */
export async function cancelAttendanceSession({ subjectId, dateKey, slot }) {
  if (!subjectId) return null;
  const session = await ClassSession.findOne({ subject: subjectId, dateKey, slot });
  if (!session) return null;
  session.status = 'cancelled';
  await session.save();
  return { cancelled: true, sessionId: String(session._id) };
}
