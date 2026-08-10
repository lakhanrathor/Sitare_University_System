/**
 * Seeds the real Semester-3 timetable plus a matching attendance history.
 *
 * The grid below is a direct transcription of the institute timetable: two
 * sections running in parallel, Monday-Friday, six teaching periods a day.
 *
 * The headline attendance case from the spec is preserved: WAD Section A is
 * planned for 30 classes, only 2 have been conducted, and SU24001 attended
 * both — so the app must show 100%, never 2/30.
 *
 * Run:  npm run seed
 */
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import User from '../models/User.js';
import Section from '../models/Section.js';
import Subject from '../models/Subject.js';
import Enrollment from '../models/Enrollment.js';
import ClassSession from '../models/ClassSession.js';
import Attendance from '../models/Attendance.js';
import Timetable from '../models/Timetable.js';
import TimetableEntry from '../models/TimetableEntry.js';
import ScheduleChange from '../models/ScheduleChange.js';
import SwapRequest from '../models/SwapRequest.js';
import Notification from '../models/Notification.js';
import { toUTCDate, todayKey, startOfWeek } from '../utils/date.js';

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* People                                                              */
/* ------------------------------------------------------------------ */

const FACULTY = [
  { key: 'ankit', name: 'Mr Ankit Mehta', email: 'ankit.mehta@sitare.org', empId: 'FAC101' },
  { key: 'anuja', name: 'Dr Anuja Agarwal', email: 'anuja.agarwal@sitare.org', empId: 'FAC102' },
  { key: 'deepak', name: 'Dr Deepak Rao', email: 'deepak.rao@sitare.org', empId: 'FAC103' },
  { key: 'chhavi', name: 'Ms Chhavi Sharma', email: 'chhavi.sharma@sitare.org', empId: 'FAC104' },
  { key: 'muskan', name: 'Ms Muskan Katiyar', email: 'muskan.katiyar@sitare.org', empId: 'FAC105' },
  { key: 'prateek', name: 'Mr Prateek Goel', email: 'prateek.goel@sitare.org', empId: 'FAC106' },
];

const SECTION_A_STUDENTS = [
  'Aarav Sharma', 'Diya Patel', 'Kabir Singh', 'Ananya Reddy',
  'Rohan Verma', 'Ishita Nair', 'Arjun Mehta', 'Sneha Gupta',
];
const SECTION_B_STUDENTS = [
  'Vivaan Joshi', 'Meera Krishnan', 'Aditya Rao', 'Riya Malhotra',
  'Karan Bhatia', 'Tanvi Desai', 'Nikhil Chawla', 'Pooja Iyer',
];

/* ------------------------------------------------------------------ */
/* Subjects — one offering per section                                 */
/* ------------------------------------------------------------------ */

const SUBJECTS = [
  { code: 'WAD', name: 'Web Applications Development', credits: 4, A: 'ankit', B: 'anuja' },
  { code: 'OSP', name: 'OS Principles', credits: 4, A: 'deepak', B: 'deepak' },
  { code: 'DL', name: 'Deep Learning', credits: 4, A: 'chhavi', B: 'muskan' },
  { code: 'CPS', name: 'Creative Problem Solving', credits: 3, A: 'prateek', B: 'prateek' },
];

/* ------------------------------------------------------------------ */
/* A second semester, so the semester switcher has something real in it */
/* ------------------------------------------------------------------ */

const SEM5_STUDENTS = [
  'Yash Kulkarni', 'Nandini Rao', 'Farhan Qureshi', 'Ritika Bose',
  'Manav Shetty', 'Alisha Fernandes',
];

const SEM5_SUBJECTS = [
  { code: 'CN', name: 'Computer Networks', credits: 4, faculty: 'deepak' },
  { code: 'SE', name: 'Software Engineering', credits: 3, faculty: 'ankit' },
  { code: 'ML', name: 'Machine Learning', credits: 4, faculty: 'chhavi' },
];

/*
 * [day, slot, code, kind] — semester 5 runs a single section.
 * These lecturers also teach semester 3, so every period here sits in a gap in
 * their semester-3 commitments. A clash across semesters is a real clash.
 */
