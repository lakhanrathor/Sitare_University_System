import mongoose from 'mongoose';

/**
 * "This lecturer marks this one class."
 *
 * Deliberately tied to a single date rather than the recurring period. A
 * stand-in is arranged for a particular occasion — the Dean took Tuesday's
 * session and left without marking it — and next week the register belongs to
 * its own lecturer again. Hanging this off the weekly grid would quietly hand
 * someone another lecturer's whole subject for the rest of the semester.
 *
 * It only decides *who may mark*. The session and every mark on it still
 * belong to `subject` and its faculty, so the class lands on the owner's
 * dashboard exactly as if they had taken the register themselves.
 */
const attendanceDelegationSchema = new mongoose.Schema(
  {
    /** The register being handed over. */
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subject',
      required: true,
      index: true,
    },
    /** 'YYYY-MM-DD' — this class, not the weekly slot. */
    dateKey: { type: String, required: true, index: true },
    slot: { type: Number, required: true, min: 1, max: 12 },

    /** Who has been asked to mark it. */
    faculty: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    /**
     * The grid cell this came from, kept so the timetable can show the
     * hand-over on the right period. Null when the period carries no subject
     * of its own — an event such as "Session with Dean", whose register the
     * admin pointed at a subject for this date only.
     */
    entry: { type: mongoose.Schema.Types.ObjectId, ref: 'TimetableEntry', default: null },

    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

// One register, one stand-in.
attendanceDelegationSchema.index({ subject: 1, dateKey: 1, slot: 1 }, { unique: true });

export default mongoose.model('AttendanceDelegation', attendanceDelegationSchema);
