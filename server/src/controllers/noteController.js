import { z } from 'zod';
import Note from '../models/Note.js';
import Section from '../models/Section.js';
import Subject from '../models/Subject.js';
import User from '../models/User.js';
import Enrollment from '../models/Enrollment.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { putFile, openFile, deleteFiles } from '../services/fileStore.js';
import { notify } from '../services/notificationService.js';

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
  sectionId: z.string().length(24).nullable().optional(),
  subjectId: z.string().length(24).nullable().optional(),
});

const shape = (n) => ({
  id: String(n._id),
  title: n.title,
  description: n.description,
  semester: n.semester,
  section: n.section ? { id: String(n.section._id ?? n.section), name: n.section.name } : null,
  subject: n.subject
    ? { id: String(n.subject._id ?? n.subject), code: n.subject.code, name: n.subject.name }
    : null,
  uploadedBy: n.uploadedBy?.name
    ? { id: String(n.uploadedBy._id), name: n.uploadedBy.name }
    : null,
  postedOn: n.createdAt,
  attachments: (n.attachments || []).map((a) => ({
    id: String(a._id),
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
const idOf = (v) => (v ? String(v._id ?? v) : '');

/**
 * What this caller may see.
 *
 * A student's view is fixed by their own record — never by a query parameter,
 * or one could read another year's material by editing the URL.
 */
function scopeFor(user, query) {
  if (user.role === 'student') {
    return {
      semester: user.semester,
      // Their section's material, plus anything addressed to the whole year.
      $or: [{ section: idOf(user.section) || null }, { section: null }],
    };
  }

  const filter = {};
  if (query.semester) filter.semester = Number(query.semester);
  if (query.section) filter.section = query.section;
  if (query.subject) filter.subject = query.subject;
  if (query.mine === 'true') filter.uploadedBy = user._id;
  return filter;
}

export const listNotes = asyncHandler(async (req, res) => {
  const notes = await Note.find(scopeFor(req.user, req.query))
    .populate('section', 'name')
    .populate('subject', 'code name')
    .populate('uploadedBy', 'name')
    .sort({ createdAt: -1 })
    .limit(300)
    .lean();

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
    const rows = await Enrollment.find({ subject: subject._id, isActive: true })
      .select('student')
      .lean();
    if (rows.length) return rows.map((r) => String(r.student));
  }
  const filter = { role: 'student', isActive: true };
  if (section) filter.section = section._id;
  else filter.semester = semester;
  const rows = await User.find(filter).select('_id').lean();
  return rows.map((r) => String(r._id));
}

/** Publish notes to a cohort. */
export const createNote = asyncHandler(async (req, res) => {
  const { title, description, semester, sectionId, subjectId } = uploadSchema.parse(req.body);
  const files = req.files || [];

  if (!files.length) throw ApiError.badRequest('Attach at least one file');

  let section = null;
  if (sectionId) {
    section = await Section.findById(sectionId);
    if (!section) throw ApiError.notFound('Section not found');
    if (section.semester !== semester) {
      throw ApiError.badRequest('That section belongs to a different semester');
    }
  }

  let subject = null;
  if (subjectId) {
    subject = await Subject.findById(subjectId);
    if (!subject) throw ApiError.notFound('Subject not found');
    /*
     * A lecturer publishes against their own subject. Without this a teacher
     * could file material under a colleague's subject, where it would look
     * like the colleague had posted it.
     */
    if (req.user.role === 'faculty' && String(subject.faculty) !== String(req.user._id)) {
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
          meta: { kind: 'note', semester, uploadedBy: String(req.user._id) },
        })
      );
    }

    const note = await Note.create({
      title,
      description,
      semester,
      section: section?._id || null,
      subject: subject?._id || null,
      attachments: stored,
      uploadedBy: req.user._id,
    });

    // Tell the cohort it is there — material nobody knows about helps nobody.
    const students = await cohortFor({ subject, section, semester });
    if (students.length) {
      await notify(students, {
        type: 'note:published',
        title: 'New notes published',
        message: `${title}${subject ? ` · ${subject.code}` : ''} — from ${req.user.name}`,
        link: '/notes',
        createdBy: req.user._id,
      });
    }

    const full = await Note.findById(note._id)
      .populate('section', 'name')
      .populate('subject', 'code name')
      .populate('uploadedBy', 'name')
      .lean();

    res.status(201).json({ success: true, message: 'Notes published', data: shape(full) });
  } catch (err) {
    // Never leave uploaded files orphaned in storage behind a failed record.
    await deleteFiles(stored.map((s) => s.fileId));
    throw err;
  }
});

/** A note is readable by whoever it was addressed to. */
async function loadVisible(user, noteId) {
  const note = await Note.findById(noteId);
  if (!note) throw ApiError.notFound('Those notes no longer exist');

  if (user.role === 'student') {
    const sameYear = Number(note.semester) === Number(user.semester);
    // No section means the whole year; otherwise it has to be their own.
    const forThem = !note.section || idOf(note.section) === idOf(user.section);
    if (!sameYear || !forThem) throw ApiError.forbidden('Those notes are not for your class');
  }
  return note;
}

export const downloadNoteFile = asyncHandler(async (req, res) => {
  const note = await loadVisible(req.user, req.params.noteId);

  const attachment = (note.attachments || []).find(
    (a) => String(a._id) === String(req.params.attachmentId)
  );
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
  const note = await Note.findById(req.params.noteId);
  if (!note) throw ApiError.notFound('Those notes no longer exist');

  const mine = String(note.uploadedBy) === String(req.user._id);
  if (req.user.role !== 'admin' && !mine) {
    throw ApiError.forbidden('You can only remove notes you published');
  }

  await deleteFiles((note.attachments || []).map((a) => a.fileId));
  await note.deleteOne();

  res.json({ success: true, message: 'Notes removed', data: { id: String(note._id) } });
});
