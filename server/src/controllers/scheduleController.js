import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { sectionLabel } from '../utils/section.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { toUTCDate, todayKey, dayOfWeek } from '../utils/date.js';
import { idOf, sameId } from '../utils/ids.js';
import { isTeachingDay, dayName } from '../config/slots.js';
import {
  findConflicts,
  getFreeSlots,
  moveAttendanceSession,
  cancelAttendanceSession,
  slotsForSemester,
  getPublishedTimetable,
  slotsOf,
  labelOf,
} from '../services/timetableService.js';
import {
  notify,
  facultyAndAdminIds,
  studentAudience,
} from '../services/notificationService.js';
import { emitToUsers } from '../sockets/index.js';

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const extraClassSchema = z.object({
  date: dateKey,
  slot: z.number().int().min(1).max(12),
  sectionId: z.string().min(1),
  subjectId: z.string().min(1).optional(),
  title: z.string().max(120).optional().default(''),
  kind: z.enum(['lecture', 'office-hours', 'event']).optional().default('lecture'),
  room: z.string().max(60).optional().default(''),
  reason: z.string().max(300).optional().default(''),
});

export const moveClassSchema = z.object({
  entryId: z.string().min(1),
  date: dateKey,
  toDate: dateKey,
  toSlot: z.number().int().min(1).max(12),
  reason: z.string().max(300).optional().default(''),
});

export const cancelClassSchema = z.object({
  entryId: z.string().min(1),
  date: dateKey,
  reason: z.string().max(300).optional().default(''),
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function assertBookableDate(key) {
  if (!isTeachingDay(dayOfWeek(key))) {
    throw ApiError.badRequest(`${dayName(dayOfWeek(key))} is not a teaching day`);
  }
  if (key < todayKey()) throw ApiError.badRequest('That date has already passed');
}

/** Faculty may only touch their own periods; admin may touch any. */
function assertOwnsEntry(user, entry) {
  if (user.role === 'admin') return;
  const owns =
    sameId(entry.facultyId, user) || sameId(entry.subject?.facultyId, user);
  if (!owns) throw ApiError.forbidden('This period belongs to another faculty member');
}

/**
 * Students to tell about a change. Passing the section matters: a booked
 * period with no subject (an event titled "Reschedule", say) still belongs to
 * that cohort and they must hear about it.
 */
const audience = (subjectId, sectionId) =>
  studentAudience({ subjectId, sectionId });

/**
 * Period labels are per-timetable, so a handler loads the grid for the
 * semester it is working in and formats against that.
 */
async function slotNamer(semester) {
  const slots = await slotsForSemester(semester);
  return (n) => labelOf(slots, n);
}

/* ------------------------------------------------------------------ */
/* Free slots                                                          */
/* ------------------------------------------------------------------ */

/** Which periods are open on a date — the answer to "where can I fit this?". */
export const listFreeSlots = asyncHandler(async (req, res) => {
  const date = req.query.date || todayKey();
  if (!isTeachingDay(dayOfWeek(date))) {
    return res.json({ success: true, data: { date, slots: [] } });
  }

  const sections = await prisma.section.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
  });
  let scoped = req.query.section
    ? sections.filter((s) => sameId(s, req.query.section))
    : sections;
  if (req.query.semester) {
    scoped = scoped.filter((s) => s.semester === Number(req.query.semester));
  }

  const slots = await getFreeSlots(date, {
    facultyId: req.user.role === 'faculty' ? idOf(req.user) : null,
    // Semester travels with each cohort: a whole-year period only blocks its
    // own year, so the free list has to know which year each section is in.
    sections: scoped.map((s) => ({ id: s.id, name: s.name, semester: s.semester })),
    semester: req.query.semester || scoped[0]?.semester,
  });

  res.json({ success: true, data: { date, slots } });
});

