import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { sectionLabel } from '../utils/section.js';
import ApiError from '../utils/ApiError.js';
import { getOverallForStudents, getStudentSummary } from '../services/attendanceService.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { parseCSVToObjects, STUDENT_COLUMNS } from '../utils/csv.js';
import { parseStudentsPDF } from '../services/pdfParser.js';
import { todayKey, addDays } from '../utils/date.js';
import { idOf, sameId } from '../utils/ids.js';
import { hashPassword } from '../utils/user.js';
import { notify } from '../services/notificationService.js';
import {
  purgeSection,
  purgeSubjects,
  purgeUsers,
  describePurge,
} from '../services/purgeService.js';

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const emailSchema = z.string().email('Enter a valid email address').transform((v) => v.toLowerCase());

export const createUserSchema = z
  .object({
    name: z.string().min(2, 'Name is required').max(120),
    email: emailSchema,
    role: z.enum(['student', 'faculty', 'admin']),
    password: z.string().min(6, 'Password must be at least 6 characters').optional(),
    department: z.string().max(120).optional().default('Computer Science'),
    // student
    rollNumber: z.string().max(30).optional(),
    batch: z.string().max(30).optional(),
    semester: z.number().int().min(1).max(10).optional(),
    sectionId: z.string().optional(),
    // faculty
    employeeId: z.string().max(30).optional(),
  })
  .refine((d) => d.role !== 'student' || Boolean(d.rollNumber), {
    message: 'A student needs a roll number',
    path: ['rollNumber'],
  })
  .refine((d) => d.role !== 'student' || Boolean(d.sectionId), {
    message: 'A student needs a section',
    path: ['sectionId'],
  });

export const updateUserSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  email: emailSchema.optional(),
  department: z.string().max(120).optional(),
  rollNumber: z.string().max(30).optional(),
  batch: z.string().max(30).optional(),
  semester: z.number().int().min(1).max(10).optional(),
  sectionId: z.string().nullable().optional(),
  employeeId: z.string().max(30).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(6).optional(),
});

export const sectionSchema = z.object({
  // Blank means the semester runs as one undivided batch.
  name: z.string().max(10).optional().default(''),
  semester: z.number().int().min(1).max(10),
  department: z.string().max(120).optional().default('Computer Science'),
});

export const updateSectionSchema = z.object({
  name: z.string().max(10).optional(),
  semester: z.number().int().min(1).max(10).optional(),
  department: z.string().max(120).optional(),
});

export const subjectSchema = z.object({
  code: z.string().min(2).max(12),
  name: z.string().min(2).max(120),
  semester: z.number().int().min(1).max(10),
  sectionId: z.string().min(1, 'Choose a section'),
  facultyId: z.string().min(1, 'Assign a lecturer'),
  credits: z.number().int().min(1).max(10).optional().default(3),
  plannedClasses: z.number().int().min(1).max(200).optional().default(30),
  minAttendance: z.number().int().min(0).max(100).optional().default(75),
  enrolAllInSection: z.boolean().optional().default(true),
});

export const importStudentsSchema = z.object({
  csv: z.string().min(1),
  semester: z.number().int().min(1).max(10),
  dryRun: z.boolean().optional().default(false),
});

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

/** Everything the admin home needs in one call. */
export const getOverview = asyncHandler(async (_req, res) => {
  const today = todayKey();
  const weekAgo = addDays(today, -7);

  const [
    students,
    faculty,
    admins,
    sections,
    subjects,
    published,
    drafts,
    pendingSwaps,
    sessionsThisWeek,
    changesThisWeek,
    unassignedStudents,
    subjectsNoFacultyList,
  ] = await Promise.all([
    prisma.user.count({ where: { role: 'student', isActive: true } }),
    prisma.user.count({ where: { role: 'faculty', isActive: true } }),
    prisma.user.count({ where: { role: 'admin', isActive: true } }),
    prisma.section.count({ where: { isActive: true } }),
    prisma.subject.count({ where: { isActive: true } }),
    prisma.timetable.findMany({ where: { status: 'published' }, orderBy: { semester: 'asc' } }),
    prisma.timetable.count({ where: { status: 'draft' } }),
    prisma.swapRequest.count({ where: { status: 'pending' } }),
    prisma.classSession.count({
      where: { status: 'completed', dateKey: { gte: weekAgo, lte: today } },
    }),
    prisma.scheduleChange.count({ where: { createdAt: { gte: new Date(`${weekAgo}T00:00:00Z`) } } }),
    prisma.user.count({ where: { role: 'student', isActive: true, sectionId: null } }),
    // The count alone sends an admin hunting through every semester for it —
    // naming it here is what the "Needs your attention" card shows instead.
    prisma.subject.findMany({
      where: { isActive: true, facultyId: null },
      select: { id: true, code: true, name: true, semester: true, section: { select: { name: true } } },
    }),
  ]);
  const subjectsNoFaculty = subjectsNoFacultyList.length;

  // Semesters that have cohorts but no live timetable — the gap an admin cares about.
  const allSections = await prisma.section.findMany({ where: { isActive: true } });
  const semestersWithSections = [...new Set(allSections.map((s) => s.semester))].sort();
  const publishedSemesters = new Set(published.map((t) => t.semester));
  const missingTimetables = semestersWithSections.filter((s) => !publishedSemesters.has(s));

  res.json({
    success: true,
    data: {
      people: { students, faculty, admins },
      academics: {
        sections,
        subjects,
        semesters: semestersWithSections,
        subjectsNoFaculty: subjectsNoFacultyList.map((s) => ({
          id: s.id,
          code: s.code,
          name: s.name,
          semester: s.semester,
          section: s.section?.name || null,
        })),
      },
      timetables: {
        published: published.map((t) => ({
          id: t.id,
          name: t.name,
          semester: t.semester,
          entryCount: t.entryCount,
          effectiveFrom: t.effectiveFromKey,
        })),
        drafts,
        missingTimetables,
      },
      activity: { sessionsThisWeek, changesThisWeek },
      todo: {
        pendingSwaps,
        unassignedStudents,
        subjectsNoFaculty,
        missingTimetables: missingTimetables.length,
      },
    },
  });
});

