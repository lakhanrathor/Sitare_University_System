import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { EXAM_TYPES } from '../config/exams.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { idOf, sameId } from '../utils/ids.js';
import { sectionIdOf } from '../utils/user.js';
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
    subjectId: z.string().uuid().nullable().optional(),
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
  /*
   * Absent means the whole college. The form sends '' for that, and multipart
   * turns every field into a string, so the empty case is normalised here
   * rather than being coerced to 0 and failing the range check.
   */
  semester: z
    .preprocess(
      (v) => (v === '' || v === null || v === undefined ? null : v),
      z.coerce.number().int().min(1).max(10).nullable()
    )
    .optional()
    .default(null),
  sectionId: z
    .preprocess((v) => (v === '' ? null : v), z.string().uuid().nullable())
    .optional()
    .default(null),
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

/*
 * Correcting a published schedule.
 *
 * Deliberately narrower than publishing: the semester, the section and the
 * attached file are not editable here. Those three decide *who was told* —
 * the notification has already gone to that cohort, and quietly re-pointing a
 * schedule at a different year would leave the wrong people holding it. A
 * schedule addressed to the wrong cohort is withdrawn and published again.
 *
 * Not multipart, unlike publishing, because no file crosses this boundary —
 * so `papers` is a real array rather than a JSON string.
 */
const editSchema = z.object({
  title: z.string().trim().min(3, 'Give this schedule a title').max(200),
  examType: z.enum(EXAM_TYPES),
  instructions: z.string().trim().max(5000).optional().default(''),
  papers: z.array(paperSchema).max(60),
});

/**
 * `protect` populates the signed-in user's section, so it arrives as a
 * document rather than an id. A query filter casts it, but a string comparison
 * silently never matches.
 */

/** How a schedule's audience reads in a notification. */
const cohortLine = (semester, sectionName) => {
  if (semester == null) return 'every year';
  return `semester ${semester}${sectionName ? `, section ${sectionName}` : ''}`;
};

const shape = (e) => {
  const papers = [...(e.papers || [])].sort(
    (a, b) => a.dateKey.localeCompare(b.dateKey) || (a.startTime || '').localeCompare(b.startTime || '')
  );
  const dates = papers.map((p) => p.dateKey);
  return {
    id: e.id,
    title: e.title,
    examType: e.examType,
    semester: e.semester,
    section: e.section ? { id: e.section.id, name: e.section.name } : null,
    instructions: e.instructions,
    startsOn: dates[0] || null,
    endsOn: dates[dates.length - 1] || null,
    publishedBy: e.publishedBy?.name ? { name: e.publishedBy.name } : null,
    publishedOn: e.createdAt,
    papers: papers.map((p) => ({
      id: p.id,
      subject: p.subject ? { id: p.subject.id, code: p.subject.code, name: p.subject.name } : null,
      label: p.label,
      dateKey: p.dateKey,
      startTime: p.startTime,
      endTime: p.endTime,
      room: p.room,
    })),
    attachments: (e.attachments || []).map((a) => ({
      id: a.id,
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
    })),
  };
};

/** What this caller may see. */
function scopeFor(user, query) {
  if (user.role === 'student') {
    /*
     * Two ways a schedule reaches a student: it is addressed to their year
     * (and either to their cohort or to the whole year), or it is addressed to
     * no year at all — the single sheet covering the whole college.
     */
    return {
      OR: [
        { semester: null },
        {
          semester: user.semester,
          OR: [{ sectionId: sectionIdOf(user) }, { sectionId: null }],
        },
      ],
    };
  }
  const where = {};
  // A whole-college sheet is every year's business, so it survives the filter.
  if (query.semester) {
    where.OR = [{ semester: Number(query.semester) }, { semester: null }];
  }
  if (query.section) where.sectionId = query.section;
  if (query.examType) where.examType = query.examType;
  return where;
}

