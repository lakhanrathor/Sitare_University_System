import { z } from 'zod';
import User from '../models/User.js';
import Section, { sectionLabel } from '../models/Section.js';
import Subject from '../models/Subject.js';
import Enrollment from '../models/Enrollment.js';
import ClassSession from '../models/ClassSession.js';
import Attendance from '../models/Attendance.js';
import SwapRequest from '../models/SwapRequest.js';
import ScheduleChange from '../models/ScheduleChange.js';
import Timetable from '../models/Timetable.js';
import TimetableEntry from '../models/TimetableEntry.js';
import LeaveDocument from '../models/LeaveDocument.js';
import ApiError from '../utils/ApiError.js';
import { getOverallForStudents, getStudentSummary } from '../services/attendanceService.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { parseCSVToObjects } from '../utils/csv.js';
import { parseStudentsPDF } from '../services/pdfParser.js';
import { todayKey, addDays } from '../utils/date.js';
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
    User.countDocuments({ role: 'student', isActive: true }),
    User.countDocuments({ role: 'faculty', isActive: true }),
    User.countDocuments({ role: 'admin', isActive: true }),
    Section.countDocuments({ isActive: true }),
    Subject.countDocuments({ isActive: true }),
    Timetable.find({ status: 'published' }).sort({ semester: 1 }).lean(),
    Timetable.countDocuments({ status: 'draft' }),
    SwapRequest.countDocuments({ status: 'pending' }),
    ClassSession.countDocuments({ status: 'completed', dateKey: { $gte: weekAgo, $lte: today } }),
    ScheduleChange.countDocuments({ createdAt: { $gte: new Date(`${weekAgo}T00:00:00Z`) } }),
    User.countDocuments({ role: 'student', isActive: true, section: null }),
    // The count alone sends an admin hunting through every semester for it —
    // naming it here is what the "Needs your attention" card shows instead.
    Subject.find({ isActive: true, faculty: null })
      .select('code name semester')
      .populate('section', 'name')
      .lean(),
  ]);
  const subjectsNoFaculty = subjectsNoFacultyList.length;

  // Semesters that have cohorts but no live timetable — the gap an admin cares about.
  const allSections = await Section.find({ isActive: true }).lean();
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
          id: String(s._id),
          code: s.code,
          name: s.name,
          semester: s.semester,
          section: s.section?.name || null,
        })),
      },
      timetables: {
        published: published.map((t) => ({
          id: String(t._id),
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
  id: String(u._id),
  name: u.name,
  email: u.email,
  role: u.role,
  rollNumber: u.rollNumber || null,
  employeeId: u.employeeId || null,
  batch: u.batch || null,
  semester: u.semester || null,
  department: u.department || null,
  section: u.section ? { id: String(u.section._id || u.section), name: u.section.name } : null,
  isActive: u.isActive,
  createdAt: u.createdAt,
});

export const listUsers = asyncHandler(async (req, res) => {
  const { role, section, semester, q, deactivatedOnly, withAttendance, below } = req.query;

  const filter = {};
  if (role) filter.role = role;
  if (section) filter.section = section;
  if (semester) filter.semester = Number(semester);
  // Two lists, never mixed: either everyone active, or everyone deactivated —
  // "show deactivated" means exactly that, not "active plus deactivated".
  filter.isActive = deactivatedOnly !== 'true';
  if (q) {
    const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: rx }, { email: rx }, { rollNumber: rx }, { employeeId: rx }];
  }

  const users = await User.find(filter)
    .populate('section', 'name')
    .sort({ role: 1, rollNumber: 1, name: 1 })
    .limit(500)
    .lean();

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
  const overall = await getOverallForStudents(students.map((s) => s._id));

  const threshold = below === undefined || below === '' ? null : Number(below);
  let data = users.map((u) => ({
    ...shapeUser(u),
    attendance: u.role === 'student' ? overall[String(u._id)] || null : null,
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
  const student = await User.findOne({ _id: req.params.studentId, role: 'student' })
    .populate('section', 'name')
    .lean();
  if (!student) throw ApiError.notFound('Student not found');

  const [summary, documents] = await Promise.all([
    getStudentSummary(student._id),
    LeaveDocument.find({ student: student._id }).sort({ sentAt: -1 }).lean(),
  ]);

  res.json({
    success: true,
    data: {
      student: shapeUser(student),
      ...summary,
      documentCount: documents.length,
    },
  });
});

/** Faculty with their teaching load — used when assigning a subject. */
export const listFacultyWithLoad = asyncHandler(async (_req, res) => {
  const faculty = await User.find({ role: 'faculty', isActive: true }).sort({ name: 1 }).lean();
  const subjects = await Subject.find({ isActive: true }).populate('section', 'name').lean();
  const entries = await TimetableEntry.find().lean();

  res.json({
    success: true,
    data: faculty.map((f) => {
      const mine = subjects.filter((s) => String(s.faculty) === String(f._id));
      return {
        id: String(f._id),
        name: f.name,
        email: f.email,
        employeeId: f.employeeId,
        subjectCount: mine.length,
        periodsPerWeek: entries.filter((e) => String(e.faculty) === String(f._id)).length,
        subjects: mine.map((s) => `${s.code} · Sec ${s.section?.name ?? '—'}`),
      };
    }),
  });
});

export const createUser = asyncHandler(async (req, res) => {
  const { sectionId, password, ...rest } = req.body;

  if (await User.findOne({ email: rest.email })) {
    throw ApiError.conflict(`${rest.email} is already registered`);
  }

  let section = null;
  if (rest.role === 'student') {
    section = await Section.findById(sectionId);
    if (!section) throw ApiError.badRequest('That section does not exist');
  }

  // A sensible default so an admin can add people without inventing passwords.
  const defaults = { student: 'student123', faculty: 'faculty123', admin: 'admin123' };

  const user = await User.create({
    ...rest,
    password: password || defaults[rest.role],
    section: section?._id || null,
    semester: rest.role === 'student' ? (rest.semester ?? section.semester) : rest.semester,
  });

  // New students join every subject their section already runs.
  let enrolled = 0;
  if (user.role === 'student') {
    const subjects = await Subject.find({ section: section._id, isActive: true }).select('_id').lean();
    if (subjects.length) {
      await Enrollment.insertMany(
        subjects.map((s) => ({ student: user._id, subject: s._id })),
        { ordered: false }
      ).catch(() => {});
      enrolled = subjects.length;
    }
  }

  await notify([user._id], {
    type: 'account:created',
    title: 'Welcome to Sitare University',
    message: `Your ${user.role} account is ready. ${password ? '' : `Temporary password: ${defaults[user.role]} — please change it.`}`,
    link: '/',
    createdBy: req.user._id,
  });

  res.status(201).json({
    success: true,
    message: `${user.name} added${enrolled ? ` and enrolled in ${enrolled} subjects` : ''}`,
    data: shapeUser(user),
  });
});

export const updateUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.userId);
  if (!user) throw ApiError.notFound('User not found');

  const { sectionId, password, ...rest } = req.body;

  if (rest.email && rest.email !== user.email) {
    if (await User.findOne({ email: rest.email, _id: { $ne: user._id } })) {
      throw ApiError.conflict(`${rest.email} is already registered`);
    }
  }

  // Guard against locking everyone out of administration.
  if (rest.isActive === false && user.role === 'admin') {
    const others = await User.countDocuments({
      role: 'admin',
      isActive: true,
      _id: { $ne: user._id },
    });
    if (others === 0) throw ApiError.badRequest('This is the last active admin account');
  }

  Object.assign(user, rest);
  if (sectionId !== undefined) user.section = sectionId || null;
  if (password) user.password = password;
  await user.save();

  const fresh = await User.findById(user._id).populate('section', 'name').lean();
  res.json({ success: true, message: `${user.name} updated`, data: shapeUser(fresh) });
});

