import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { ENTRY_KINDS } from '../config/slots.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { parseCSVToObjects, toCSV, TIMETABLE_COLUMNS } from '../utils/csv.js';
import { parseTimetablePDF } from '../services/pdfParser.js';
import { todayKey, toUTCDate } from '../utils/date.js';
import { idOf, sameId } from '../utils/ids.js';
import { sectionIdOf } from '../utils/user.js';
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
  subjectId: z.string().uuid().nullable().optional(),
  /** Or name one: renames the current subject, or creates it if there is none. */
  subjectName: z.string().trim().min(1).max(160).optional(),
  subjectCode: z.string().trim().min(1).max(12).optional(),

  facultyId: z.string().uuid().nullable().optional(),
  /**
   * 'subject' hands the whole subject to that lecturer everywhere it runs.
   * 'day' hands them only this subject's periods on this one recurring day —
   * a double or triple period is one sitting, so correcting it should not
   * mean repeating the fix period by period, but it must not spill onto a
   * different day the same subject also runs on. 'entry' changes this one
   * period only, for a period genuinely taken by somebody else.
   */
  applyFacultyTo: z.enum(['subject', 'day', 'entry']).optional().default('subject'),

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
  const timetable = await prisma.timetable.findUnique({ where: { id: entry.timetableId } });
  const semester = timetable?.semester;

  /*
   * Collected rather than written as we go, so a correction touching four
   * fields is one update at the bottom instead of four round trips — and
   * cannot half-apply if one of them is rejected.
   */
  const data = {};
  const changes = [];

  /* ---- Which subject this period is ---- */
  if (body.subjectId !== undefined) {
    if (body.subjectId === null) {
      data.subjectId = null;
      entry.subjectId = null;
      changes.push('subject cleared');
    } else {
      const next = await prisma.subject.findUnique({ where: { id: body.subjectId } });
      if (!next) throw ApiError.notFound('Subject not found');
      data.subjectId = next.id;
      entry.subjectId = next.id;
      changes.push(`now ${next.code}`);
    }
  }

  /* ---- Its name and code, corrected for good ---- */
  if (body.subjectName || body.subjectCode) {
    const current = entry.subjectId
      ? await prisma.subject.findUnique({ where: { id: entry.subjectId } })
      : null;

    if (current) {
      const before = current.name;
      const patch = {};
      if (body.subjectName) patch.name = body.subjectName;
      if (body.subjectCode) patch.code = body.subjectCode.toUpperCase();
      const saved = await prisma.subject.update({ where: { id: current.id }, data: patch });
      if (body.subjectName && body.subjectName !== before) {
        changes.push(`renamed "${before}" to "${body.subjectName}"`);
      }
      if (body.subjectCode) changes.push(`code ${saved.code}`);
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
      data.subjectId = created.id;
      entry.subjectId = created.id;
      if (entry.kind === 'event') data.kind = 'lecture';
      changes.push(`created ${created.code} and enrolled the cohort`);
    }
  }

  /* ---- Who takes it ---- */
  if (body.facultyId !== undefined) {
    const person = body.facultyId
      ? await prisma.user.findFirst({
          where: { id: body.facultyId, role: 'faculty', isActive: true },
        })
      : null;
    if (body.facultyId && !person) throw ApiError.notFound('That lecturer was not found');

    if (body.applyFacultyTo === 'entry') {
      data.facultyId = person?.id || null;
      changes.push(person ? `${person.name} takes this period` : 'lecturer cleared here');
    } else if (body.applyFacultyTo === 'day' && entry.subjectId) {
      // Every period of this same subject, this same day, for this same
      // cohort — the whole block this one period belongs to.
      await prisma.timetableEntry.updateMany({
        where: {
          timetableId: entry.timetableId,
          dayOfWeek: entry.dayOfWeek,
          subjectId: entry.subjectId,
          sectionId: entry.sectionId ?? null,
        },
        data: { facultyId: person?.id || null },
      });
      // Keeps the update below from writing a stale value back over this.
      data.facultyId = person?.id || null;
      changes.push(
        person
          ? `${person.name} takes every period of this subject on ${dayName(entry.dayOfWeek)}`
          : `lecturer cleared for every period of this subject on ${dayName(entry.dayOfWeek)}`
      );
    } else {
      // A subject always has an owner — "left unassigned" would null out a
      // required field. Clearing for just this period is what 'entry' is for.
      if (!person) {
        throw ApiError.badRequest(
          'A subject must have a lecturer — clear the lecturer for just this period instead, or choose a replacement.'
        );
      }
      /*
       * "Becomes theirs everywhere" has to mean everywhere. Handing the
       * subject over is only half of it: each period can carry its own
       * lecturer, and any period still holding one goes on displaying the
       * previous lecturer no matter who owns the subject. Clearing them is
       * what makes the rest of the grid follow — without it exactly one cell
       * changed, the one that was clicked, and the option silently did
       * something much narrower than it offered.
       *
       * Both in one transaction: a subject owned by one lecturer while its
       * periods still name another is the inconsistency this is fixing.
       */
      let followed = 0;
      if (entry.subjectId) {
        const [, cleared] = await prisma.$transaction([
          prisma.subject.update({
            where: { id: entry.subjectId },
            data: { facultyId: person.id },
          }),
          prisma.timetableEntry.updateMany({
            where: { subjectId: entry.subjectId, facultyId: { not: null } },
            data: { facultyId: null },
          }),
        ]);
        followed = cleared.count;
      }
      // This period inherits the new owner along with the rest.
      data.facultyId = null;
      changes.push(
        followed > 1
          ? `assigned to ${person.name} — ${followed} periods now follow the subject`
          : `assigned to ${person.name}`
      );
    }
  }

  if (body.kind !== undefined) {
    data.kind = body.kind;
    changes.push(`kind ${body.kind}`);
  }
  if (body.title !== undefined) {
    data.title = body.title;
    changes.push(body.title ? `note "${body.title}"` : 'note cleared');
  }
  if (body.room !== undefined) data.room = body.room;

  await prisma.timetableEntry.update({ where: { id: entry.id }, data });

  /*
   * A correction is not private: the lecturer who has just been given the
   * subject, and the cohort sitting in it, are looking at the same grid.
   */
  const staff = await facultyAndAdminIds();
  const students = await studentAudience({
    subjectId: entry.subjectId,
    sectionId: entry.sectionId,
  });
  emitToUsers([...staff, ...students, idOf(req.user)], 'timetable:changed', {
    reason: 'corrected',
  });

  res.json({
    success: true,
    message: changes.length ? `Updated — ${changes.join(', ')}` : 'Nothing to change',
    data: { entryId: entry.id },
  });
});

