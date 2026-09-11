/**
 * Hard deletes for the admin console.
 *
 * Records reference each other across six tables, so removing one thing by
 * itself would leave attendance marks pointing at a subject that no longer
 * exists, or a timetable period owned by nobody. Everything an admin can
 * delete is therefore torn down through here, which removes the dependants in
 * the order that keeps the database consistent at every step.
 *
 * The foreign keys that came with PostgreSQL would now cascade much of this on
 * their own, and the explicit deletes are kept anyway for two reasons. The
 * admin is shown a breakdown of exactly what was removed, which a cascade
 * cannot report. And the rule that matters most here is not a cascade at all —
 * a departing lecturer leaves their subjects standing, unassigned — so it has
 * to be expressed as an update in the middle of the sequence. The cascades
 * remain underneath as a backstop for anything this misses.
 *
 * Each of the three runs inside one transaction. A purge touches seven tables,
 * and stopping halfway is the one outcome worse than not starting: attendance
 * marks whose session is gone, or an account deleted while the subjects it was
 * meant to release still name it. All or nothing.
 *
 * These are genuinely destructive and cannot be undone — the caller is
 * responsible for confirming first.
 */
import { prisma } from '../config/prisma.js';
import { idOf } from '../utils/ids.js';

/*
 * A purge is a long sequence of writes, so the interactive transaction gets a
 * deliberately generous budget: the default five seconds is a sensible guard
 * against a stuck request, and far too short for deleting a cohort's whole
 * history on a cold database.
 */
const TX = { timeout: 120_000, maxWait: 10_000 };

/** Everything hanging off a set of subjects. */
async function purgeSubjectsIn(tx, subjectIds) {
  if (!subjectIds.length) return { subjects: 0 };

  const [sessions, entries] = await Promise.all([
    tx.classSession.findMany({ where: { subjectId: { in: subjectIds } }, select: { id: true } }),
    tx.timetableEntry.findMany({
      where: { subjectId: { in: subjectIds } },
      select: { id: true },
    }),
  ]);
  const sessionIds = sessions.map(idOf);
  const entryIds = entries.map(idOf);

  const out = {};
  out.attendance = (
    await tx.attendance.deleteMany({
      where: { OR: [{ subjectId: { in: subjectIds } }, { sessionId: { in: sessionIds } }] },
    })
  ).count;
  out.sessions = (await tx.classSession.deleteMany({ where: { id: { in: sessionIds } } })).count;
  out.enrolments = (
    await tx.enrollment.deleteMany({ where: { subjectId: { in: subjectIds } } })
  ).count;
  out.swaps = (
    await tx.swapRequest.deleteMany({
      where: { OR: [{ fromEntryId: { in: entryIds } }, { toEntryId: { in: entryIds } }] },
    })
  ).count;
  out.changes = (
    await tx.scheduleChange.deleteMany({
      where: { OR: [{ subjectId: { in: subjectIds } }, { entryId: { in: entryIds } }] },
    })
  ).count;
  /*
   * Three references Mongo let dangle and a foreign key will not. A delegation
   * belongs to the class it covers, so it goes; an exam paper names a subject
   * that will not exist, so it goes; a note merely mentions one, and losing
   * the material along with the subject would be the wrong trade.
   */
  await tx.attendanceDelegation.deleteMany({
    where: { OR: [{ subjectId: { in: subjectIds } }, { entryId: { in: entryIds } }] },
  });
  await tx.examPaper.deleteMany({ where: { subjectId: { in: subjectIds } } });
  await tx.note.updateMany({
    where: { subjectId: { in: subjectIds } },
    data: { subjectId: null },
  });
  out.periods = (await tx.timetableEntry.deleteMany({ where: { id: { in: entryIds } } })).count;
  out.subjects = (await tx.subject.deleteMany({ where: { id: { in: subjectIds } } })).count;

  return out;
}

