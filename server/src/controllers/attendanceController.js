import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { ATTENDANCE_STATUS, PRESENT_STATUSES } from '../config/attendance.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { toDateKey, toUTCDate, todayKey, isFutureKey, addDays } from '../utils/date.js';
import { idOf, sameId } from '../utils/ids.js';
import { safeUser } from '../utils/user.js';
import {
  resolveOccurrences,
  getPublishedTimetable,
  slotsOf,
  labelOf,
} from '../services/timetableService.js';
import { assertSubjectAccess, assertRegisterAccess, sectionRef } from './subjectController.js';

/**
 * The classes this caller is standing in on for `subjectId`, or null when the
 * subject is simply theirs (or they are an admin) and no narrowing applies.
 */
/**
 * The periods this subject actually runs in on one date — the grid plus any
 * one-off moves and extras, minus anything cancelled or moved away.
 *
 * Used to bound "apply to my other classes today": a period the subject does
 * not sit in is not a class, and recording one would add to the denominator a
 * lesson that never took place.
 */
async function slotsRunningOn(subject, dateKey) {
  const { byDate } = await resolveOccurrences([dateKey], {
    sectionId: subject.sectionId || undefined,
    semester: subject.semester,
  });
  const live = (byDate[dateKey] || []).filter(
    (o) =>
      o.subject &&
      sameId(o.subject.id, subject) &&
      !['cancelled', 'moved-out'].includes(o.origin) &&
      // Office hours are not a class — nobody is enrolled to attend them, so
      // they cannot be one of the periods a register is applied across.
      o.kind !== 'office-hours'
  );
  return new Set(live.map((o) => o.slot));
}

/**
 * The kind of period this subject has, at one exact slot, on one date.
 *
 * Distinguishes a slot the grid genuinely marks as office hours from an
 * ordinary lecture, so marking attendance against it can be refused before
 * anything is written — not just left out of the picker that offers slots.
 */
async function classKindOn(subject, dateKey, slot) {
  const { byDate } = await resolveOccurrences([dateKey], {
    sectionId: subject.sectionId || undefined,
    semester: subject.semester,
  });
  const hit = (byDate[dateKey] || []).find(
    (o) =>
      o.subject &&
      sameId(o.subject.id, subject) &&
      o.slot === Number(slot) &&
      !['cancelled', 'moved-out'].includes(o.origin)
  );
  return hit?.kind || null;
}

async function standInClasses(user, subjectId) {
  if (user.role !== 'faculty') return null;
  const subject = await prisma.subject.findUnique({
    where: { id: subjectId },
    select: { facultyId: true },
  });
  if (!subject) return null;
  if (sameId(subject.facultyId, user)) return null;
  const rows = await prisma.attendanceDelegation.findMany({
    where: { subjectId, facultyId: idOf(user) },
  });
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
  /**
   * Other periods of the same subject on the same date that this one register
   * also covers — a block timetabled across two or more slots. Each is checked
   * against the day's real classes before anything is written.
   */
  alsoSlots: z.array(z.number().int().min(1).max(12)).max(11).optional().default([]),
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
  const summary = await getStudentSummary(idOf(req.user));
  res.json({ success: true, data: summary });
});