/* ------------------------------------------------------------------ */
/* People                                                             */
/* ------------------------------------------------------------------ */

const shapeUser = (u) => ({
  id: idOf(u),
  name: u.name,
  email: u.email,
  role: u.role,
  rollNumber: u.rollNumber || null,
  employeeId: u.employeeId || null,
  batch: u.batch || null,
  semester: u.semester || null,
  department: u.department || null,
  section: u.section ? { id: idOf(u.section), name: u.section.name } : null,
  isActive: u.isActive,
  createdAt: u.createdAt,
});

export const listUsers = asyncHandler(async (req, res) => {
  const { role, section, semester, q, deactivatedOnly, withAttendance, below } = req.query;

  const where = {};
  if (role) where.role = role;
  if (section) where.sectionId = section;
  if (semester) where.semester = Number(semester);
  // Two lists, never mixed: either everyone active, or everyone deactivated —
  // "show deactivated" means exactly that, not "active plus deactivated".
  where.isActive = deactivatedOnly !== 'true';
  if (q) {
    /*
     * LIKE metacharacters, not regex ones. Prisma's `contains` builds an ILIKE
     * pattern and escapes nothing, so an unescaped "%" would match every row
     * and "_" any single character. The backslash is replaced first, or it
     * would go on to escape the escapes added after it.
     */
    const term = String(q).replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const like = { contains: term, mode: 'insensitive' };
    where.OR = [{ name: like }, { email: like }, { rollNumber: like }, { employeeId: like }];
  }

  const users = await prisma.user.findMany({
    where,
    include: { section: { select: { id: true, name: true } } },
    /*
     * rollNumber is null for every lecturer, and the default puts those last.
     * With a 500-row cap that decides *which rows come back*, not merely their
     * order — so where the nulls go is stated rather than inherited.
     */
    orderBy: [{ role: 'asc' }, { rollNumber: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
    take: 500,
  });

  /*
   * Attendance is attached only when asked for. It costs an aggregate over
   * every mark, which the ordinary People list has no use for — but the
   * shortage view is the whole point of that list at the end of a semester.
   */
  const wantsAttendance = withAttendance === 'true' || below !== undefined;
  if (!wantsAttendance) {
    return res.json({ success: true, data: users.map(shapeUser) });
  }

  const students = users.filter((u) => u.role === 'student');
  const overall = await getOverallForStudents(students.map(idOf));

  const threshold = below === undefined || below === '' ? null : Number(below);
  let data = users.map((u) => ({
    ...shapeUser(u),
    attendance: u.role === 'student' ? overall[idOf(u)] || null : null,
  }));

  if (threshold !== null && Number.isFinite(threshold)) {
    /*
     * A student with no classes held yet has no percentage — not a zero. They
     * are not in shortage, they simply have no record, so the shortage filter
     * must not sweep them up.
     */
    data = data.filter(
      (u) => u.attendance?.percentage !== null && u.attendance?.percentage < threshold
    );
    data.sort((a, b) => (a.attendance?.percentage ?? 0) - (b.attendance?.percentage ?? 0));
  }

  res.json({ success: true, data });
});

/**
 * One student, everything an administrator needs when deciding on a shortage:
 * who they are, how their attendance actually stands, and what they sent in.
 */
export const getStudentProfile = asyncHandler(async (req, res) => {
  const student = await prisma.user.findFirst({
    where: { id: req.params.studentId, role: 'student' },
    include: { section: { select: { id: true, name: true } } },
  });
  if (!student) throw ApiError.notFound('Student not found');

  const [summary, documentCount] = await Promise.all([
    getStudentSummary(student.id),
    // Only the count was ever used; reading every document to call .length on
    // it was work the database can do without sending any rows back.
    prisma.leaveDocument.count({ where: { studentId: student.id } }),
  ]);

  res.json({
    success: true,
    data: {
      student: shapeUser(student),
      ...summary,
      documentCount,
    },
  });
});

/** Faculty with their teaching load — used when assigning a subject. */
export const listFacultyWithLoad = asyncHandler(async (_req, res) => {
  const faculty = await prisma.user.findMany({
    where: { role: 'faculty', isActive: true },
    orderBy: { name: 'asc' },
  });
  /*
   * Sorted, because this list is rendered verbatim under each lecturer's
   * name: unsorted, the database's natural order put the same lecturer's
   * subjects in a different sequence on different machines, which reads as
   * the data having changed when nothing has. Code is the label an admin
   * scans for; section breaks the tie between two offerings sharing one code.
   */
  const subjects = await prisma.subject.findMany({
    where: { isActive: true },
    orderBy: [{ code: 'asc' }, { sectionId: { sort: 'asc', nulls: 'first' } }],
    include: { section: { select: { name: true } } },
  });
  const entries = await prisma.timetableEntry.findMany();

  res.json({
    success: true,
    data: faculty.map((f) => {
      const mine = subjects.filter((s) => sameId(s.facultyId, f));
      return {
        id: f.id,
        name: f.name,
        email: f.email,
        employeeId: f.employeeId,
        subjectCount: mine.length,
        periodsPerWeek: entries.filter((e) => sameId(e.facultyId, f)).length,
        subjects: mine.map((s) => `${s.code} · Sec ${s.section?.name ?? '—'}`),
      };
    }),
  });
});

export const createUser = asyncHandler(async (req, res) => {
  const { sectionId, password, ...rest } = req.body;

  if (await prisma.user.findUnique({ where: { email: rest.email } })) {
    throw ApiError.conflict(`${rest.email} is already registered`);
  }

  let section = null;
  if (rest.role === 'student') {
    section = sectionId ? await prisma.section.findUnique({ where: { id: sectionId } }) : null;
    if (!section) throw ApiError.badRequest('That section does not exist');
  }

  // A sensible default so an admin can add people without inventing passwords.
  const defaults = { student: 'student123', faculty: 'faculty123', admin: 'admin123' };

  // New students join every subject their section already runs.
  let enrolled = 0;
  /*
   * The account and its enrolments in one transaction: a student who exists
   * but is on no register reads as a working import right up until a lecturer
   * opens the sheet and finds them missing.
   */
  const user = await prisma.$transaction(async (tx) => {
    const person = await tx.user.create({
      data: {
        ...rest,
        password: await hashPassword(password || defaults[rest.role]),
        sectionId: section?.id || null,
        semester: rest.role === 'student' ? (rest.semester ?? section.semester) : rest.semester,
      },
      include: { section: { select: { id: true, name: true } } },
    });

    if (person.role === 'student') {
      const subjects = await tx.subject.findMany({
        where: { sectionId: section.id, isActive: true },
        select: { id: true },
      });
      if (subjects.length) {
        /*
         * skipDuplicates rather than a swallowed error, so the one collision
         * that is expected — a student already enrolled — is ignored without
         * also discarding every other reason this could fail.
         */
        await tx.enrollment.createMany({
          data: subjects.map((sub) => ({ studentId: person.id, subjectId: sub.id })),
          skipDuplicates: true,
        });
        enrolled = subjects.length;
      }
    }
    return person;
  });

  await notify([user.id], {
    type: 'account:created',
    title: 'Welcome to Sitare University',
    message: `Your ${user.role} account is ready. ${password ? '' : `Temporary password: ${defaults[user.role]} — please change it.`}`,
    link: '/',
    createdBy: idOf(req.user),
  });

  res.status(201).json({
    success: true,
    message: `${user.name} added${enrolled ? ` and enrolled in ${enrolled} subjects` : ''}`,
    data: shapeUser(user),
  });
});

export const updateUser = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.userId } });
  if (!user) throw ApiError.notFound('User not found');

  const { sectionId, password, ...rest } = req.body;

  if (rest.email && rest.email !== user.email) {
    const taken = await prisma.user.findFirst({
      where: { email: rest.email, id: { not: user.id } },
    });
    if (taken) throw ApiError.conflict(`${rest.email} is already registered`);
  }

  // Guard against locking everyone out of administration.
  if (rest.isActive === false && user.role === 'admin') {
    const others = await prisma.user.count({
      where: { role: 'admin', isActive: true, id: { not: user.id } },
    });
    if (others === 0) throw ApiError.badRequest('This is the last active admin account');
  }

  const data = { ...rest };
  if (sectionId !== undefined) data.sectionId = sectionId || null;
  if (password) data.password = await hashPassword(password);

  const fresh = await prisma.user.update({
    where: { id: user.id },
    data,
    include: { section: { select: { id: true, name: true } } },
  });
  res.json({ success: true, message: `${fresh.name} updated`, data: shapeUser(fresh) });
});