/** Subjects the caller may schedule an extra class for, in a given section. */
export const listBookableSubjects = asyncHandler(async (req, res) => {
  const where = { isActive: true };
  if (req.query.section) where.sectionId = req.query.section;
  if (req.user.role === 'faculty') where.facultyId = idOf(req.user);

  const subjects = await prisma.subject.findMany({
    where,
    include: { section: { select: { id: true, name: true } } },
  });
  res.json({
    success: true,
    data: subjects.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      section: s.section ? { id: s.section.id, name: s.section.name } : null,
    })),
  });
});

/* ------------------------------------------------------------------ */
/* Book a free period                                                  */
/* ------------------------------------------------------------------ */

/**
 * Claim a free period for an extra class. The booking lands on the shared grid
 * immediately and every other teacher is notified, which is what stops two
 * people planning the same period.
 */
export const bookExtraClass = asyncHandler(async (req, res) => {
  const { date, slot, sectionId, subjectId, title, kind, room, reason } = req.body;

  assertBookableDate(date);

  const section = await prisma.section.findUnique({ where: { id: sectionId } });
  if (!section) throw ApiError.notFound('Section not found');

  const timetable = await getPublishedTimetable(section.semester);
  const slotLabel = await slotNamer(section.semester);
  const periods = slotsOf(timetable);
  if (!periods.some((p) => p.slot === Number(slot))) {
    throw ApiError.badRequest('That period is not on this semester’s timetable');
  }

  let subject = null;
  if (subjectId) {
    subject = await prisma.subject.findUnique({
      where: { id: subjectId },
      include: { section: { select: { id: true, name: true } } },
    });
    if (!subject) throw ApiError.notFound('Subject not found');
    if (!sameId(subject.sectionId, section)) {
      throw ApiError.badRequest(`${subject.code} is not offered to section ${section.name}`);
    }
    if (req.user.role === 'faculty' && !sameId(subject.facultyId, req.user)) {
      throw ApiError.forbidden('You do not teach that subject');
    }
  } else if (!title) {
    throw ApiError.badRequest('Choose a subject, or give the session a title');
  }

  const facultyId =
    req.user.role === 'faculty' ? idOf(req.user) : subject?.facultyId || idOf(req.user);

  const conflicts = await findConflicts({
    dateKey: date,
    slot,
    sectionId: section.id,
    facultyId,
    semester: section.semester,
  });
  if (conflicts.section) {
    const c = conflicts.section;
    throw ApiError.conflict(
      `Section ${section.name} already has ${c.subject?.code || c.title} at ${slotLabel(slot)}${
        c.faculty ? ` with ${c.faculty.name}` : ''
      }.`
    );
  }
  /*
   * Another cohort of this same year is a combined class — allowed, and the
   * register is taken for each section in turn. Another year is not.
   */
  if (conflicts.faculty) {
    const c = conflicts.faculty;
    throw ApiError.conflict(
      `You already have ${c.subject?.code || c.title} with semester ${c.semester}${
        c.section?.name ? ` section ${c.section.name}` : ''
      } at ${slotLabel(slot)}. Two different years cannot be taught at once.`
    );
  }

  const change = await prisma.scheduleChange.create({
    data: {
      kind: 'extra',
      timetableId: timetable?.id || null,
      date: toUTCDate(date),
      dateKey: date,
      sectionId: section.id,
      subjectId: subject?.id || null,
      facultyId,
      slot,
      kindOfClass: kind,
      title: title || '',
      room,
      reason,
      createdById: idOf(req.user),
    },
  });

  const label = subject ? `${subject.code} ${subject.name}` : title;
  const staff = await facultyAndAdminIds({ exclude: [idOf(req.user)] });

  await notify(staff, {
    type: 'schedule:extra',
    title: 'Period booked',
    message: `${req.user.name} booked ${slotLabel(slot)} on ${date} (Section ${section.name}) for ${label}.`,
    link: `/timetable?date=${date}`,
    createdBy: idOf(req.user),
    meta: { date, slot, sectionId: section.id },
  });

  const students = await audience(subject?.id, section.id);
  if (students.length) {
    await notify(students, {
      type: 'schedule:extra',
      title: subject ? 'Extra class scheduled' : 'Session added to your timetable',
      message: `${label} — ${slotLabel(slot)} on ${date}${reason ? `. ${reason}` : '.'}`,
      link: `/timetable?date=${date}`,
      createdBy: idOf(req.user),
    });
  }

  emitToUsers([...staff, ...students, idOf(req.user)], 'timetable:changed', {
    reason: 'extra',
    date,
  });

  res.status(201).json({
    success: true,
    message: `${slotLabel(slot)} booked for section ${section.name}`,
    data: { changeId: change.id, date, slot },
  });
});