const SEM5_GRID = [
  [1, 1, 'CN', 'L'],
  [1, 2, 'SE', 'L'],
  [2, 4, 'ML', 'L'],
  [2, 5, 'ML', 'L'],
  [3, 1, 'SE', 'L'],
  [4, 1, 'CN', 'L'],
  [4, 2, 'CN', 'L'],
  [4, 4, 'ML', 'L'],
  [5, 4, 'CN', 'O'],
  [5, 5, 'SE', 'L'],
];

/* ------------------------------------------------------------------ */
/* The weekly grid                                                     */
/* ------------------------------------------------------------------ */
/*
 * Slots: 1 = 9:00  2 = 10:00  3 = 11:00  |LUNCH|  4 = 1:30  5 = 2:30  6 = 3:30
 * Each row: [day, slot, section, code, kind, facultyKeyOverride?, title?]
 * kind: L = lecture, O = office hours, E = event
 */
const GRID = [
  // ── Monday ──────────────────────────────────────────────
  [1, 2, 'B', 'OSP', 'L'],
  [1, 3, 'B', 'OSP', 'L'],
  [1, 4, 'A', 'WAD', 'L'],
  [1, 4, 'B', 'CPS', 'L'],
  [1, 5, 'A', 'WAD', 'L'],
  [1, 5, 'B', 'CPS', 'L'],
  [1, 6, 'A', 'WAD', 'L'],
  [1, 6, 'B', 'CPS', 'O'],

  // ── Tuesday ─────────────────────────────────────────────
  [2, 1, 'A', 'OSP', 'L'],
  [2, 1, 'B', 'DL', 'L'],
  [2, 2, 'A', 'OSP', 'L'],
  [2, 2, 'B', 'DL', 'L'],
  [2, 3, 'A', 'OSP', 'O'],
  [2, 3, 'B', 'DL', 'O'],
  [2, 4, 'A', 'CPS', 'L'],
  [2, 4, 'B', 'WAD', 'L'],
  [2, 5, 'A', 'CPS', 'L'],
  [2, 5, 'B', 'WAD', 'L'],
  [2, 6, 'A', 'CPS', 'O'],
  [2, 6, 'B', 'WAD', 'L'],

  // ── Wednesday ───────────────────────────────────────────
  [3, 1, 'B', 'OSP', 'L'],
  [3, 2, 'B', 'OSP', 'L'],
  [3, 3, 'B', 'OSP', 'O'],
  [3, 4, 'A', 'DL', 'L'],
  [3, 5, 'A', 'DL', 'L'],
  [3, 6, 'A', 'DL', 'O'],

  // ── Thursday ────────────────────────────────────────────
  [4, 1, 'B', 'DL', 'L'],
  [4, 2, 'A', 'CPS', 'L'],
  [4, 2, 'B', 'DL', 'L'],
  [4, 3, 'A', 'CPS', 'L'],
  [4, 3, 'B', 'DL', 'L'],
  [4, 4, 'A', null, 'E', null, 'Session with Dean'],
  [4, 4, 'B', 'WAD', 'O', 'anuja'],
  // Anuja takes both sections together on Thursday afternoons.
  [4, 5, 'A', 'WAD', 'L', 'anuja'],
  [4, 5, 'B', 'WAD', 'L', 'anuja'],
  [4, 6, 'A', 'WAD', 'L', 'anuja'],
  [4, 6, 'B', 'WAD', 'L', 'anuja'],

  // ── Friday ──────────────────────────────────────────────
  [5, 1, 'A', 'OSP', 'L'],
  [5, 1, 'B', null, 'E', null, 'Session with Dean'],
  [5, 2, 'A', 'OSP', 'L'],
  [5, 2, 'B', 'CPS', 'L'],
  [5, 3, 'A', 'WAD', 'O'],
  [5, 3, 'B', 'CPS', 'L'],
  [5, 4, 'A', 'DL', 'L'],
  [5, 5, 'A', 'DL', 'L'],
  [5, 6, 'A', 'DL', 'L'],
];

const KIND = { L: 'lecture', O: 'office-hours', E: 'event' };

/* ------------------------------------------------------------------ */
/* Attendance history                                                  */
/* ------------------------------------------------------------------ */
/*
 * Sessions are listed oldest-first. Their dates are NOT hard-coded: each one
 * is placed on a period the subject genuinely occupies in the grid above,
 * walking back from yesterday. Hard-coded day offsets used to drop classes
 * onto Saturdays and onto periods the subject never runs, which then showed up
 * as "off-timetable" on the marking screen.
 *
 * One character per student, in roster order: P present, A absent, L late.
 */