/** Suspend or restore access without removing anything. */
export const setUserStatus = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.userId } });
  if (!user) throw ApiError.notFound('User not found');

  const active = Boolean(req.body?.isActive);

  // The only refusal left: locking the last admin out is unrecoverable —
  // nobody would be able to sign in and undo it, including whoever did it.
  if (!active && user.role === 'admin') {
    const others = await prisma.user.count({
      where: { role: 'admin', isActive: true, id: { not: user.id } },
    });
    if (others === 0) throw ApiError.badRequest('This is the last active admin account');
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { isActive: active },
  });
  res.json({
    success: true,
    message: `${updated.name} ${active ? 'reactivated' : 'deactivated'}`,
    data: { id: updated.id, isActive: updated.isActive },
  });
});

/**
 * Delete a person outright, with their enrolments, attendance and swap
 * requests. A lecturer's subjects and timetable periods survive them, left
 * unassigned so they can be handed to somebody else.
 */
export const deleteUser = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.userId } });
  if (!user) throw ApiError.notFound('User not found');

  if (user.role === 'admin') {
    const others = await prisma.user.count({ where: { role: 'admin', id: { not: user.id } } });
    if (others === 0) {
      throw ApiError.badRequest(
        'This is the only admin account — deleting it would leave nobody able to administer the system'
      );
    }
  }

  const { name, role } = user;
  const counts = await purgeUsers([user.id]);
  const detail = describePurge({ ...counts, users: 0 });

  res.json({
    success: true,
    message: `${name} (${role}) deleted${detail ? ` — removed ${detail}` : ''}`,
    data: counts,
  });
});

