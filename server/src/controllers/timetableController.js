import { z } from 'zod';
import Timetable from '../models/Timetable.js';
import TimetableEntry, { ENTRY_KINDS } from '../models/TimetableEntry.js';
import AttendanceDelegation from '../models/AttendanceDelegation.js';
import Section from '../models/Section.js';
import Subject from '../models/Subject.js';
import User from '../models/User.js';
import Enrollment from '../models/Enrollment.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { parseCSVToObjects, toCSV } from '../utils/csv.js';
import { parseTimetablePDF } from '../services/pdfParser.js';
import { todayKey, toUTCDate } from '../utils/date.js';
import { SLOTS, LUNCH, DAYS, parseDay, isValidSlot, dayName } from '../config/slots.js';
import {
  getWeek,
  getPublishedTimetable,
  getPublishedTimetables,
  resolveOccurrences,
  slotsOf,
} from '../services/timetableService.js';
import { notify, facultyAndAdminIds, studentAudience } from '../services/notificationService.js';
import { emitToUsers } from '../sockets/index.js';

export const uploadSchema = z.object({
  name: z.string().min(1, 'Give this timetable a name').max(120),
  semester: z.number().int().min(1).max(10),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  csv: z.string().min(1, 'CSV content is required'),
  publish: z.boolean().optional().default(false),
});

/* ------------------------------------------------------------------ */
/* Correcting a period                                                 */
/* ------------------------------------------------------------------ */

const editEntrySchema = z.object({
  /** Point the period at a different subject already on the semester. */
  subjectId: z.string().length(24).nullable().optional(),
  /** Or name one: renames the current subject, or creates it if there is none. */
  subjectName: z.string().trim().min(1).max(160).optional(),
  subjectCode: z.string().trim().min(1).max(12).optional(),

  facultyId: z.string().length(24).nullable().optional(),
  /**
   * 'subject' hands the whole subject to that lecturer — which is what fixing
   * an unassigned class means. 'entry' changes this one period only, for a
   * period genuinely taken by somebody else.
   */
  applyFacultyTo: z.enum(['subject', 'entry']).optional().default('subject'),

  kind: z.enum(ENTRY_KINDS).optional(),
  title: z.string().trim().max(200).optional(),
  room: z.string().trim().max(60).optional(),
});

/**
 * Correct one cell of the grid.
 *
 * Extraction from a PDF is inference, and inference is sometimes wrong: a
 * subject arrives with its words out of order, two cells merge into one, a
 * lecturer is missed and the period reads as a bare event. Rather than making
 * an administrator re-upload the file and hope, this fixes the cell in place.
 *
 * The point is that a correction lands *everywhere*. Renaming a subject writes
 * to the Subject document, so every grid, register, report and dashboard that
 * names it changes at once — there is one subject, not one per cell. Naming the
 * lecturer assigns the subject to them by default, because a class showing no
 * teacher is an unassigned subject, and assigning it here is what stops it
 * being unassigned on the faculty's own dashboard too.
 */
export const editEntry = asyncHandler(async (req, res) => {
  const body = editEntrySchema.parse(req.body);
  const entry = await loadEntryForAdmin(req.params.entryId);
  const timetable = await Timetable.findById(entry.timetable).lean();
  const semester = timetable?.semester;

  const changes = [];

  /* ---- Which subject this period is ---- */
  if (body.subjectId !== undefined) {
    if (body.subjectId === null) {
      entry.subject = null;
      changes.push('subject cleared');
    } else {
      const next = await Subject.findById(body.subjectId);
      if (!next) throw ApiError.notFound('Subject not found');
      entry.subject = next._id;
      changes.push(`now ${next.code}`);
    }
  }

  /* ---- Its name and code, corrected for good ---- */
  if (body.subjectName || body.subjectCode) {
    const current = entry.subject
      ? await Subject.findById(entry.subject._id || entry.subject)
      : null;

    if (current) {
      const before = current.name;
      if (body.subjectName) current.name = body.subjectName;
      if (body.subjectCode) current.code = body.subjectCode.toUpperCase();
      await current.save();
      if (body.subjectName && body.subjectName !== before) {
        changes.push(`renamed "${before}" to "${body.subjectName}"`);
      }
      if (body.subjectCode) changes.push(`code ${current.code}`);
    } else {
      /*
       * A period with no subject — an event the parser could not place. Naming
       * it creates the subject and enrols the cohort, which is what turns a
       * bare event into a class with a register.
       */
      if (!body.subjectName) {
        throw ApiError.badRequest('Give the subject a name');
      }
      const created = await createSubjectForEntry(entry, {
        name: body.subjectName,
        code: body.subjectCode,
        semester,
        facultyId: body.facultyId || null,
      });
      entry.subject = created._id;
      if (entry.kind === 'event') entry.kind = 'lecture';
      changes.push(`created ${created.code} and enrolled the cohort`);
    }
  }

  /* ---- Who takes it ---- */
  if (body.facultyId !== undefined) {
    const person = body.facultyId
      ? await User.findOne({ _id: body.facultyId, role: 'faculty', isActive: true })
      : null;
    if (body.facultyId && !person) throw ApiError.notFound('That lecturer was not found');

    if (body.applyFacultyTo === 'entry') {
      entry.faculty = person?._id || null;
      changes.push(person ? `${person.name} takes this period` : 'lecturer cleared here');
    } else {
      // A subject always has an owner — "left unassigned" would null out a
      // required field. Clearing for just this period is what 'entry' is for.
      if (!person) {
        throw ApiError.badRequest(
          'A subject must have a lecturer — clear the lecturer for just this period instead, or choose a replacement.'
        );
      }
      // Assign the subject itself, so nothing anywhere still reads unassigned.
      const subjectId = entry.subject?._id || entry.subject;
      if (subjectId) {
        await Subject.updateOne({ _id: subjectId }, { $set: { faculty: person._id } });
      }
      // Clear the per-period override so the cell inherits the new owner.
      entry.faculty = null;
      changes.push(`assigned to ${person.name}`);
    }
  }

  if (body.kind !== undefined) {
    entry.kind = body.kind;
    changes.push(`kind ${body.kind}`);
  }
  if (body.title !== undefined) {
    entry.title = body.title;
    changes.push(body.title ? `note "${body.title}"` : 'note cleared');
  }
  if (body.room !== undefined) entry.room = body.room;

  await entry.save();

  /*
   * A correction is not private: the lecturer who has just been given the
   * subject, and the cohort sitting in it, are looking at the same grid.
   */
  const staff = await facultyAndAdminIds();
  const students = await studentAudience({
    subjectId: entry.subject?._id || entry.subject,
    sectionId: entry.section?._id || entry.section,
  });
  emitToUsers([...staff, ...students, String(req.user._id)], 'timetable:changed', {
    reason: 'corrected',
  });

  res.json({
    success: true,
    message: changes.length ? `Updated — ${changes.join(', ')}` : 'Nothing to change',
    data: { entryId: String(entry._id) },
  });
});