/* The relations every exam response is built from. */
const examInclude = {
  section: { select: { id: true, name: true } },
  publishedBy: { select: { name: true } },
  papers: { include: { subject: { select: { id: true, code: true, name: true } } } },
  attachments: { orderBy: { createdAt: 'asc' } },
};

export const listExams = asyncHandler(async (req, res) => {
  const exams = await prisma.examSchedule.findMany({
    where: scopeFor(req.user, req.query),
    include: examInclude,
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  res.json({ success: true, data: exams.map(shape) });
});

/** Everyone the schedule concerns: the cohort, and the staff who teach them. */
async function audienceFor({ semester, sectionId }) {
  const studentWhere = { role: 'student', isActive: true };
  // A null semester is the whole college, so neither filter narrows anything.
  if (sectionId) studentWhere.sectionId = sectionId;
  else if (semester != null) studentWhere.semester = semester;

  const subjectWhere = { isActive: true };
  if (semester != null) subjectWhere.semester = semester;

  const [students, subjects] = await Promise.all([
    prisma.user.findMany({ where: studentWhere, select: { id: true } }),
    prisma.subject.findMany({ where: subjectWhere, select: { facultyId: true } }),
  ]);

  const staff = [...new Set(subjects.map((s) => s.facultyId).filter(Boolean))];
  return { students: students.map(idOf), staff };
}

export const publishExam = asyncHandler(async (req, res) => {
  const body = publishSchema.parse(req.body);
  const files = req.files || [];

  if (!files.length && !body.papers.length) {
    throw ApiError.badRequest('Attach the timetable, or list the papers');
  }

  let section = null;
  if (body.sectionId) {
    if (body.semester == null) {
      throw ApiError.badRequest(
        'A sheet covering every year cannot be addressed to one section — choose a semester, or leave the section blank'
      );
    }
    section = await prisma.section.findUnique({ where: { id: body.sectionId } });
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
        })
      );
    }

    const exam = await prisma.examSchedule.create({
      data: {
        title: body.title,
        examType: body.examType,
        semester: body.semester,
        sectionId: section?.id || null,
        instructions: body.instructions,
        publishedById: idOf(req.user),
        papers: {
          create: body.papers.map((p) => ({
            subjectId: p.subjectId || null,
            label: p.label,
            dateKey: p.dateKey,
            startTime: p.startTime,
            endTime: p.endTime,
            room: p.room,
          })),
        },
        attachments: { create: stored },
      },
    });

    /*
     * Both audiences at once. Teachers need the dates as much as students —
     * they invigilate, and their own classes stop while exams run.
     */
    const { students, staff } = await audienceFor({
      semester: body.semester,
      sectionId: section?.id,
    });
    const who = [...new Set([...students, ...staff])];
    if (who.length) {
      await notify(who, {
        type: 'exam:published',
        title: 'Exam timetable published',
        message: `${body.title} — ${cohortLine(body.semester, section?.name)}.`,
        link: '/exams',
        createdBy: idOf(req.user),
        // Tagged so the notification can be taken back if this is withdrawn.
        meta: { examId: exam.id },
      });
      emitToUsers(who, 'exam:published', { examId: exam.id });
    }

    const full = await prisma.examSchedule.findUnique({
      where: { id: exam.id },
      include: examInclude,
    });

    res.status(201).json({ success: true, message: 'Exam timetable published', data: shape(full) });
  } catch (err) {
    // Never leave uploaded files orphaned in storage behind a failed record.
    await deleteFiles(stored.map((s) => s.fileId));
    throw err;
  }
});

/*
 * What a reader would notice. Title and instructions are edited far more often
 * than the papers are — a typo in a heading is not worth a notification to
 * three hundred people, but a paper that moved day is.
 */
const paperFingerprint = (papers) =>
  JSON.stringify(
    [...papers]
      .map((p) => [p.subjectId || '', p.label || '', p.dateKey, p.startTime || '', p.endTime || '', p.room || ''])
      .sort()
  );

