import mongoose from 'mongoose';

export const ENTRY_KINDS = ['lecture', 'office-hours', 'event'];

/**
 * One cell of the weekly grid — a recurring commitment, not a dated class.
 * Actual dated classes are derived from these entries and then adjusted by
 * ScheduleChange documents, so moving a class on one date never rewrites the
 * recurring plan.
 */
const timetableEntrySchema = new mongoose.Schema(
  {
    timetable: { type: mongoose.Schema.Types.ObjectId, ref: 'Timetable', required: true, index: true },

    dayOfWeek: { type: Number, required: true, min: 1, max: 7, index: true },
    slot: { type: Number, required: true, min: 1, max: 12 },
    /**
     * Null means the whole semester sits this period together. Plenty of
     * institutes run one cohort per year and never split into sections, and
     * forcing a section on them would duplicate every class.
     */
    section: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Section',
      default: null,
      index: true,
    },

    /** Null for non-academic entries such as "Session with Dean". */
    subject: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', default: null },
    /**
     * Who actually takes this period. Defaults to the subject's faculty but can
     * differ — e.g. a combined session taken by the other WAD lecturer.
     */
    faculty: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    /*
     * Who marks a register when its own lecturer will not is deliberately NOT
     * stored here — see AttendanceDelegation. It belongs to a single dated
     * class, not to the weekly period.
     */
    kind: { type: String, enum: ENTRY_KINDS, default: 'lecture' },
    /** Used when there is no subject, e.g. "Session with Dean". */
    title: { type: String, trim: true, default: '' },
    room: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

// One cohort cannot be in two places in the same period.
timetableEntrySchema.index({ timetable: 1, dayOfWeek: 1, slot: 1, section: 1 }, { unique: true });

export default mongoose.model('TimetableEntry', timetableEntrySchema);
