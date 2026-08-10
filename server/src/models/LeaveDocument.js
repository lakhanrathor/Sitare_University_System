import mongoose from 'mongoose';

export const LEAVE_SOURCES = ['student', 'upload', 'email'];

/**
 * One leave application.
 *
 * The point of this collection is the end of the semester: pull the students
 * below the attendance requirement and read what each of them actually sent,
 * instead of searching a shared mailbox one name at a time.
 *
 * Three ways in, one record. A student raising it in the portal, an admin
 * filing something handed in on paper, and the inbox reader that will later
 * poll absent@sitare.org all write this shape — only `source` and the mail
 * headers differ. That is why adding ingestion later needs no migration and no
 * second screen to read it back.
 */
const attachmentSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true, trim: true },
    contentType: { type: String, default: 'application/octet-stream' },
    size: { type: Number, default: 0 },
    /** GridFS id. Files live outside the document so a scan or a photo of a
        medical certificate is not squeezed against the 16 MB document cap. */
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { _id: true }
);

const leaveDocumentSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    /**
     * When the student sent it — not when it was filed. An application
     * forwarded to us in November is still evidence about September, so the
     * folder is ordered by this and never by createdAt.
     */
    sentAt: { type: Date, required: true, index: true },

    /** The reason, in a line — this is what the folder lists. */
    regarding: { type: String, required: true, trim: true, maxlength: 300 },
    /** Anything further the student wanted to explain. */
    body: { type: String, default: '', trim: true, maxlength: 20000 },

    /**
     * The days being missed. Optional, because a student writing "I will be
     * away for my sister's wedding" before they know the exact days is still
     * worth having on file — but when it is given it is the single most useful
     * thing here at review time.
     */
    leaveFrom: { type: Date, default: null },
    leaveTo: { type: Date, default: null },

    /**
     * Optional throughout. Plenty of genuine absences come with no paperwork
     * at all, and demanding a file would either block those students or teach
     * them to attach something meaningless.
     */
    attachments: { type: [attachmentSchema], default: [] },

    source: { type: String, enum: LEAVE_SOURCES, default: 'student', index: true },

    /* ---- Filled in only by the inbox reader, ignored by manual upload ---- */
    /** The address it actually came from, which may not be their college one. */
    fromAddress: { type: String, default: '', trim: true, lowercase: true },
    /** Dedupe key, so a reply chain does not file the same mail repeatedly. */
    messageId: { type: String, default: null, trim: true },

    /** Whoever filed it. Null once mail arrives on its own. */
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// The folder view: one student, newest first.
leaveDocumentSchema.index({ student: 1, sentAt: -1 });

/*
 * A mail is filed once however many times it is delivered. Sparse because
 * manual uploads have no Message-ID and must not collide with each other on a
 * shared null.
 */
leaveDocumentSchema.index(
  { messageId: 1 },
  { unique: true, partialFilterExpression: { messageId: { $type: 'string' } } }
);

export default mongoose.model('LeaveDocument', leaveDocumentSchema);
