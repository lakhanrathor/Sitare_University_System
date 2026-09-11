import { prisma } from '../config/prisma.js';
import { PRESENT_STATUSES } from '../config/attendance.js';
import { idOf } from '../utils/ids.js';

/**
 * THE RULE, in one place:
 *
 *   percentage = presentClasses / conductedClasses * 100
 *
 * `conductedClasses` is the number of ClassSession rows with status
 * 'completed' for that subject — i.e. classes that actually happened.
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
  const rows = await prisma.classSession.groupBy({
    by: ['subjectId'],
    where: { subjectId: { in: subjectIds }, status: 'completed' },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.subjectId, r._count._all]));
}

/**
 * Per-subject attended counts for one student.
 *
 * The `session` clause is the load-bearing part: without it a record left
 * behind by a class that was later cancelled would still count toward the
 * numerator, and a student could read above 100%.
 */
async function getStudentSubjectTallies(studentId, subjectIds) {
  if (!subjectIds.length) return {};
  const rows = await prisma.attendance.groupBy({
    by: ['subjectId'],
    where: {
      studentId,
      subjectId: { in: subjectIds },
      status: { in: PRESENT_STATUSES },
      session: { status: 'completed' },
    },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.subjectId, { present: r._count._all }]));
}

/**
 * Overall attendance for many students in one pass.
 *
 * Built for the shortage list: finding the fifteen students below the
 * requirement out of two hundred and forty must not mean two hundred and forty
 * round trips.
 *
 * Read the denominator carefully. It counts *this student's* attendance rows
 * against completed sessions, which is not the same number as the per-subject
 * view uses — that one counts every completed session of the subject, whether
 * or not the student has a row for it. The two agree for a student enrolled
 * from the start and diverge for one who joined mid-semester, who reads lower
 * there and higher here. In SQL the two look close enough to be one query with
 * a different WHERE, and merging them would quietly change the admin shortage
 * list. They are separate on purpose.
 */
export async function getOverallForStudents(studentIds) {
  if (!studentIds?.length) return {};

  const where = { studentId: { in: studentIds }, session: { status: 'completed' } };
  const [totals, presents] = await Promise.all([
    prisma.attendance.groupBy({ by: ['studentId'], where, _count: { _all: true } }),
    prisma.attendance.groupBy({
      by: ['studentId'],
      where: { ...where, status: { in: PRESENT_STATUSES } },
      _count: { _all: true },
    }),
  ]);

  const presentByStudent = Object.fromEntries(presents.map((r) => [r.studentId, r._count._all]));

  return Object.fromEntries(
    totals.map((r) => {
      const conducted = r._count._all;
      const present = presentByStudent[r.studentId] || 0;
      return [
        r.studentId,
        {
          conducted,
          present,
          absent: Math.max(conducted - present, 0),
          percentage: computePercentage(present, conducted),
        },
      ];
    })
  );
}

/**
 * Full attendance summary for a student: every enrolled subject plus a
 * class-weighted overall figure.
 */
export async function getStudentSummary(studentId) {
  const enrollments = await prisma.enrollment.findMany({
    where: { studentId, isActive: true },
    include: {
      subject: {
        select: {
          id: true,
          code: true,
          name: true,
          semester: true,
          credits: true,
          plannedClasses: true,
          minAttendance: true,
          isActive: true,
          faculty: { select: { name: true, email: true } },
        },
      },
    },
  });

  const subjects = enrollments.map((e) => e.subject).filter((s) => s && s.isActive !== false);
  const subjectIds = subjects.map(idOf);

  const [conductedMap, tallyMap] = await Promise.all([
    getConductedCounts(subjectIds),
    getStudentSubjectTallies(studentId, subjectIds),
  ]);

  const bySubject = subjects.map((s) => {
    const key = idOf(s);
    const conducted = conductedMap[key] || 0;
    const tally = tallyMap[key] || { present: 0 };
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
  const sessions = await prisma.classSession.findMany({
    where: { subjectId },
    orderBy: [{ date: 'desc' }, { slot: 'desc' }],
  });

  const records = await prisma.attendance.findMany({
    where: { studentId, sessionId: { in: sessions.map(idOf) } },
  });

  const bySession = new Map(records.map((r) => [r.sessionId, r]));

  return sessions.map((s) => {
    const rec = bySession.get(s.id);
    return {
      sessionId: s.id,
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
  const enrollments = await prisma.enrollment.findMany({
    where: { subjectId, isActive: true },
    include: {
      student: {
        select: { id: true, name: true, email: true, rollNumber: true, batch: true, isActive: true },
      },
    },
  });

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

  const conducted = (await getConductedCounts([subjectId]))[idOf(subjectId)] || 0;

  const rows = await prisma.attendance.groupBy({
    by: ['studentId'],
    where: { subjectId, status: { in: PRESENT_STATUSES }, session: { status: 'completed' } },
    _count: { _all: true },
  });
  const presentMap = Object.fromEntries(rows.map((r) => [r.studentId, r._count._all]));

  return {
    conducted,
    students: students.map((s) => {
      const present = presentMap[idOf(s)] || 0;
      return {
        studentId: s.id,
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