/* ------------------------------------------------------------------ */
/* Move a class                                                        */
/* ------------------------------------------------------------------ */

/**
 * Shift one occurrence of a class to another period. The recurring timetable is
 * untouched — only this date moves — and any attendance sheet already taken
 * travels with it.
 */
export const moveClass = asyncHandler(async (req, res) => {
  const { entryId, date, toDate, toSlot, reason } = req.body;

  const entry = await prisma.timetableEntry.findUnique({
    where: { id: entryId },
    include: {
      subject: { select: { id: true, code: true, name: true, facultyId: true, sectionId: true, semester: true } },
      section: { select: { id: true, name: true, semester: true } },
      faculty: { select: { id: true, name: true } },
    },
  });
  if (!entry) throw ApiError.notFound('That period is not on the timetable');

  assertOwnsEntry(req.user, entry);
  assertBookableDate(date);
  assertBookableDate(toDate);

  const slotLabel = await slotNamer(entry.subject?.semester || entry.section?.semester);

  if (dayOfWeek(date) !== entry.dayOfWeek) {
    throw ApiError.badRequest(
      `${entry.subject?.code || entry.title} is not scheduled on ${dayName(dayOfWeek(date))}`
    );
  }
  if (date === toDate && Number(toSlot) === entry.slot) {
    throw ApiError.badRequest('That is already the scheduled period');
  }

  const existing = await prisma.scheduleChange.findFirst({
    where: { entryId: entry.id, dateKey: date, kind: { in: ['move', 'cancel'] } },
  });
  if (existing) {
    throw ApiError.conflict('This class has already been moved or cancelled on that date');
  }

  const facultyId = entry.facultyId || entry.subject?.facultyId;
  const conflicts = await findConflicts({
    dateKey: toDate,
    slot: toSlot,
    /*
     * A period on an undivided semester has no section — that year never
     * split — so it is the whole year's cohort rather than one section's.
     */
    sectionId: entry.sectionId || null,
    wholeYear: !entry.sectionId,
    facultyId,
    semester: entry.section?.semester ?? entry.subject?.semester,
    ignoreEntryIds: [entry.id],
  });
  if (conflicts.section) {
    const c = conflicts.section;
    throw ApiError.conflict(
      `${sectionLabel(entry.section)} already has ${c.subject?.code || c.title} at ${slotLabel(toSlot)} that day.`
    );
  }
  /*
   * Another cohort of the same year in the destination period is a combined
   * class, not a clash. Another year is a clash — see findConflicts.
   */
  if (conflicts.faculty) {
    const c = conflicts.faculty;
    throw ApiError.conflict(
      `${entry.faculty?.name || 'The lecturer'} already has ${c.subject?.code || c.title} with semester ${c.semester} at ${slotLabel(toSlot)} that day.`
    );
  }

  const change = await prisma.scheduleChange.create({
    data: {
      kind: 'move',
      timetableId: entry.timetableId,
      date: toUTCDate(date),
      dateKey: date,
      entryId: entry.id,
      fromSlot: entry.slot,
      toDate: toUTCDate(toDate),
      toDateKey: toDate,
      toSlot,
      sectionId: entry.sectionId || null,
      subjectId: entry.subjectId || null,
      facultyId: facultyId || null,
      kindOfClass: entry.kind,
      title: entry.title,
      reason,
      createdById: idOf(req.user),
    },
  });

  // Keep an already-taken sheet attached to the class it belongs to.
  const attendance = await moveAttendanceSession({
    subjectId: entry.subjectId,
    fromDateKey: date,
    fromSlot: entry.slot,
    toDateKey: toDate,
    toSlot,
    facultyId,
  });

  const label = entry.subject ? `${entry.subject.code} ${entry.subject.name}` : entry.title;
  const staff = await facultyAndAdminIds({ exclude: [idOf(req.user)] });
  const students = await audience(entry.subjectId, entry.sectionId);

  const msg = `${label} (${sectionLabel(entry.section)}) moved from ${slotLabel(entry.slot)} on ${date} to ${slotLabel(toSlot)} on ${toDate}.`;

  await notify(staff, {
    type: 'schedule:moved',
    title: 'Class rescheduled',
    message: `${req.user.name}: ${msg}`,
    link: `/timetable?date=${toDate}`,
    createdBy: idOf(req.user),
  });
  if (students.length) {
    await notify(students, {
      type: 'schedule:moved',
      title: 'Your class moved',
      message: msg,
      link: `/timetable?date=${toDate}`,
      createdBy: idOf(req.user),
    });
  }

  emitToUsers([...staff, ...students, idOf(req.user)], 'timetable:changed', {
    reason: 'move',
    date,
    toDate,
  });

  res.status(201).json({
    success: true,
    message: `Moved to ${slotLabel(toSlot)} on ${toDate}`,
    data: {
      changeId: change.id,
      attendanceMoved: Boolean(attendance?.moved),
      attendanceNote: attendance?.reason || null,
    },
  });
});

