import { z } from 'zod';
import ExamSchedule, { EXAM_TYPES } from '../models/ExamSchedule.js';
import Section from '../models/Section.js';
import Subject from '../models/Subject.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { putFile, openFile, deleteFiles } from '../services/fileStore.js';
import { notify, withdrawNotifications } from '../services/notificationService.js';
import { emitToUsers } from '../sockets/index.js';

/*
 * Exam timetables.
 *
 * The administration publishes; everyone else reads. A student sees only their
 * own year's schedule, taken from their record rather than from a query
 * parameter — otherwise another year's paper list is a URL edit away.
 */

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const clockTime = z
  .string()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Use HH:MM')
  .or(z.literal(''));

const paperSchema = z
  .object({
    subjectId: z.string().length(24).nullable().optional(),
    label: z.string().trim().max(160).optional().default(''),
    dateKey: dateOnly,
    startTime: clockTime.optional().default(''),
    endTime: clockTime.optional().default(''),
    room: z.string().trim().max(60).optional().default(''),
  })
  .refine((p) => p.subjectId || p.label.trim(), {
    message: 'Each paper needs a subject or a name',
    path: ['label'],
  })
  .refine((p) => !p.startTime || !p.endTime || p.endTime > p.startTime, {
    message: 'The paper cannot end before it starts',
    path: ['endTime'],
  });

const publishSchema = z.object({
  title: z.string().trim().min(3, 'Give this schedule a title').max(200),
  examType: z.enum(EXAM_TYPES).optional().default('end-term'),
  semester: z.coerce.number().int().min(1).max(10),
  sectionId: z.string().length(24).nullable().optional(),
  instructions: z.string().trim().max(5000).optional().default(''),
  /** Arrives as a JSON string because the request is multipart. */
  papers: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The paper list could not be read' });
        return z.NEVER;
      }
    })
    .pipe(z.array(paperSchema).max(60)),
});

/**
 * `protect` populates the signed-in user's section, so it arrives as a
 * document rather than an id. A query filter casts it, but a string comparison
 * silently never matches.
 */
const idOf = (v) => (v ? String(v._id ?? v) : '');

const shape = (e) => {
  const papers = [...(e.papers || [])].sort(
    (a, b) => a.dateKey.localeCompare(b.dateKey) || (a.startTime || '').localeCompare(b.startTime || '')
  );
  const dates = papers.map((p) => p.dateKey);
  return {
    id: String(e._id),
    title: e.title,
    examType: e.examType,
    semester: e.semester,
    section: e.section ? { id: String(e.section._id ?? e.section), name: e.section.name } : null,
    instructions: e.instructions,
    startsOn: dates[0] || null,
    endsOn: dates[dates.length - 1] || null,
    publishedBy: e.publishedBy?.name ? { name: e.publishedBy.name } : null,
    publishedOn: e.createdAt,
    papers: papers.map((p) => ({
      id: String(p._id),
      subject: p.subject
        ? { id: String(p.subject._id ?? p.subject), code: p.subject.code, name: p.subject.name }
        : null,
      label: p.label,
      dateKey: p.dateKey,
      startTime: p.startTime,
      endTime: p.endTime,
      room: p.room,
    })),
    attachments: (e.attachments || []).map((a) => ({
      id: String(a._id),
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
    })),
  };
};

/** What this caller may see. */
function scopeFor(user, query) {
  if (user.role === 'student') {
    return {
      semester: user.semester,
      $or: [{ section: idOf(user.section) || null }, { section: null }],
    };
  }
  const filter = {};
  if (query.semester) filter.semester = Number(query.semester);
  if (query.section) filter.section = query.section;
  if (query.examType) filter.examType = query.examType;
  return filter;
}

export const listExams = asyncHandler(async (req, res) => {
  const exams = await ExamSchedule.find(scopeFor(req.user, req.query))
    .populate('section', 'name')
    .populate('papers.subject', 'code name')
    .populate('publishedBy', 'name')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  res.json({ success: true, data: exams.map(shape) });
});

