import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { idOf, sameId } from '../utils/ids.js';
import { putFile, openFile, deleteFiles } from '../services/fileStore.js';
import { notify, adminIds } from '../services/notificationService.js';

/*
 * Leave applications.
 *
 * A student raises their own — they are the one who knows why they were away.
 * The administration reads them: admin-only on the other side, because a leave
 * application routinely carries a medical reason or a family matter, and the
 * decision it feeds — whether a shortage is excused — is theirs alone.
 */

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const applicationSchema = z
  .object({
    reason: z.string().trim().min(3, 'Say why you were away').max(300),
    details: z.string().trim().max(20000).optional().default(''),
    // Both optional, but a range has to make sense if it is given.
    leaveFrom: dateOnly.optional().or(z.literal('')),
    leaveTo: dateOnly.optional().or(z.literal('')),
  })
  .refine((v) => !v.leaveFrom || !v.leaveTo || v.leaveTo >= v.leaveFrom, {
    message: 'The last day cannot be before the first',
    path: ['leaveTo'],
  });

const asDate = (v) => (v ? new Date(`${v}T00:00:00.000Z`) : null);
const asKey = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d || null);

const shape = (d) => ({
  id: d.id,
  sentAt: asKey(d.sentAt),
  leaveFrom: asKey(d.leaveFrom),
  leaveTo: asKey(d.leaveTo),
  regarding: d.regarding,
  body: d.body,
  source: d.source,
  fromAddress: d.fromAddress || '',
  filedOn: d.createdAt,
  attachments: (d.attachments || []).map((a) => ({
    id: a.id,
    filename: a.filename,
    contentType: a.contentType,
    size: a.size,
  })),
});

/* ------------------------------------------------------------------ */
/* The student's own applications                                      */
/* ------------------------------------------------------------------ */

export const listMyLeave = asyncHandler(async (req, res) => {
  const docs = await prisma.leaveDocument.findMany({
    where: { studentId: idOf(req.user) },
    include: { attachments: { orderBy: { createdAt: 'asc' } } },
    orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }],
  });
  res.json({ success: true, data: docs.map(shape) });
});

/**
 * Raise a leave application.
 *
 * Only the reason is required. Documents are optional on purpose — see the
 * model — and so are the dates.
 */
export const submitLeave = asyncHandler(async (req, res) => {
  const { reason, details, leaveFrom, leaveTo } = applicationSchema.parse(req.body);
  const files = req.files || [];

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

    const doc = await prisma.leaveDocument.create({
      data: {
        studentId: idOf(req.user),
        // Submitted now; the days it covers are the leave dates, not this.
        sentAt: new Date(),
        regarding: reason,
        body: details,
        leaveFrom: asDate(leaveFrom),
        leaveTo: asDate(leaveTo),
        source: 'student',
        uploadedById: idOf(req.user),
        attachments: { create: stored },
      },
      include: { attachments: true },
    });

    // The administration is the audience — tell them it has arrived.
    const admins = await adminIds();
    if (admins.length) {
      const when =
        leaveFrom && leaveTo && leaveFrom !== leaveTo
          ? ` for ${leaveFrom} to ${leaveTo}`
          : leaveFrom
            ? ` for ${leaveFrom}`
            : '';
      await notify(admins, {
        type: 'leave:submitted',
        title: 'Leave application received',
        message: `${req.user.name} applied for leave${when}: ${reason}`,
        link: `/admin/students/${idOf(req.user)}`,
        createdBy: idOf(req.user),
      });
    }

    res.status(201).json({
      success: true,
      message: 'Your leave application has been sent to the office',
      data: shape(doc),
    });
  } catch (err) {
    // Never leave uploaded files orphaned in storage behind a failed record.
    await deleteFiles(stored.map((s) => s.fileId));
    throw err;
  }
});

/* ------------------------------------------------------------------ */
/* Shared: reading and removing                                        */
/* ------------------------------------------------------------------ */

/** An application is the student's own business and the administration's. */
async function loadVisible(user, docId) {
  const doc = await prisma.leaveDocument.findUnique({
    where: { id: docId },
    include: { attachments: true },
  });
  if (!doc) throw ApiError.notFound('That application no longer exists');
  const mine = sameId(doc.studentId, user);
  if (user.role !== 'admin' && !mine) {
    throw ApiError.forbidden('That application is not yours');
  }
  return doc;
}

/** Stream one attachment back. */
export const downloadAttachment = asyncHandler(async (req, res) => {
  const doc = await loadVisible(req.user, req.params.docId);

  const attachment = (doc.attachments || []).find((a) => sameId(a, req.params.attachmentId));
  if (!attachment) throw ApiError.notFound('That attachment is not on this application');

  const { file, stream } = await openFile(attachment.fileId);

  res.setHeader('Content-Type', attachment.contentType || 'application/octet-stream');
  res.setHeader('Content-Length', file.length);
  /*
   * Always as a download, never rendered in place. These are files a student
   * uploaded; nothing uploaded should ever be executed in the origin that
   * holds an administrator's session.
   */
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(attachment.filename)}"`
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

/** Withdraw your own, or remove one as an administrator. */
export const deleteLeave = asyncHandler(async (req, res) => {
  const doc = await loadVisible(req.user, req.params.docId);

  // The record before the bytes: reversed, the attachments still reference the
  // file rows and the foreign key refuses the delete.
  await prisma.leaveDocument.delete({ where: { id: doc.id } });
  await deleteFiles((doc.attachments || []).map((a) => a.fileId));

  res.json({
    success: true,
    message: req.user.role === 'admin' ? 'Application deleted' : 'Application withdrawn',
    data: { id: doc.id },
  });
});

/* ------------------------------------------------------------------ */
/* Administration                                                      */
/* ------------------------------------------------------------------ */

/** Everything one student has sent in, newest first. */
export const listLeaveDocuments = asyncHandler(async (req, res) => {
  const student = await prisma.user.findFirst({
    where: { id: req.params.studentId, role: 'student' },
  });
  if (!student) throw ApiError.notFound('Student not found');

  const docs = await prisma.leaveDocument.findMany({
    where: { studentId: student.id },
    include: { attachments: { orderBy: { createdAt: 'asc' } } },
    orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }],
  });

  res.json({ success: true, data: docs.map(shape) });
});
