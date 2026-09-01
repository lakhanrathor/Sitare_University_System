import mongoose from 'mongoose';
import Enrollment from '../models/Enrollment.js';
import ClassSession from '../models/ClassSession.js';
import Attendance, { PRESENT_STATUSES } from '../models/Attendance.js';

const oid = (id) => new mongoose.Types.ObjectId(String(id));

/**
 * THE RULE, in one place:
 *
 *   percentage = presentClasses / conductedClasses * 100
 *
 * `conductedClasses` is the number of ClassSession documents with
 * status 'completed' for that subject — i.e. classes that actually happened.
 * `subject.plannedClasses` (30 for a semester) is NEVER the denominator.
 *
 * 30 planned, 2 conducted, 2 attended  =>  100%   (not 6.7%)
 * When nothing has been conducted yet the percentage is `null`, not 0 —
 * the UI renders that as "No classes yet" so a student is never shown 0%
 * for a subject that has not started.
 */
export function computePercentage(present, conducted) {
  if (!conducted || conducted <= 0) return null;
  return Math.round((present / conducted) * 100 * 100) / 100;
}

/** conducted-class count per subject: { [subjectId]: count } */
export async function getConductedCounts(subjectIds) {
  if (!subjectIds.length) return {};
  const rows = await ClassSession.aggregate([
    { $match: { subject: { $in: subjectIds.map(oid) }, status: 'completed' } },
    { $group: { _id: '$subject', conducted: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((r) => [String(r._id), r.conducted]));
}

/**
 * Per-subject attended counts for one student.
 * Joins each record back to its session so records belonging to a cancelled
 * class can never inflate the numerator.
 */
async function getStudentSubjectTallies(studentId, subjectIds) {
  if (!subjectIds.length) return {};
  const rows = await Attendance.aggregate([
    { $match: { student: oid(studentId), subject: { $in: subjectIds.map(oid) } } },
    {
      $lookup: {
        from: 'classsessions',
        localField: 'session',
        foreignField: '_id',
        as: 'sess',
        pipeline: [{ $match: { status: 'completed' } }, { $project: { _id: 1 } }],
      },
    },
    { $match: { 'sess.0': { $exists: true } } },
    {
      $group: {
        _id: '$subject',
        present: { $sum: { $cond: [{ $in: ['$status', PRESENT_STATUSES] }, 1, 0] } },
        markedAbsent: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } },
      },
    },
  ]);
  return Object.fromEntries(rows.map((r) => [String(r._id), r]));
}

/**
 * Overall attendance for many students in one pass.
 *
 * Built for the shortage list: finding the fifteen students below the
 * requirement out of two hundred and forty must not mean two hundred and
 * forty round trips. Marking a register writes a row for every enrolled
 * student, so counting a student's rows against completed sessions gives the
 * same denominator the per-subject view uses — the classes actually held while
 * they were enrolled.
 */
export async function getOverallForStudents(studentIds) {
  if (!studentIds?.length) return {};
  const rows = await Attendance.aggregate([
    { $match: { student: { $in: studentIds.map(oid) } } },
    {
      $lookup: {
        from: 'classsessions',
        localField: 'session',
        foreignField: '_id',
        as: 'sess',
        pipeline: [{ $match: { status: 'completed' } }, { $project: { _id: 1 } }],
      },
    },
    { $match: { 'sess.0': { $exists: true } } },
    {
      $group: {
        _id: '$student',
        conducted: { $sum: 1 },
        present: { $sum: { $cond: [{ $in: ['$status', PRESENT_STATUSES] }, 1, 0] } },
      },
    },
  ]);

  return Object.fromEntries(
    rows.map((r) => [
      String(r._id),
      {
        conducted: r.conducted,
        present: r.present,
        absent: Math.max(r.conducted - r.present, 0),
        percentage: computePercentage(r.present, r.conducted),
      },
    ])
  );
}

/**
 * Full attendance summary for a student: every enrolled subject plus a
 * class-weighted overall figure.
 */
export async function getStudentSummary(studentId) {
  const enrollments = await Enrollment.find({ student: studentId, isActive: true })
    .populate({
      path: 'subject',
      select: 'code name semester credits plannedClasses minAttendance faculty isActive',
      populate: { path: 'faculty', select: 'name email' },
    })
    .lean();

  const subjects = enrollments.map((e) => e.subject).filter((s) => s && s.isActive !== false);
  const subjectIds = subjects.map((s) => s._id);

  const [conductedMap, tallyMap] = await Promise.all([
    getConductedCounts(subjectIds),
    getStudentSubjectTallies(studentId, subjectIds),
  ]);

  const bySubject = subjects.map((s) => {
    const key = String(s._id);
    const conducted = conductedMap[key] || 0;
    const tally = tallyMap[key] || { present: 0, markedAbsent: 0 };
    const present = tally.present;
    // Any conducted class without a present record counts against the student,
    // so present + absent always reconciles with conducted.
    const absent = Math.max(conducted - present, 0);
    const percentage = computePercentage(present, conducted);

    return {
      subjectId: key,
      code: s.code,
      name: s.name,
      credits: s.credits,
      faculty: s.faculty ? { name: s.faculty.name, email: s.faculty.email } : null,
      plannedClasses: s.plannedClasses, // shown as context only
      minAttendance: s.minAttendance,
      conducted,
      present,
      absent,
      percentage,
      status: attendanceStatusLabel(percentage, s.minAttendance),
    };
  });

  bySubject.sort((a, b) => a.code.localeCompare(b.code));

  const totalConducted = bySubject.reduce((n, s) => n + s.conducted, 0);
  const totalPresent = bySubject.reduce((n, s) => n + s.present, 0);
  const overallPct = computePercentage(totalPresent, totalConducted);
  const minAttendance = bySubject.length
    ? Math.max(...bySubject.map((s) => s.minAttendance ?? 75))
    : 75;

  return {
    overall: {
      conducted: totalConducted,
      present: totalPresent,
      absent: Math.max(totalConducted - totalPresent, 0),
      percentage: overallPct,
      minAttendance,
      status: attendanceStatusLabel(overallPct, minAttendance),
      totalPlanned: bySubject.reduce((n, s) => n + (s.plannedClasses || 0), 0),
      subjectCount: bySubject.length,
    },
    subjects: bySubject,
  };
}

/** 'good' | 'warning' | 'critical' | 'no-data' — drives the colour coding. */
export function attendanceStatusLabel(percentage, minAttendance = 75) {
  if (percentage === null || percentage === undefined) return 'no-data';
  if (percentage >= minAttendance) return 'good';
  if (percentage >= minAttendance - 10) return 'warning';
  return 'critical';
}

/** Chronological class-by-class history for one student in one subject. */
export async function getStudentSubjectHistory(studentId, subjectId) {
  const sessions = await ClassSession.find({ subject: subjectId })
    .sort({ date: -1, slot: -1 })
    .lean();

  const records = await Attendance.find({
    student: studentId,
    session: { $in: sessions.map((s) => s._id) },
  }).lean();

  const bySession = new Map(records.map((r) => [String(r.session), r]));

  return sessions.map((s) => {
    const rec = bySession.get(String(s._id));
    return {
      sessionId: String(s._id),
      date: s.dateKey,
      slot: s.slot,
      topic: s.topic,
      cancelled: s.status === 'cancelled',
      // Cancelled classes are not counted either way.
      status: s.status === 'cancelled' ? 'cancelled' : rec?.status || 'absent',
      remark: rec?.remark || '',
    };
  });
}

/**
 * Roster for a subject with each student's running percentage.
 * Used by faculty for the report view and to prefill the marking sheet.
 */
export async function getSubjectRoster(subjectId) {
  const enrollments = await Enrollment.find({ subject: subjectId, isActive: true })
    .populate({ path: 'student', select: 'name email rollNumber batch isActive' })
    .lean();

  /*
   * The enrollment record itself has nothing to do with whether the student's
   * account is still active — deactivating a student in Admin -> People
   * never touches Enrollment. Their attendance history stays in the database
   * either way (Deactivate, don't delete), but the current roster — what a
   * teacher marks against, and what a report lists — should only ever be who
   * is actually still enrolled and active.
   */
  const students = enrollments
    .map((e) => e.student)
    .filter((s) => s && s.isActive !== false)
    .sort((a, b) => (a.rollNumber || '').localeCompare(b.rollNumber || ''));

  const conducted = (await getConductedCounts([subjectId]))[String(subjectId)] || 0;

  const rows = await Attendance.aggregate([
    { $match: { subject: oid(subjectId) } },
    {
      $lookup: {
        from: 'classsessions',
        localField: 'session',
        foreignField: '_id',
        as: 'sess',
        pipeline: [{ $match: { status: 'completed' } }, { $project: { _id: 1 } }],
      },
    },
    { $match: { 'sess.0': { $exists: true } } },
    {
      $group: {
        _id: '$student',
        present: { $sum: { $cond: [{ $in: ['$status', PRESENT_STATUSES] }, 1, 0] } },
      },
    },
  ]);
  const presentMap = Object.fromEntries(rows.map((r) => [String(r._id), r.present]));

  return {
    conducted,
    students: students.map((s) => {
      const present = presentMap[String(s._id)] || 0;
      return {
        studentId: String(s._id),
        name: s.name,
        email: s.email,
        rollNumber: s.rollNumber,
        batch: s.batch,
        present,
        absent: Math.max(conducted - present, 0),
        percentage: computePercentage(present, conducted),
      };
    }),
  };
}
