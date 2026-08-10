import mongoose from 'mongoose';

export const TIMETABLE_STATUS = ['draft', 'published', 'archived'];

/**
 * A versioned weekly plan uploaded by the admin. Publishing one archives the
 * previously published timetable for the same semester, so there is always
 * exactly one live grid and a history of what it replaced.
 */
const timetableSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    semester: { type: Number, required: true, min: 1, max: 10, index: true },
    department: { type: String, trim: true, default: 'Computer Science' },

    effectiveFrom: { type: Date, required: true },
    effectiveFromKey: { type: String, required: true },

    status: { type: String, enum: TIMETABLE_STATUS, default: 'draft', index: true },
    publishedAt: { type: Date },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    /**
     * The period grid this timetable runs on, taken from the uploaded file.
     * Institutes do not share a clock — one runs 55-minute periods from 9:00,
     * another hourly periods with lunch at 12:00 — so the times belong to the
     * timetable, not to a global constant. Empty means fall back to the
     * built-in default.
     */
    slots: [
      {
        _id: false,
        slot: { type: Number, required: true },
        label: { type: String, required: true },
        start: { type: String, required: true },
        end: { type: String, required: true },
      },
    ],
    /** Where the break sits, so the rendered grid matches the printed one. */
    lunch: {
      type: {
        _id: false,
        label: { type: String, default: 'LUNCH' },
        start: String,
        end: String,
        afterSlot: Number,
      },
      default: null,
    },

    /** Non-blocking issues surfaced at upload time (e.g. combined classes). */
    warnings: [{ type: String }],
    entryCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default mongoose.model('Timetable', timetableSchema);
