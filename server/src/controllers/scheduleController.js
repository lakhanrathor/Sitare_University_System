import { z } from 'zod';
import mongoose from 'mongoose';
import TimetableEntry from '../models/TimetableEntry.js';
import ScheduleChange from '../models/ScheduleChange.js';
import Section, { sectionLabel } from '../models/Section.js';
import Subject from '../models/Subject.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { toUTCDate, todayKey, dayOfWeek } from '../utils/date.js';
import { isTeachingDay, dayName } from '../config/slots.js';
import {
  findConflicts,
  getFreeSlots,
  moveAttendanceSession,
  cancelAttendanceSession,
  slotsForSemester,
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
    (entry.faculty && String(entry.faculty) === String(user._id)) ||
    (entry.subject?.faculty && String(entry.subject.faculty) === String(user._id));
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

  const sections = await Section.find({ isActive: true }).sort({ name: 1 }).lean();
  let scoped = req.query.section
    ? sections.filter((s) => String(s._id) === String(req.query.section))
    : sections;
  if (req.query.semester) {
    scoped = scoped.filter((s) => s.semester === Number(req.query.semester));
  }

  const slots = await getFreeSlots(date, {
    facultyId: req.user.role === 'faculty' ? String(req.user._id) : null,
    // Semester travels with each cohort: a whole-year period only blocks its
    // own year, so the free list has to know which year each section is in.
    sections: scoped.map((s) => ({ id: s._id, name: s.name, semester: s.semester })),
    semester: req.query.semester || scoped[0]?.semester,
  });

  res.json({ success: true, data: { date, slots } });
});