/** Everyone the schedule concerns: the cohort, and the staff who teach them. */
async function audienceFor({ semester, sectionId }) {
  const studentFilter = { role: 'student', isActive: true };
  if (sectionId) studentFilter.section = sectionId;
  else studentFilter.semester = semester;

  const [students, subjects] = await Promise.all([
    User.find(studentFilter).select('_id').lean(),
    Subject.find({ semester, isActive: true }).select('faculty').lean(),
  ]);

  const staff = [...new Set(subjects.map((s) => s.faculty).filter(Boolean).map(String))];
  return { students: students.map((s) => String(s._id)), staff };
}

export const publishExam = asyncHandler(async (req, res) => {
  const body = publishSchema.parse(req.body);
  const files = req.files || [];

  if (!files.length && !body.papers.length) {
    throw ApiError.badRequest('Attach the timetable, or list the papers');
  }

  let section = null;
  if (body.sectionId) {
    section = await Section.findById(body.sectionId);
    if (!section) throw ApiError.notFound('Section not found');
    if (section.semester !== body.semester) {
      throw ApiError.badRequest('That section belongs to a different semester');
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
          meta: { kind: 'exam-schedule', semester: body.semester },
        })
      );
    }

    const exam = await ExamSchedule.create({
      title: body.title,
      examType: body.examType,
      semester: body.semester,
      section: section?._id || null,
      instructions: body.instructions,
      papers: body.papers.map((p) => ({
        subject: p.subjectId || null,
        label: p.label,
        dateKey: p.dateKey,
        startTime: p.startTime,
        endTime: p.endTime,
        room: p.room,
      })),
      attachments: stored,
      publishedBy: req.user._id,
    });

    /*
     * Both audiences at once. Teachers need the dates as much as students —
     * they invigilate, and their own classes stop while exams run.
     */
    const { students, staff } = await audienceFor({
      semester: body.semester,
      sectionId: section?._id,
    });
    const who = [...new Set([...students, ...staff])];
    if (who.length) {
      await notify(who, {
        type: 'exam:published',
        title: 'Exam timetable published',
        message: `${body.title} — semester ${body.semester}${section?.name ? `, section ${section.name}` : ''}.`,
        link: '/exams',
        createdBy: req.user._id,
        // Tagged so the notification can be taken back if this is withdrawn.
        meta: { examId: String(exam._id) },
      });
      emitToUsers(who, 'exam:published', { examId: String(exam._id) });
    }

    const full = await ExamSchedule.findById(exam._id)
      .populate('section', 'name')
      .populate('papers.subject', 'code name')
      .populate('publishedBy', 'name')
      .lean();

    res.status(201).json({ success: true, message: 'Exam timetable published', data: shape(full) });
  } catch (err) {
    // Never leave uploaded files orphaned in storage behind a failed record.
    await deleteFiles(stored.map((s) => s.fileId));
    throw err;
  }
});

/** A schedule is readable by the cohort it is addressed to, and by all staff. */
async function loadVisible(user, examId) {
  const exam = await ExamSchedule.findById(examId);
  if (!exam) throw ApiError.notFound('That exam timetable no longer exists');

  if (user.role === 'student') {
    const sameYear = Number(exam.semester) === Number(user.semester);
    const forThem = !exam.section || idOf(exam.section) === idOf(user.section);
    if (!sameYear || !forThem) {
      throw ApiError.forbidden('That timetable is not for your year');
    }
  }
  return exam;
}

export const downloadExamFile = asyncHandler(async (req, res) => {
  const exam = await loadVisible(req.user, req.params.examId);

  const attachment = (exam.attachments || []).find(
    (a) => String(a._id) === String(req.params.attachmentId)
  );
  if (!attachment) throw ApiError.notFound('That file is not on this timetable');

  const { file, stream } = await openFile(attachment.fileId);

  res.setHeader('Content-Type', attachment.contentType || 'application/octet-stream');
  res.setHeader('Content-Length', file.length);
  // Always a download; nothing uploaded should render in a signed-in origin.
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(attachment.filename)}"`
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

export const deleteExam = asyncHandler(async (req, res) => {
  const exam = await ExamSchedule.findById(req.params.examId);
  if (!exam) throw ApiError.notFound('That exam timetable no longer exists');

  await deleteFiles((exam.attachments || []).map((a) => a.fileId));
  // Nobody should keep being told about a timetable that is gone.
  await withdrawNotifications({ type: 'exam:published', 'meta.examId': String(exam._id) });
  await exam.deleteOne();

  res.json({ success: true, message: 'Exam timetable removed', data: { id: String(exam._id) } });
});