/**
 * Build the subject a corrected period needs, and enrol whoever sits in it.
 * Without the enrolment the register would open with nobody on it.
 */
async function createSubjectForEntry(entry, { name, code, semester, facultyId }) {
  const sectionId = entry.sectionId || null;
  const sections = await prisma.section.findMany({
    where: { isActive: true, semester: Number(semester) },
  });
  const owner = sectionId || sections[0]?.id;
  if (!owner) throw ApiError.badRequest('This semester has no cohort to attach a subject to');

  const taken = new Set(
    (
      await prisma.subject.findMany({ where: { sectionId: owner }, select: { code: true } })
    ).map((s) => s.code.toUpperCase())
  );
  const finalCode = code ? code.toUpperCase() : deriveCode(name, taken);
  if (code && taken.has(finalCode)) {
    throw ApiError.conflict(`${finalCode} already exists for this cohort`);
  }

  const subject = await prisma.subject.create({
    data: {
      code: finalCode,
      name,
      semester: Number(semester),
      sectionId: owner,
      facultyId: facultyId || null,
      department: sections[0]?.department || 'Computer Science',
      plannedClasses: 30,
      minAttendance: 75,
    },
  });

  /*
   * A section-less period is the whole year sitting together, so everybody in
   * the semester attends it — not just the cohort the subject hangs off.
   */
  const where = sectionId
    ? { role: 'student', isActive: true, sectionId }
    : { role: 'student', isActive: true, sectionId: { in: sections.map(idOf) } };
  const students = await prisma.user.findMany({ where, select: { id: true } });
  if (students.length) {
    await prisma.enrollment.createMany({
      data: students.map((st) => ({ studentId: st.id, subjectId: subject.id })),
      skipDuplicates: true,
    });
  }

  return subject;
}

