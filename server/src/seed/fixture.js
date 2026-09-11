/**
 * A deterministic development fixture — the dataset the regression checks
 * need in order to actually assert anything.
 *
 * This is deliberately separate from seed.js. seed.js is production-shaped:
 * it creates one admin and stops, so an administrator builds the real
 * institute through the Admin UI. That is correct for a real deployment and
 * useless as a test fixture — with a single admin account,
 * security-check.mjs's RBAC section skips, its IDOR section emits no
 * assertions at all (the loop body never runs), and its injection section
 * fails for want of a single student. Everything here exists to close that
 * gap, so a check that passes means something.
 *
 * Run:  npm run seed:demo
 *
 * Every date is anchored to the Monday of the current week rather than
 * hard-coded, so the timetable always renders as "this week" and marked
 * classes always sit in the past. Nothing here uses Math.random: the same
 * command twice produces the same data, which is what lets api-snapshot.mjs
 * compare one run against another.
 */
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { SLOTS, LUNCH } from '../config/slots.js';
import { addDays, startOfWeek, todayKey, toUTCDate } from '../utils/date.js';
import { sameId } from '../utils/ids.js';
import { putFile } from '../services/fileStore.js';

import User from '../models/User.js';
import Section from '../models/Section.js';
import Subject from '../models/Subject.js';
import Enrollment from '../models/Enrollment.js';
import ClassSession from '../models/ClassSession.js';
import Attendance from '../models/Attendance.js';
import AttendanceDelegation from '../models/AttendanceDelegation.js';
import Timetable from '../models/Timetable.js';
import TimetableEntry from '../models/TimetableEntry.js';
import ScheduleChange from '../models/ScheduleChange.js';
import SwapRequest from '../models/SwapRequest.js';
import Note from '../models/Note.js';
import ExamSchedule from '../models/ExamSchedule.js';
import LeaveDocument from '../models/LeaveDocument.js';
import Notification from '../models/Notification.js';

/* Monday of this week — every other date is expressed relative to it. */
const MONDAY = startOfWeek(todayKey());

/*
 * Documents created in one call share a createdAt to the millisecond, and
 * every list endpoint here sorts by it descending. Ties then break
 * arbitrarily, so the same fixture serves the same list in a different
 * order run to run — which makes a golden-output baseline useless. Stamping
 * distinct, increasing times fixes the order at the source rather than
 * papering over it by sorting in the comparer.
 */
let clock = 0;
const stamped = (doc) => {
  const at = new Date(Date.parse(`${MONDAY}T00:00:00.000Z`) + (clock += 60_000));
  return { ...doc, createdAt: at, updatedAt: at };
};
const NO_AUTO_TIMESTAMPS = { timestamps: false };
const lastWeek = (dow) => addDays(MONDAY, dow - 1 - 7);
const twoWeeksAgo = (dow) => addDays(MONDAY, dow - 1 - 14);
const thisWeek = (dow) => addDays(MONDAY, dow - 1);
const nextWeek = (dow) => addDays(MONDAY, dow - 1 + 7);

