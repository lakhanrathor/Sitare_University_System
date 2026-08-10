import { z } from 'zod';
import mongoose from 'mongoose';
import Subject from '../models/Subject.js';
import Enrollment from '../models/Enrollment.js';
import ClassSession from '../models/ClassSession.js';
import Attendance, { ATTENDANCE_STATUS, PRESENT_STATUSES } from '../models/Attendance.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { toDateKey, toUTCDate, todayKey, isFutureKey, addDays } from '../utils/date.js';
import {
  resolveOccurrences,
  getPublishedTimetable,
  slotsOf,
  labelOf,
} from '../services/timetableService.js';
import { assertSubjectAccess, assertRegisterAccess, sectionRef } from './subjectController.js';
import AttendanceDelegation from '../models/AttendanceDelegation.js';

/**
 * The classes this caller is standing in on for `subjectId`, or null when the
 * subject is simply theirs (or they are an admin) and no narrowing applies.
 */
async function standInClasses(user, subjectId) {
  if (user.role !== 'faculty') return null;
  const subject = await Subject.findById(subjectId).select('faculty').lean();
  if (!subject) return null;
  if (String(subject.faculty) === String(user._id)) return null;
  const rows = await AttendanceDelegation.find({ subject: subjectId, faculty: user._id }).lean();
  return rows.length ? rows : null;
}
import {
  getStudentSummary,
  getStudentSubjectHistory,
  getSubjectRoster,
  computePercentage,
} from '../services/attendanceService.js';
import { emitToUsers, emitToSubject } from '../sockets/index.js';

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const dateKeySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

export const markAttendanceSchema = z.object({
  date: dateKeySchema,
  slot: z.number().int().min(1).max(12).optional().default(1),
  topic: z.string().max(200).optional().default(''),
  records: z
    .array(
      z.object({
        studentId: z.string().min(1),
        status: z.enum(ATTENDANCE_STATUS),
        remark: z.string().max(200).optional().default(''),
      })
    )
    .min(1, 'At least one student record is required'),
});

export const cancelSessionSchema = z.object({
  cancelled: z.boolean(),
});

/* ------------------------------------------------------------------ */
/* Student-facing                                                      */
/* ------------------------------------------------------------------ */

/** Overall + subject-wise attendance for the signed-in student. */
export const getMyAttendance = asyncHandler(async (req, res) => {
  if (req.user.role !== 'student') {
    throw ApiError.forbidden('Only students have a personal attendance summary');
  }
  const summary = await getStudentSummary(req.user._id);
  res.json({ success: true, data: summary });
});

/** Class-by-class history for one of the student's subjects. */
export const getMySubjectHistory = asyncHandler(async (req, res) => {
  const { subjectId } = req.params;

  const enrolled = await Enrollment.exists({
    student: req.user._id,
    subject: subjectId,
    isActive: true,
  });
  if (!enrolled) throw ApiError.forbidden('You are not enrolled in this subject');

  const subject = await Subject.findById(subjectId).populate('faculty', 'name email').lean();
  const history = await getStudentSubjectHistory(req.user._id, subjectId);

  const conducted = history.filter((h) => !h.cancelled).length;
  const present = history.filter(
    (h) => !h.cancelled && PRESENT_STATUSES.includes(h.status)
  ).length;

  res.json({
    success: true,
    data: {
      subject: {
        id: String(subject._id),
        code: subject.code,
        name: subject.name,
        plannedClasses: subject.plannedClasses,
        minAttendance: subject.minAttendance,
        faculty: subject.faculty ? { name: subject.faculty.name } : null,
      },
      conducted,
      present,
      absent: Math.max(conducted - present, 0),
      percentage: computePercentage(present, conducted),
      history,
    },
  });
});

/** Faculty/admin view of any student's summary. */
export const getStudentAttendance = asyncHandler(async (req, res) => {
  const student = await User.findById(req.params.studentId);
  if (!student || student.role !== 'student') throw ApiError.notFound('Student not found');

  const summary = await getStudentSummary(student._id);
  res.json({
    success: true,
    data: { student: student.toSafeJSON(), ...summary },
  });
});

/* ------------------------------------------------------------------ */
/* Faculty-facing                                                      */
/* ------------------------------------------------------------------ */

