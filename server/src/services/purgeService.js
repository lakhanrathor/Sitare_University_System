/**
 * Hard deletes for the admin console.
 *
 * Records reference each other across six collections, so removing one thing
 * by itself would leave attendance marks pointing at a subject that no longer
 * exists, or a timetable period owned by nobody. Everything an admin can
 * delete is therefore torn down through here, which removes the dependants in
 * the order that keeps the database consistent at every step.
 *
 * These are genuinely destructive and cannot be undone — the caller is
 * responsible for confirming first.
 */
import User from '../models/User.js';
import Subject from '../models/Subject.js';
import Enrollment from '../models/Enrollment.js';
import ClassSession from '../models/ClassSession.js';
import Attendance from '../models/Attendance.js';
import TimetableEntry from '../models/TimetableEntry.js';
import ScheduleChange from '../models/ScheduleChange.js';
import SwapRequest from '../models/SwapRequest.js';
import Notification from '../models/Notification.js';

const ids = (docs) => docs.map((d) => d._id);

/** Everything hanging off a set of subjects. */
export async function purgeSubjects(subjectIds) {
  if (!subjectIds.length) return { subjects: 0 };

  const sessionIds = ids(
    await ClassSession.find({ subject: { $in: subjectIds } }).select('_id').lean()
  );
  const entryIds = ids(
    await TimetableEntry.find({ subject: { $in: subjectIds } }).select('_id').lean()
  );

  const out = {};
  out.attendance = (
    await Attendance.deleteMany({
      $or: [{ subject: { $in: subjectIds } }, { session: { $in: sessionIds } }],
    })
  ).deletedCount;
  out.sessions = (await ClassSession.deleteMany({ _id: { $in: sessionIds } })).deletedCount;
  out.enrolments = (await Enrollment.deleteMany({ subject: { $in: subjectIds } })).deletedCount;
  out.swaps = (
    await SwapRequest.deleteMany({
      $or: [{ fromEntry: { $in: entryIds } }, { toEntry: { $in: entryIds } }],
    })
  ).deletedCount;
  out.changes = (
    await ScheduleChange.deleteMany({
      $or: [{ subject: { $in: subjectIds } }, { entry: { $in: entryIds } }],
    })
  ).deletedCount;
  out.periods = (await TimetableEntry.deleteMany({ _id: { $in: entryIds } })).deletedCount;
  out.subjects = (await Subject.deleteMany({ _id: { $in: subjectIds } })).deletedCount;

  return out;
}

/** Everything belonging to a set of people. */
export async function purgeUsers(userIds) {
  if (!userIds.length) return { users: 0 };

  const out = {};
  out.attendance = (await Attendance.deleteMany({ student: { $in: userIds } })).deletedCount;
  out.enrolments = (await Enrollment.deleteMany({ student: { $in: userIds } })).deletedCount;
  await Notification.deleteMany({ user: { $in: userIds } });

  // Swaps this person raised or was asked about.
  out.swaps = (
    await SwapRequest.deleteMany({
      $or: [{ requestedBy: { $in: userIds } }, { counterparty: { $in: userIds } }],
    })
  ).deletedCount;

  /*
   * A departing lecturer leaves their classes standing: the subject and its
   * timetable period survive with nobody assigned, so an admin can hand them
   * to someone else rather than losing the class.
   */
  await Subject.updateMany({ faculty: { $in: userIds } }, { $set: { faculty: null } });
  await TimetableEntry.updateMany({ faculty: { $in: userIds } }, { $set: { faculty: null } });
  await ScheduleChange.updateMany({ faculty: { $in: userIds } }, { $set: { faculty: null } });

  out.users = (await User.deleteMany({ _id: { $in: userIds } })).deletedCount;
  return out;
}

/** A whole cohort: its people, its subjects and its place on the timetable. */
export async function purgeSection(section) {
  const students = ids(
    await User.find({ role: 'student', section: section._id }).select('_id').lean()
  );
  const subjects = ids(await Subject.find({ section: section._id }).select('_id').lean());

  const fromSubjects = await purgeSubjects(subjects);
  const fromUsers = await purgeUsers(students);

  // Periods and changes attached to the section rather than to a subject.
  const entryIds = ids(
    await TimetableEntry.find({ section: section._id }).select('_id').lean()
  );
  await SwapRequest.deleteMany({
    $or: [{ fromEntry: { $in: entryIds } }, { toEntry: { $in: entryIds } }],
  });
  await ScheduleChange.deleteMany({ section: section._id });
  const extraPeriods = (await TimetableEntry.deleteMany({ section: section._id })).deletedCount;

  await section.deleteOne();

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