/**
 * Build the subject a corrected period needs, and enrol whoever sits in it.
 * Without the enrolment the register would open with nobody on it.
 */
async function createSubjectForEntry(entry, { name, code, semester, facultyId }) {
  const sectionId = entry.section?._id || entry.section || null;
  const sections = await Section.find({ isActive: true, semester: Number(semester) }).lean();
  const owner = sectionId || sections[0]?._id;
  if (!owner) throw ApiError.badRequest('This semester has no cohort to attach a subject to');

  const taken = new Set(
    (await Subject.find({ section: owner }).select('code').lean()).map((s) => s.code.toUpperCase())
  );
  const finalCode = code ? code.toUpperCase() : deriveCode(name, taken);
  if (code && taken.has(finalCode)) {
    throw ApiError.conflict(`${finalCode} already exists for this cohort`);
  }

  const subject = await Subject.create({
    code: finalCode,
    name,
    semester: Number(semester),
    section: owner,
    faculty: facultyId || null,
    department: sections[0]?.department || 'Computer Science',
    plannedClasses: 30,
    minAttendance: 75,
  });

  /*
   * A section-less period is the whole year sitting together, so everybody in
   * the semester attends it — not just the cohort the subject hangs off.
   */
  const studentFilter = sectionId
    ? { role: 'student', isActive: true, section: sectionId }
    : { role: 'student', isActive: true, section: { $in: sections.map((s) => s._id) } };
  const students = await User.find(studentFilter).select('_id').lean();
  if (students.length) {
    await Enrollment.insertMany(
      students.map((st) => ({ student: st._id, subject: subject._id })),
      { ordered: false }
    ).catch(() => {});
  }

  return subject;
}

/* ------------------------------------------------------------------ */
/* Who marks a period's register                                       */
/* ------------------------------------------------------------------ */

const attendanceBySchema = z.object({
  // null clears the hand-over and returns the register to its own lecturer.
  facultyId: z.string().length(24).nullable(),
  // Only needed for a period that carries no subject, e.g. "Session with Dean".
  subjectId: z.string().length(24).nullable().optional(),
  // The single class being handed over. Never the whole weekly period.
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
});

const loadEntryForAdmin = async (entryId) => {
  const entry = await TimetableEntry.findById(entryId)
    .populate('subject', 'code name faculty semester')
    .populate('faculty', 'name email')
    .populate('section', 'name semester');
  if (!entry) throw ApiError.notFound('That period is not on the timetable');
  return entry;
};

/** The hand-over in force for one dated class, if there is one. */
const delegationFor = (entry, dateKey) =>
  AttendanceDelegation.findOne({
    dateKey,
    slot: entry.slot,
    $or: [
      { entry: entry._id },
      ...(entry.subject ? [{ subject: entry.subject._id }] : []),
    ],
  }).populate('faculty', 'name email');

/**
 * Every lecturer, flagged with what they are already doing in this period.
 *
 * "Free at that time" is the whole point of the choice, so availability is
 * computed rather than left for the admin to work out from the grid. A
 * lecturer who is busy is still listed — the admin may know they are the right
 * person anyway — but the clash is named.
 */