/** Bulk-add students from a CSV: name, email, rollNumber, section[, batch]. */
export const importStudents = asyncHandler(async (req, res) => {
  const semester = Number(req.body.semester);
  const dryRun = req.body.dryRun === true || req.body.dryRun === 'true';

  if (!Number.isInteger(semester)) throw ApiError.badRequest('Choose a semester');

  // A PDF roster, an uploaded CSV, or pasted text — all end up as the same rows.
  let records;
  let source;
  if (req.file) {
    const isCsv =
      /csv/i.test(req.file.mimetype) || req.file.originalname.toLowerCase().endsWith('.csv');
    if (isCsv) {
      ({ records } = parseCSVToObjects(req.file.buffer.toString('utf-8'), STUDENT_COLUMNS));
      source = 'csv';
    } else {
      try {
        records = await parseStudentsPDF(req.file.buffer);
        source = 'pdf';
      } catch (err) {
        throw ApiError.badRequest(err.message);
      }
    }
  } else if (req.body?.csv?.trim()) {
    ({ records } = parseCSVToObjects(req.body.csv, STUDENT_COLUMNS));
    source = 'csv';
  } else {
    throw ApiError.badRequest('Attach a student list PDF or CSV, or paste the rows');
  }

  if (!records.length) throw ApiError.badRequest('No student rows could be read');

  const sections = await prisma.section.findMany({
    where: { isActive: true, semester: Number(semester) },
  });
  const byName = new Map(sections.map((s) => [s.name.toUpperCase(), s]));
  if (!sections.length) {
    throw ApiError.badRequest(`No sections exist for semester ${semester}`);
  }

  /*
   * A cohort is usually imported into one known section, so the admin picks it
   * once here instead of repeating it on every row. That reduces the file to
   * the three things that actually differ per student — roll number, name and
   * email — and any other column it happens to carry is simply ignored.
   */
  const fixedSection = req.body.sectionId
    ? sections.find((s) => sameId(s, req.body.sectionId))
    : null;
  if (req.body.sectionId && !fixedSection) {
    throw ApiError.badRequest('That section does not belong to the chosen semester');
  }

  /*
   * A real roster of a hundred students usually has two or three bad rows — a
   * stray space in an address, a duplicate, someone already registered. Those
   * rows are skipped and listed rather than failing the whole file, because
   * refusing ninety-seven good students over three typos helps nobody. What is
   * never done is inventing data: a row that cannot be trusted is left out.
   */
  const skipped = [];
  const rows = [];
  const seenEmail = new Set();
  const seenRoll = new Set();

  for (const r of records) {
    const line = r.__line;
    const name = (r.name || '').trim();
    // Cell layout can leave a space inside an address ("su _24027@…"), which
    // is a formatting artefact rather than part of the address.
    const email = (r.email || '').replace(/\s+/g, '').toLowerCase();
    const rollNumber = (r.rollnumber || r.roll || '').replace(/\s+/g, '').toUpperCase();
    const sectionName = (r.section || '').trim().toUpperCase();
    const batch = (r.batch || '').trim();

    const skip = (message) => skipped.push({ line, who: name || email || rollNumber, message });

    // With a section chosen above, the file need not mention one at all.
    const section = fixedSection || byName.get(sectionName);

    if (!name) skip('no name');
    else if (!rollNumber) skip('no roll number');
    else if (!/^\S+@\S+\.\S+$/.test(email)) skip(`unusable email "${(r.email || '').trim()}"`);
    else if (!section) {
      skip(
        sectionName
          ? `unknown section "${r.section}"`
          : 'no section — choose one above, or add a section column'
      );
    } else if (seenEmail.has(email)) skip(`${email} appears twice in the file`);
    else if (seenRoll.has(rollNumber)) skip(`roll number ${rollNumber} appears twice in the file`);
    else {
      seenEmail.add(email);
      seenRoll.add(rollNumber);
      rows.push({ name, email, rollNumber, batch, section, line });
    }
  }

  // Anyone already on the system is skipped too, not duplicated.
  const clashes = await prisma.user.findMany({
    where: {
      OR: [
        { email: { in: rows.map((r) => r.email) } },
        { rollNumber: { in: rows.map((r) => r.rollNumber) } },
      ],
    },
    select: { email: true, rollNumber: true },
  });

  const takenEmail = new Set(clashes.map((c) => c.email));
  const takenRoll = new Set(clashes.map((c) => c.rollNumber));
  const importable = rows.filter((r) => {
    if (takenEmail.has(r.email) || takenRoll.has(r.rollNumber)) {
      skipped.push({ line: r.line, who: r.name, message: 'already registered' });
      return false;
    }
    return true;
  });

  if (dryRun) {
    return res.json({
      success: true,
      data: {
        valid: importable.length > 0,
        count: importable.length,
        source,
        readCount: records.length,
        // Shown back so the admin can confirm the PDF was read correctly.
        section: fixedSection ? sectionLabel(fixedSection) : null,
        preview: importable.slice(0, 8).map((r) => ({
          name: r.name,
          email: r.email,
          rollNumber: r.rollNumber,
          section: sectionLabel(r.section),
        })),
        skipped,
        errors: importable.length ? [] : skipped,
        dryRun: true,
      },
    });
  }

  /*
   * Hashed once for the whole file. bcrypt is deliberately slow, and every row
   * gets the same default password, so hashing per student would make a
   * hundred-row import take a hundred times longer for an identical result.
   */
  const defaultPassword = await hashPassword('student123');

  /* Which subjects a section runs does not change while the file is read. */
  const subjectsBySection = new Map();
  const subjectsFor = async (sectionId) => {
    if (!subjectsBySection.has(sectionId)) {
      subjectsBySection.set(
        sectionId,
        await prisma.subject.findMany({ where: { sectionId, isActive: true }, select: { id: true } })
      );
    }
    return subjectsBySection.get(sectionId);
  };

  const created = [];
  for (const r of importable) {
    const subjects = await subjectsFor(r.section.id);
    /*
     * Account and enrolments together. A student created but not enrolled is
     * invisible to every register in their section and looks like a roster
     * that imported cleanly — the worst kind of failure, because nobody goes
     * looking for it.
     */
    const user = await prisma.$transaction(async (tx) => {
      const person = await tx.user.create({
        data: {
          name: r.name,
          email: r.email,
          password: defaultPassword,
          role: 'student',
          rollNumber: r.rollNumber,
          batch: r.batch || null,
          semester: Number(semester),
          sectionId: r.section.id,
          department: r.section.department,
        },
      });
      if (subjects.length) {
        await tx.enrollment.createMany({
          data: subjects.map((sub) => ({ studentId: person.id, subjectId: sub.id })),
          skipDuplicates: true,
        });
      }
      return person;
    });
    created.push(user);
  }

  res.status(201).json({
    success: true,
    message:
      `${created.length} students added with the default password` +
      (skipped.length ? `, ${skipped.length} row${skipped.length === 1 ? '' : 's'} skipped` : ''),
    data: { count: created.length, skipped, errors: [] },
  });
});

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