/** All recorded classes for a subject, newest first. */
export const listSessions = asyncHandler(async (req, res) => {
  const subject = await assertSubjectAccess(req.user, req.params.subjectId);

  const sessions = await ClassSession.find({ subject: subject._id })
    .sort({ date: -1, slot: -1 })
    .lean();

  const enrolledCount = await Enrollment.countDocuments({
    subject: subject._id,
    isActive: true,
  });

  res.json({
    success: true,
    data: {
      conducted: sessions.filter((s) => s.status === 'completed').length,
      plannedClasses: subject.plannedClasses,
      enrolledCount,
      sessions: sessions.map((s) => ({
        id: String(s._id),
        date: s.dateKey,
        slot: s.slot,
        topic: s.topic,
        status: s.status,
        presentCount: s.presentCount,
        totalMarked: s.totalMarked,
      })),
    },
  });
});

/**
 * The classes this subject actually has, as dated occurrences.
 *
 * Attendance is taken against a real class, not an arbitrary calendar date, so
 * this drives the picker on the marking screen:
 *   - cancelled classes are left out entirely — there is nothing to record
 *   - a class moved to another day appears on its NEW date, not its old one
 *   - extra classes booked into free periods appear too
 *   - a sheet that already exists is always listed, even if the grid has since
 *     changed underneath it, so past records stay reachable
 */