/* ------------------------------------------------------------------ */
/* Who marks a period's register                                       */
/* ------------------------------------------------------------------ */

const attendanceBySchema = z.object({
  // null clears the hand-over and returns the register to its own lecturer.
  facultyId: z.string().uuid().nullable(),
  // Only needed for a period that carries no subject, e.g. "Session with Dean".
  subjectId: z.string().uuid().nullable().optional(),
  // The single class being handed over. Never the whole weekly period.
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
});

const loadEntryForAdmin = async (entryId) => {
  const entry = await prisma.timetableEntry.findUnique({
    where: { id: entryId },
    include: {
      subject: { select: { id: true, code: true, name: true, facultyId: true, semester: true } },
      faculty: { select: { id: true, name: true, email: true } },
      section: { select: { id: true, name: true, semester: true } },
    },
  });
  if (!entry) throw ApiError.notFound('That period is not on the timetable');
  return entry;
};

/** The hand-over in force for one dated class, if there is one. */
const delegationFor = (entry, dateKey) =>
  prisma.attendanceDelegation.findFirst({
    where: {
      dateKey,
      slot: entry.slot,
      OR: [
        { entryId: entry.id },
        ...(entry.subjectId ? [{ subjectId: entry.subjectId }] : []),
      ],
    },
    include: { faculty: { select: { id: true, name: true, email: true } } },
  });

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

  const ownerId = entry.facultyId || entry.subject?.facultyId || '';
  const current = await delegationFor(entry, date);

  const [faculty, { byDate }] = await Promise.all([
    // The owner is not a stand-in for themselves — "its own lecturer" is the
    // other option in the list.
    prisma.user.findMany({
      where: { role: 'faculty', isActive: true, ...(ownerId ? { id: { not: ownerId } } : {}) },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    }),
    resolveOccurrences([date]),
  ]);

  const atSlot = (byDate[date] || []).filter(
    (o) =>
      o.slot === entry.slot &&
      !['moved-out', 'cancelled'].includes(o.origin) &&
      !sameId(o.entryId, entry)
  );
  const busy = new Map();
  for (const o of atSlot) {
    if (o.faculty) busy.set(idOf(o.faculty), o);
  }

  res.json({
    success: true,
    data: {
      date,
      slot: entry.slot,
      owner: entry.faculty
        ? { id: entry.faculty.id, name: entry.faculty.name }
        : entry.subject?.facultyId
          ? { id: entry.subject.facultyId, name: '' }
          : null,
      subject: entry.subject
        ? { id: entry.subject.id, code: entry.subject.code, name: entry.subject.name }
        : null,
      title: entry.title,
      attendanceBy: current?.faculty
        ? { id: current.faculty.id, name: current.faculty.name }
        : null,
      // What the hand-over's register counts towards, when the period has no
      // subject of its own.
      countsToward: current?.subjectId || null,
      candidates: faculty.map((f) => {
        const clash = busy.get(idOf(f));
        return {
          id: f.id,
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
    if (existing) await prisma.attendanceDelegation.delete({ where: { id: existing.id } });
    return res.json({
      success: true,
      message: 'Register returned to its own lecturer',
      data: { entryId: entry.id, date },
    });
  }

  const person = await prisma.user.findFirst({
    where: { id: facultyId, role: 'faculty', isActive: true },
  });
  if (!person) throw ApiError.notFound('That lecturer was not found');

  /*
   * A period with no subject has no register — there is nothing for the marks
   * to be recorded against. The admin names one in the same step, and it is
   * stored on the hand-over rather than written onto the weekly grid, so the
   * period itself stays the event it was.
   */
  const subject =
    entry.subject || (subjectId ? await prisma.subject.findUnique({ where: { id: subjectId } }) : null);
  if (!subject) {
    throw ApiError.badRequest(
      'This period has no subject, so there is no register to mark. Choose the subject its attendance counts towards.'
    );
  }

  const doc = await prisma.attendanceDelegation.upsert({
    where: {
      subjectId_dateKey_slot: { subjectId: subject.id, dateKey: date, slot: entry.slot },
    },
    create: {
      subjectId: subject.id,
      dateKey: date,
      slot: entry.slot,
      facultyId: person.id,
      entryId: entry.id,
      assignedById: idOf(req.user),
    },
    update: { facultyId: person.id, entryId: entry.id, assignedById: idOf(req.user) },
  });

  const what = `${subject.code}${entry.title ? ` (${entry.title})` : ''} on ${date}, period ${entry.slot}`;
  await notify([person.id], {
    type: 'attendance:delegated',
    title: 'You have been asked to mark a register',
    message: `${what}. Just this one class — the marks are recorded against its own lecturer.`,
    link: '/faculty',
    createdBy: idOf(req.user),
  });

  const owner = entry.facultyId || subject.facultyId || null;
  if (owner && !sameId(owner, person)) {
    await notify([owner], {
      type: 'attendance:delegated',
      title: 'Someone else will mark your register',
      message: `${person.name} was asked to mark ${what}. The attendance still counts as yours.`,
      link: '/faculty',
      createdBy: idOf(req.user),
    });
  }

  res.json({
    success: true,
    message: `Register for ${date} handed to ${person.name}`,
    data: { entryId: entry.id, date, id: doc.id },
  });
});

/* ------------------------------------------------------------------ */
/* Reading the grid                                                    */
/* ------------------------------------------------------------------ */

/** Slot/day/section reference data the client needs to draw the grid. */
export const getMeta = asyncHandler(async (req, res) => {
  const [sections, published] = await Promise.all([
    prisma.section.findMany({
      where: { isActive: true },
      orderBy: [{ semester: 'asc' }, { name: 'asc' }],
    }),
    getPublishedTimetables(),
  ]);

  // Which semesters actually have a live grid — the selector is built from this.
  // Each carries its own period times, because timetables do not share a clock.
  const semesters = published
    .map((t) => ({
      semester: t.semester,
      timetableId: t.id,
      name: t.name,
      slots: slotsOf(t),
      // Four columns reassembled into the shape the client already reads.
      lunch: t.lunchStart
        ? {
            label: t.lunchLabel || 'LUNCH',
            start: t.lunchStart,
            end: t.lunchEnd,
            afterSlot: t.lunchAfterSlot,
          }
        : LUNCH,
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
      sections: sections.map((s) => ({ id: s.id, name: s.name, semester: s.semester })),
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
    const own = sectionIdOf(req.user);
    if (!own) throw ApiError.badRequest('You have not been assigned to a semester yet');
    const section = await prisma.section.findUnique({ where: { id: own } });
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
  const list = await prisma.timetable.findMany({
    orderBy: { createdAt: 'desc' },
    take: 30,
    include: { uploadedBy: { select: { name: true } } },
  });

  res.json({
    success: true,
    data: list.map((t) => ({
      id: t.id,
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
      const entries = await prisma.timetableEntry.findMany({
        where: { timetableId: tt.id },
        include: {
          section: { select: { name: true } },
          subject: { select: { code: true } },
          faculty: { select: { email: true } },
        },
        orderBy: [{ dayOfWeek: 'asc' }, { slot: 'asc' }],
      });
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
    prisma.subject.findMany({ where: { isActive: true, ...scope } }),
    prisma.user.findMany({ where: { role: 'faculty', isActive: true } }),
    prisma.section.findMany({ where: { isActive: true, ...scope } }),
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
    const { records } = parseCSVToObjects(req.body.csv, TIMETABLE_COLUMNS);
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
    prisma.section.findMany({ where: { isActive: true, ...scope } }),
    prisma.subject.findMany({
      where: { isActive: true, ...scope },
      include: { section: { select: { id: true, name: true } } },
    }),
    prisma.user.findMany({ where: { role: 'faculty', isActive: true } }),
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
      const doc = await prisma.section.create({
        data: { name, semester: Number(semester), department },
      });
      sections.push(doc);
      sectionByName.set(name, doc);
    } else {
      // Preview only: a stand-in so validation can proceed without writing.
      const stub = { id: `new:${name}`, name, semester: Number(semester), department };
      sections.push(stub);
      sectionByName.set(name, stub);
    }
  }
  const facultyByEmail = new Map(faculty.map((f) => [f.email.toLowerCase(), f]));
  const facultyByName = new Map(faculty.map((f) => [normName(f.name), f]));
  const subjectByKey = new Map(
    subjects.map((s) => [`${s.code.toUpperCase()}|${s.sectionId ?? ''}`, s])
  );
  const subjectByName = new Map(
    subjects.map((s) => [`${normName(s.name)}|${s.sectionId ?? ''}`, s])
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
        new Set(subjects.filter((s) => s.sectionId === sid).map((s) => s.code.toUpperCase()))
      );
    }
    return takenBySection.get(sid);
  };
  const newSubjects = new Map(); // "name|sectionId" -> { name, code, sectionName, facultyName }
  const renames = new Map(); // subjectId -> { from, to }

  const errors = [];
  const warnings = [];
  const notes = [];
  const parsed = [];
  const seenCell = new Map();
  const seenFaculty = new Map();

  /*
   * Existing subjects that have no lecturer of their own and whose lecturer
   * this file names — only ever an account that already exists. Written at
   * commit time, not here, so a preview stays read-only.
   */
  const adoptions = new Map();

  /* Names the file prints that match no account, reported once each. */
  const unmatchedNames = new Map();

  /**
   * The lecturer a printed name refers to — only ever an account that already
   * exists.
   *
   * It used to create one, inventing an address from the name: "Amit Sir"
   * became amit.sir@sitare.org. A timetable prints whatever fits the cell — a
   * title, an initial, a nickname, two people sharing a slash — and none of
   * that is an identifier, so the address was a guess that merely looked
   * official, and the account it made was unusable by the person it named.
   * Staff are added in People, where a real address is typed once.
   *
   * A name matching nobody leaves the period unassigned rather than failing
   * the upload: the subject is still created, and an admin assigns its
   * lecturer afterwards — which fills in every period of it at once, because
   * a period with no lecturer of its own shows the subject's.
   */
  const resolveFaculty = (rawName) => {
    const key = normName(rawName);
    if (!key) return null;
    const existing = facultyByName.get(key);
    if (existing) return { id: existing.id, name: existing.name };

    // "Ms Preeti Shukla/Ms Riya Bangera" — the first named owns the subject.
    const primary = String(rawName).split(/[/,]|\s+&\s+/)[0].trim();
    const byPrimary = facultyByName.get(normName(primary));
    if (byPrimary) return { id: byPrimary.id, name: byPrimary.name };

    if (!unmatchedNames.has(key)) unmatchedNames.set(key, primary || String(rawName).trim());
    return null;
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
      const sid = idOf(owner);
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
          renames.set(idOf(subject), { from: subject.name, to: subjName });
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
        if (hit) facultyRef = { id: hit.id, name: hit.name };
        else notes.push({ line, message: `No account for "${email}" — period left unassigned` });
      } else if (facName) {
        facultyRef = resolveFaculty(facName);
      } else if (subject?.facultyId) {
        const hit = faculty.find((f) => sameId(f, subject.facultyId));
        if (hit) facultyRef = { id: hit.id, name: hit.name };
      }

      /*
       * A subject that already exists but has nobody assigned takes the
       * lecturer the file gives it.
       *
       * Only the *first* upload used to assign anyone, because a lecturer was
       * set when a subject was created and never afterwards. Delete the staff
       * — which leaves the subjects standing with facultyId null, by design
       * (see purgeService) — and re-upload the same grid, and every subject
       * stayed unassigned while the periods showed a name, so the Academics
       * list read as assigned and the edit dialog said "Choose…".
       *
       * Deliberately only when there is nobody: a subject that already has a
       * lecturer keeps them. Re-uploading a grid must not silently hand
       * somebody's subject to whoever happens to be printed in a cell — a
       * period covered by a colleague is exactly what the entry's own faculty
       * field is for.
       */
      if (subject && !subject.facultyId && facultyRef && !adoptions.has(subject.id)) {
        adoptions.set(subject.id, { ref: facultyRef, code: subject.code });
        notes.push({
          line,
          message: `${subject.code} had no lecturer — assigned to ${facultyRef.name} from the file`,
        });
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
        section: section?.id || null,
        sectionName: section?.name || 'All',
        subject: subject?.id || null,
        pendingSubjectKey: pendingSubject ? `${normName(subjName)}|${sid}` : null,
        subjectCode: subject?.code || pendingSubject?.code || '',
        subjectName: subject?.name || pendingSubject?.name || '',
        faculty: facultyRef?.id || null,
        facultyName: facultyRef?.name || '',
        kind: effectiveKind,
        title: effectiveTitle,
        isNewSubject: Boolean(pendingSubject),
      });
    }
  }

  /*
   * Once per name, not once per cell: a lecturer printed in twenty periods is
   * one thing for the admin to act on, and twenty identical lines would bury
   * every other note on the page.
   */
  for (const name of unmatchedNames.values()) {
    notes.push({
      line: 0,
      message: `"${name}" is not a staff account — those periods are unassigned. Add them under People, then set the lecturer on the subject.`,
    });
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
    /* Never anyone: the upload creates no accounts. Kept so the client's
       shape does not change, and so "0 to create" stays true rather than
       absent. */
    faculty: [],
    unmatchedFaculty: [...unmatchedNames.values()],
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
    if (create) await prisma.subject.update({ where: { id }, data: { name: r.to } });
  }

  /*
   * No account is ever created here — see resolveFaculty. Staff come from
   * People, where a real address is typed once, and this path only ever
   * matches what is already there.
   */

  /*
   * After the accounts exist, so a name the file introduced for the first time
   * can be adopted in the same upload that creates it.
   */
  for (const [subjectId, a] of adoptions) {
    if (!a.ref.id) continue;
    await prisma.subject.update({ where: { id: subjectId }, data: { facultyId: a.ref.id } });
  }

  const createdSubjects = new Map();
  for (const [key, s] of newSubjects) {
    const resolvedFaculty =
      facultyByName.get(normName(s.facultyName)) ||
      facultyByName.get(normName(String(s.facultyName).split(/[/,]/)[0]));

    const doc = await prisma.subject.create({
      data: {
        code: s.code,
        name: s.name,
        semester: Number(semester),
        sectionId: s.sectionId,
        facultyId: resolvedFaculty ? idOf(resolvedFaculty) : null,
        department: sections[0]?.department || 'Computer Science',
        plannedClasses: 30,
        minAttendance: 75,
      },
    });
    createdSubjects.set(key, doc);

    /*
     * Enrol the cohort that actually attends. With no section split in the
     * file that is everybody in the semester, not just the primary section —
     * otherwise students in the other sections would never appear on a
     * register.
     */
    const where = s.wholeSemester
      ? { role: 'student', isActive: true, sectionId: { in: sections.map(idOf) } }
      : { role: 'student', isActive: true, sectionId: s.sectionId };
    const students = await prisma.user.findMany({ where, select: { id: true } });
    if (students.length) {
      await prisma.enrollment.createMany({
        data: students.map((st) => ({ studentId: st.id, subjectId: doc.id })),
        skipDuplicates: true,
      });
    }
  }

  for (const p of parsed) {
    if (p.pendingSubjectKey) {
      const doc = createdSubjects.get(p.pendingSubjectKey);
      if (doc) {
        p.subject = doc.id;
        if (!p.faculty) p.faculty = doc.facultyId;
      }
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
    created: { faculty: 0, subjects: createdSubjects.size },
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

  const lunch = upload.lunch || null;

  /*
   * The grid and its periods go in together. A timetable whose slot list did
   * not make it would render every period as "Period 3" with no times, which
   * looks like a parsing failure rather than a half-written record.
   */
  const timetable = await prisma.timetable.create({
    data: {
      name,
      semester,
      effectiveFrom: toUTCDate(effectiveFrom),
      effectiveFromKey: effectiveFrom,
      uploadedById: idOf(req.user),
      status: 'draft',
      // The period grid belongs to this timetable, straight from the file.
      slots: {
        create: (upload.periods || []).map((s) => ({
          slot: s.slot,
          label: s.label,
          start: s.start,
          end: s.end,
        })),
      },
      lunchLabel: lunch?.label ?? null,
      lunchStart: lunch?.start ?? null,
      lunchEnd: lunch?.end ?? null,
      lunchAfterSlot: lunch?.afterSlot ?? null,
      warnings: [...new Set(warnings)],
      entryCount: parsed.length,
    },
  });

  await prisma.timetableEntry.createMany({
    data: parsed.map((p) => ({
      timetableId: timetable.id,
      dayOfWeek: p.dayOfWeek,
      slot: p.slot,
      sectionId: p.section,
      subjectId: p.subject,
      facultyId: p.faculty,
      kind: p.kind,
      title: p.title,
    })),
  });

  if (publish) await publishTimetableById(timetable.id, req.user);

  const fresh = await prisma.timetable.findUnique({ where: { id: timetable.id } });
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
      id: fresh.id,
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
  const timetable = await prisma.timetable.findUnique({ where: { id: timetableId } });
  if (!timetable) throw ApiError.notFound('Timetable not found');

  /*
   * Archive-then-publish in one transaction. A unique index enforces one
   * published grid per semester, so the two steps are not merely tidy — run
   * apart, the publish would collide with the version it is replacing.
   */
  const [, published] = await prisma.$transaction([
    prisma.timetable.updateMany({
      where: { id: { not: timetable.id }, semester: timetable.semester, status: 'published' },
      data: { status: 'archived' },
    }),
    prisma.timetable.update({
      where: { id: timetable.id },
      data: { status: 'published', publishedAt: new Date() },
    }),
  ]);

  const audience = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true },
  });
  await notify(audience.map(idOf), {
    type: 'timetable:published',
    title: 'Timetable updated',
    message: `"${published.name}" is now the live timetable for semester ${published.semester}.`,
    link: '/timetable',
    createdBy: idOf(actor),
    meta: { timetableId: published.id },
  });

  return published;
}

export const publishTimetable = asyncHandler(async (req, res) => {
  const tt = await publishTimetableById(req.params.timetableId, req.user);
  res.json({
    success: true,
    message: 'Timetable published to all staff and students',
    data: { id: tt.id, status: tt.status },
  });
});

/**
 * Delete any version, live or not. Removing the published one simply leaves
 * that semester without a timetable until another is published — nothing else
 * depends on it, because one-off changes attach to dates rather than the grid.
 */
export const deleteTimetable = asyncHandler(async (req, res) => {
  const tt = await prisma.timetable.findUnique({ where: { id: req.params.timetableId } });
  if (!tt) throw ApiError.notFound('Timetable not found');

  const wasLive = tt.status === 'published';
  /*
   * Everything hanging off the grid goes with it, in one transaction: swaps
   * and hand-overs point at periods, and a foreign key will not let those
   * outlive the rows they name.
   */
  const entries = await prisma.timetableEntry.findMany({
    where: { timetableId: tt.id },
    select: { id: true },
  });
  const entryIds = entries.map(idOf);
  const [, , , , removedEntries] = await prisma.$transaction([
    prisma.swapRequest.deleteMany({
      where: { OR: [{ fromEntryId: { in: entryIds } }, { toEntryId: { in: entryIds } }] },
    }),
    prisma.attendanceDelegation.deleteMany({ where: { entryId: { in: entryIds } } }),
    prisma.scheduleChange.deleteMany({ where: { timetableId: tt.id } }),
    prisma.timetableSlot.deleteMany({ where: { timetableId: tt.id } }),
    prisma.timetableEntry.deleteMany({ where: { timetableId: tt.id } }),
    prisma.timetable.delete({ where: { id: tt.id } }),
  ]);
  const removed = removedEntries.count;

  res.json({
    success: true,
    message: `"${tt.name}" deleted — ${removed} periods removed${
      wasLive ? `. Semester ${tt.semester} now has no live timetable.` : ''
    }`,
    data: { wasLive, periods: removed },
  });
});