const ATTENDANCE = [
  {
    code: 'WAD',
    section: 'A',
    sessions: [
      { topic: 'Course intro, HTTP basics', marks: 'PPPPPPPP' },
      { topic: 'React components and state', marks: 'PPPAPPPP' },
    ],
  },
  {
    code: 'OSP',
    section: 'A',
    sessions: [
      { topic: 'Processes and threads', marks: 'PPPPPPPP' },
      { topic: 'CPU scheduling', marks: 'PAPPPPAP' },
      { topic: 'Deadlocks', marks: 'APPPPPPP' },
      { topic: 'Memory management', marks: 'PPPPAPPP' },
      { topic: 'Virtual memory', marks: 'PPLPPPPP' },
    ],
  },
  {
    code: 'DL',
    section: 'A',
    sessions: [
      { topic: 'Perceptrons', marks: 'PPPPPPPP' },
      { topic: 'Backpropagation', marks: 'APPAPPPP' },
      { topic: 'CNN basics', marks: 'AAPPPPPP' },
      { topic: 'Regularisation', marks: 'PPPPPPPA' },
    ],
  },
  {
    code: 'CPS',
    section: 'A',
    sessions: [
      { topic: 'Design thinking', marks: 'PPPPPPPP' },
      { topic: 'Ideation techniques', marks: 'PPAPPPPP' },
      { topic: 'Prototyping', marks: 'APPPPPPP' },
    ],
  },
  // Section B: OSP has run, the rest have not — so B students see subjects
  // with no classes yet and must read "—", not 0%.
  {
    code: 'OSP',
    section: 'B',
    sessions: [
      { topic: 'Processes and threads', marks: 'PPPPPPPP' },
      { topic: 'CPU scheduling', marks: 'PPAPPPPP' },
    ],
  },
];

const STATUS_MAP = { P: 'present', A: 'absent', L: 'late' };

/** ISO weekday (1 = Monday … 7 = Sunday) for a 'YYYY-MM-DD' key. */
function isoDay(dateKey) {
  const js = new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
  return js === 0 ? 7 : js;
}