/** Subjects the caller may schedule an extra class for, in a given section. */
export const listBookableSubjects = asyncHandler(async (req, res) => {
  const filter = { isActive: true };
  if (req.query.section) filter.section = req.query.section;
  if (req.user.role === 'faculty') filter.faculty = req.user._id;

  const subjects = await Subject.find(filter).populate('section', 'name').lean();
  res.json({
    success: true,
    data: subjects.map((s) => ({
      id: String(s._id),
      code: s.code,
      name: s.name,
      section: s.section ? { id: String(s.section._id), name: s.section.name } : null,
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

  const section = await Section.findById(sectionId);
  if (!section) throw ApiError.notFound('Section not found');

  const slotLabel = await slotNamer(section.semester);
  const periods = await slotsForSemester(section.semester);
  if (!periods.some((p) => p.slot === Number(slot))) {
    throw ApiError.badRequest('That period is not on this semester’s timetable');
  }

  let subject = null;
  if (subjectId) {
    subject = await Subject.findById(subjectId).populate('section', 'name');
    if (!subject) throw ApiError.notFound('Subject not found');
    if (String(subject.section?._id) !== String(section._id)) {
      throw ApiError.badRequest(`${subject.code} is not offered to section ${section.name}`);
    }
    if (req.user.role === 'faculty' && String(subject.faculty) !== String(req.user._id)) {
      throw ApiError.forbidden('You do not teach that subject');
    }
  } else if (!title) {
    throw ApiError.badRequest('Choose a subject, or give the session a title');
  }

  const facultyId = req.user.role === 'faculty' ? req.user._id : subject?.faculty || req.user._id;

  const conflicts = await findConflicts({
    dateKey: date,
    slot,
    sectionId: section._id,
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

  const change = await ScheduleChange.create({
    kind: 'extra',
    date: toUTCDate(date),
    dateKey: date,
    section: section._id,
    subject: subject?._id || null,
    faculty: facultyId,
    slot,
    kindOfClass: kind,
    title: title || '',
    room,
    reason,
    createdBy: req.user._id,
  });

  const label = subject ? `${subject.code} ${subject.name}` : title;
  const staff = await facultyAndAdminIds({ exclude: [req.user._id] });

  await notify(staff, {
    type: 'schedule:extra',
    title: 'Period booked',
    message: `${req.user.name} booked ${slotLabel(slot)} on ${date} (Section ${section.name}) for ${label}.`,
    link: `/timetable?date=${date}`,
    createdBy: req.user._id,
    meta: { date, slot, sectionId: String(section._id) },
  });

  const students = await audience(subject?._id, section._id);
  if (students.length) {
    await notify(students, {
      type: 'schedule:extra',
      title: subject ? 'Extra class scheduled' : 'Session added to your timetable',
      message: `${label} — ${slotLabel(slot)} on ${date}${reason ? `. ${reason}` : '.'}`,
      link: `/timetable?date=${date}`,
      createdBy: req.user._id,
    });
  }

  emitToUsers([...staff, ...students, String(req.user._id)], 'timetable:changed', {
    reason: 'extra',
    date,
  });

  res.status(201).json({
    success: true,
    message: `${slotLabel(slot)} booked for section ${section.name}`,
    data: { changeId: String(change._id), date, slot },
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

  const entry = await TimetableEntry.findById(entryId)
    .populate('subject', 'code name faculty section')
    .populate('section', 'name semester')
    .populate('faculty', 'name');
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

  const existing = await ScheduleChange.findOne({
    entry: entry._id,
    dateKey: date,
    kind: { $in: ['move', 'cancel'] },
  });
  if (existing) {
    throw ApiError.conflict('This class has already been moved or cancelled on that date');
  }

  const facultyId = entry.faculty?._id || entry.subject?.faculty;
  const conflicts = await findConflicts({
    dateKey: toDate,
    slot: toSlot,
    /*
     * A period on an undivided semester has no section — that year never
     * split — so it is the whole year's cohort rather than one section's.
     */
    sectionId: entry.section?._id || null,
    wholeYear: !entry.section,
    facultyId,
    semester: entry.section?.semester ?? entry.subject?.semester,
    ignoreEntryIds: [entry._id],
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

  const change = await ScheduleChange.create({
    kind: 'move',
    date: toUTCDate(date),
    dateKey: date,
    entry: entry._id,
    fromSlot: entry.slot,
    toDate: toUTCDate(toDate),
    toDateKey: toDate,
    toSlot,
    section: entry.section?._id || null,
    subject: entry.subject?._id || null,
    faculty: facultyId || null,
    kindOfClass: entry.kind,
    title: entry.title,
    reason,
    createdBy: req.user._id,
  });

  // Keep an already-taken sheet attached to the class it belongs to.
  const attendance = await moveAttendanceSession({
    subjectId: entry.subject?._id,
    fromDateKey: date,
    fromSlot: entry.slot,
    toDateKey: toDate,
    toSlot,
    facultyId,
  });

  const label = entry.subject ? `${entry.subject.code} ${entry.subject.name}` : entry.title;
  const staff = await facultyAndAdminIds({ exclude: [req.user._id] });
  const students = await audience(entry.subject?._id, entry.section?._id);

  const msg = `${label} (${sectionLabel(entry.section)}) moved from ${slotLabel(entry.slot)} on ${date} to ${slotLabel(toSlot)} on ${toDate}.`;

  await notify(staff, {
    type: 'schedule:moved',
    title: 'Class rescheduled',
    message: `${req.user.name}: ${msg}`,
    link: `/timetable?date=${toDate}`,
    createdBy: req.user._id,
  });
  if (students.length) {
    await notify(students, {
      type: 'schedule:moved',
      title: 'Your class moved',
      message: msg,
      link: `/timetable?date=${toDate}`,
      createdBy: req.user._id,
    });
  }

  emitToUsers([...staff, ...students, String(req.user._id)], 'timetable:changed', {
    reason: 'move',
    date,
    toDate,
  });

  res.status(201).json({
    success: true,
    message: `Moved to ${slotLabel(toSlot)} on ${toDate}`,
    data: {
      changeId: String(change._id),
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

  const entry = await TimetableEntry.findById(entryId)
    .populate('subject', 'code name faculty')
    .populate('section', 'name semester')
    .populate('faculty', 'name');
  if (!entry) throw ApiError.notFound('That period is not on the timetable');

  assertOwnsEntry(req.user, entry);
  if (dayOfWeek(date) !== entry.dayOfWeek) {
    throw ApiError.badRequest('That class is not scheduled on that day');
  }

  const slotLabel = await slotNamer(entry.subject?.semester || entry.section?.semester);

  const existing = await ScheduleChange.findOne({
    entry: entry._id,
    dateKey: date,
    kind: { $in: ['move', 'cancel'] },
  });
  if (existing) throw ApiError.conflict('This class has already been moved or cancelled');

  const change = await ScheduleChange.create({
    kind: 'cancel',
    date: toUTCDate(date),
    dateKey: date,
    entry: entry._id,
    fromSlot: entry.slot,
    section: entry.section?._id || null,
    subject: entry.subject?._id || null,
    faculty: entry.faculty?._id || entry.subject?.faculty || null,
    kindOfClass: entry.kind,
    title: entry.title,
    reason,
    createdBy: req.user._id,
  });

  // A class that never happened must not count in the attendance denominator.
  await cancelAttendanceSession({
    subjectId: entry.subject?._id,
    dateKey: date,
    slot: entry.slot,
  });

  const label = entry.subject ? `${entry.subject.code} ${entry.subject.name}` : entry.title;
  const staff = await facultyAndAdminIds({ exclude: [req.user._id] });
  const students = await audience(entry.subject?._id, entry.section?._id);
  const msg = `${label} (${sectionLabel(entry.section)}) at ${slotLabel(entry.slot)} on ${date} is cancelled${reason ? ` — ${reason}` : '.'}`;

  await notify([...staff, ...students], {
    type: 'schedule:cancelled',
    title: 'Class cancelled',
    message: msg,
    link: `/timetable?date=${date}`,
    createdBy: req.user._id,
  });

  emitToUsers([...staff, ...students, String(req.user._id)], 'timetable:changed', {
    reason: 'cancel',
    date,
  });

  res.status(201).json({
    success: true,
    message: 'Class cancelled',
    data: { changeId: String(change._id) },
  });
});

/** Undo an extra booking, a move or a cancellation. */
export const undoChange = asyncHandler(async (req, res) => {
  const change = await ScheduleChange.findById(req.params.changeId).populate('section', 'name');
  if (!change) throw ApiError.notFound('Change not found');

  /*
   * An admin can undo anything. Faculty stay limited to their own changes, and
   * to halves of a swap only an admin should be unpicking — undoing one side
   * on its own would leave the two classes out of step.
   */
  if (req.user.role !== 'admin') {
    if (change.swapRequest) {
      throw ApiError.forbidden('Only an admin can unpick an approved swap');
    }
    if (String(change.createdBy) !== String(req.user._id)) {
      throw ApiError.forbidden('Only the person who made this change, or an admin, can undo it');
    }
  }

  // Put an already-taken sheet back where it started.
  if (change.kind === 'move') {
    await moveAttendanceSession({
      subjectId: change.subject,
      fromDateKey: change.toDateKey,
      fromSlot: change.toSlot,
      toDateKey: change.dateKey,
      toSlot: change.fromSlot,
      facultyId: change.faculty,
    });
  }

  const affectedDates = [change.dateKey, change.toDateKey].filter(Boolean);
  await change.deleteOne();

  const staff = await facultyAndAdminIds({ exclude: [req.user._id] });
  const students = await audience(change.subject, change.section?._id);
  await notify([...staff, ...students], {
    type: 'schedule:reverted',
    title: 'Schedule change undone',
    message: `${req.user.name} reverted a ${change.kind} on ${change.dateKey}.`,
    link: `/timetable?date=${change.dateKey}`,
    createdBy: req.user._id,
  });
  emitToUsers([...staff, ...students, String(req.user._id)], 'timetable:changed', {
    reason: 'undo',
    dates: affectedDates,
  });

  res.json({ success: true, message: 'Change undone' });
});

/** Recent deviations from the grid — an audit trail for admins and staff. */
export const listChanges = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.from) filter.dateKey = { $gte: req.query.from };
  if (req.user.role === 'faculty' && req.query.mine === 'true') {
    filter.$or = [{ createdBy: req.user._id }, { faculty: req.user._id }];
  }

  const changes = await ScheduleChange.find(filter)
    .sort({ createdAt: -1 })
    .limit(60)
    .populate('subject', 'code name')
    .populate('section', 'name')
    .populate('faculty', 'name')
    .populate('createdBy', 'name')
    .lean();

  res.json({
    success: true,
    data: changes.map((c) => ({
      id: String(c._id),
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
      fromSwap: Boolean(c.swapRequest),
      createdAt: c.createdAt,
    })),
  });
});
