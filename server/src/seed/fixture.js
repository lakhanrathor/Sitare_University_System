/**
 * A deterministic development fixture — the dataset the regression checks
 * need in order to actually assert anything.
 *
 * This is deliberately separate from seed.js. seed.js is production-shaped: it
 * creates one admin and stops, so an administrator builds the real institute
 * through the Admin UI. That is correct for a real deployment and useless as a
 * test fixture — with a single admin account, security-check.mjs's RBAC
 * section skips, its IDOR section emits no assertions at all, and its
 * injection section fails for want of a single student. Everything here exists
 * to close that gap, so a check that passes means something.
 *
 * Run:  npm run seed:demo
 *
 * Every date is anchored to the Monday of the current week rather than
 * hard-coded, so the timetable always renders as "this week" and marked
 * classes always sit in the past. Nothing here uses Math.random: the same
 * command twice produces the same data, which is what lets api-snapshot.mjs
 * compare one run against another.
 */
import bcrypt from 'bcryptjs';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { SLOTS, LUNCH } from '../config/slots.js';
import { addDays, startOfWeek, todayKey, toUTCDate } from '../utils/date.js';

/* Monday of this week — every other date is expressed relative to it. */
const MONDAY = startOfWeek(todayKey());

/*
 * Rows created in one call share a timestamp, and several list endpoints sort
 * by createdAt descending. Ties then break arbitrarily, so the same fixture
 * serves the same list in a different order run to run — which makes a
 * golden-output baseline useless. Stamping distinct, increasing times fixes
 * the order at the source rather than papering over it in the comparer.
 */
let clock = 0;
const stamp = () => {
  const at = new Date(Date.parse(`${MONDAY}T00:00:00.000Z`) + (clock += 60_000));
  return { createdAt: at, updatedAt: at };
};

const lastWeek = (dow) => addDays(MONDAY, dow - 1 - 7);
const twoWeeksAgo = (dow) => addDays(MONDAY, dow - 1 - 14);
const thisWeek = (dow) => addDays(MONDAY, dow - 1);
const nextWeek = (dow) => addDays(MONDAY, dow - 1 + 7);

/* One round, reused: hashing eleven passwords separately costs a second. */
const hash = (plain) => bcrypt.hashSync(plain, 10);