export const listSubjectOccurrences = asyncHandler(async (req, res) => {
  const today = todayKey();

  /*
   * A stand-in was asked to mark specific classes, so those are the only ones
   * offered — listing the subject's whole term would invite them to record
   * lessons that are not theirs to record.
   */
  const standingIn = await standInClasses(req.user, req.params.subjectId);
  const subject = standingIn
    ? await Subject.findById(req.params.subjectId)
    : await assertSubjectAccess(req.user, req.params.subjectId);
  if (!subject) throw ApiError.notFound('Subject not found');

  /*
   * Two different windows on purpose. The recurring grid only means anything
   * from the date it took effect, so scheduled classes are resolved from
   * there. Recorded sheets predate the grid — the register was being kept
   * before any timetable was uploaded — so those reach much further back and
   * must never be hidden just because the grid is newer.
   */
  const timetable = await getPublishedTimetable(subject.semester);
  const windowStart = addDays(today, -60);
  const effective = timetable?.effectiveFromKey;
  const gridFrom = req.query.from || (effective && effective > windowStart ? effective : windowStart);
  const to = req.query.to || addDays(today, 14);
  const sessionsFrom = addDays(today, -365);

  const dates = [];
  for (let d = gridFrom; d <= to; d = addDays(d, 1)) dates.push(d);

  const { byDate } = await resolveOccurrences(dates, {
    sectionId: subject.section ? String(subject.section) : undefined,
    semester: subject.semester,
  });

  const map = new Map(); // "date|slot" -> row
  for (const list of Object.values(byDate)) {
    for (const o of list) {
      if (!o.subject || String(o.subject.id) !== String(subject._id)) continue;
      // A cancelled or relocated class is not something to record here.
      if (o.origin === 'cancelled' || o.origin === 'moved-out') continue;
      map.set(`${o.date}|${o.slot}`, {
        date: o.date,
        slot: o.slot,
        origin: o.origin,
        movedFrom: o.movedFrom || null,
        reason: o.reason || '',
      });
    }
  }

  // Any sheet already taken must remain reachable even if the grid moved on.
  const sessions = await ClassSession.find({
    subject: subject._id,
    dateKey: { $gte: sessionsFrom, $lte: to },
  }).lean();

  for (const s of sessions) {
    const key = `${s.dateKey}|${s.slot}`;
    const base = map.get(key) || { date: s.dateKey, slot: s.slot, origin: 'recorded' };
    map.set(key, {
      ...base,
      sessionId: String(s._id),
      taken: true,
      sessionStatus: s.status,
      topic: s.topic,
      presentCount: s.presentCount,
      totalMarked: s.totalMarked,
    });
  }

  // Period labels come from the timetable this subject runs on.
  const periods = slotsOf(timetable);

  let rows = [...map.values()];

  if (standingIn) {
    // Exactly the classes handed over — nothing else on this subject.
    const allowed = new Set(standingIn.map((d) => `${d.dateKey}|${d.slot}`));
    for (const d of standingIn) {
      if (!map.has(`${d.dateKey}|${d.slot}`)) {
        // A register pointed at this subject from a period of its own, such as
        // an event; it has no grid row here but still needs marking.
        rows.push({ date: d.dateKey, slot: d.slot, origin: 'scheduled' });
      }
    }
    rows = rows.filter((o) => allowed.has(`${o.date}|${o.slot}`));
  }

  const occurrences = rows
    .map((o) => ({
      ...o,
      taken: Boolean(o.taken),
      slotLabel: labelOf(periods, o.slot),
      // Attendance is only meaningful once the class has actually happened.
      takeable: o.date <= today,
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || b.slot - a.slot);

  res.json({
    success: true,
    data: {
      subject: {
        id: String(subject._id),
        code: subject.code,
        name: subject.name,
        semester: subject.semester,
        plannedClasses: subject.plannedClasses,
        section: await sectionRef(subject),
      },
      today,
      // The real denominator, not just what falls inside this window.
      conducted: await ClassSession.countDocuments({
        subject: subject._id,
        status: 'completed',
      }),
      pending: occurrences.filter((o) => o.takeable && !o.taken).length,
      occurrences,
    },
  });
});

/**
 * The marking sheet for one date/slot: every enrolled student, prefilled with
 * an existing mark if attendance was already taken.
 */
export const getAttendanceSheet = asyncHandler(async (req, res) => {
  const date = toDateKey(req.query.date || todayKey());
  const slot = Number(req.query.slot || 1);
  if (!date) throw ApiError.badRequest('Invalid date');
  // Per class, not per subject: a stand-in only holds this one register.
  const subject = await assertRegisterAccess(req.user, req.params.subjectId, date, slot);

  const [roster, session] = await Promise.all([
    getSubjectRoster(subject._id),
    ClassSession.findOne({ subject: subject._id, dateKey: date, slot }).lean(),
  ]);

  let marks = {};
  if (session) {
    const records = await Attendance.find({ session: session._id }).lean();
    marks = Object.fromEntries(
      records.map((r) => [String(r.student), { status: r.status, remark: r.remark }])
    );
  }

  res.json({
    success: true,
    data: {
      subject: {
        id: String(subject._id),
        code: subject.code,
        name: subject.name,
        semester: subject.semester,
        plannedClasses: subject.plannedClasses,
        minAttendance: subject.minAttendance,
        section: await sectionRef(subject),
      },
      date,
      slot,
      isFuture: isFutureKey(date),
      // conducted count so far — the live denominator
      conducted: roster.conducted,
      existingSession: session
        ? { id: String(session._id), topic: session.topic, status: session.status }
        : null,
      students: roster.students.map((s) => ({
        ...s,
        // default to present: marking the few absentees is the common case
        marked: marks[s.studentId]?.status || 'present',
        remark: marks[s.studentId]?.remark || '',
      })),
    },
  });
});

/**
 * Create-or-update a class session and its attendance in one call.
 * Recording a session is exactly what increments the denominator, so a class
 * only counts once a faculty member has actually taken attendance for it.
 */
export const markAttendance = asyncHandler(async (req, res) => {
  const { date, slot, topic, records } = req.body;
  // Per class, not per subject — a stand-in may only save the one handed over.
  const subject = await assertRegisterAccess(req.user, req.params.subjectId, date, slot);

  if (isFutureKey(date)) {
    throw ApiError.badRequest('Attendance cannot be recorded for a future date');
  }

  const enrollments = await Enrollment.find({ subject: subject._id, isActive: true })
    .select('student')
    .lean();
  if (!enrollments.length) {
    throw ApiError.badRequest('No students are enrolled in this subject yet');
  }
  const enrolledIds = new Set(enrollments.map((e) => String(e.student)));

  const submitted = new Map();
  for (const r of records) {
    if (!enrolledIds.has(String(r.studentId))) continue; // ignore non-enrolled ids
    submitted.set(String(r.studentId), r);
  }
  if (!submitted.size) throw ApiError.badRequest('No valid enrolled students in the submission');

  // Any enrolled student left out of the payload is recorded as absent so the
  // sheet is always complete for this class.
  const finalRecords = [...enrolledIds].map((studentId) => {
    const r = submitted.get(studentId);
    return {
      studentId,
      status: r?.status || 'absent',
      remark: r?.remark || '',
    };
  });

  const session = await ClassSession.findOneAndUpdate(
    { subject: subject._id, dateKey: date, slot },
    {
      $setOnInsert: { subject: subject._id, date: toUTCDate(date), dateKey: date, slot },
      $set: { faculty: subject.faculty, topic: topic || '', status: 'completed' },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await Attendance.bulkWrite(
    finalRecords.map((r) => ({
      updateOne: {
        filter: { session: session._id, student: new mongoose.Types.ObjectId(r.studentId) },
        update: {
          $set: { status: r.status, remark: r.remark, markedBy: req.user._id },
          $setOnInsert: {
            session: session._id,
            subject: subject._id,
            student: new mongoose.Types.ObjectId(r.studentId),
          },
        },
        upsert: true,
      },
    })),
    { ordered: false }
  );

  const presentCount = finalRecords.filter((r) => PRESENT_STATUSES.includes(r.status)).length;
  session.presentCount = presentCount;
  session.totalMarked = finalRecords.length;
  await session.save();

  const conducted = await ClassSession.countDocuments({
    subject: subject._id,
    status: 'completed',
  });

  // Realtime: every affected student refreshes their own numbers, and anyone
  // watching this subject sees the new session immediately.
  const payload = {
    subjectId: String(subject._id),
    subjectCode: subject.code,
    subjectName: subject.name,
    sessionId: String(session._id),
    date,
    slot,
    conducted,
    at: new Date().toISOString(),
  };
  emitToUsers([...enrolledIds], 'attendance:updated', payload);
  emitToSubject(subject._id, 'subject:attendance-updated', {
    ...payload,
    presentCount,
    totalMarked: finalRecords.length,
  });

  res.status(201).json({
    success: true,
    message: `Attendance saved for ${date}`,
    data: {
      sessionId: String(session._id),
      date,
      slot,
      presentCount,
      absentCount: finalRecords.length - presentCount,
      totalMarked: finalRecords.length,
      conducted,
      plannedClasses: subject.plannedClasses,
    },
  });
});

/**
 * Cancel (or restore) a class. A cancelled class leaves the denominator, so
 * nobody is penalised for a lecture that never happened.
 */
export const setSessionCancelled = asyncHandler(async (req, res) => {
  const session = await ClassSession.findById(req.params.sessionId);
  if (!session) throw ApiError.notFound('Class session not found');
  const subject = await assertSubjectAccess(req.user, session.subject);

  session.status = req.body.cancelled ? 'cancelled' : 'completed';
  await session.save();

  const conducted = await ClassSession.countDocuments({
    subject: subject._id,
    status: 'completed',
  });

  const enrollments = await Enrollment.find({ subject: subject._id, isActive: true })
    .select('student')
    .lean();

  const payload = {
    subjectId: String(subject._id),
    subjectCode: subject.code,
    subjectName: subject.name,
    sessionId: String(session._id),
    date: session.dateKey,
    conducted,
    cancelled: session.status === 'cancelled',
    at: new Date().toISOString(),
  };
  emitToUsers(enrollments.map((e) => e.student), 'attendance:updated', payload);
  emitToSubject(subject._id, 'subject:attendance-updated', payload);

  res.json({
    success: true,
    message: session.status === 'cancelled' ? 'Class marked as cancelled' : 'Class restored',
    data: { sessionId: String(session._id), status: session.status, conducted },
  });
});

/** Delete a session and every attendance record attached to it. */
export const deleteSession = asyncHandler(async (req, res) => {
  const session = await ClassSession.findById(req.params.sessionId);
  if (!session) throw ApiError.notFound('Class session not found');
  const subject = await assertSubjectAccess(req.user, session.subject);

  await Attendance.deleteMany({ session: session._id });
  await session.deleteOne();

  const conducted = await ClassSession.countDocuments({
    subject: subject._id,
    status: 'completed',
  });
  const enrollments = await Enrollment.find({ subject: subject._id, isActive: true })
    .select('student')
    .lean();

  const payload = {
    subjectId: String(subject._id),
    subjectCode: subject.code,
    subjectName: subject.name,
    date: session.dateKey,
    conducted,
    deleted: true,
    at: new Date().toISOString(),
  };
  emitToUsers(enrollments.map((e) => e.student), 'attendance:updated', payload);
  emitToSubject(subject._id, 'subject:attendance-updated', payload);

  res.json({ success: true, message: 'Class record deleted', data: { conducted } });
});