/** Class-by-class history for one of the student's subjects. */
export const getMySubjectHistory = asyncHandler(async (req, res) => {
  const { subjectId } = req.params;

  const enrolled = await prisma.enrollment.findFirst({
    where: { studentId: idOf(req.user), subjectId, isActive: true },
    select: { id: true },
  });
  if (!enrolled) throw ApiError.forbidden('You are not enrolled in this subject');

  const subject = await prisma.subject.findUnique({
    where: { id: subjectId },
    include: { faculty: { select: { name: true, email: true } } },
  });
  const history = await getStudentSubjectHistory(idOf(req.user), subjectId);

  const conducted = history.filter((h) => !h.cancelled).length;
  const present = history.filter(
    (h) => !h.cancelled && PRESENT_STATUSES.includes(h.status)
  ).length;

  res.json({
    success: true,
    data: {
      subject: {
        id: subject.id,
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

/**
 * Faculty/admin view of a student's summary.
 *
 * Admin is unrestricted. Faculty are not: this returns every subject the
 * student takes, including ones taught by someone else, so a lecturer with no
 * connection to this student must not be able to pull it up by id alone —
 * only someone who actually teaches at least one subject they are enrolled in.
 */
export const getStudentAttendance = asyncHandler(async (req, res) => {
  const student = await prisma.user.findUnique({
    where: { id: req.params.studentId },
    // Included because safeUser reports the cohort, and a row without the
    // relation would report the student as having no section at all.
    include: { section: { select: { id: true, name: true } } },
  });
  if (!student || student.role !== 'student') throw ApiError.notFound('Student not found');

  if (req.user.role === 'faculty') {
    const shared = await prisma.enrollment.findFirst({
      where: {
        studentId: student.id,
        isActive: true,
        subject: { facultyId: idOf(req.user), isActive: true },
      },
      select: { id: true },
    });
    if (!shared) throw ApiError.forbidden('You do not teach a subject this student takes');
  }

  const summary = await getStudentSummary(student.id);
  res.json({
    success: true,
    data: { student: safeUser(student), ...summary },
  });
});

/* ------------------------------------------------------------------ */
/* Faculty-facing                                                      */
/* ------------------------------------------------------------------ */

/** All recorded classes for a subject, newest first. */
export const listSessions = asyncHandler(async (req, res) => {
  const subject = await assertSubjectAccess(req.user, req.params.subjectId);

  const sessions = await prisma.classSession.findMany({
    where: { subjectId: subject.id },
    orderBy: [{ date: 'desc' }, { slot: 'desc' }],
  });

  const enrolledCount = await prisma.enrollment.count({
    where: { subjectId: subject.id, isActive: true },
  });

  res.json({
    success: true,
    data: {
      conducted: sessions.filter((s) => s.status === 'completed').length,
      plannedClasses: subject.plannedClasses,
      enrolledCount,
      sessions: sessions.map((s) => ({
        id: s.id,
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
    ? await prisma.subject.findUnique({ where: { id: req.params.subjectId } })
    : await assertSubjectAccess(req.user, req.params.subjectId);
  if (!subject) throw ApiError.notFound('Subject not found');

  /*
   * Reaching this point without being the subject's own lecturer or an admin
   * means assertSubjectAccess let them through on a standing per-period
   * override — a subject split by day, not a stand-in. The occurrence list
   * is narrowed the same way a delegation narrows it, just resolved per
   * occurrence's actual faculty rather than a fixed list of dates.
   */
  const coTeaching =
    !standingIn && req.user.role === 'faculty' && !sameId(subject.facultyId, req.user);

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
    sectionId: subject.sectionId || undefined,
    semester: subject.semester,
  });

  const map = new Map(); // "date|slot" -> row
  for (const list of Object.values(byDate)) {
    for (const o of list) {
      if (!o.subject || !sameId(o.subject.id, subject)) continue;
      // A cancelled or relocated class is not something to record here.
      if (o.origin === 'cancelled' || o.origin === 'moved-out') continue;
      // Office hours are not a class — nobody is enrolled to sit them, so
      // there is no register for a teacher to take.
      if (o.kind === 'office-hours') continue;
      map.set(`${o.date}|${o.slot}`, {
        date: o.date,
        slot: o.slot,
        origin: o.origin,
        movedFrom: o.movedFrom || null,
        reason: o.reason || '',
        // Only needed to narrow a co-teacher's list below; stripped before
        // this ever reaches the response.
        faculty: o.faculty?.id || null,
      });
    }
  }

  // Any sheet already taken must remain reachable even if the grid moved on.
  const sessions = await prisma.classSession.findMany({
    where: { subjectId: subject.id, dateKey: { gte: sessionsFrom, lte: to } },
  });

  for (const s of sessions) {
    const key = `${s.dateKey}|${s.slot}`;
    const base = map.get(key) || { date: s.dateKey, slot: s.slot, origin: 'recorded' };
    map.set(key, {
      ...base,
      sessionId: s.id,
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
  } else if (coTeaching) {
    // Exactly the days actually resolved to this lecturer — a subject split
    // by day never offers a class that still belongs to someone else.
    rows = rows.filter((o) => o.faculty && sameId(o.faculty, req.user));
  }

  const occurrences = rows
    .map(({ faculty, ...o }) => ({
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
        id: subject.id,
        code: subject.code,
        name: subject.name,
        semester: subject.semester,
        plannedClasses: subject.plannedClasses,
        section: await sectionRef(subject),
      },
      today,
      // The real denominator, not just what falls inside this window.
      conducted: await prisma.classSession.count({
        where: { subjectId: subject.id, status: 'completed' },
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
    getSubjectRoster(subject.id),
    prisma.classSession.findUnique({
      where: { subjectId_dateKey_slot: { subjectId: subject.id, dateKey: date, slot } },
    }),
  ]);

  let marks = {};
  if (session) {
    const records = await prisma.attendance.findMany({ where: { sessionId: session.id } });
    marks = Object.fromEntries(
      records.map((r) => [r.studentId, { status: r.status, remark: r.remark }])
    );
  }

  res.json({
    success: true,
    data: {
      subject: {
        id: subject.id,
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
        ? { id: session.id, topic: session.topic, status: session.status }
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
 *
 * `alsoSlots` lets one register cover a block of periods — a lab timetabled
 * across three of them is one sitting, and asking the teacher to tick the same
 * names three times is busywork. Every period still becomes its own session,
 * so the conducted count reflects what the timetable says was held.
 */
export const markAttendance = asyncHandler(async (req, res) => {
  const { date, slot, topic, records, alsoSlots } = req.body;
  // Per class, not per subject — a stand-in may only save the one handed over.
  const subject = await assertRegisterAccess(req.user, req.params.subjectId, date, slot);

  if (isFutureKey(date)) {
    throw ApiError.badRequest('Attendance cannot be recorded for a future date');
  }

  /*
   * Office hours are not a class — nobody is enrolled to sit them, so there is
   * no register to take. Checked against the grid rather than trusted from the
   * client, so a stale picker or a direct call cannot slip one through.
   */
  const primaryKind = await classKindOn(subject, date, slot);
  if (primaryKind === 'office-hours') {
    throw ApiError.badRequest(
      'This period is scheduled as office hours, not a class — there is no attendance to take.'
    );
  }

  /*
   * Every extra period is checked as strictly as the first. Access is granted
   * per class, so a stand-in handed one period must not reach the rest of the
   * day through this — and a slot the subject does not actually run in would
   * invent a class that never happened, inflating the denominator.
   */
  const extra = [...new Set((Array.isArray(alsoSlots) ? alsoSlots : []).map(Number))].filter(
    (s) => Number.isInteger(s) && s !== Number(slot)
  );

  if (extra.length) {
    const running = await slotsRunningOn(subject, date);
    for (const s of extra) {
      if (!running.has(s)) {
        throw ApiError.badRequest(
          `${subject.code} does not run in period ${s} on ${date}, so attendance cannot be recorded for it.`
        );
      }
      await assertRegisterAccess(req.user, req.params.subjectId, date, s);
    }
  }

  const slotsToWrite = [Number(slot), ...extra].sort((a, b) => a - b);

  /*
   * A register already taken can only be corrected on the day it was taken —
   * once the day has moved on, this is history, not a mistake to fix. A class
   * being marked for the very first time is unaffected, however old the date
   * is, since that isn't an edit. Checked here, not just hidden in the UI, so
   * a stale page or a direct call cannot slip a late correction through.
   */
  if (date !== todayKey()) {
    const alreadyTaken = await prisma.classSession.findMany({
      where: { subjectId: subject.id, dateKey: date, slot: { in: slotsToWrite } },
      select: { id: true },
    });
    if (alreadyTaken.length) {
      throw ApiError.badRequest(
        'Attendance for this class was already recorded and can only be edited on the same day — it can no longer be changed.'
      );
    }
  }

  const enrollments = await prisma.enrollment.findMany({
    where: { subjectId: subject.id, isActive: true },
    select: { studentId: true },
  });
  if (!enrollments.length) {
    throw ApiError.badRequest('No students are enrolled in this subject yet');
  }
  const enrolledIds = new Set(enrollments.map((e) => e.studentId));

  const submitted = new Map();
  for (const r of records) {
    if (!enrolledIds.has(idOf(r.studentId))) continue; // ignore non-enrolled ids
    submitted.set(idOf(r.studentId), r);
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

  const presentCount = finalRecords.filter((r) => PRESENT_STATUSES.includes(r.status)).length;

  /**
   * Write this register against one period.
   *
   * One transaction, because a session without its marks is a class that
   * counts against every student and a set of marks without their session is
   * orphaned — neither is a state this should ever be interruptible into.
   * The marks go in as a single statement rather than sixty upserts. Prisma
   * has no bulk upsert, and a loop over a class of sixty would be sixty round
   * trips inside a transaction holding locks the whole time.
   */
  const writeSession = (targetSlot) =>
    prisma.$transaction(async (tx) => {
      const session = await tx.classSession.upsert({
        where: {
          subjectId_dateKey_slot: { subjectId: subject.id, dateKey: date, slot: targetSlot },
        },
        create: {
          subjectId: subject.id,
          date: toUTCDate(date),
          dateKey: date,
          slot: targetSlot,
          facultyId: subject.facultyId,
          topic: topic || '',
          status: 'completed',
          presentCount,
          totalMarked: finalRecords.length,
        },
        update: {
          // Deliberately not the date or slot: those identify the class.
          facultyId: subject.facultyId,
          topic: topic || '',
          status: 'completed',
          presentCount,
          totalMarked: finalRecords.length,
        },
      });

      const ids = finalRecords.map((r) => r.studentId);
      const statuses = finalRecords.map((r) => r.status);
      const remarks = finalRecords.map((r) => r.remark || '');

      await tx.$executeRaw`
        INSERT INTO attendance (id, session_id, subject_id, student_id, status, remark, marked_by_id, created_at, updated_at)
        SELECT
          gen_random_uuid(), ${session.id}::uuid, ${subject.id}::uuid, s.student_id::uuid,
          s.status::"AttendanceStatus", s.remark, ${idOf(req.user)}::uuid, now(), now()
        FROM unnest(${ids}::text[], ${statuses}::text[], ${remarks}::text[])
          AS s(student_id, status, remark)
        ON CONFLICT (session_id, student_id) DO UPDATE
          SET status = EXCLUDED.status,
              remark = EXCLUDED.remark,
              marked_by_id = EXCLUDED.marked_by_id,
              updated_at = now()
      `;

      return session;
    });

  /*
   * A double or triple period is one sitting, and the register is the same for
   * all of it. Each period still becomes its own session, because the
   * timetable says three classes were held and the denominator has to agree —
   * this saves the teacher repeating the work, not the classes themselves.
   */
  const sessions = [];
  for (const s of slotsToWrite) sessions.push(await writeSession(s));
  const session = sessions.find((s) => s.slot === slot) || sessions[0];

  const conducted = await prisma.classSession.count({
    where: { subjectId: subject.id, status: 'completed' },
  });

  // Realtime: every affected student refreshes their own numbers, and anyone
  // watching this subject sees the new session immediately.
  const payload = {
    subjectId: subject.id,
    subjectCode: subject.code,
    subjectName: subject.name,
    sessionId: session.id,
    date,
    slot,
    slots: slotsToWrite,
    conducted,
    at: new Date().toISOString(),
  };
  emitToUsers([...enrolledIds], 'attendance:updated', payload);
  emitToSubject(subject.id, 'subject:attendance-updated', {
    ...payload,
    presentCount,
    totalMarked: finalRecords.length,
  });

  res.status(201).json({
    success: true,
    // Say how many classes it covered — a teacher applying one register to a
    // block should see that all of them were recorded.
    message:
      slotsToWrite.length > 1
        ? `Attendance saved for ${slotsToWrite.length} classes on ${date}`
        : `Attendance saved for ${date}`,
    data: {
      sessionId: session.id,
      date,
      slot,
      slots: slotsToWrite,
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
  const session = await prisma.classSession.findUnique({ where: { id: req.params.sessionId } });
  if (!session) throw ApiError.notFound('Class session not found');
  // Scoped to the exact class, not the whole subject — a lecturer covering
  // one day of a split subject can cancel their own classes, never someone
  // else's day of it.
  const subject = await assertRegisterAccess(
    req.user,
    session.subjectId,
    session.dateKey,
    session.slot
  );

  const updated = await prisma.classSession.update({
    where: { id: session.id },
    data: { status: req.body.cancelled ? 'cancelled' : 'completed' },
  });

  const conducted = await prisma.classSession.count({
    where: { subjectId: subject.id, status: 'completed' },
  });

  const enrollments = await prisma.enrollment.findMany({
    where: { subjectId: subject.id, isActive: true },
    select: { studentId: true },
  });

  const payload = {
    subjectId: subject.id,
    subjectCode: subject.code,
    subjectName: subject.name,
    sessionId: updated.id,
    date: updated.dateKey,
    conducted,
    cancelled: updated.status === 'cancelled',
    at: new Date().toISOString(),
  };
  emitToUsers(enrollments.map((e) => e.studentId), 'attendance:updated', payload);
  emitToSubject(subject.id, 'subject:attendance-updated', payload);

  res.json({
    success: true,
    message: updated.status === 'cancelled' ? 'Class marked as cancelled' : 'Class restored',
    data: { sessionId: updated.id, status: updated.status, conducted },
  });
});

/** Delete a session and every attendance record attached to it. */
export const deleteSession = asyncHandler(async (req, res) => {
  const session = await prisma.classSession.findUnique({ where: { id: req.params.sessionId } });
  if (!session) throw ApiError.notFound('Class session not found');
  // Same scoping as cancelling — deleting is even more final.
  const subject = await assertRegisterAccess(
    req.user,
    session.subjectId,
    session.dateKey,
    session.slot
  );

  /* One transaction: a register half-deleted is worse than one not deleted. */
  await prisma.$transaction([
    prisma.attendance.deleteMany({ where: { sessionId: session.id } }),
    prisma.classSession.delete({ where: { id: session.id } }),
  ]);

  const conducted = await prisma.classSession.count({
    where: { subjectId: subject.id, status: 'completed' },
  });
  const enrollments = await prisma.enrollment.findMany({
    where: { subjectId: subject.id, isActive: true },
    select: { studentId: true },
  });

  const payload = {
    subjectId: subject.id,
    subjectCode: subject.code,
    subjectName: subject.name,
    date: session.dateKey,
    conducted,
    deleted: true,
    at: new Date().toISOString(),
  };
  emitToUsers(enrollments.map((e) => e.studentId), 'attendance:updated', payload);
  emitToSubject(subject.id, 'subject:attendance-updated', payload);

  res.json({ success: true, message: 'Class record deleted', data: { conducted } });
});
