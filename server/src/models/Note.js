import mongoose from 'mongoose';

/**
 * Course material a lecturer shares with a cohort.
 *
 * Addressed to a year, and optionally to one section within it. A note with no
 * section belongs to the whole year — which is both the common case and what an
 * undivided semester needs, since those cohorts have no section name at all.
 */
const attachmentSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true, trim: true },
    contentType: { type: String, default: 'application/octet-stream' },
    size: { type: Number, default: 0 },
    /** GridFS id — slides and scans live outside the 16 MB document cap. */
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { _id: true }
);

const noteSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', trim: true, maxlength: 5000 },

    semester: { type: Number, required: true, min: 1, max: 10, index: true },
    /** Null means every section of that year can see it. */
    section: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Section',
      default: null,
      index: true,
    },
    /** Which subject it belongs to, so a student can find it among the rest. */
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subject',
      default: null,
      index: true,
    },

    attachments: { type: [attachmentSchema], default: [] },

    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  },
  { timestamps: true }
);

// How the list is read: one cohort's material, newest first.
noteSchema.index({ semester: 1, section: 1, createdAt: -1 });

export default mongoose.model('Note', noteSchema);