export const listSections = asyncHandler(async (_req, res) => {
  const sections = await prisma.section.findMany({ orderBy: [{ semester: 'asc' }, { name: 'asc' }] });
  const ids = sections.map(idOf);

  const [studentRows, subjectRows] = await Promise.all([
    prisma.user.groupBy({
      by: ['sectionId'],
      where: { role: 'student', isActive: true, sectionId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.subject.groupBy({
      by: ['sectionId'],
      where: { isActive: true, sectionId: { in: ids } },
      _count: { _all: true },
    }),
  ]);
  const students = Object.fromEntries(studentRows.map((r) => [r.sectionId, r._count._all]));
  const subjects = Object.fromEntries(subjectRows.map((r) => [r.sectionId, r._count._all]));

  res.json({
    success: true,
    data: sections.map((s) => ({
      id: s.id,
      name: s.name,
      label: sectionLabel(s),
      semester: s.semester,
      department: s.department,
      isActive: s.isActive,
      studentCount: students[idOf(s)] || 0,
      subjectCount: subjects[idOf(s)] || 0,
    })),
  });
});

export const createSection = asyncHandler(async (req, res) => {
  const { semester, department } = req.body;
  const raw = (req.body.name || '').trim();

  /*
   * "A, B" names two cohorts, not one section called "A, B" — a section is
   * always a single roster. Splitting on commas here is what lets an admin
   * create both sections in one step instead of opening this dialog twice;
   * one plain name (or a blank one, for an undivided semester) behaves
   * exactly as before.
   */
  const names = [...new Set(raw.split(',').map((n) => n.trim().toUpperCase()).filter(Boolean))];

  if (names.length > 1) {
    const conflicts = await prisma.section.findMany({
      where: { name: { in: names }, semester, department },
      select: { name: true },
    });
    if (conflicts.length) {
      const list = conflicts.map((c) => c.name).join(', ');
      throw ApiError.conflict(
        `Section${conflicts.length > 1 ? 's' : ''} ${list} already exist${conflicts.length > 1 ? '' : 's'} in semester ${semester}`
      );
    }

    /*
     * createMany returns only a count, and the response names what it made, so
     * the rows are read back. A transaction of creates would return them
     * directly but would also roll the whole set back over one collision —
     * which the check above has already ruled out.
     */
    await prisma.section.createMany({ data: names.map((name) => ({ name, semester, department })) });
    const created = await prisma.section.findMany({
      where: { name: { in: names }, semester, department },
      orderBy: { name: 'asc' },
    });
    return res.status(201).json({
      success: true,
      message: `${created.map((s) => sectionLabel(s)).join(', ')} created for semester ${semester}`,
      data: created.map((s) => ({ id: s.id, name: s.name, semester: s.semester })),
    });
  }

  const name = names[0] || '';
  const exists = await prisma.section.findUnique({
    where: { name_semester_department: { name, semester, department } },
  });
  if (exists) {
    throw ApiError.conflict(
      name
        ? `Section ${name} already exists in semester ${semester}`
        : `Semester ${semester} already has an undivided batch. Give this one a name to run two cohorts side by side.`
    );
  }

  const section = await prisma.section.create({ data: { name, semester, department } });
  res.status(201).json({
    success: true,
    message: `${sectionLabel(section)} created for semester ${semester}`,
    data: { id: section.id, name: section.name, semester: section.semester },
  });
});

/**
 * Rename a section, or move it to another semester.
 *
 * A section's semester is what places its subjects and students in the
 * academic year, so moving one carries its subjects and students with it —
 * leaving them behind would strand a Semester-3 cohort inside a Semester-7
 * section and break every lookup that scopes by semester.
 */
export const updateSection = asyncHandler(async (req, res) => {
  const section = await prisma.section.findUnique({ where: { id: req.params.sectionId } });
  if (!section) throw ApiError.notFound('Section not found');

  // An explicit empty name clears it, turning the cohort into the whole year.
  const name =
    req.body.name === undefined ? section.name : req.body.name.trim().toUpperCase();
  const semester = req.body.semester ?? section.semester;
  const department = req.body.department?.trim() || section.department;

  const clash = await prisma.section.findFirst({
    where: { name, semester, department, id: { not: section.id } },
  });
  if (clash) {
    throw ApiError.conflict(
      name
        ? `Section ${name} already exists in semester ${semester}`
        : `Semester ${semester} already has an undivided batch`
    );
  }

  const movedSemester = semester !== section.semester;
  const previous = { label: sectionLabel(section), semester: section.semester };

  const updated = await prisma.section.update({
    where: { id: section.id },
    data: { name, semester, department },
  });

  const moved = { subjects: 0, students: 0 };
  if (movedSemester) {
    moved.subjects = (
      await prisma.subject.updateMany({
        where: { sectionId: section.id },
        data: { semester, department },
      })
    ).count;
    moved.students = (
      await prisma.user.updateMany({
        where: { role: 'student', sectionId: section.id },
        data: { semester },
      })
    ).count;
  }

  const detail = movedSemester
    ? ` — moved from semester ${previous.semester}${
        moved.subjects || moved.students
          ? `, taking ${moved.subjects} subjects and ${moved.students} students`
          : ''
      }`
    : '';

  res.json({
    success: true,
    message: `${previous.label} updated to ${sectionLabel(updated)}${detail}`,
    data: { id: updated.id, name, semester, department, moved },
  });
});

/** Deletes the cohort outright, along with everything that belonged to it. */
export const deleteSection = asyncHandler(async (req, res) => {
  const section = await prisma.section.findUnique({ where: { id: req.params.sectionId } });
  if (!section) throw ApiError.notFound('Section not found');

  const label = sectionLabel(section);
  const counts = await purgeSection(section);
  const detail = describePurge(counts);

  res.json({
    success: true,
    message: `${label} deleted${detail ? ` — removed ${detail}` : ''}`,
    data: counts,
  });
});

/* ------------------------------------------------------------------ */
/* Subjects                                                            */
/* ------------------------------------------------------------------ */

export const listSubjectsAdmin = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.semester) where.semester = Number(req.query.semester);
  if (req.query.section) where.sectionId = req.query.section;

  const subjects = await prisma.subject.findMany({
    where,
    include: {
      faculty: { select: { id: true, name: true, email: true } },
      section: { select: { id: true, name: true, semester: true } },
    },
    orderBy: [{ semester: 'asc' }, { code: 'asc' }],
  });

  const ids = subjects.map(idOf);
  const semesters = [...new Set(subjects.map((s) => s.semester))];

  /*
   * A period can be handed to someone other than the subject's own lecturer
   * for just that day ("apply to this period" in the timetable's correction
   * dialog) — e.g. one lecturer covers Tuesday/Wednesday and another covers
   * Thursday. The list below has room for only one name per subject, so it
   * must show everyone who actually teaches a live period of it, not just
   * whoever `Subject.faculty` happens to say — otherwise the person covering
   * Thursday is invisible here even though the timetable shows them plainly.
   * Scoped to the live published grid only: a draft or archived version's
   * overrides say nothing about who teaches the subject today.
   */
  const publishedTimetables = await prisma.timetable.findMany({
    where: { semester: { in: semesters }, status: 'published' },
    select: { id: true },
  });
  const publishedIds = publishedTimetables.map(idOf);

  const [enrolRows, sessionRows, entryFacultyRows] = await Promise.all([
    prisma.enrollment.groupBy({
      by: ['subjectId'],
      where: { subjectId: { in: ids }, isActive: true },
      _count: { _all: true },
    }),
    prisma.classSession.groupBy({
      by: ['subjectId'],
      where: { subjectId: { in: ids }, status: 'completed' },
      _count: { _all: true },
    }),
    publishedIds.length
      ? prisma.timetableEntry.findMany({
          where: {
            subjectId: { in: ids },
            timetableId: { in: publishedIds },
            facultyId: { not: null },
          },
          select: { subjectId: true, faculty: { select: { id: true, name: true } } },
        })
      : [],
  ]);
  const enrolled = Object.fromEntries(enrolRows.map((r) => [r.subjectId, r._count._all]));
  const conducted = Object.fromEntries(sessionRows.map((r) => [r.subjectId, r._count._all]));

  // subjectId -> Map(facultyId -> name), built from actual per-period overrides.
  const coveringFaculty = new Map();
  for (const row of entryFacultyRows) {
    if (!row.faculty) continue;
    const sid = row.subjectId;
    if (!coveringFaculty.has(sid)) coveringFaculty.set(sid, new Map());
    coveringFaculty.get(sid).set(idOf(row.faculty), row.faculty.name);
  }

  res.json({
    success: true,
    data: subjects.map((s) => {
      const sid = idOf(s);
      // The subject's own lecturer first, then anyone else who covers a
      // period of it, deduplicated by id — never a hard-coded name, always
      // whatever the timetable actually says right now.
      const names = new Map();
      if (s.faculty) names.set(idOf(s.faculty), s.faculty.name);
      for (const [fid, name] of coveringFaculty.get(sid) || []) names.set(fid, name);

      return {
        id: sid,
        code: s.code,
        name: s.name,
        semester: s.semester,
        credits: s.credits,
        plannedClasses: s.plannedClasses,
        minAttendance: s.minAttendance,
        isActive: s.isActive,
        section: s.section ? { id: s.section.id, name: s.section.name } : null,
        faculty: s.faculty ? { id: s.faculty.id, name: s.faculty.name } : null,
        // Ready-to-display label — "Mr Ankit Mehta" when only one person
        // teaches it, "Mr Ankit Mehta/Dr Anuja Agarwal" when more than one
        // actually does, null when the subject has no lecturer at all.
        facultyLabel: names.size ? [...names.values()].join('/') : null,
        enrolledCount: enrolled[sid] || 0,
        conducted: conducted[sid] || 0,
      };
    }),
  });
});