function shiftKey(dateKey, days) {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The most recent `count` lecture periods this subject actually has, ending
 * yesterday. Returned oldest-first so it lines up with the session list.
 */
function recentPeriods(sectionKey, code, count) {
  const rows = GRID.filter(
    ([, , sec, subjectCode, kind]) => sec === sectionKey && subjectCode === code && kind === 'L'
  );
  if (!rows.length) return [];

  const found = [];
  let cursor = daysAgo(1);
  for (let guard = 0; guard < 400 && found.length < count; guard += 1) {
    const dow = isoDay(cursor);
    const slots = rows
      .filter(([day]) => day === dow)
      .map(([, slot]) => slot)
      .sort((a, b) => b - a); // latest period first, since we walk backwards
    for (const slot of slots) {
      if (found.length < count) found.push({ dateKey: cursor, slot });
    }
    cursor = shiftKey(cursor, -1);
  }
  return found.reverse();
}

/* ------------------------------------------------------------------ */

async function seed() {
  await mongoose.connect(env.mongoUri);
  console.log(`[seed] Connected to ${mongoose.connection.name}`);

  await Promise.all([
    Attendance.deleteMany({}),
    ClassSession.deleteMany({}),
    Enrollment.deleteMany({}),
    Subject.deleteMany({}),
    User.deleteMany({}),
    Section.deleteMany({}),
    Timetable.deleteMany({}),
    TimetableEntry.deleteMany({}),
    ScheduleChange.deleteMany({}),
    SwapRequest.deleteMany({}),
    Notification.deleteMany({}),
  ]);
  // Legacy single-field unique index on Subject.code would reject WAD twice.
  await Promise.all([
    Subject.collection.dropIndexes().catch(() => {}),
    User.collection.dropIndexes().catch(() => {}),
  ]);
  await Promise.all([Subject.syncIndexes(), User.syncIndexes()]);
  console.log('[seed] Cleared existing data');

  const admin = await User.create({
    name: 'System Admin',
    email: 'admin@sitare.org',
    password: 'admin123',
    role: 'admin',
    department: 'Administration',
  });

  const sections = {};
  for (const name of ['A', 'B']) {
    sections[name] = await Section.create({ name, semester: 3, department: 'Computer Science' });
  }

  const faculty = {};
  for (const f of FACULTY) {
    faculty[f.key] = await User.create({
      name: f.name,
      email: f.email,
      password: 'faculty123',
      role: 'faculty',
      employeeId: f.empId,
      department: 'Computer Science',
    });
  }

  const students = { A: [], B: [] };
  let roll = 1;
  for (const [sec, names] of [
    ['A', SECTION_A_STUDENTS],
    ['B', SECTION_B_STUDENTS],
  ]) {
    for (const name of names) {
      const rollNumber = `SU240${String(roll).padStart(2, '0')}`;
      roll += 1;
      students[sec].push(
        await User.create({
          name,
          email: `${rollNumber.toLowerCase()}@sitare.org`,
          password: 'student123',
          role: 'student',
          rollNumber,
          batch: '2024-28',
          semester: 3,
          section: sections[sec]._id,
          department: 'Computer Science',
        })
      );
    }
  }
  console.log(
    `[seed] ${students.A.length + students.B.length} students, ${FACULTY.length} faculty, 1 admin`
  );

  // Subjects: one offering per section, each with its own roster.
  const subjects = {}; // "CODE|SECTION" -> doc
  for (const s of SUBJECTS) {
    for (const sec of ['A', 'B']) {
      const doc = await Subject.create({
        code: s.code,
        name: s.name,
        department: 'Computer Science',
        semester: 3,
        credits: s.credits,
        section: sections[sec]._id,
        faculty: faculty[s[sec]]._id,
        plannedClasses: 30,
        minAttendance: 75,
      });
      subjects[`${s.code}|${sec}`] = doc;

      await Enrollment.insertMany(
        students[sec].map((st) => ({ student: st._id, subject: doc._id }))
      );
    }
  }
  console.log(`[seed] ${Object.keys(subjects).length} subject offerings + enrolments`);

  // Timetable, published and live from the start of this week.
  const timetable = await Timetable.create({
    name: 'Semester 3 — Odd 2026',
    semester: 3,
    department: 'Computer Science',
    effectiveFrom: toUTCDate(startOfWeek(todayKey())),
    effectiveFromKey: startOfWeek(todayKey()),
    status: 'published',
    publishedAt: new Date(),
    uploadedBy: admin._id,
    entryCount: GRID.length,
    warnings: [
      'Dr Anuja Agarwal takes both sections at 2:30 and 3:30 on Thursday — treated as a combined class.',
    ],
  });

  await TimetableEntry.insertMany(
    GRID.map(([day, slot, sec, code, kind, facultyOverride, title]) => {
      const subject = code ? subjects[`${code}|${sec}`] : null;
      const facultyId = facultyOverride
        ? faculty[facultyOverride]._id
        : subject
          ? subject.faculty
          : null;
      return {
        timetable: timetable._id,
        dayOfWeek: day,
        slot,
        section: sections[sec]._id,
        subject: subject?._id || null,
        faculty: facultyId,
        kind: KIND[kind],
        title: title || '',
      };
    })
  );
  console.log(`[seed] Timetable published — ${GRID.length} periods across Mon-Fri`);

  // Attendance history.
  for (const plan of ATTENDANCE) {
    const subject = subjects[`${plan.code}|${plan.section}`];
    const roster = students[plan.section];
    const periods = recentPeriods(plan.section, plan.code, plan.sessions.length);

    for (const [i, sess] of plan.sessions.entries()) {
      const period = periods[i];
      if (!period) break; // grid has fewer past periods than sessions listed
      const key = period.dateKey;
      const marks = sess.marks.split('').map((c) => STATUS_MAP[c]);
      const presentCount = marks.filter((m) => m !== 'absent').length;

      const session = await ClassSession.create({
        subject: subject._id,
        faculty: subject.faculty,
        date: toUTCDate(key),
        dateKey: key,
        slot: period.slot,
        topic: sess.topic,
        status: 'completed',
        presentCount,
        totalMarked: roster.length,
      });

      await Attendance.insertMany(
        roster.map((s, i) => ({
          session: session._id,
          subject: subject._id,
          student: s._id,
          status: marks[i],
          markedBy: subject.faculty,
        }))
      );
    }
    console.log(
      `[seed] ${plan.code} Section ${plan.section} -> ${periods.length} conducted / 30 planned` +
        (periods.length ? ` (${periods[0].dateKey} … ${periods[periods.length - 1].dateKey})` : '')
    );
  }

  /* ---------------------------------------------------------------- */
  /* Semester 5 — a second live timetable                              */
  /* ---------------------------------------------------------------- */

  const sec5 = await Section.create({ name: 'A', semester: 5, department: 'Computer Science' });

  const students5 = [];
  for (const [i, name] of SEM5_STUDENTS.entries()) {
    const rollNumber = `SU220${String(i + 1).padStart(2, '0')}`;
    students5.push(
      await User.create({
        name,
        email: `${rollNumber.toLowerCase()}@sitare.org`,
        password: 'student123',
        role: 'student',
        rollNumber,
        batch: '2022-26',
        semester: 5,
        section: sec5._id,
        department: 'Computer Science',
      })
    );
  }

  const subjects5 = {};
  for (const s of SEM5_SUBJECTS) {
    const doc = await Subject.create({
      code: s.code,
      name: s.name,
      department: 'Computer Science',
      semester: 5,
      credits: s.credits,
      section: sec5._id,
      faculty: faculty[s.faculty]._id,
      plannedClasses: 30,
      minAttendance: 75,
    });
    subjects5[s.code] = doc;
    await Enrollment.insertMany(students5.map((st) => ({ student: st._id, subject: doc._id })));
  }

  const timetable5 = await Timetable.create({
    name: 'Semester 5 — Odd 2026',
    semester: 5,
    department: 'Computer Science',
    effectiveFrom: toUTCDate(startOfWeek(todayKey())),
    effectiveFromKey: startOfWeek(todayKey()),
    status: 'published',
    publishedAt: new Date(),
    uploadedBy: admin._id,
    entryCount: SEM5_GRID.length,
  });

  await TimetableEntry.insertMany(
    SEM5_GRID.map(([day, slot, code, kind]) => ({
      timetable: timetable5._id,
      dayOfWeek: day,
      slot,
      section: sec5._id,
      subject: subjects5[code]._id,
      faculty: subjects5[code].faculty,
      kind: KIND[kind],
    }))
  );
  console.log(
    `[seed] Semester 5 -> 1 section, ${students5.length} students, ${SEM5_SUBJECTS.length} subjects, ${SEM5_GRID.length} periods`
  );

  console.log('\n──────────────────── LOGIN CREDENTIALS ────────────────────');
  console.log(' Admin    admin@sitare.org             admin123');
  console.log(' Faculty  ankit.mehta@sitare.org       faculty123   (WAD  Sec A)');
  console.log('          anuja.agarwal@sitare.org     faculty123   (WAD  Sec B)');
  console.log('          deepak.rao@sitare.org        faculty123   (OSP  both)');
  console.log('          chhavi.sharma@sitare.org     faculty123   (DL   Sec A)');
  console.log('          muskan.katiyar@sitare.org    faculty123   (DL   Sec B)');
  console.log('          prateek.goel@sitare.org      faculty123   (CPS  both)');
  console.log(' Student  su24001@sitare.org           student123   (Sem 3, Section A)');
  console.log('          su24009@sitare.org           student123   (Sem 3, Section B)');
  console.log('          su22001@sitare.org           student123   (Sem 5, Section A)');
  console.log('          su24001 … su24016  and  su22001 … su22006');
  console.log('───────────────────────────────────────────────────────────');
  console.log('\n Aarav Sharma (SU24001, Section A) expected attendance:');
  console.log('   WAD  2 of 2 attended   -> 100%    <- 30 planned, ignored');
  console.log('   OSP  4 of 5 attended   -> 80%');
  console.log('   DL   2 of 4 attended   -> 50%');
  console.log('   CPS  2 of 3 attended   -> 66.67%');
  console.log('   OVERALL 10 of 14       -> 71.43%\n');

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch(async (err) => {
  console.error('[seed] Failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
