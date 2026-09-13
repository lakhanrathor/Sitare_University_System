import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { idOf, sameId } from '../utils/ids.js';
import { sectionIdOf } from '../utils/user.js';
import { putFile, openFile, deleteFiles } from '../services/fileStore.js';
import { notify, withdrawNotifications } from '../services/notificationService.js';

/*
 * Course material, shared with a cohort.
 *
 * Lecturers publish; students read and download. A student only ever sees
 * material addressed to their own year — and to their section, or to the year
 * as a whole.
 */

const uploadSchema = z.object({
  title: z.string().trim().min(2, 'Give these notes a title').max(200),
  description: z.string().trim().max(5000).optional().default(''),
  semester: z.coerce.number().int().min(1).max(10),
  sectionId: z.string().uuid().nullable().optional(),
  subjectId: z.string().uuid().nullable().optional(),
});

const shape = (n) => ({
  id: n.id,
  title: n.title,
  description: n.description,
  semester: n.semester,
  section: n.section ? { id: n.section.id, name: n.section.name } : null,
  subject: n.subject ? { id: n.subject.id, code: n.subject.code, name: n.subject.name } : null,
  uploadedBy: n.uploadedBy?.name ? { id: n.uploadedBy.id, name: n.uploadedBy.name } : null,
  postedOn: n.createdAt,
  attachments: (n.attachments || []).map((a) => ({
    id: a.id,
    filename: a.filename,
    contentType: a.contentType,
    size: a.size,
  })),
});

/**
 * An id as a string, whatever shape it arrives in.
 *
 * `protect` populates the signed-in user's section, so `user.section` is a
 * document rather than an id. A query filter still casts it, but a string
 * comparison against one silently never matches — which reads as the student
 * being locked out of their own class's material.
 */

/**
 * What this caller may see.
 *
 * A student's view is fixed by their own record — never by a query parameter,
 * or one could read another year's material by editing the URL.
 *
 * A faculty member's view is fixed the same way: their own uploads, plus
 * whatever cohort their own subjects teach. Without this a lecturer saw every
 * note posted college-wide — someone else's Sem 3 handout showing up for a
 * teacher who has nothing to do with Sem 3 reads as the notes system leaking,
 * not as a feature.
 *
 * Admin keeps the wider view: the query filters narrow it, but with none
 * given they see everything, which is what oversight of the whole notes
 * system requires.
 */
async function scopeFor(user, query) {
  if (user.role === 'student') {
    return {
      semester: user.semester,
      // Their section's material, plus anything addressed to the whole year.
      OR: [{ sectionId: sectionIdOf(user) }, { sectionId: null }],
    };
  }

  /*
   * A lecturer sees what they published, and nothing else.
   *
   * It used to be their own uploads *plus* every note addressed to a cohort
   * they teach, which meant a shared year put each teacher's material in front
   * of all the others. Notes are written for a class, not for the staff room:
   * someone's working draft, their phrasing, the order they choose to teach
   * something in. A colleague reading it changes what people are willing to
   * put up, and no part of this system needs them to.
   *
   * Administrators keep the full list below — somebody has to be able to
   * answer "what has been given to this year", and to remove what should not
   * be there.
   */
  if (user.role === 'faculty') return { uploadedById: idOf(user) };

  const where = {};
  if (query.semester) where.semester = Number(query.semester);
  if (query.section) where.sectionId = query.section;
  if (query.subject) where.subjectId = query.subject;
  if (query.mine === 'true') where.uploadedById = idOf(user);
  return where;
}

export const listNotes = asyncHandler(async (req, res) => {
  const notes = await prisma.note.findMany({
    where: await scopeFor(req.user, req.query),
    include: {
      section: { select: { id: true, name: true } },
      subject: { select: { id: true, code: true, name: true } },
      uploadedBy: { select: { id: true, name: true } },
      attachments: { orderBy: { createdAt: 'asc' } },
    },
    orderBy: { createdAt: 'desc' },
    take: 300,
  });

  res.json({ success: true, data: notes.map(shape) });
});

/**
 * Who these notes are for.
 *
 * Enrolment is the precise answer when a subject is named — it leaves out
 * anyone not taking that elective. Otherwise it is the section, or, for
 * material addressed to a whole year, everyone in it. The shared helper stops
 * at the section and would tell nobody about a year-wide note.
 */
async function cohortFor({ subject, section, semester }) {
  if (subject) {
    const rows = await prisma.enrollment.findMany({
      where: { subjectId: subject.id, isActive: true },
      select: { studentId: true },
    });
    if (rows.length) return rows.map((r) => r.studentId);
  }
  const where = { role: 'student', isActive: true };
  if (section) where.sectionId = section.id;
  else where.semester = semester;
  const rows = await prisma.user.findMany({ where, select: { id: true } });
  return rows.map(idOf);
}