export const createSubject = asyncHandler(async (req, res) => {
  const { code, name, semester, sectionId, facultyId, enrolAllInSection, ...rest } = req.body;

  const [section, faculty] = await Promise.all([
    sectionId ? prisma.section.findUnique({ where: { id: sectionId } }) : null,
    facultyId ? prisma.user.findUnique({ where: { id: facultyId } }) : null,
  ]);
  if (!section) throw ApiError.badRequest('That section does not exist');
  if (!faculty || faculty.role !== 'faculty') throw ApiError.badRequest('Choose a faculty member');
  if (section.semester !== semester) {
    throw ApiError.badRequest(
      `Section ${section.name} belongs to semester ${section.semester}, not ${semester}`
    );
  }

  const clash = await prisma.subject.findFirst({
    where: { code: code.toUpperCase(), sectionId: section.id },
  });
  if (clash) {
    throw ApiError.conflict(`${code.toUpperCase()} already exists for section ${section.name}`);
  }

  const subject = await prisma.subject.create({
    data: {
      ...rest,
      // Uppercased here as well as by the database CHECK: the constraint makes
      // a miss loud, this makes there be nothing to miss.
      code: code.toUpperCase(),
      name,
      semester,
      sectionId: section.id,
      facultyId: faculty.id,
      department: section.department,
    },
  });

  let enrolled = 0;
  if (enrolAllInSection) {
    const students = await prisma.user.findMany({
      where: { role: 'student', sectionId: section.id, isActive: true },
      select: { id: true },
    });
    if (students.length) {
      await prisma.enrollment.createMany({
        data: students.map((st) => ({ studentId: st.id, subjectId: subject.id })),
        skipDuplicates: true,
      });
      enrolled = students.length;
    }
  }

  await notify([faculty.id], {
    type: 'subject:assigned',
    title: 'Subject assigned to you',
    message: `You now teach ${subject.code} ${subject.name} for Section ${section.name}.`,
    link: '/',
    createdBy: idOf(req.user),
  });

  res.status(201).json({
    success: true,
    message: `${subject.code} created${enrolled ? ` with ${enrolled} students enrolled` : ''}`,
    data: { id: subject.id, code: subject.code, enrolled },
  });
});