/** Everything belonging to a set of people. */
async function purgeUsersIn(tx, userIds) {
  if (!userIds.length) return { users: 0 };

  const out = {};
  out.attendance = (
    await tx.attendance.deleteMany({ where: { studentId: { in: userIds } } })
  ).count;
  out.enrolments = (
    await tx.enrollment.deleteMany({ where: { studentId: { in: userIds } } })
  ).count;
  await tx.notification.deleteMany({ where: { userId: { in: userIds } } });

  // Swaps this person raised or was asked about.
  out.swaps = (
    await tx.swapRequest.deleteMany({
      where: { OR: [{ requestedById: { in: userIds } }, { counterpartyId: { in: userIds } }] },
    })
  ).count;

  /*
   * A departing lecturer leaves their classes standing: the subject and its
   * timetable period survive with nobody assigned, so an admin can hand them
   * to someone else rather than losing the class. This is the reason those
   * foreign keys are SetNull, and the reason this is an update and not a
   * delete.
   */
  await tx.subject.updateMany({
    where: { facultyId: { in: userIds } },
    data: { facultyId: null },
  });
  await tx.timetableEntry.updateMany({
    where: { facultyId: { in: userIds } },
    data: { facultyId: null },
  });
  await tx.scheduleChange.updateMany({
    where: { facultyId: { in: userIds } },
    data: { facultyId: null },
  });

  /*
   * Rows that merely name this person rather than belong to them. Mongo was
   * content to let every one of these point at a deleted account; a foreign
   * key is not, so each is released before the account goes. Attendance marks
   * are the one to get right: cascading here would delete every register a
   * departing lecturer ever took.
   */
  await tx.classSession.updateMany({
    where: { facultyId: { in: userIds } },
    data: { facultyId: null },
  });
  await tx.attendance.updateMany({
    where: { markedById: { in: userIds } },
    data: { markedById: null },
  });
  await tx.timetable.updateMany({
    where: { uploadedById: { in: userIds } },
    data: { uploadedById: null },
  });
  await tx.note.updateMany({
    where: { uploadedById: { in: userIds } },
    data: { uploadedById: null },
  });
  await tx.examSchedule.updateMany({
    where: { publishedById: { in: userIds } },
    data: { publishedById: null },
  });
  await tx.scheduleChange.updateMany({
    where: { createdById: { in: userIds } },
    data: { createdById: null },
  });
  await tx.notification.updateMany({
    where: { createdById: { in: userIds } },
    data: { createdById: null },
  });
  await tx.swapRequest.updateMany({
    where: { decidedById: { in: userIds } },
    data: { decidedById: null },
  });
  await tx.leaveDocument.updateMany({
    where: { uploadedById: { in: userIds } },
    data: { uploadedById: null },
  });
  await tx.attendanceDelegation.updateMany({
    where: { assignedById: { in: userIds } },
    data: { assignedById: null },
  });

  /* These two are the person's own, not a mention of them. */
  await tx.attendanceDelegation.deleteMany({ where: { facultyId: { in: userIds } } });
  await tx.leaveDocument.deleteMany({ where: { studentId: { in: userIds } } });

  out.users = (await tx.user.deleteMany({ where: { id: { in: userIds } } })).count;
  return out;
}

/** Everything hanging off a set of subjects, in one transaction. */
export function purgeSubjects(subjectIds) {
  if (!subjectIds.length) return Promise.resolve({ subjects: 0 });
  return prisma.$transaction((tx) => purgeSubjectsIn(tx, subjectIds), TX);
}

/** Everything belonging to a set of people, in one transaction. */
export function purgeUsers(userIds) {
  if (!userIds.length) return Promise.resolve({ users: 0 });
  return prisma.$transaction((tx) => purgeUsersIn(tx, userIds), TX);
}

/** A whole cohort: its people, its subjects and its place on the timetable. */
export function purgeSection(section) {
  return prisma.$transaction((tx) => purgeSectionIn(tx, section), TX);
}

async function purgeSectionIn(tx, section) {
  const sectionId = idOf(section);

  const [studentRows, subjectRows] = await Promise.all([
    tx.user.findMany({ where: { role: 'student', sectionId }, select: { id: true } }),
    tx.subject.findMany({ where: { sectionId }, select: { id: true } }),
  ]);

  const fromSubjects = await purgeSubjectsIn(tx, subjectRows.map(idOf));
  const fromUsers = await purgeUsersIn(tx, studentRows.map(idOf));

  // Periods and changes attached to the section rather than to a subject.
  const entries = await tx.timetableEntry.findMany({
    where: { sectionId },
    select: { id: true },
  });
  const entryIds = entries.map(idOf);
  await tx.swapRequest.deleteMany({
    where: { OR: [{ fromEntryId: { in: entryIds } }, { toEntryId: { in: entryIds } }] },
  });
  await tx.attendanceDelegation.deleteMany({ where: { entryId: { in: entryIds } } });
  await tx.scheduleChange.deleteMany({ where: { sectionId } });
  const extraPeriods = (await tx.timetableEntry.deleteMany({ where: { sectionId } })).count;

  /*
   * Notes and exam schedules were never cleaned up here, which Mongo permitted
   * — the section id simply dangled. A foreign key will not have that, and the
   * obvious alternative is worse than the dangling pointer was: a null section
   * on either of these means "the whole year can read it", so releasing them
   * would silently widen a deleted cohort's material to everybody. They are
   * removed with the cohort instead.
   */
  await tx.note.deleteMany({ where: { sectionId } });
  await tx.examSchedule.deleteMany({ where: { sectionId } });

  /* Anyone left pointing at the section — a lecturer, an admin — is released
     rather than deleted; only its students were purged above. */
  await tx.user.updateMany({ where: { sectionId }, data: { sectionId: null } });

  await tx.section.delete({ where: { id: sectionId } });

  return {
    students: fromUsers.users || 0,
    subjects: fromSubjects.subjects || 0,
    sessions: fromSubjects.sessions || 0,
    attendance: (fromSubjects.attendance || 0) + (fromUsers.attendance || 0),
    periods: (fromSubjects.periods || 0) + extraPeriods,
  };
}

/** Plain-English summary of what a purge removed. */
export function describePurge(counts) {
  const n = (v, one, many) => v && `${v} ${v === 1 ? one : many}`;
  return [
    n(counts.users ?? counts.students, 'account', 'accounts'),
    n(counts.subjects, 'subject', 'subjects'),
    n(counts.sessions, 'recorded class', 'recorded classes'),
    n(counts.attendance, 'attendance mark', 'attendance marks'),
    n(counts.periods, 'timetable period', 'timetable periods'),
  ]
    .filter(Boolean)
    .join(', ');
}