export const updateExam = asyncHandler(async (req, res) => {
  const body = editSchema.parse(req.body);

  const exam = await prisma.examSchedule.findUnique({
    where: { id: req.params.examId },
    include: { papers: true, attachments: { select: { id: true } } },
  });
  if (!exam) throw ApiError.notFound('That exam timetable no longer exists');

  // The same floor publishing has: a schedule with neither is not a schedule.
  if (!exam.attachments.length && !body.papers.length) {
    throw ApiError.badRequest('Keep at least one paper, or the schedule has nothing in it');
  }

  const before = paperFingerprint(exam.papers);
  const after = paperFingerprint(body.papers);

  /*
   * Replaced wholesale rather than diffed. The dialog hands back the list as
   * the admin now wants it, and a half-applied correction — the old date gone
   * but the new one not yet written — is worse than either state.
   */
  await prisma.$transaction([
    prisma.examPaper.deleteMany({ where: { examId: exam.id } }),
    prisma.examSchedule.update({
      where: { id: exam.id },
      data: {
        title: body.title,
        examType: body.examType,
        instructions: body.instructions,
        papers: {
          create: body.papers.map((p) => ({
            subjectId: p.subjectId || null,
            label: p.label,
            dateKey: p.dateKey,
            startTime: p.startTime,
            endTime: p.endTime,
            room: p.room,
          })),
        },
      },
    }),
  ]);

  /*
   * Only when a paper actually moved. Someone who has already planned around
   * the old date has to be told again — but the correction is a fresh
   * notification rather than an edit of the original, because the original may
   * long since have been read and dismissed.
   */
  if (before !== after) {
    const { students, staff } = await audienceFor({
      semester: exam.semester,
      sectionId: exam.sectionId,
    });
    const who = [...new Set([...students, ...staff])];
    if (who.length) {
      await notify(who, {
        type: 'exam:updated',
        title: 'Exam timetable corrected',
        message: `${body.title} — check your paper dates again.`,
        link: '/exams',
        createdBy: idOf(req.user),
        meta: { examId: exam.id },
      });
      emitToUsers(who, 'exam:published', { examId: exam.id });
    }
  }

  const full = await prisma.examSchedule.findUnique({
    where: { id: exam.id },
    include: examInclude,
  });

  res.json({ success: true, message: 'Exam timetable updated', data: shape(full) });
});

/** A schedule is readable by the cohort it is addressed to, and by all staff. */
async function loadVisible(user, examId) {
  const exam = await prisma.examSchedule.findUnique({
    where: { id: examId },
    include: { attachments: true },
  });
  if (!exam) throw ApiError.notFound('That exam timetable no longer exists');

  if (user.role === 'student') {
    // A schedule with no semester is the whole college's, so it is theirs too.
    const theirs =
      exam.semester == null ||
      (Number(exam.semester) === Number(user.semester) &&
        (!exam.sectionId || sameId(exam.sectionId, sectionIdOf(user))));
    if (!theirs) throw ApiError.forbidden('That timetable is not for your year');
  }
  return exam;
}

export const downloadExamFile = asyncHandler(async (req, res) => {
  const exam = await loadVisible(req.user, req.params.examId);

  const attachment = (exam.attachments || []).find((a) => sameId(a, req.params.attachmentId));
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
  const exam = await prisma.examSchedule.findUnique({
    where: { id: req.params.examId },
    include: { attachments: true },
  });
  if (!exam) throw ApiError.notFound('That exam timetable no longer exists');

  // Nobody should keep being told about a timetable that is gone — including
  // by a correction notice, which outlives the original it corrected.
  await withdrawNotifications({
    type: { in: ['exam:published', 'exam:updated'] },
    // A Json column, so the key inside it is addressed by path.
    meta: { path: ['examId'], equals: exam.id },
  });
  // The record before the bytes: the other order leaves attachments still
  // pointing at the files, and the foreign key refuses.
  await prisma.examSchedule.delete({ where: { id: exam.id } });
  await deleteFiles((exam.attachments || []).map((a) => a.fileId));

  res.json({ success: true, message: 'Exam timetable removed', data: { id: exam.id } });
});