export const updateSubject = asyncHandler(async (req, res) => {
  const subject = await prisma.subject.findUnique({ where: { id: req.params.subjectId } });
  if (!subject) throw ApiError.notFound('Subject not found');

  const { facultyId, ...rest } = req.body;
  // A departing lecturer leaves a subject with no faculty (see purgeUsers) —
  // that is not a real id, so it must never be cast into a query filter below.
  const previous = subject.facultyId || null;
  const data = { ...rest };

  if (facultyId && facultyId !== previous) {
    const faculty = await prisma.user.findUnique({ where: { id: facultyId } });
    if (!faculty || faculty.role !== 'faculty') throw ApiError.badRequest('Choose a faculty member');
    data.facultyId = faculty.id;

    // The timetable stores the lecturer per period; keep it in step, but leave
    // any period deliberately overridden to somebody else alone. Nothing to
    // reconcile if the subject had no previous lecturer to begin with.
    if (previous) {
      await prisma.timetableEntry.updateMany({
        where: { subjectId: subject.id, facultyId: previous },
        data: { facultyId: faculty.id },
      });
    }

    await notify([faculty.id], {
      type: 'subject:assigned',
      title: 'Subject assigned to you',
      message: `You now teach ${subject.code} ${subject.name}.`,
      link: '/',
      createdBy: idOf(req.user),
    });
  }

  const updated = await prisma.subject.update({ where: { id: subject.id }, data });

  res.json({ success: true, message: `${updated.code} updated`, data: { id: updated.id } });
});