/** Suspend or restore access without removing anything. */
export const setUserStatus = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.userId);
  if (!user) throw ApiError.notFound('User not found');

  const active = Boolean(req.body?.isActive);

  // The only refusal left: locking the last admin out is unrecoverable —
  // nobody would be able to sign in and undo it, including whoever did it.
  if (!active && user.role === 'admin') {
    const others = await User.countDocuments({
      role: 'admin',
      isActive: true,
      _id: { $ne: user._id },
    });
    if (others === 0) throw ApiError.badRequest('This is the last active admin account');
  }

  user.isActive = active;
  await user.save();
  res.json({
    success: true,
    message: `${user.name} ${active ? 'reactivated' : 'deactivated'}`,
    data: { id: String(user._id), isActive: user.isActive },
  });
});

/**
 * Delete a person outright, with their enrolments, attendance and swap
 * requests. A lecturer's subjects and timetable periods survive them, left
 * unassigned so they can be handed to somebody else.
 */
export const deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.userId);
  if (!user) throw ApiError.notFound('User not found');

  if (user.role === 'admin') {
    const others = await User.countDocuments({ role: 'admin', _id: { $ne: user._id } });
    if (others === 0) {
      throw ApiError.badRequest(
        'This is the only admin account — deleting it would leave nobody able to administer the system'
      );
    }
  }

  const { name, role } = user;
  const counts = await purgeUsers([user._id]);
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
      ({ records } = parseCSVToObjects(req.file.buffer.toString('utf-8')));
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
    ({ records } = parseCSVToObjects(req.body.csv));
    source = 'csv';
  } else {
    throw ApiError.badRequest('Attach a student list PDF or CSV, or paste the rows');
  }

  if (!records.length) throw ApiError.badRequest('No student rows could be read');

  const sections = await Section.find({ isActive: true, semester: Number(semester) }).lean();
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
    ? sections.find((s) => String(s._id) === String(req.body.sectionId))
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
  const clashes = await User.find({
    $or: [
      { email: { $in: rows.map((r) => r.email) } },
      { rollNumber: { $in: rows.map((r) => r.rollNumber) } },
    ],
  })
    .select('email rollNumber')
    .lean();

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

  const created = [];
  for (const r of importable) {
    const user = await User.create({
      name: r.name,
      email: r.email,
      password: 'student123',
      role: 'student',
      rollNumber: r.rollNumber,
      batch: r.batch || undefined,
      semester: Number(semester),
      section: r.section._id,
      department: r.section.department,
    });
    created.push(user);

    const subjects = await Subject.find({ section: r.section._id, isActive: true })
      .select('_id')
      .lean();
    if (subjects.length) {
      await Enrollment.insertMany(
        subjects.map((s) => ({ student: user._id, subject: s._id })),
        { ordered: false }
      ).catch(() => {});
    }
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
  const sections = await Section.find().sort({ semester: 1, name: 1 }).lean();
  const ids = sections.map((s) => s._id);

  const [studentRows, subjectRows] = await Promise.all([
    User.aggregate([
      { $match: { role: 'student', isActive: true, section: { $in: ids } } },
      { $group: { _id: '$section', n: { $sum: 1 } } },
    ]),
    Subject.aggregate([
      { $match: { isActive: true, section: { $in: ids } } },
      { $group: { _id: '$section', n: { $sum: 1 } } },
    ]),
  ]);
  const students = Object.fromEntries(studentRows.map((r) => [String(r._id), r.n]));
  const subjects = Object.fromEntries(subjectRows.map((r) => [String(r._id), r.n]));

  res.json({
    success: true,
    data: sections.map((s) => ({
      id: String(s._id),
      name: s.name,
      label: sectionLabel(s),
      semester: s.semester,
      department: s.department,
      isActive: s.isActive,
      studentCount: students[String(s._id)] || 0,
      subjectCount: subjects[String(s._id)] || 0,
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
    const conflicts = await Section.find({ name: { $in: names }, semester, department })
      .select('name')
      .lean();
    if (conflicts.length) {
      const list = conflicts.map((c) => c.name).join(', ');
      throw ApiError.conflict(
        `Section${conflicts.length > 1 ? 's' : ''} ${list} already exist${conflicts.length > 1 ? '' : 's'} in semester ${semester}`
      );
    }

    const created = await Section.insertMany(names.map((name) => ({ name, semester, department })));
    return res.status(201).json({
      success: true,
      message: `${created.map((s) => sectionLabel(s)).join(', ')} created for semester ${semester}`,
      data: created.map((s) => ({ id: String(s._id), name: s.name, semester: s.semester })),
    });
  }

  const name = names[0] || '';
  const exists = await Section.findOne({ name, semester, department });
  if (exists) {
    throw ApiError.conflict(
      name
        ? `Section ${name} already exists in semester ${semester}`
        : `Semester ${semester} already has an undivided batch. Give this one a name to run two cohorts side by side.`
    );
  }

  const section = await Section.create({ name, semester, department });
  res.status(201).json({
    success: true,
    message: `${sectionLabel(section)} created for semester ${semester}`,
    data: { id: String(section._id), name: section.name, semester: section.semester },
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
  const section = await Section.findById(req.params.sectionId);
  if (!section) throw ApiError.notFound('Section not found');

  // An explicit empty name clears it, turning the cohort into the whole year.
  const name =
    req.body.name === undefined ? section.name : req.body.name.trim().toUpperCase();
  const semester = req.body.semester ?? section.semester;
  const department = req.body.department?.trim() || section.department;

  const clash = await Section.findOne({
    name,
    semester,
    department,
    _id: { $ne: section._id },
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

  section.name = name;
  section.semester = semester;
  section.department = department;
  await section.save();

  const moved = { subjects: 0, students: 0 };
  if (movedSemester) {
    moved.subjects = (
      await Subject.updateMany({ section: section._id }, { $set: { semester, department } })
    ).modifiedCount;
    moved.students = (
      await User.updateMany({ role: 'student', section: section._id }, { $set: { semester } })
    ).modifiedCount;
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
    message: `${previous.label} updated to ${sectionLabel(section)}${detail}`,
    data: { id: String(section._id), name, semester, department, moved },
  });
});

/** Deletes the cohort outright, along with everything that belonged to it. */
export const deleteSection = asyncHandler(async (req, res) => {
  const section = await Section.findById(req.params.sectionId);
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
  const filter = {};
  if (req.query.semester) filter.semester = Number(req.query.semester);
  if (req.query.section) filter.section = req.query.section;

  const subjects = await Subject.find(filter)
    .populate('faculty', 'name email')
    .populate('section', 'name semester')
    .sort({ semester: 1, code: 1 })
    .lean();

  const ids = subjects.map((s) => s._id);
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
  const publishedTimetables = await Timetable.find({
    semester: { $in: semesters },
    status: 'published',
  })
    .select('_id')
    .lean();
  const publishedIds = publishedTimetables.map((t) => t._id);

  const [enrolRows, sessionRows, entryFacultyRows] = await Promise.all([
    Enrollment.aggregate([
      { $match: { subject: { $in: ids }, isActive: true } },
      { $group: { _id: '$subject', n: { $sum: 1 } } },
    ]),
    ClassSession.aggregate([
      { $match: { subject: { $in: ids }, status: 'completed' } },
      { $group: { _id: '$subject', n: { $sum: 1 } } },
    ]),
    publishedIds.length
      ? TimetableEntry.find({
          subject: { $in: ids },
          timetable: { $in: publishedIds },
          faculty: { $ne: null },
        })
          .select('subject faculty')
          .populate('faculty', 'name')
          .lean()
      : [],
  ]);
  const enrolled = Object.fromEntries(enrolRows.map((r) => [String(r._id), r.n]));
  const conducted = Object.fromEntries(sessionRows.map((r) => [String(r._id), r.n]));

  // subjectId -> Map(facultyId -> name), built from actual per-period overrides.
  const coveringFaculty = new Map();
  for (const row of entryFacultyRows) {
    if (!row.faculty) continue;
    const sid = String(row.subject);
    if (!coveringFaculty.has(sid)) coveringFaculty.set(sid, new Map());
    coveringFaculty.get(sid).set(String(row.faculty._id), row.faculty.name);
  }

  res.json({
    success: true,
    data: subjects.map((s) => {
      const sid = String(s._id);
      // The subject's own lecturer first, then anyone else who covers a
      // period of it, deduplicated by id — never a hard-coded name, always
      // whatever the timetable actually says right now.
      const names = new Map();
      if (s.faculty) names.set(String(s.faculty._id), s.faculty.name);
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
        section: s.section ? { id: String(s.section._id), name: s.section.name } : null,
        faculty: s.faculty ? { id: String(s.faculty._id), name: s.faculty.name } : null,
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
    Section.findById(sectionId),
    User.findById(facultyId),
  ]);
  if (!section) throw ApiError.badRequest('That section does not exist');
  if (!faculty || faculty.role !== 'faculty') throw ApiError.badRequest('Choose a faculty member');
  if (section.semester !== semester) {
    throw ApiError.badRequest(
      `Section ${section.name} belongs to semester ${section.semester}, not ${semester}`
    );
  }

  const clash = await Subject.findOne({ code: code.toUpperCase(), section: section._id });
  if (clash) {
    throw ApiError.conflict(`${code.toUpperCase()} already exists for section ${section.name}`);
  }

  const subject = await Subject.create({
    ...rest,
    code,
    name,
    semester,
    section: section._id,
    faculty: faculty._id,
    department: section.department,
  });

  let enrolled = 0;
  if (enrolAllInSection) {
    const students = await User.find({ role: 'student', section: section._id, isActive: true })
      .select('_id')
      .lean();
    if (students.length) {
      await Enrollment.insertMany(
        students.map((s) => ({ student: s._id, subject: subject._id })),
        { ordered: false }
      ).catch(() => {});
      enrolled = students.length;
    }
  }

  await notify([faculty._id], {
    type: 'subject:assigned',
    title: 'Subject assigned to you',
    message: `You now teach ${subject.code} ${subject.name} for Section ${section.name}.`,
    link: '/',
    createdBy: req.user._id,
  });

  res.status(201).json({
    success: true,
    message: `${subject.code} created${enrolled ? ` with ${enrolled} students enrolled` : ''}`,
    data: { id: String(subject._id), code: subject.code, enrolled },
  });
});

export const updateSubject = asyncHandler(async (req, res) => {
  const subject = await Subject.findById(req.params.subjectId);
  if (!subject) throw ApiError.notFound('Subject not found');

  const { facultyId, ...rest } = req.body;
  // A departing lecturer leaves a subject with faculty: null (see purgeUsers) —
  // that is not a real id, so it must never be cast into a query filter below.
  const previous = subject.faculty ? String(subject.faculty) : null;

  if (facultyId && facultyId !== previous) {
    const faculty = await User.findById(facultyId);
    if (!faculty || faculty.role !== 'faculty') throw ApiError.badRequest('Choose a faculty member');
    subject.faculty = faculty._id;

    // The timetable stores the lecturer per period; keep it in step, but leave
    // any period deliberately overridden to somebody else alone. Nothing to
    // reconcile if the subject had no previous lecturer to begin with.
    if (previous) {
      await TimetableEntry.updateMany(
        { subject: subject._id, faculty: previous },
        { $set: { faculty: faculty._id } }
      );
    }

    await notify([faculty._id], {
      type: 'subject:assigned',
      title: 'Subject assigned to you',
      message: `You now teach ${subject.code} ${subject.name}.`,
      link: '/',
      createdBy: req.user._id,
    });
  }

  Object.assign(subject, rest);
  await subject.save();

  res.json({ success: true, message: `${subject.code} updated`, data: { id: String(subject._id) } });
});

/** Deletes the subject and its register, however much history it holds. */
export const deleteSubject = asyncHandler(async (req, res) => {
  const subject = await Subject.findById(req.params.subjectId);
  if (!subject) throw ApiError.notFound('Subject not found');

  const code = subject.code;
  const counts = await purgeSubjects([subject._id]);
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
  const subject = await Subject.findById(req.params.subjectId).populate('section', 'name semester');
  if (!subject) throw ApiError.notFound('Subject not found');

  const [enrolments, sectionStudents] = await Promise.all([
    Enrollment.find({ subject: subject._id, isActive: true })
      .populate('student', 'name rollNumber email')
      .lean(),
    User.find({ role: 'student', section: subject.section?._id, isActive: true })
      .select('name rollNumber email')
      .sort({ rollNumber: 1 })
      .lean(),
  ]);

  const enrolledIds = new Set(enrolments.map((e) => String(e.student?._id)));

  res.json({
    success: true,
    data: {
      subject: { id: String(subject._id), code: subject.code, name: subject.name },
      enrolled: enrolments
        .filter((e) => e.student)
        .map((e) => ({
          id: String(e.student._id),
          name: e.student.name,
          rollNumber: e.student.rollNumber,
        }))
        .sort((a, b) => (a.rollNumber || '').localeCompare(b.rollNumber || '')),
      available: sectionStudents
        .filter((s) => !enrolledIds.has(String(s._id)))
        .map((s) => ({ id: String(s._id), name: s.name, rollNumber: s.rollNumber })),
    },
  });
});

export const setEnrolment = asyncHandler(async (req, res) => {
  const subject = await Subject.findById(req.params.subjectId);
  if (!subject) throw ApiError.notFound('Subject not found');

  const { studentIds, action } = req.body || {};
  if (!Array.isArray(studentIds) || !studentIds.length) {
    throw ApiError.badRequest('Select at least one student');
  }

  if (action === 'remove') {
    await Enrollment.deleteMany({ subject: subject._id, student: { $in: studentIds } });
    return res.json({ success: true, message: `${studentIds.length} students removed` });
  }

  await Enrollment.insertMany(
    studentIds.map((student) => ({ student, subject: subject._id })),
    { ordered: false }
  ).catch(() => {});

  res.json({ success: true, message: `${studentIds.length} students enrolled` });
});