async function fixture() {
  /*
   * The same hard stop seed.js carries, for the same reason — this wipes
   * every collection and creates accounts with well-known passwords.
   */
  if (env.isProd) {
    console.error(
      '[fixture] Refusing to run: NODE_ENV=production. This wipes every collection and creates ' +
        'accounts with publicly-known demo passwords — never appropriate for a real deployment.'
    );
    process.exit(1);
  }

  await mongoose.connect(env.mongoUri);
  console.log(`[fixture] Connected to ${mongoose.connection.name}`);

  await Promise.all([
    Attendance.deleteMany({}),
    AttendanceDelegation.deleteMany({}),
    ClassSession.deleteMany({}),
    Enrollment.deleteMany({}),
    Subject.deleteMany({}),
    User.deleteMany({}),
    Section.deleteMany({}),
    Timetable.deleteMany({}),
    TimetableEntry.deleteMany({}),
    ScheduleChange.deleteMany({}),
    SwapRequest.deleteMany({}),
    Note.deleteMany({}),
    ExamSchedule.deleteMany({}),
    LeaveDocument.deleteMany({}),
    Notification.deleteMany({}),
  ]);
  // Same rationale as seed.js: a stale index from an older schema shape would
  // reject perfectly valid data long after this script finished.
  await Promise.all([
    Subject.collection.dropIndexes().catch(() => {}),
    User.collection.dropIndexes().catch(() => {}),
  ]);
  await Promise.all([Subject.syncIndexes(), User.syncIndexes()]);
  // GridFS is not a model, so deleteMany above does not touch it.
  await Promise.all([
    mongoose.connection.db.collection('attachments.files').deleteMany({}),
    mongoose.connection.db.collection('attachments.chunks').deleteMany({}),
  ]);
  console.log('[fixture] Cleared existing data');

  /* ---------------------------------------------------------------- */
  /* Sections — two divided years plus one undivided, because the      */
  /* section-less branches are exactly the ones that break silently.   */
  /* ---------------------------------------------------------------- */
  const [sec3A, sec3B, sec5] = await Section.create([
    { name: 'A', semester: 3, department: 'Computer Science' },
    { name: 'B', semester: 3, department: 'Computer Science' },
    { name: '', semester: 5, department: 'Computer Science' },
  ]);

  /* ---------------------------------------------------------------- */
  /* People                                                            */
  /* ---------------------------------------------------------------- */
  const admin = await User.create({
    name: 'System Admin',
    email: 'admin@sitare.org',
    password: 'admin123',
    role: 'admin',
    department: 'Administration',
  });

  /*
   * Three faculty with deliberately disjoint subject sets. security-check
   * §2 asserts that one lecturer's subject list contains none of another's,
   * which only means something if their subjects genuinely do not overlap.
   */
  const [ananya, vikram, meera, retired] = await User.create([
    {
      name: 'Dr Ananya Rao',
      email: 'ananya.rao@sitare.org',
      password: 'faculty123',
      role: 'faculty',
      employeeId: 'FAC-001',
      department: 'Computer Science',
    },
    {
      name: 'Mr Vikram Iyer',
      email: 'vikram.iyer@sitare.org',
      password: 'faculty123',
      role: 'faculty',
      employeeId: 'FAC-002',
      department: 'Computer Science',
    },
    {
      name: 'Ms Meera Nair',
      email: 'meera.nair@sitare.org',
      password: 'faculty123',
      role: 'faculty',
      employeeId: 'FAC-003',
      department: 'Computer Science',
    },
    // google-auth-check.mjs needs a deactivated account to prove sign-in
    // refuses it exactly as password login does.
    {
      name: 'Dr Retired Lecturer',
      email: 'retired.lecturer@sitare.org',
      password: 'faculty123',
      role: 'faculty',
      employeeId: 'FAC-099',
      department: 'Computer Science',
      isActive: false,
    },
  ]);

  const mkStudent = (n, name, section, semester) => ({
    name,
    email: `su-${n}@sitare.org`,
    password: 'student123',
    role: 'student',
    rollNumber: `2024CS${n}`,
    batch: '2024',
    semester,
    section: section._id,
    department: 'Computer Science',
  });

  const students3A = await User.create([
    mkStudent('30001', 'Aarav Sharma', sec3A, 3),
    mkStudent('30002', 'Diya Patel', sec3A, 3),
    /*
     * Enrolled below *after* the first classes were already marked. This is
     * the one row that makes the two attendance denominators visibly
     * different: the subject has N conducted classes, but this student only
     * has attendance rows for the ones held since they joined. Remove them
     * and both calculations agree by accident, hiding a real divergence.
     */
    mkStudent('30003', 'Kabir Menon', sec3A, 3),
  ]);
  const students3B = await User.create([
    mkStudent('30011', 'Ishaan Gupta', sec3B, 3),
    mkStudent('30012', 'Ananya Singh', sec3B, 3),
  ]);
  const students5 = await User.create([
    mkStudent('50001', 'Rhea Kapoor', sec5, 5),
    mkStudent('50002', 'Arjun Desai', sec5, 5),
  ]);

  /* ---------------------------------------------------------------- */
  /* Subjects — disjoint per lecturer, plus one with no section at all */
  /* ---------------------------------------------------------------- */
  const [dsa, dbms, os, cn, ethics, ml] = await Subject.create([
    { code: 'DSA', name: 'Data Structures and Algorithms', semester: 3, section: sec3A._id, faculty: ananya._id, department: 'Computer Science' },
    { code: 'DBMS', name: 'Database Management Systems', semester: 3, section: sec3A._id, faculty: ananya._id, department: 'Computer Science' },
    { code: 'OS', name: 'Operating Systems', semester: 3, section: sec3B._id, faculty: vikram._id, department: 'Computer Science' },
    { code: 'CN', name: 'Computer Networks', semester: 3, section: sec3B._id, faculty: vikram._id, department: 'Computer Science' },
    /*
     * No section: the whole year sits this one together. Subject.section is
     * nullable for exactly this case, and the null branch runs through
     * scopeFor(), resolveOccurrences() and the enrolment paths.
     */
    { code: 'PROF', name: 'Professional Ethics', semester: 3, section: null, faculty: ananya._id, department: 'Computer Science' },
    { code: 'ML', name: 'Machine Learning', semester: 5, section: sec5._id, faculty: meera._id, department: 'Computer Science' },
  ]);

  /* ---------------------------------------------------------------- */
  /* Enrolment                                                         */
  /* ---------------------------------------------------------------- */
  const enrol = (studentList, subjectList) =>
    studentList.flatMap((s) => subjectList.map((sub) => ({ student: s._id, subject: sub._id })));

  await Enrollment.insertMany([
    ...enrol(students3A, [dsa, dbms, ethics]),
    ...enrol(students3B, [os, cn, ethics]),
    ...enrol(students5, [ml]),
  ]);

  /* ---------------------------------------------------------------- */
  /* Timetables — one published grid per semester                      */
  /* ---------------------------------------------------------------- */
  const effectiveFrom = addDays(MONDAY, -28);
  const gridFor = (name, semester) => ({
    name,
    semester,
    department: 'Computer Science',
    effectiveFrom: toUTCDate(effectiveFrom),
    effectiveFromKey: effectiveFrom,
    status: 'published',
    publishedAt: new Date(`${effectiveFrom}T00:00:00.000Z`),
    uploadedBy: admin._id,
    slots: SLOTS,
    lunch: LUNCH,
    warnings: [],
  });

  /* Stamped for the same reason the notes and schedule changes are: the
     versions list sorts on createdAt descending, and two grids created in one
     call tie on it. */
  const [tt3, tt5] = await Timetable.create(
    [stamped(gridFor('Semester 3 — Fixture Grid', 3)), stamped(gridFor('Semester 5 — Fixture Grid', 5))],
    NO_AUTO_TIMESTAMPS,
  );

  const entry = (timetable, dayOfWeek, slot, section, subject, faculty, extra = {}) => ({
    timetable: timetable._id,
    dayOfWeek,
    slot,
    section: section ? section._id : null,
    subject: subject ? subject._id : null,
    faculty: faculty ? faculty._id : null,
    kind: 'lecture',
    ...extra,
  });

  const sem3Entries = [
    // Section A — Ananya
    entry(tt3, 1, 1, sec3A, dsa, ananya),
    entry(tt3, 1, 2, sec3A, dsa, ananya), // a double period, so the
    entry(tt3, 3, 1, sec3A, dsa, ananya), // "apply to the block" path has data
    entry(tt3, 2, 1, sec3A, dbms, ananya),
    entry(tt3, 4, 2, sec3A, dbms, ananya),
    // Section B — Vikram
    entry(tt3, 1, 1, sec3B, os, vikram),
    entry(tt3, 2, 2, sec3B, os, vikram),
    entry(tt3, 3, 1, sec3B, cn, vikram),
    // Whole year together — no section on the row at all
    entry(tt3, 5, 3, null, ethics, ananya),
    // Office hours must never be offered for attendance; keep one on the grid
    // so that exclusion is actually exercised rather than assumed.
    entry(tt3, 4, 3, sec3A, dsa, ananya, { kind: 'office-hours' }),
    // A period with no subject — the "Session with Dean" shape.
    entry(tt3, 5, 1, sec3A, null, null, { kind: 'event', title: 'Session with Dean' }),
  ];
  const sem5Entries = [
    entry(tt5, 1, 4, sec5, ml, meera),
    entry(tt5, 3, 4, sec5, ml, meera),
  ];
  const entries = await TimetableEntry.insertMany([...sem3Entries, ...sem5Entries]);
  await Timetable.updateOne({ _id: tt3._id }, { $set: { entryCount: sem3Entries.length } });
  await Timetable.updateOne({ _id: tt5._id }, { $set: { entryCount: sem5Entries.length } });

  const findEntry = (timetable, dow, slot, section) =>
    entries.find(
      (e) =>
        sameId(e.timetable, timetable._id) &&
        e.dayOfWeek === dow &&
        e.slot === slot &&
        /* A section-less period is matched by asking for no section, not by
           two nulls comparing equal — sameId deliberately refuses that. */
        (section ? sameId(e.section, section._id) : e.section == null)
    );

  /* ---------------------------------------------------------------- */
  /* Conducted classes and attendance                                  */
  /*                                                                   */
  /* All in the past, so `takeable` does not flip as the week advances */
  /* and a snapshot taken on Monday still matches one taken on Friday. */
  /* ---------------------------------------------------------------- */
  const dsaDates = [twoWeeksAgo(1), twoWeeksAgo(3), lastWeek(1), lastWeek(3)];

  const sessions = [];
  for (const [i, dateKey] of dsaDates.entries()) {
    sessions.push({
      subject: dsa._id,
      faculty: ananya._id,
      date: toUTCDate(dateKey),
      dateKey,
      slot: 1,
      topic: ['Arrays', 'Linked lists', 'Stacks', 'Queues'][i],
      // One cancelled class, which must leave the denominator entirely.
      status: i === 2 ? 'cancelled' : 'completed',
    });
  }
  const dsaSessions = await ClassSession.insertMany(sessions);

  /*
   * Kabir joined late: he has no attendance rows for the first two classes.
   * Aarav and Diya attended everything except one absence each.
   */
  const joinedFrom = lastWeek(3);
  const marks = [];
  for (const session of dsaSessions) {
    if (session.status !== 'completed') continue;
    for (const student of students3A) {
      const isLate = String(student.rollNumber) === '2024CS30003';
      if (isLate && session.dateKey < joinedFrom) continue;
      marks.push({
        session: session._id,
        subject: dsa._id,
        student: student._id,
        // One deterministic absence, so percentages are not all 100%.
        status:
          student.rollNumber === '2024CS30002' && session.dateKey === dsaDates[0]
            ? 'absent'
            : 'present',
        markedBy: ananya._id,
      });
    }
  }
  await Attendance.insertMany(marks);
  for (const session of dsaSessions) {
    if (session.status !== 'completed') continue;
    const forSession = marks.filter((m) => sameId(m.session, session._id));
    await ClassSession.updateOne(
      { _id: session._id },
      {
        $set: {
          presentCount: forSession.filter((m) => m.status === 'present').length,
          totalMarked: forSession.length,
        },
      }
    );
  }

  /* ---------------------------------------------------------------- */
  /* One schedule change of each kind, plus a stand-in                 */
  /*                                                                   */
  /* resolveOccurrences() merges the recurring grid with these three   */
  /* shapes; without one of each, most of that function is untested.   */
  /* ---------------------------------------------------------------- */
  const dsaMonday = findEntry(tt3, 1, 1, sec3A);
  const dbmsTuesday = findEntry(tt3, 2, 1, sec3A);
  const osMonday = findEntry(tt3, 1, 1, sec3B);

  await ScheduleChange.create([
    stamped({
      kind: 'cancel',
      timetable: tt3._id,
      date: toUTCDate(thisWeek(1)),
      dateKey: thisWeek(1),
      entry: dsaMonday._id,
      section: sec3A._id,
      subject: dsa._id,
      faculty: ananya._id,
      reason: 'Lecturer on duty leave',
      createdBy: admin._id,
    }),
    stamped({
      kind: 'move',
      timetable: tt3._id,
      date: toUTCDate(thisWeek(2)),
      dateKey: thisWeek(2),
      entry: dbmsTuesday._id,
      fromSlot: dbmsTuesday.slot,
      toDate: toUTCDate(thisWeek(4)),
      toDateKey: thisWeek(4),
      toSlot: 5,
      section: sec3A._id,
      subject: dbms._id,
      faculty: ananya._id,
      reason: 'Clashed with a guest lecture',
      createdBy: admin._id,
    }),
    stamped({
      kind: 'extra',
      timetable: tt3._id,
      date: toUTCDate(thisWeek(5)),
      dateKey: thisWeek(5),
      slot: 6,
      section: sec3B._id,
      subject: os._id,
      faculty: vikram._id,
      kindOfClass: 'lecture',
      reason: 'Revision before the mid-term',
      createdBy: vikram._id,
    }),
  ], NO_AUTO_TIMESTAMPS);

  /*
   * A stand-in holds one dated register, never the subject. Vikram covers a
   * single DSA class; his own subject list must still not contain DSA.
   */
  await AttendanceDelegation.create({
    subject: dsa._id,
    dateKey: thisWeek(3),
    slot: 1,
    faculty: vikram._id,
    entry: findEntry(tt3, 3, 1, sec3A)._id,
    assignedBy: admin._id,
    note: 'Covering while Dr Rao is at a conference',
  });

  /* ---------------------------------------------------------------- */
  /* A swap waiting on an administrator                                */
  /* ---------------------------------------------------------------- */
  await SwapRequest.create({
    requestedBy: ananya._id,
    counterparty: vikram._id,
    fromEntry: dsaMonday._id,
    fromDateKey: nextWeek(1),
    fromSlot: dsaMonday.slot,
    toEntry: osMonday._id,
    toDateKey: nextWeek(1),
    toSlot: osMonday.slot,
    reason: 'Clinic appointment',
    status: 'pending',
  });

  /* ---------------------------------------------------------------- */
  /* Attachments — notes, an exam schedule and a leave application     */
  /*                                                                   */
  /* security-check §3 looks for a note with attachments that a given  */
  /* lecturer cannot see. Vikram's Section-B note is invisible to      */
  /* Ananya, which is what gives that check something to assert.       */
  /* ---------------------------------------------------------------- */
  const pdf = (label) => Buffer.from(`%PDF-1.4\n% fixture: ${label}\n`, 'utf8');

  const storeOne = async (label, filename) =>
    putFile({ buffer: pdf(label), filename, contentType: 'application/pdf' });

  const [dsaHandout, osHandout, examSheet, medicalNote] = await Promise.all([
    storeOne('dsa-notes', 'dsa-week-1.pdf'),
    storeOne('os-notes', 'os-scheduling.pdf'),
    storeOne('exam-sheet', 'midterm-timetable.pdf'),
    storeOne('medical', 'medical-certificate.pdf'),
  ]);

  await Note.create(
    [
      stamped({
        title: 'DSA — week 1 handout',
        description: 'Arrays and linked lists.',
        semester: 3,
        section: sec3A._id,
        subject: dsa._id,
        attachments: [dsaHandout],
        uploadedBy: ananya._id,
      }),
      stamped({
        // Section B only — deliberately outside Ananya's cohort.
        title: 'OS — scheduling notes',
        description: 'Round-robin and priority scheduling.',
        semester: 3,
        section: sec3B._id,
        subject: os._id,
        attachments: [osHandout],
        uploadedBy: vikram._id,
      }),
    ],
    NO_AUTO_TIMESTAMPS
  );

  await ExamSchedule.create({
    title: 'Semester 3 mid-term',
    examType: 'mid-term',
    semester: 3,
    section: null,
    instructions: 'Bring your ID card. No calculators.',
    papers: [
      { subject: dsa._id, dateKey: nextWeek(1), startTime: '10:00', endTime: '12:00', room: 'H1' },
      { subject: dbms._id, dateKey: nextWeek(3), startTime: '10:00', endTime: '12:00', room: 'H1' },
      // A paper the system has no subject for — the free-text label fallback.
      { subject: null, label: 'Open Elective', dateKey: nextWeek(5), startTime: '14:00', endTime: '16:00', room: 'H2' },
    ],
    attachments: [examSheet],
    publishedBy: admin._id,
  });

  await LeaveDocument.create({
    student: students3A[1]._id,
    sentAt: new Date(`${lastWeek(1)}T09:30:00.000Z`),
    regarding: 'Medical leave — viral fever',
    body: 'Requesting leave for two days, certificate attached.',
    leaveFrom: toUTCDate(lastWeek(1)),
    leaveTo: toUTCDate(lastWeek(2)),
    attachments: [medicalNote],
    source: 'student',
  });

  /* ---------------------------------------------------------------- */
  /* Notifications                                                     */
  /* ---------------------------------------------------------------- */
  await Notification.create(
    [
      stamped({
        user: vikram._id,
        type: 'swap:requested',
        title: 'Swap requested with you',
        message: 'Dr Ananya Rao would like to exchange periods.',
        link: '/swaps',
        requiresAction: true,
        createdBy: ananya._id,
      }),
      stamped({
        user: admin._id,
        type: 'swap:requested',
        title: 'Swap needs approval',
        message: 'Dr Ananya Rao → Mr Vikram Iyer.',
        link: '/swaps',
        requiresAction: true,
        createdBy: ananya._id,
      }),
    ],
    NO_AUTO_TIMESTAMPS
  );

  /* ---------------------------------------------------------------- */
  const counts = {
    sections: await Section.countDocuments(),
    users: await User.countDocuments(),
    subjects: await Subject.countDocuments(),
    enrollments: await Enrollment.countDocuments(),
    sessions: await ClassSession.countDocuments(),
    attendance: await Attendance.countDocuments(),
    timetables: await Timetable.countDocuments(),
    entries: await TimetableEntry.countDocuments(),
    changes: await ScheduleChange.countDocuments(),
    delegations: await AttendanceDelegation.countDocuments(),
    swaps: await SwapRequest.countDocuments(),
    notes: await Note.countDocuments(),
    exams: await ExamSchedule.countDocuments(),
    leave: await LeaveDocument.countDocuments(),
    notifications: await Notification.countDocuments(),
  };

  console.log('\n──────────────────── FIXTURE LOADED ────────────────────');
  for (const [k, v] of Object.entries(counts)) {
    console.log(` ${k.padEnd(16)} ${v}`);
  }
  console.log('────────────────────── LOGINS ──────────────────────────');
  console.log(' Admin      admin@sitare.org          admin123');
  console.log(' Faculty    ananya.rao@sitare.org     faculty123   (Sem 3 A: DSA, DBMS, PROF)');
  console.log(' Faculty    vikram.iyer@sitare.org    faculty123   (Sem 3 B: OS, CN)');
  console.log(' Faculty    meera.nair@sitare.org     faculty123   (Sem 5: ML)');
  console.log(' Student    su-30001@sitare.org       student123   (Sem 3 A)');
  console.log(' Student    su-50001@sitare.org       student123   (Sem 5)');
  console.log(' Inactive   retired.lecturer@sitare.org            (deactivated on purpose)');
  console.log('────────────────────────────────────────────────────────');
  console.log(`\nWeek anchored to Monday ${MONDAY}. Marked classes sit in the two weeks before it.\n`);

  await mongoose.disconnect();
  process.exit(0);
}

fixture().catch(async (err) => {
  console.error('[fixture] Failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