/** Publish notes to a cohort. */
export const createNote = asyncHandler(async (req, res) => {
  const { title, description, semester, sectionId, subjectId } = uploadSchema.parse(req.body);
  const files = req.files || [];

  if (!files.length) throw ApiError.badRequest('Attach at least one file');

  let section = null;
  if (sectionId) {
    section = await prisma.section.findUnique({ where: { id: sectionId } });
    if (!section) throw ApiError.notFound('Section not found');
    if (section.semester !== semester) {
      throw ApiError.badRequest('That section belongs to a different semester');
    }
  }

  let subject = null;
  if (subjectId) {
    subject = await prisma.subject.findUnique({ where: { id: subjectId } });
    if (!subject) throw ApiError.notFound('Subject not found');
    /*
     * A lecturer publishes against their own subject. Without this a teacher
     * could file material under a colleague's subject, where it would look
     * like the colleague had posted it.
     */
    if (req.user.role === 'faculty' && !sameId(subject.facultyId, req.user)) {
      throw ApiError.forbidden('You do not teach that subject');
    }
  }

  const stored = [];
  try {
    for (const f of files) {
      stored.push(
        await putFile({
          buffer: f.buffer,
          filename: f.originalname,
          contentType: f.mimetype,
        })
      );
    }

    const note = await prisma.note.create({
      data: {
        title,
        description,
        semester,
        sectionId: section?.id || null,
        subjectId: subject?.id || null,
        uploadedById: idOf(req.user),
        attachments: { create: stored },
      },
    });

    // Tell the cohort it is there — material nobody knows about helps nobody.
    const students = await cohortFor({ subject, section, semester });
    if (students.length) {
      await notify(students, {
        type: 'note:published',
        title: 'New notes published',
        message: `${title}${subject ? ` · ${subject.code}` : ''} — from ${req.user.name}`,
        link: '/notes',
        createdBy: idOf(req.user),
        // Tagged so the notification can be taken back if these are removed.
        meta: { noteId: note.id },
      });
    }

    const full = await prisma.note.findUnique({
      where: { id: note.id },
      include: {
        section: { select: { id: true, name: true } },
        subject: { select: { id: true, code: true, name: true } },
        uploadedBy: { select: { id: true, name: true } },
        attachments: { orderBy: { createdAt: 'asc' } },
      },
    });

    res.status(201).json({ success: true, message: 'Notes published', data: shape(full) });
  } catch (err) {
    // Never leave uploaded files orphaned in storage behind a failed record.
    await deleteFiles(stored.map((s) => s.fileId));
    throw err;
  }
});

/**
 * A note is readable by whoever it was addressed to — this must mirror
 * `scopeFor` exactly. That function decides which notes a faculty member's
 * *list* shows; without the same check here, direct access to one note's id
 * would reach cohorts a lecturer has nothing to do with, even though the list
 * they see never surfaced it in the first place.
 */
async function loadVisible(user, noteId) {
  const note = await prisma.note.findUnique({
    where: { id: noteId },
    include: { attachments: true },
  });
  if (!note) throw ApiError.notFound('Those notes no longer exist');

  if (user.role === 'student') {
    const sameYear = Number(note.semester) === Number(user.semester);
    // No section means the whole year; otherwise it has to be their own.
    const forThem = !note.sectionId || sameId(note.sectionId, sectionIdOf(user));
    if (!sameYear || !forThem) throw ApiError.forbidden('Those notes are not for your class');
  }

  // Mirrors scopeFor: a lecturer's own uploads, and nothing a colleague filed.
  if (user.role === 'faculty' && !sameId(note.uploadedById, user)) {
    throw ApiError.forbidden('Those notes were published by someone else');
  }
  return note;
}

export const downloadNoteFile = asyncHandler(async (req, res) => {
  const note = await loadVisible(req.user, req.params.noteId);

  const attachment = (note.attachments || []).find((a) => sameId(a, req.params.attachmentId));
  if (!attachment) throw ApiError.notFound('That file is not on these notes');

  const { file, stream } = await openFile(attachment.fileId);

  res.setHeader('Content-Type', attachment.contentType || 'application/octet-stream');
  res.setHeader('Content-Length', file.length);
  /*
   * Always a download, never rendered in place: these are files one user
   * uploaded and another opens, and nothing uploaded should execute in the
   * origin holding somebody's session.
   */
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(attachment.filename)}"`
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

/** Withdraw notes you published, or remove any as an administrator. */
export const deleteNote = asyncHandler(async (req, res) => {
  const note = await prisma.note.findUnique({
    where: { id: req.params.noteId },
    include: { attachments: true },
  });
  if (!note) throw ApiError.notFound('Those notes no longer exist');

  const mine = sameId(note.uploadedById, req.user);
  if (req.user.role !== 'admin' && !mine) {
    throw ApiError.forbidden('You can only remove notes you published');
  }

  // Nobody should keep being pointed at material that is gone.
  await withdrawNotifications({
    type: 'note:published',
    meta: { path: ['noteId'], equals: note.id },
  });
  /*
   * The record first, then the bytes. Reversed, the file rows are still
   * referenced by the attachments hanging off the note, and the foreign key
   * refuses the delete.
   */
  await prisma.note.delete({ where: { id: note.id } });
  await deleteFiles((note.attachments || []).map((a) => a.fileId));

  res.json({ success: true, message: 'Notes removed', data: { id: note.id } });
});