/** Deletes the subject and its register, however much history it holds. */
export const deleteSubject = asyncHandler(async (req, res) => {
  const subject = await prisma.subject.findUnique({ where: { id: req.params.subjectId } });
  if (!subject) throw ApiError.notFound('Subject not found');

  const code = subject.code;
  const counts = await purgeSubjects([subject.id]);
  const detail = describePurge(counts);

  res.json({
    success: true,
    message: `${code} deleted${detail ? ` — removed ${detail}` : ''}`,
    data: counts,
  });
});

/* ------------------------------------------------------------------ */
/* Enrolment                                                           */
/* ------------------------------------------------------------------ */

export const getSubjectRosterAdmin = asyncHandler(async (req, res) => {
  const subject = await prisma.subject.findUnique({
    where: { id: req.params.subjectId },
    include: { section: { select: { id: true, name: true, semester: true } } },
  });
  if (!subject) throw ApiError.notFound('Subject not found');

  const [enrolments, sectionStudents] = await Promise.all([
    prisma.enrollment.findMany({
      where: { subjectId: subject.id, isActive: true },
      include: { student: { select: { id: true, name: true, rollNumber: true, email: true } } },
    }),
    /*
     * A subject with no section belongs to the whole year and has no roster to
     * offer here. Asking for `sectionId: undefined` would drop the clause and
     * return every student in the institute, so the empty answer is explicit.
     */
    subject.sectionId
      ? prisma.user.findMany({
          where: { role: 'student', sectionId: subject.sectionId, isActive: true },
          select: { id: true, name: true, rollNumber: true, email: true },
          orderBy: { rollNumber: { sort: 'asc', nulls: 'first' } },
        })
      : [],
  ]);

  const enrolledIds = new Set(enrolments.map((e) => e.studentId));

  res.json({
    success: true,
    data: {
      subject: { id: subject.id, code: subject.code, name: subject.name },
      enrolled: enrolments
        .filter((e) => e.student)
        .map((e) => ({
          id: e.student.id,
          name: e.student.name,
          rollNumber: e.student.rollNumber,
        }))
        .sort((a, b) => (a.rollNumber || '').localeCompare(b.rollNumber || '')),
      available: sectionStudents
        .filter((st) => !enrolledIds.has(st.id))
        .map((st) => ({ id: st.id, name: st.name, rollNumber: st.rollNumber })),
    },
  });
});

export const setEnrolment = asyncHandler(async (req, res) => {
  const subject = await prisma.subject.findUnique({ where: { id: req.params.subjectId } });
  if (!subject) throw ApiError.notFound('Subject not found');

  const { studentIds, action } = req.body || {};
  if (!Array.isArray(studentIds) || !studentIds.length) {
    throw ApiError.badRequest('Select at least one student');
  }

  if (action === 'remove') {
    await prisma.enrollment.deleteMany({
      where: { subjectId: subject.id, studentId: { in: studentIds } },
    });
    return res.json({ success: true, message: `${studentIds.length} students removed` });
  }

  await prisma.enrollment.createMany({
    data: studentIds.map((studentId) => ({ studentId, subjectId: subject.id })),
    skipDuplicates: true,
  });

  res.json({ success: true, message: `${studentIds.length} students enrolled` });
});