export const listAttendanceCandidates = asyncHandler(async (req, res) => {
  const entry = await loadEntryForAdmin(req.params.entryId);
  const date = req.query.date || todayKey();

  const ownerId = String(entry.faculty?._id || entry.subject?.faculty || '');
  const current = await delegationFor(entry, date);

  const [faculty, { byDate }] = await Promise.all([
    // The owner is not a stand-in for themselves — "its own lecturer" is the
    // other option in the list.
    User.find({ role: 'faculty', isActive: true, ...(ownerId ? { _id: { $ne: ownerId } } : {}) })
      .select('name email')
      .sort({ name: 1 })
      .lean(),
    resolveOccurrences([date]),
  ]);

  const atSlot = (byDate[date] || []).filter(
    (o) =>
      o.slot === entry.slot &&
      !['moved-out', 'cancelled'].includes(o.origin) &&
      String(o.entryId) !== String(entry._id)
  );
  const busy = new Map();
  for (const o of atSlot) {
    if (o.faculty) busy.set(String(o.faculty.id), o);
  }

  res.json({
    success: true,
    data: {
      date,
      slot: entry.slot,
      owner: entry.faculty
        ? { id: String(entry.faculty._id), name: entry.faculty.name }
        : entry.subject?.faculty
          ? { id: String(entry.subject.faculty), name: '' }
          : null,
      subject: entry.subject
        ? { id: String(entry.subject._id), code: entry.subject.code, name: entry.subject.name }
        : null,
      title: entry.title,
      attendanceBy: current?.faculty
        ? { id: String(current.faculty._id), name: current.faculty.name }
        : null,
      // What the hand-over's register counts towards, when the period has no
      // subject of its own.
      countsToward: current?.subject ? String(current.subject) : null,
      candidates: faculty.map((f) => {
        const clash = busy.get(String(f._id));
        return {
          id: String(f._id),
          name: f.name,
          email: f.email,
          free: !clash,
          busyWith: clash ? clash.subject?.code || clash.title || 'another class' : null,
        };
      }),
    },
  });
});

/**
 * Hand a period's register to another lecturer, or give it back.
 *
 * Nothing about who teaches the class changes: the session and its attendance
 * still belong to the period's own subject and lecturer, so the marks appear
 * on their dashboard exactly as if they had taken the register themselves.
 */
