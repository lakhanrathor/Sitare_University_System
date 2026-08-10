import mongoose from 'mongoose';

export const SESSION_STATUS = ['completed', 'cancelled'];

/**
 * One actually-held class. The count of `completed` sessions for a subject IS
 * the attendance denominator. A subject planned for 30 classes with only 2
 * sessions recorded has a denominator of 2 — never 30.
 * `cancelled` sessions are excluded from the denominator entirely.
 */
const classSessionSchema = new mongoose.Schema(
  {
    subject: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', required: true, index: true },
    faculty: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    /** Calendar day of the class, normalised to 00:00:00 UTC. */
    date: { type: Date, required: true, index: true },
    /** 'YYYY-MM-DD' — stable key for grouping and de-duplication. */
    dateKey: { type: String, required: true, index: true },
    /** Period/slot number, lets a subject have multiple classes on one day. */
    slot: { type: Number, default: 1, min: 1, max: 12 },

    topic: { type: String, trim: true, default: '' },
    status: { type: String, enum: SESSION_STATUS, default: 'completed', index: true },

    /** Cached counters, refreshed whenever attendance is saved. */
    presentCount: { type: Number, default: 0 },
    totalMarked: { type: Number, default: 0 },
  },
  { timestamps: true }
);

classSessionSchema.index({ subject: 1, dateKey: 1, slot: 1 }, { unique: true });

export default mongoose.model('ClassSession', classSessionSchema);