/* ------------------------------------------------------------------ */
/* Cancel a class                                                      */
/* ------------------------------------------------------------------ */

export const cancelClass = asyncHandler(async (req, res) => {
  const { entryId, date, reason } = req.body;

  const entry = await prisma.timetableEntry.findUnique({
    where: { id: entryId },
    include: {
      subject: { select: { id: true, code: true, name: true, facultyId: true, semester: true } },
      section: { select: { id: true, name: true, semester: true } },
      faculty: { select: { id: true, name: true } },
    },
  });
  if (!entry) throw ApiError.notFound('That period is not on the timetable');

  assertOwnsEntry(req.user, entry);
  if (dayOfWeek(date) !== entry.dayOfWeek) {
    throw ApiError.badRequest('That class is not scheduled on that day');
  }

  const slotLabel = await slotNamer(entry.subject?.semester || entry.section?.semester);

  const existing = await prisma.scheduleChange.findFirst({
    where: { entryId: entry.id, dateKey: date, kind: { in: ['move', 'cancel'] } },
  });
  if (existing) throw ApiError.conflict('This class has already been moved or cancelled');

  const change = await prisma.scheduleChange.create({
    data: {
      kind: 'cancel',
      timetableId: entry.timetableId,
      date: toUTCDate(date),
      dateKey: date,
      entryId: entry.id,
      fromSlot: entry.slot,
      sectionId: entry.sectionId || null,
      subjectId: entry.subjectId || null,
      facultyId: entry.facultyId || entry.subject?.facultyId || null,
      kindOfClass: entry.kind,
      title: entry.title,
      reason,
      createdById: idOf(req.user),
    },
  });

  // A class that never happened must not count in the attendance denominator.
  await cancelAttendanceSession({
    subjectId: entry.subjectId,
    dateKey: date,
    slot: entry.slot,
  });

  const label = entry.subject ? `${entry.subject.code} ${entry.subject.name}` : entry.title;
  const staff = await facultyAndAdminIds({ exclude: [idOf(req.user)] });
  const students = await audience(entry.subjectId, entry.sectionId);
  const msg = `${label} (${sectionLabel(entry.section)}) at ${slotLabel(entry.slot)} on ${date} is cancelled${reason ? ` — ${reason}` : '.'}`;

  await notify([...staff, ...students], {
    type: 'schedule:cancelled',
    title: 'Class cancelled',
    message: msg,
    link: `/timetable?date=${date}`,
    createdBy: idOf(req.user),
  });

  emitToUsers([...staff, ...students, idOf(req.user)], 'timetable:changed', {
    reason: 'cancel',
    date,
  });

  res.status(201).json({
    success: true,
    message: 'Class cancelled',
    data: { changeId: change.id },
  });
});