async function fixture() {
  /*
   * The same hard stop fixture.js and seed.js carry, for the same reason —
   * this empties every table and creates accounts with well-known passwords.
   */
  if (env.isProd) {
    console.error(
      '[fixture] Refusing to run: NODE_ENV=production. This empties every table and creates ' +
        'accounts with publicly-known demo passwords — never appropriate for a real deployment.'
    );
    process.exit(1);
  }

  console.log(`[fixture] Connected to ${env.databaseUrl.replace(/:[^:@/]*@/, ':****@')}`);

  /*
   * Deleted in dependency order rather than relying on ON DELETE CASCADE, so
   * this says out loud what it removes. `attachments` before `files` because
   * that foreign key is Restrict on purpose: a file row must never be orphaned
   * by something deleting the thing that referenced it.
   */
  await prisma.attendance.deleteMany();
  await prisma.attendanceDelegation.deleteMany();
  await prisma.classSession.deleteMany();
  await prisma.enrollment.deleteMany();
  await prisma.scheduleChange.deleteMany();
  await prisma.swapRequest.deleteMany();
  await prisma.attachment.deleteMany();
  await prisma.file.deleteMany();
  await prisma.examPaper.deleteMany();
  await prisma.examSchedule.deleteMany();
  await prisma.note.deleteMany();
  await prisma.leaveDocument.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.timetableEntry.deleteMany();
  await prisma.timetableSlot.deleteMany();
  await prisma.timetable.deleteMany();
  await prisma.subject.deleteMany();
  await prisma.user.deleteMany();
  await prisma.section.deleteMany();
  console.log('[fixture] Cleared existing data');

  /* ---------------------------------------------------------------- */
  /* Sections — two divided years plus one undivided, because the      */
  /* section-less branches are exactly the ones that break silently.   */
  /* ---------------------------------------------------------------- */
  const sec3A = await prisma.section.create({
    data: { name: 'A', semester: 3, department: 'Computer Science' },
  });
  const sec3B = await prisma.section.create({
    data: { name: 'B', semester: 3, department: 'Computer Science' },
  });
  const sec5 = await prisma.section.create({
    data: { name: '', semester: 5, department: 'Computer Science' },
  });

  /* ---------------------------------------------------------------- */
  /* People                                                            */
  /* ---------------------------------------------------------------- */
  const admin = await prisma.user.create({
    data: {
      name: 'System Admin',
      email: 'admin@sitare.org',
      password: hash('admin123'),
      role: 'admin',
      department: 'Administration',
    },
  });

  /*
   * Three faculty with deliberately disjoint subject sets. security-check §2
   * asserts that one lecturer's subject list contains none of another's, which
   * only means something if their subjects genuinely do not overlap.
   */
  const facultyPassword = hash('faculty123');
  const mkFaculty = (name, email, employeeId, extra = {}) => ({
    name,
    email,
    password: facultyPassword,
    role: 'faculty',
    employeeId,
    department: 'Computer Science',
    ...extra,
  });

  const ananya = await prisma.user.create({
    data: mkFaculty('Dr Ananya Rao', 'ananya.rao@sitare.org', 'FAC-001'),
  });
  const vikram = await prisma.user.create({
    data: mkFaculty('Mr Vikram Iyer', 'vikram.iyer@sitare.org', 'FAC-002'),
  });
  const meera = await prisma.user.create({
    data: mkFaculty('Ms Meera Nair', 'meera.nair@sitare.org', 'FAC-003'),
  });
  // google-auth-check.mjs needs a deactivated account to prove sign-in refuses
  // it exactly as password login does.
  await prisma.user.create({
    data: mkFaculty('Dr Retired Lecturer', 'retired.lecturer@sitare.org', 'FAC-099', {
      isActive: false,
    }),
  });

  const studentPassword = hash('student123');
  const mkStudent = (n, name, section, semester) => ({
    name,
    email: `su-${n}@sitare.org`,
    password: studentPassword,
    role: 'student',
    rollNumber: `2024CS${n}`,
    batch: '2024',
    semester,
    sectionId: section.id,
    department: 'Computer Science',
  });

  const createStudents = async (rows) => {
    const out = [];
    for (const row of rows) out.push(await prisma.user.create({ data: row }));
    return out;
  };

  const students3A = await createStudents([
    mkStudent('30001', 'Aarav Sharma', sec3A, 3),
    mkStudent('30002', 'Diya Patel', sec3A, 3),
    /*
     * Enrolled below *after* the first classes were already marked. This is
     * the one row that makes the two attendance denominators visibly
     * different: the subject has N conducted classes, but this student only
     * has attendance rows for the ones held since they joined. Remove them and
     * both calculations agree by accident, hiding a real divergence.
     */
    mkStudent('30003', 'Kabir Menon', sec3A, 3),
  ]);
  const students3B = await createStudents([
    mkStudent('30011', 'Ishaan Gupta', sec3B, 3),
    mkStudent('30012', 'Ananya Singh', sec3B, 3),
  ]);
  const students5 = await createStudents([
    mkStudent('50001', 'Rhea Kapoor', sec5, 5),
    mkStudent('50002', 'Arjun Desai', sec5, 5),
  ]);

  /* ---------------------------------------------------------------- */
  /* Subjects — disjoint per lecturer, plus one with no section at all */
  /* ---------------------------------------------------------------- */
  const mkSubject = (data) =>
    prisma.subject.create({ data: { department: 'Computer Science', ...data } });

  const dsa = await mkSubject({
    code: 'DSA',
    name: 'Data Structures and Algorithms',
    semester: 3,
    sectionId: sec3A.id,
    facultyId: ananya.id,
  });
  const dbms = await mkSubject({
    code: 'DBMS',
    name: 'Database Management Systems',
    semester: 3,
    sectionId: sec3A.id,
    facultyId: ananya.id,
  });
  const os = await mkSubject({
    code: 'OS',
    name: 'Operating Systems',
    semester: 3,
    sectionId: sec3B.id,
    facultyId: vikram.id,
  });
  const cn = await mkSubject({
    code: 'CN',
    name: 'Computer Networks',
    semester: 3,
    sectionId: sec3B.id,
    facultyId: vikram.id,
  });
  /*
   * No section: the whole year sits this one together. Subject.sectionId is
   * nullable for exactly this case, and the null branch runs through
   * scopeFor(), resolveOccurrences() and the enrolment paths.
   */
  const ethics = await mkSubject({
    code: 'PROF',
    name: 'Professional Ethics',
    semester: 3,
    sectionId: null,
    facultyId: ananya.id,
  });
  const ml = await mkSubject({
    code: 'ML',
    name: 'Machine Learning',
    semester: 5,
    sectionId: sec5.id,
    facultyId: meera.id,
  });

  /* ---------------------------------------------------------------- */
  /* Enrolment                                                         */
  /* ---------------------------------------------------------------- */
  const enrol = (studentList, subjectList) =>
    studentList.flatMap((s) => subjectList.map((sub) => ({ studentId: s.id, subjectId: sub.id })));

  await prisma.enrollment.createMany({
    data: [
      ...enrol(students3A, [dsa, dbms, ethics]),
      ...enrol(students3B, [os, cn, ethics]),
      ...enrol(students5, [ml]),
    ],
  });

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
    uploadedById: admin.id,
    lunchLabel: LUNCH?.label ?? null,
    lunchStart: LUNCH?.start ?? null,
    lunchEnd: LUNCH?.end ?? null,
    lunchAfterSlot: LUNCH?.afterSlot ?? null,
    warnings: [],
    /* The period grid was an embedded array; it is now a child table. */
    slots: { create: SLOTS.map((s) => ({ slot: s.slot, label: s.label, start: s.start, end: s.end })) },
    ...stamp(),
  });

  const tt3 = await prisma.timetable.create({ data: gridFor('Semester 3 — Fixture Grid', 3) });
  const tt5 = await prisma.timetable.create({ data: gridFor('Semester 5 — Fixture Grid', 5) });

  const entry = (timetable, dayOfWeek, slot, section, subject, faculty, extra = {}) => ({
    timetableId: timetable.id,
    dayOfWeek,
    slot,
    sectionId: section ? section.id : null,
    subjectId: subject ? subject.id : null,
    facultyId: faculty ? faculty.id : null,
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
  const sem5Entries = [entry(tt5, 1, 4, sec5, ml, meera), entry(tt5, 3, 4, sec5, ml, meera)];

  await prisma.timetableEntry.createMany({ data: [...sem3Entries, ...sem5Entries] });
  const entries = await prisma.timetableEntry.findMany();
  await prisma.timetable.update({
    where: { id: tt3.id },
    data: { entryCount: sem3Entries.length },
  });
  await prisma.timetable.update({
    where: { id: tt5.id },
    data: { entryCount: sem5Entries.length },
  });

  const findEntry = (timetable, dow, slot, section) =>
    entries.find(
      (e) =>
        e.timetableId === timetable.id &&
        e.dayOfWeek === dow &&
        e.slot === slot &&
        /* A section-less period is matched by asking for no section, never by
           two nulls comparing equal. */
        (section ? e.sectionId === section.id : e.sectionId === null)
    );

  /* ---------------------------------------------------------------- */
  /* Conducted classes and attendance                                  */
  /*                                                                   */
  /* All in the past, so `takeable` does not flip as the week advances */
  /* and a snapshot taken on Monday still matches one taken on Friday. */
  /* ---------------------------------------------------------------- */
  const dsaDates = [twoWeeksAgo(1), twoWeeksAgo(3), lastWeek(1), lastWeek(3)];

  const dsaSessions = [];
  for (const [i, dateKey] of dsaDates.entries()) {
    dsaSessions.push(
      await prisma.classSession.create({
        data: {
          subjectId: dsa.id,
          facultyId: ananya.id,
          date: toUTCDate(dateKey),
          dateKey,
          slot: 1,
          topic: ['Arrays', 'Linked lists', 'Stacks', 'Queues'][i],
          // One cancelled class, which must leave the denominator entirely.
          status: i === 2 ? 'cancelled' : 'completed',
        },
      })
    );
  }

  /*
   * Kabir joined late: he has no attendance rows for the first two classes.
   * Aarav and Diya attended everything except one absence each.
   */
  const joinedFrom = lastWeek(3);
  const marks = [];
  for (const session of dsaSessions) {
    if (session.status !== 'completed') continue;
    for (const student of students3A) {
      const isLate = student.rollNumber === '2024CS30003';
      if (isLate && session.dateKey < joinedFrom) continue;
      marks.push({
        sessionId: session.id,
        subjectId: dsa.id,
        studentId: student.id,
        // One deterministic absence, so percentages are not all 100%.
        status:
          student.rollNumber === '2024CS30002' && session.dateKey === dsaDates[0]
            ? 'absent'
            : 'present',
        markedById: ananya.id,
      });
    }
  }
  await prisma.attendance.createMany({ data: marks });

  for (const session of dsaSessions) {
    if (session.status !== 'completed') continue;
    const forSession = marks.filter((m) => m.sessionId === session.id);
    await prisma.classSession.update({
      where: { id: session.id },
      data: {
        presentCount: forSession.filter((m) => m.status === 'present').length,
        totalMarked: forSession.length,
      },
    });
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

  await prisma.scheduleChange.create({
    data: {
      kind: 'cancel',
      timetableId: tt3.id,
      date: toUTCDate(thisWeek(1)),
      dateKey: thisWeek(1),
      entryId: dsaMonday.id,
      sectionId: sec3A.id,
      subjectId: dsa.id,
      facultyId: ananya.id,
      reason: 'Lecturer on duty leave',
      createdById: admin.id,
      ...stamp(),
    },
  });
  await prisma.scheduleChange.create({
    data: {
      kind: 'move',
      timetableId: tt3.id,
      date: toUTCDate(thisWeek(2)),
      dateKey: thisWeek(2),
      entryId: dbmsTuesday.id,
      fromSlot: dbmsTuesday.slot,
      toDate: toUTCDate(thisWeek(4)),
      toDateKey: thisWeek(4),
      toSlot: 5,
      sectionId: sec3A.id,
      subjectId: dbms.id,
      facultyId: ananya.id,
      reason: 'Clashed with a guest lecture',
      createdById: admin.id,
      ...stamp(),
    },
  });
  await prisma.scheduleChange.create({
    data: {
      kind: 'extra',
      timetableId: tt3.id,
      date: toUTCDate(thisWeek(5)),
      dateKey: thisWeek(5),
      slot: 6,
      sectionId: sec3B.id,
      subjectId: os.id,
      facultyId: vikram.id,
      kindOfClass: 'lecture',
      reason: 'Revision before the mid-term',
      createdById: vikram.id,
      ...stamp(),
    },
  });

  /*
   * A stand-in holds one dated register, never the subject. Vikram covers a
   * single DSA class; his own subject list must still not contain DSA.
   */
  await prisma.attendanceDelegation.create({
    data: {
      subjectId: dsa.id,
      dateKey: thisWeek(3),
      slot: 1,
      facultyId: vikram.id,
      entryId: findEntry(tt3, 3, 1, sec3A).id,
      assignedById: admin.id,
      note: 'Covering while Dr Rao is at a conference',
    },
  });

  /* ---------------------------------------------------------------- */
  /* A swap waiting on an administrator                                */
  /* ---------------------------------------------------------------- */
  await prisma.swapRequest.create({
    data: {
      requestedById: ananya.id,
      counterpartyId: vikram.id,
      fromEntryId: dsaMonday.id,
      fromDateKey: nextWeek(1),
      fromSlot: dsaMonday.slot,
      toEntryId: osMonday.id,
      toDateKey: nextWeek(1),
      toSlot: osMonday.slot,
      reason: 'Clinic appointment',
      status: 'pending',
    },
  });

  /* ---------------------------------------------------------------- */
  /* Attachments — notes, an exam schedule and a leave application     */
  /*                                                                   */
  /* security-check §3 looks for a note with attachments that a given  */
  /* lecturer cannot see. Vikram's Section-B note is invisible to      */
  /* Ananya, which is what gives that check something to assert.       */
  /* ---------------------------------------------------------------- */
  const pdf = (label) => Buffer.from(`%PDF-1.4\n% fixture: ${label}\n`, 'utf8');

  const storeOne = async (label, filename) => {
    const data = pdf(label);
    const file = await prisma.file.create({
      data: { data, filename, contentType: 'application/pdf', size: data.length },
    });
    /* The shape an attachment row is created with, minus its owner. */
    return { fileId: file.id, filename, contentType: 'application/pdf', size: data.length };
  };

  const dsaHandout = await storeOne('dsa-notes', 'dsa-week-1.pdf');
  const osHandout = await storeOne('os-notes', 'os-scheduling.pdf');
  const examSheet = await storeOne('exam-sheet', 'midterm-timetable.pdf');
  const medicalNote = await storeOne('medical', 'medical-certificate.pdf');

  await prisma.note.create({
    data: {
      title: 'DSA — week 1 handout',
      description: 'Arrays and linked lists.',
      semester: 3,
      sectionId: sec3A.id,
      subjectId: dsa.id,
      uploadedById: ananya.id,
      attachments: { create: [dsaHandout] },
      ...stamp(),
    },
  });
  await prisma.note.create({
    data: {
      // Section B only — deliberately outside Ananya's cohort.
      title: 'OS — scheduling notes',
      description: 'Round-robin and priority scheduling.',
      semester: 3,
      sectionId: sec3B.id,
      subjectId: os.id,
      uploadedById: vikram.id,
      attachments: { create: [osHandout] },
      ...stamp(),
    },
  });

  await prisma.examSchedule.create({
    data: {
      title: 'Semester 3 mid-term',
      examType: 'mid-term',
      semester: 3,
      sectionId: null,
      instructions: 'Bring your ID card. No calculators.',
      publishedById: admin.id,
      papers: {
        create: [
          { subjectId: dsa.id, dateKey: nextWeek(1), startTime: '10:00', endTime: '12:00', room: 'H1' },
          { subjectId: dbms.id, dateKey: nextWeek(3), startTime: '10:00', endTime: '12:00', room: 'H1' },
          // A paper the system has no subject for — the free-text label fallback.
          {
            subjectId: null,
            label: 'Open Elective',
            dateKey: nextWeek(5),
            startTime: '14:00',
            endTime: '16:00',
            room: 'H2',
          },
        ],
      },
      attachments: { create: [examSheet] },
      ...stamp(),
    },
  });

  await prisma.leaveDocument.create({
    data: {
      studentId: students3A[1].id,
      sentAt: new Date(`${lastWeek(1)}T09:30:00.000Z`),
      regarding: 'Medical leave — viral fever',
      body: 'Requesting leave for two days, certificate attached.',
      leaveFrom: toUTCDate(lastWeek(1)),
      leaveTo: toUTCDate(lastWeek(2)),
      source: 'student',
      attachments: { create: [medicalNote] },
      ...stamp(),
    },
  });

  /* ---------------------------------------------------------------- */
  /* Notifications                                                     */
  /* ---------------------------------------------------------------- */
  await prisma.notification.create({
    data: {
      userId: vikram.id,
      type: 'swap:requested',
      title: 'Swap requested with you',
      message: 'Dr Ananya Rao would like to exchange periods.',
      link: '/swaps',
      requiresAction: true,
      createdById: ananya.id,
      ...stamp(),
    },
  });
  await prisma.notification.create({
    data: {
      userId: admin.id,
      type: 'swap:requested',
      title: 'Swap needs approval',
      message: 'Dr Ananya Rao → Mr Vikram Iyer.',
      link: '/swaps',
      requiresAction: true,
      createdById: ananya.id,
      ...stamp(),
    },
  });

  /* ---------------------------------------------------------------- */
  const counts = {
    sections: await prisma.section.count(),
    users: await prisma.user.count(),
    subjects: await prisma.subject.count(),
    enrollments: await prisma.enrollment.count(),
    sessions: await prisma.classSession.count(),
    attendance: await prisma.attendance.count(),
    timetables: await prisma.timetable.count(),
    entries: await prisma.timetableEntry.count(),
    changes: await prisma.scheduleChange.count(),
    delegations: await prisma.attendanceDelegation.count(),
    swaps: await prisma.swapRequest.count(),
    notes: await prisma.note.count(),
    exams: await prisma.examSchedule.count(),
    leave: await prisma.leaveDocument.count(),
    notifications: await prisma.notification.count(),
  };

  console.log('\n────────────────── FIXTURE LOADED ──────────────────');
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

  await prisma.$disconnect();
  process.exit(0);
}

fixture().catch(async (err) => {
  console.error('[fixture] Failed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