export const setAttendanceBy = asyncHandler(async (req, res) => {
  const { facultyId, subjectId, date } = attendanceBySchema.parse(req.body);
  const entry = await loadEntryForAdmin(req.params.entryId);

  const existing = await delegationFor(entry, date);

  if (!facultyId) {
    if (existing) await existing.deleteOne();
    return res.json({
      success: true,
      message: 'Register returned to its own lecturer',
      data: { entryId: String(entry._id), date },
    });
  }

  const person = await User.findOne({ _id: facultyId, role: 'faculty', isActive: true });
  if (!person) throw ApiError.notFound('That lecturer was not found');

  /*
   * A period with no subject has no register — there is nothing for the marks
   * to be recorded against. The admin names one in the same step, and it is
   * stored on the hand-over rather than written onto the weekly grid, so the
   * period itself stays the event it was.
   */
  const subject = entry.subject || (subjectId ? await Subject.findById(subjectId) : null);
  if (!subject) {
    throw ApiError.badRequest(
      'This period has no subject, so there is no register to mark. Choose the subject its attendance counts towards.'
    );
  }

  const doc = await AttendanceDelegation.findOneAndUpdate(
    { subject: subject._id, dateKey: date, slot: entry.slot },
    {
      $set: { faculty: person._id, entry: entry._id, assignedBy: req.user._id },
      $setOnInsert: { subject: subject._id, dateKey: date, slot: entry.slot },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const what = `${subject.code}${entry.title ? ` (${entry.title})` : ''} on ${date}, period ${entry.slot}`;
  await notify([person._id], {
    type: 'attendance:delegated',
    title: 'You have been asked to mark a register',
    message: `${what}. Just this one class — the marks are recorded against its own lecturer.`,
    link: '/faculty',
    createdBy: req.user._id,
  });

  const owner = entry.faculty?._id || subject.faculty || null;
  if (owner && String(owner) !== String(person._id)) {
    await notify([owner], {
      type: 'attendance:delegated',
      title: 'Someone else will mark your register',
      message: `${person.name} was asked to mark ${what}. The attendance still counts as yours.`,
      link: '/faculty',
      createdBy: req.user._id,
    });
  }

  res.json({
    success: true,
    message: `Register for ${date} handed to ${person.name}`,
    data: { entryId: String(entry._id), date, id: String(doc._id) },
  });
});

/* ------------------------------------------------------------------ */
/* Reading the grid                                                    */
/* ------------------------------------------------------------------ */

/** Slot/day/section reference data the client needs to draw the grid. */
export const getMeta = asyncHandler(async (req, res) => {
  const [sections, published] = await Promise.all([
    Section.find({ isActive: true }).sort({ semester: 1, name: 1 }).lean(),
    getPublishedTimetables(),
  ]);

  // Which semesters actually have a live grid — the selector is built from this.
  // Each carries its own period times, because timetables do not share a clock.
  const semesters = published
    .map((t) => ({
      semester: t.semester,
      timetableId: String(t._id),
      name: t.name,
      slots: slotsOf(t),
      lunch: t.lunch || LUNCH,
      sectionCount: sections.filter((s) => s.semester === t.semester).length,
    }))
    .sort((a, b) => a.semester - b.semester);

  res.json({
    success: true,
    data: {
      // Defaults, used only before anything has been uploaded.
      slots: SLOTS,
      lunch: LUNCH,
      days: DAYS,
      semesters,
      sections: sections.map((s) => ({ id: String(s._id), name: s.name, semester: s.semester })),
    },
  });
});

/**
 * The week grid. Students are pinned to their own section; faculty and admin
 * see every section, because spotting a free period is the whole point.
 */
export const getWeekGrid = asyncHandler(async (req, res) => {
  const anchor = req.query.date || todayKey();

  let sectionId = req.query.section || undefined;
  let semester = req.query.semester ? Number(req.query.semester) : undefined;

  if (req.user.role === 'student') {
    /*
     * A student sees their semester's timetable exactly as it was published —
     * the whole document, not a slice of it. The timetable is one shared plan
     * for the year, so hiding the other columns would show them less than the
     * sheet on the noticeboard does.
     */
    sectionId = undefined;
    const own = req.user.sectionId();
    if (!own) throw ApiError.badRequest('You have not been assigned to a semester yet');
    const section = await Section.findById(own).lean();
    semester = section?.semester;
  } else if (!semester) {
    // Staff default to the lowest semester that has a live grid.
    const published = await getPublishedTimetables();
    semester = published[0]?.semester;
  }

  const week = await getWeek(anchor, { sectionId, semester });
  res.json({
    success: true,
    data: { ...week, scopedToSection: sectionId || null, semester: semester ?? null },
  });
});

export const listTimetables = asyncHandler(async (_req, res) => {
  const list = await Timetable.find()
    .sort({ createdAt: -1 })
    .populate('uploadedBy', 'name')
    .limit(30)
    .lean();

  res.json({
    success: true,
    data: list.map((t) => ({
      id: String(t._id),
      name: t.name,
      semester: t.semester,
      status: t.status,
      effectiveFrom: t.effectiveFromKey,
      entryCount: t.entryCount,
      warnings: t.warnings || [],
      uploadedBy: t.uploadedBy?.name || null,
      publishedAt: t.publishedAt,
      createdAt: t.createdAt,
    })),
  });
});

/* ------------------------------------------------------------------ */
/* Upload                                                              */
/* ------------------------------------------------------------------ */

const TEMPLATE_HEADER = ['day', 'slot', 'section', 'subjectCode', 'facultyEmail', 'kind', 'title'];

/** Blank template, or the live grid exported so admins can edit and re-upload. */
export const downloadTemplate = asyncHandler(async (req, res) => {
  const rows = [TEMPLATE_HEADER];

  if (req.query.current === 'true') {
    const tt = await getPublishedTimetable(req.query.semester);
    if (tt) {
      const entries = await TimetableEntry.find({ timetable: tt._id })
        .populate('section', 'name')
        .populate('subject', 'code')
        .populate('faculty', 'email')
        .sort({ dayOfWeek: 1, slot: 1 })
        .lean();
      entries.forEach((e) =>
        rows.push([
          dayName(e.dayOfWeek),
          e.slot,
          e.section?.name || '',
          e.subject?.code || '',
          e.faculty?.email || '',
          e.kind,
          e.title || '',
        ])
      );
    }
  } else {
    rows.push(['Monday', 4, 'A', 'WAD', 'ankit.mehta@sitare.org', 'lecture', '']);
    rows.push(['Monday', 4, 'B', 'CPS', 'prateek.goel@sitare.org', 'lecture', '']);
    rows.push(['Tuesday', 3, 'A', 'OSP', 'deepak.rao@sitare.org', 'office-hours', '']);
    rows.push(['Friday', 1, 'B', '', '', 'event', 'Session with Dean']);
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="timetable-template.csv"');
  res.send(toCSV(rows));
});

/**
 * Parse + validate a CSV against real sections, subjects and faculty.
 *
 * Errors block the upload; warnings do not. A cohort booked twice in one
 * period is an error — students cannot be in two rooms. One lecturer in two
 * rooms is a warning, because combined sessions across sections are a real
 * thing that shows up in genuine timetables.
 */
/**
 * Subject and faculty names for the semester, so a PDF grid printed with full
 * subject names ("Web Applications Development") can be matched back to codes.
 */
async function buildCatalogue(semester) {
  const scope = semester ? { semester: Number(semester) } : {};
  const [subjects, faculty, sections] = await Promise.all([
    Subject.find({ isActive: true, ...scope }).lean(),
    User.find({ role: 'faculty', isActive: true }).lean(),
    Section.find({ isActive: true, ...scope }).lean(),
  ]);

  return {
    // One entry per code — the same subject is offered to several sections.
    subjectNames: [
      ...new Map(subjects.map((s) => [s.code, { code: s.code, name: s.name }])).values(),
    ],
    facultyNames: faculty.map((f) => ({ email: f.email, name: f.name })),
    // A single-section semester needs no "Section A" column in the PDF.
    defaultSection: sections.length === 1 ? sections[0].name : null,
  };
}

/** Rows from whichever format was uploaded. */
async function readUpload(req, semester) {
  if (req.file) {
    if (req.file.mimetype && !/pdf/i.test(req.file.mimetype)) {
      throw ApiError.badRequest('Upload a PDF file');
    }
    const catalogue = await buildCatalogue(semester);
    try {
      const out = await parseTimetablePDF(req.file.buffer, catalogue);
      // Pass the whole reading through: the period times and the subject
      // legend are as much a part of the upload as the rows themselves.
      return { ...out, source: 'pdf' };
    } catch (err) {
      throw ApiError.badRequest(err.message);
    }
  }

  if (req.body?.csv?.trim()) {
    const { records } = parseCSVToObjects(req.body.csv);
    return { records, source: 'csv', layout: 'list', periods: null, lunch: null, legend: [] };
  }

  throw ApiError.badRequest('Attach a timetable PDF, or paste the timetable text');
}

const normName = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The code an institute would write for a subject: initials for a multi-word
 * name — ADSA, PCS, AI — but a name that is already one word (DBMS) keeps
 * itself rather than becoming "D".
 */
function initialsOf(name) {
  const words = normName(name)
    .split(' ')
    .filter((w) => !['and', 'for', 'of', 'in', 'the', 'to', 'a'].includes(w));
  if (!words.length) return '';
  let base =
    words.length === 1
      ? words[0].toUpperCase().slice(0, 6)
      : words.map((w) => w[0]).join('').toUpperCase().slice(0, 6);
  if (base.length < 2) base = normName(name).replace(/\s/g, '').slice(0, 4).toUpperCase();
  return base;
}

/** A short code derived from a subject's name, for a subject the file invents. */
function deriveCode(name, taken) {
  const base = initialsOf(name);
  let code = base;
  let n = 2;
  while (taken.has(code)) code = `${base}${n++}`;
  taken.add(code);
  return code;
}

/**
 * Resolve parsed rows against the database.
 *
 * A first upload names subjects and lecturers the system has never seen — that
 * is normal, and refusing it would force an admin to hand-create everything
 * before their own timetable would load. So unknown names are collected as
 * things *to create*, reported in the preview, and only actually created when
 * the admin publishes.
 */
async function buildEntriesFromRecords(records, semester, { create = false, actor = null } = {}) {
  if (!records.length) throw ApiError.badRequest('No timetable rows could be read');

  /*
   * Everything is scoped to the semester being uploaded. "Section A" exists in
   * more than one semester, so resolving names globally would silently attach
   * a semester-5 row to a semester-3 cohort.
   */
  const scope = semester ? { semester: Number(semester) } : {};

  const [sections, subjects, faculty] = await Promise.all([
    Section.find({ isActive: true, ...scope }).lean(),
    Subject.find({ isActive: true, ...scope }).populate('section', 'name').lean(),
    User.find({ role: 'faculty', isActive: true }).lean(),
  ]);

  const sectionByName = new Map(sections.map((s) => [s.name.toUpperCase(), s]));

  /*
   * The uploaded file is the authority on what sections exist. If it names a
   * cohort the system has not heard of, that cohort is created rather than
   * the column being dropped — otherwise part of the timetable would silently
   * go missing just because the setup lags behind the file.
   */
  const namedSections = [
    ...new Set(records.map((r) => String(r.section || '').toUpperCase()).filter(Boolean)),
  ];
  const missingSections = namedSections.filter((n) => !sectionByName.has(n));

  /*
   * A file with no section columns still needs one cohort to own its subjects,
   * but it should not be christened "A" — the year simply is not divided, and
   * an invented letter would show up all over a timetable that has none.
   */
  if (!sections.length && !namedSections.length) missingSections.push('');

  const department = sections[0]?.department || 'Computer Science';
  for (const name of missingSections) {
    if (create) {
      const doc = await Section.create({ name, semester: Number(semester), department });
      sections.push(doc);
      sectionByName.set(name, doc);
    } else {
      // Preview only: a stand-in so validation can proceed without writing.
      const stub = { _id: `new:${name}`, name, semester: Number(semester), department };
      sections.push(stub);
      sectionByName.set(name, stub);
    }
  }
  const facultyByEmail = new Map(faculty.map((f) => [f.email.toLowerCase(), f]));
  const facultyByName = new Map(faculty.map((f) => [normName(f.name), f]));
  const subjectByKey = new Map(
    subjects.map((s) => [`${s.code.toUpperCase()}|${String(s.section?._id ?? '')}`, s])
  );
  const subjectByName = new Map(
    subjects.map((s) => [`${normName(s.name)}|${String(s.section?._id ?? '')}`, s])
  );

  /*
   * Codes are unique per section, not globally — "ADSA" belongs to Section A
   * and Section B alike. Tracking them per section stops a grid that applies
   * to every cohort from inventing ADSA, ADSA2, ADSA3.
   */
  const takenBySection = new Map();
  const codesFor = (sid) => {
    if (!takenBySection.has(sid)) {
      takenBySection.set(
        sid,
        new Set(
          subjects
            .filter((s) => String(s.section?._id ?? s.section) === sid)
            .map((s) => s.code.toUpperCase())
        )
      );
    }
    return takenBySection.get(sid);
  };
  const newFaculty = new Map(); // normalised name -> { name, email }
  const newSubjects = new Map(); // "name|sectionId" -> { name, code, sectionName, facultyName }
  const renames = new Map(); // subjectId -> { from, to }

  const errors = [];
  const warnings = [];
  const notes = [];
  const parsed = [];
  const seenCell = new Map();
  const seenFaculty = new Map();

  /** Find, or note for creation, the lecturer a printed name refers to. */
  const resolveFaculty = (rawName) => {
    const key = normName(rawName);
    if (!key) return null;
    const existing = facultyByName.get(key);
    if (existing) return { id: existing._id, name: existing.name, isNew: false };

    // "Ms Preeti Shukla/Ms Riya Bangera" — the first named owns the subject.
    const primary = String(rawName).split(/[/,]|\s+&\s+/)[0].trim();
    const byPrimary = facultyByName.get(normName(primary));
    if (byPrimary) return { id: byPrimary._id, name: byPrimary.name, isNew: false };

    const slug = normName(primary)
      .replace(/\b(dr|mr|mrs|ms|prof)\b/g, '')
      .trim()
      .replace(/\s+/g, '.');
    if (!slug) return null;
    if (!newFaculty.has(key)) {
      newFaculty.set(key, { name: primary, email: `${slug}@sitare.org` });
    }
    return { id: null, name: primary, isNew: true, key };
  };

  for (const r of records) {
    const line = r.__line;
    const day = parseDay(r.day);
    const slot = Number(r.slot);
    const kind = (r.kind || 'lecture').toLowerCase();
    const title = r.title || '';
    const code = (r.subjectcode || '').toUpperCase();
    const subjName = (r.subjectname || '').trim();
    const email = (r.facultyemail || '').toLowerCase();
    const facName = (r.facultyname || '').trim();

    /*
     * Rows that cannot be placed are skipped and noted, never fatal. A real
     * timetable always has a stray cell somewhere, and refusing the whole file
     * over one of them helps nobody.
     */
    if (!day || !Number.isInteger(slot) || slot < 1 || slot > 12) {
      notes.push({ line, message: `Skipped a cell that could not be placed: "${r.__raw || r.day}"` });
      continue;
    }

    /*
     * A grid with no section columns is one timetable for the whole year, so
     * it applies to every section in the semester.
     */
    /*
     * A grid with no section columns describes one cohort sitting together, so
     * it becomes one section-less period rather than a copy per section. That
     * is both what the file says and what stops every lecturer reading as
     * double-booked against themselves.
     */
    const targets = r.section
      ? [sectionByName.get(String(r.section).toUpperCase())].filter(Boolean)
      : [null];

    if (!targets.length) {
      notes.push({ line, message: `No section matched "${r.section}" — cell skipped` });
      continue;
    }

    for (const section of targets) {
      /*
       * Subjects still belong to a cohort so that enrolment and attendance
       * have a roster. With no sections in the file, everything hangs off the
       * semester's primary cohort and every student in the semester is
       * enrolled — see the enrolment step below.
       */
      const owner = section || sections[0];
      const sid = String(owner._id);
      let subject = null;
      let pendingSubject = null;

      if (code) subject = subjectByKey.get(`${code}|${sid}`) || null;
      if (!subject && subjName) subject = subjectByName.get(`${normName(subjName)}|${sid}`) || null;

      /*
       * A grid abbreviates what its legend spells out, so the same subject can
       * already be on file under its initials — "PCS" for "Probability for
       * Computer Science". Without this the re-upload builds a second subject
       * beside the first, splitting one lecturer's classes across two.
       */
      if (!subject && subjName) {
        subject = subjectByKey.get(`${initialsOf(subjName)}|${sid}`) || null;
        /*
         * Matched on its code, so the stored name is whatever an earlier
         * upload made of it. The file being uploaded now is the authority on
         * what the subject is called.
         */
        if (subject && normName(subject.name) !== normName(subjName)) {
          renames.set(String(subject._id), { from: subject.name, to: subjName });
          subject.name = subjName;
        }
      }

      if (!subject && subjName && kind !== 'event') {
        // The file names a subject this section does not run yet.
        const key = `${normName(subjName)}|${sid}`;
        if (!newSubjects.has(key)) {
          newSubjects.set(key, {
            name: subjName,
            code: code || deriveCode(subjName, codesFor(sid)),
            sectionId: sid,
            sectionName: owner.name,
            // No section split means the whole semester takes this subject.
            wholeSemester: !section,
            facultyName: facName,
          });
        }
        pendingSubject = newSubjects.get(key);
      }

      /*
       * An unrecognised cell still describes something that occupies the
       * period, so it is recorded as a titled session rather than rejected.
       * Nothing in the file is silently dropped, and nothing blocks publishing.
       */
      let effectiveKind = kind;
      let effectiveTitle = title;
      if (!subject && !pendingSubject) {
        effectiveKind = kind === 'lecture' ? 'event' : kind;
        effectiveTitle = title || r.__raw || '';
        if (!effectiveTitle) continue;
        notes.push({
          line,
          message: `"${effectiveTitle}" was kept as a scheduled session — it did not match a subject`,
        });
      }

      let facultyRef = null;
      if (email) {
        const hit = facultyByEmail.get(email);
        if (hit) facultyRef = { id: hit._id, name: hit.name, isNew: false };
        else notes.push({ line, message: `No account for "${email}" — period left unassigned` });
      } else if (facName) {
        facultyRef = resolveFaculty(facName);
      } else if (subject?.faculty) {
        const hit = faculty.find((f) => String(f._id) === String(subject.faculty));
        if (hit) facultyRef = { id: hit._id, name: hit.name, isNew: false };
      }

      // One cohort, one class per period: a repeat is a duplicate cell, so the
      // first reading wins and the rest is noted.
      const cellKey = `${day}|${slot}|${section ? sid : 'all'}`;
      if (seenCell.has(cellKey)) {
        notes.push({
          line,
          message: `${section ? `Section ${section.name}` : 'The semester'} already had a class in period ${slot} on ${dayName(day)} — kept the first`,
        });
        continue;
      }
      seenCell.set(cellKey, line);

      // Genuinely two different cells naming the same lecturer at once.
      if (facultyRef?.name) {
        const fKey = `${day}|${slot}|${normName(facultyRef.name)}`;
        const seenAt = seenFaculty.get(fKey);
        if (seenAt !== undefined && seenAt !== line) {
          warnings.push(
            `${facultyRef.name} is listed twice in period ${slot} on ${dayName(day)} — treated as a combined class.`
          );
        } else seenFaculty.set(fKey, line);
      }

      parsed.push({
        dayOfWeek: day,
        slot,
        section: section?._id || null,
        sectionName: section?.name || 'All',
        subject: subject?._id || null,
        pendingSubjectKey: pendingSubject ? `${normName(subjName)}|${sid}` : null,
        subjectCode: subject?.code || pendingSubject?.code || '',
        subjectName: subject?.name || pendingSubject?.name || '',
        faculty: facultyRef?.id || null,
        pendingFacultyKey: facultyRef?.isNew ? facultyRef.key : null,
        facultyName: facultyRef?.name || '',
        kind: effectiveKind,
        title: effectiveTitle,
        isNewSubject: Boolean(pendingSubject),
        isNewFaculty: Boolean(facultyRef?.isNew),
      });
    }
  }

  // The only thing worth refusing is a file nothing could be read from.
  if (!parsed.length) {
    errors.push({
      line: 0,
      message: 'Nothing on this timetable could be placed. Check the file is the right one.',
    });
  }

  const toCreate = {
    sections: missingSections,
    faculty: [...newFaculty.values()],
    subjects: [...newSubjects.values()].map((s) => ({
      name: s.name,
      code: s.code,
      section: s.sectionName,
      faculty: s.facultyName,
    })),
  };

  if (!create || errors.length) return { parsed, errors, warnings, notes, toCreate };

  /* ---- commit the missing pieces ---- */

  // Correct any subject the file names more fully than the database does.
  for (const [id, r] of renames) {
    notes.push({ line: 0, message: `"${r.from}" renamed to "${r.to}" to match the file` });
    if (create) await Subject.updateOne({ _id: id }, { $set: { name: r.to } });
  }

  const createdFaculty = new Map();
  for (const [key, f] of newFaculty) {
    let doc = await User.findOne({ email: f.email });
    if (!doc) {
      doc = await User.create({
        name: f.name,
        email: f.email,
        password: 'faculty123',
        role: 'faculty',
        department: sections[0]?.department || 'Computer Science',
      });
      await notify([doc._id], {
        type: 'account:created',
        title: 'Welcome to Sitare University',
        message: `A faculty account was created for you from the timetable upload. Temporary password: faculty123 — please change it.`,
        link: '/',
        createdBy: actor?._id || null,
      });
    }
    createdFaculty.set(key, doc);
  }

  const createdSubjects = new Map();
  for (const [key, s] of newSubjects) {
    const facultyDoc = s.facultyName ? createdFaculty.get(normName(s.facultyName)) : null;
    const resolvedFaculty =
      facultyDoc ||
      facultyByName.get(normName(s.facultyName)) ||
      facultyByName.get(normName(String(s.facultyName).split(/[/,]/)[0]));

    const doc = await Subject.create({
      code: s.code,
      name: s.name,
      semester: Number(semester),
      section: s.sectionId,
      faculty: resolvedFaculty?._id || null,
      department: sections[0]?.department || 'Computer Science',
      plannedClasses: 30,
      minAttendance: 75,
    });
    createdSubjects.set(key, doc);

    /*
     * Enrol the cohort that actually attends. With no section split in the
     * file that is everybody in the semester, not just the primary section —
     * otherwise students in the other sections would never appear on a
     * register.
     */
    const studentFilter = s.wholeSemester
      ? { role: 'student', isActive: true, section: { $in: sections.map((x) => x._id) } }
      : { role: 'student', isActive: true, section: s.sectionId };
    const students = await User.find(studentFilter).select('_id').lean();
    if (students.length) {
      await Enrollment.insertMany(
        students.map((st) => ({ student: st._id, subject: doc._id })),
        { ordered: false }
      ).catch(() => {});
    }
  }

  for (const p of parsed) {
    if (p.pendingSubjectKey) {
      const doc = createdSubjects.get(p.pendingSubjectKey);
      if (doc) {
        p.subject = doc._id;
        if (!p.faculty) p.faculty = doc.faculty;
      }
    }
    if (p.pendingFacultyKey) {
      const doc = createdFaculty.get(p.pendingFacultyKey);
      if (doc) p.faculty = doc._id;
    }
  }

  // Report what was actually written, not what was planned — the two can
  // differ when an account already existed under the same address.
  return {
    parsed,
    errors,
    warnings,
    notes,
    toCreate,
    created: { faculty: createdFaculty.size, subjects: createdSubjects.size },
  };
}

/**
 * Dry run — the admin sees exactly what was read out of the file before
 * anything is written. This review step is what makes PDF input safe: a PDF
 * has no table structure, so extraction is inference, and inference must be
 * confirmed by a human before a whole institute's timetable changes.
 */
export const previewUpload = asyncHandler(async (req, res) => {
  const semester = Number(req.body.semester) || undefined;
  const upload = await readUpload(req, semester);
  const { parsed, errors, warnings, notes, toCreate } = await buildEntriesFromRecords(
    upload.records,
    semester
  );

  res.json({
    success: true,
    data: {
      valid: errors.length === 0,
      notes,
      source: upload.source,
      layout: upload.layout,
      columns: upload.columns || null,
      hasSections: upload.hasSections !== false,
      periods: upload.periods || null,
      lunch: upload.lunch || null,
      legend: upload.legend || [],
      toCreate,
      rowCount: parsed.length,
      readCount: upload.records.length,
      errors,
      warnings: [...new Set(warnings)],
      entries: parsed.map(({ section, subject, faculty, ...rest }) => rest),
    },
  });
});

/** Persist the grid; optionally make it live immediately. */
export const uploadTimetable = asyncHandler(async (req, res) => {
  // Multipart form fields arrive as strings, so coerce rather than trust types.
  const name = String(req.body.name || '').trim();
  const semester = Number(req.body.semester);
  const effectiveFrom = String(req.body.effectiveFrom || '').trim();
  const publish = req.body.publish === true || req.body.publish === 'true';

  if (!name) throw ApiError.badRequest('Give this timetable a name');
  if (!Number.isInteger(semester) || semester < 1 || semester > 10) {
    throw ApiError.badRequest('Choose a valid semester');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    throw ApiError.badRequest('Effective-from date must be YYYY-MM-DD');
  }

  const upload = await readUpload(req, semester);
  const { parsed, errors, warnings, created } = await buildEntriesFromRecords(
    upload.records,
    semester,
    { create: true, actor: req.user }
  );

  if (errors.length) throw ApiError.badRequest(errors[0].message, errors);

  const timetable = await Timetable.create({
    name,
    semester,
    effectiveFrom: toUTCDate(effectiveFrom),
    effectiveFromKey: effectiveFrom,
    uploadedBy: req.user._id,
    status: 'draft',
    // The period grid belongs to this timetable, straight from the file.
    slots: upload.periods || [],
    lunch: upload.lunch || null,
    warnings: [...new Set(warnings)],
    entryCount: parsed.length,
  });

  await TimetableEntry.insertMany(
    parsed.map((p) => ({
      timetable: timetable._id,
      dayOfWeek: p.dayOfWeek,
      slot: p.slot,
      section: p.section,
      subject: p.subject,
      faculty: p.faculty,
      kind: p.kind,
      title: p.title,
    }))
  );

  if (publish) await publishTimetableById(timetable._id, req.user);

  const fresh = await Timetable.findById(timetable._id).lean();
  const madeSubjects = created?.subjects || 0;
  const madeFaculty = created?.faculty || 0;
  const extra = [
    madeSubjects && `${madeSubjects} subject${madeSubjects === 1 ? '' : 's'}`,
    madeFaculty && `${madeFaculty} faculty account${madeFaculty === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join(' and ');

  res.status(201).json({
    success: true,
    message:
      (publish ? 'Timetable published' : 'Timetable saved as draft') +
      (extra ? ` — ${extra} created` : ''),
    data: {
      id: String(fresh._id),
      name: fresh.name,
      status: fresh.status,
      entryCount: fresh.entryCount,
      warnings: fresh.warnings,
      created: { subjects: madeSubjects, faculty: madeFaculty },
    },
  });
});

/** Exactly one published grid per semester; the previous one is archived. */
async function publishTimetableById(timetableId, actor) {
  const timetable = await Timetable.findById(timetableId);
  if (!timetable) throw ApiError.notFound('Timetable not found');

  await Timetable.updateMany(
    { _id: { $ne: timetable._id }, semester: timetable.semester, status: 'published' },
    { $set: { status: 'archived' } }
  );

  timetable.status = 'published';
  timetable.publishedAt = new Date();
  await timetable.save();

  const audience = await User.find({ isActive: true }).select('_id').lean();
  await notify(
    audience.map((u) => u._id),
    {
      type: 'timetable:published',
      title: 'Timetable updated',
      message: `"${timetable.name}" is now the live timetable for semester ${timetable.semester}.`,
      link: '/timetable',
      createdBy: actor._id,
      meta: { timetableId: String(timetable._id) },
    }
  );

  return timetable;
}

export const publishTimetable = asyncHandler(async (req, res) => {
  const tt = await publishTimetableById(req.params.timetableId, req.user);
  res.json({
    success: true,
    message: 'Timetable published to all staff and students',
    data: { id: String(tt._id), status: tt.status },
  });
});

/**
 * Delete any version, live or not. Removing the published one simply leaves
 * that semester without a timetable until another is published — nothing else
 * depends on it, because one-off changes attach to dates rather than the grid.
 */
export const deleteTimetable = asyncHandler(async (req, res) => {
  const tt = await Timetable.findById(req.params.timetableId);
  if (!tt) throw ApiError.notFound('Timetable not found');

  const wasLive = tt.status === 'published';
  const removed = (await TimetableEntry.deleteMany({ timetable: tt._id })).deletedCount;
  await tt.deleteOne();

  res.json({
    success: true,
    message: `"${tt.name}" deleted — ${removed} periods removed${
      wasLive ? `. Semester ${tt.semester} now has no live timetable.` : ''
    }`,
    data: { wasLive, periods: removed },
  });
});