/** Undo an extra booking, a move or a cancellation. */
export const undoChange = asyncHandler(async (req, res) => {
  const change = await prisma.scheduleChange.findUnique({
    where: { id: req.params.changeId },
    include: { section: { select: { id: true, name: true } } },
  });
  if (!change) throw ApiError.notFound('Change not found');

  /*
   * An admin can undo anything. Faculty stay limited to their own changes, and
   * to halves of a swap only an admin should be unpicking — undoing one side
   * on its own would leave the two classes out of step.
   */
  if (req.user.role !== 'admin') {
    if (change.swapRequestId) {
      throw ApiError.forbidden('Only an admin can unpick an approved swap');
    }
    if (!sameId(change.createdById, req.user)) {
      throw ApiError.forbidden('Only the person who made this change, or an admin, can undo it');
    }
  }

  // Put an already-taken sheet back where it started.
  if (change.kind === 'move') {
    await moveAttendanceSession({
      subjectId: change.subjectId,
      fromDateKey: change.toDateKey,
      fromSlot: change.toSlot,
      toDateKey: change.dateKey,
      toSlot: change.fromSlot,
      facultyId: change.facultyId,
    });
  }

  const affectedDates = [change.dateKey, change.toDateKey].filter(Boolean);
  await prisma.scheduleChange.delete({ where: { id: change.id } });

  const staff = await facultyAndAdminIds({ exclude: [idOf(req.user)] });
  const students = await audience(change.subjectId, change.sectionId);
  await notify([...staff, ...students], {
    type: 'schedule:reverted',
    title: 'Schedule change undone',
    message: `${req.user.name} reverted a ${change.kind} on ${change.dateKey}.`,
    link: `/timetable?date=${change.dateKey}`,
    createdBy: idOf(req.user),
  });
  emitToUsers([...staff, ...students, idOf(req.user)], 'timetable:changed', {
    reason: 'undo',
    dates: affectedDates,
  });

  res.json({ success: true, message: 'Change undone' });
});

/** Recent deviations from the grid — an audit trail for admins and staff. */
export const listChanges = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.from) where.dateKey = { gte: req.query.from };
  if (req.user.role === 'faculty' && req.query.mine === 'true') {
    where.OR = [{ createdById: idOf(req.user) }, { facultyId: idOf(req.user) }];
  }

  const changes = await prisma.scheduleChange.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 60,
    include: {
      subject: { select: { code: true, name: true } },
      section: { select: { name: true } },
      faculty: { select: { name: true } },
      createdBy: { select: { name: true } },
    },
  });

  res.json({
    success: true,
    data: changes.map((c) => ({
      id: c.id,
      kind: c.kind,
      date: c.dateKey,
      toDate: c.toDateKey,
      fromSlot: c.fromSlot ?? c.slot,
      toSlot: c.toSlot,
      slot: c.slot,
      subject: c.subject ? { code: c.subject.code, name: c.subject.name } : null,
      title: c.title,
      section: c.section?.name || null,
      faculty: c.faculty?.name || null,
      createdBy: c.createdBy?.name || null,
      reason: c.reason,
      fromSwap: Boolean(c.swapRequestId),
      createdAt: c.createdAt,
    })),
  });
});
