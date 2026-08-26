import mongoose from 'mongoose';

export const CHANGE_KINDS = ['extra', 'move', 'cancel'];

/**
 * A date-specific deviation from the weekly grid. Every deviation is one of
 * three shapes, and a swap is stored as two linked `move` documents so the
 * resolver only ever has to understand these three:
 *
 *   extra   a free period is claimed for an additional class
 *   move    a scheduled class leaves (date, entry.slot) and lands at (toDate, toSlot)
 *   cancel  a scheduled class does not happen at all
 */
const scheduleChangeSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: CHANGE_KINDS, required: true, index: true },

    /**
     * Which published timetable this change belongs to. 'move' and 'cancel'
     * already imply it through 'entry', but 'extra' has no entry to imply it
     * from — an extra class is not on the recurring grid at all. Without this,
     * resolving one semester's week pulls in every OTHER semester's extra
     * bookings too: a change is otherwise found by date and section alone, and
     * a section-less (whole-year) extra has a section of null, which matches
     * every semester's query just as readily as its own.
     */
    timetable: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Timetable',
      default: null,
      index: true,
    },

    /** The date the change applies to — the ORIGINAL date for move/cancel. */
    date: { type: Date, required: true },
    dateKey: { type: String, required: true, index: true },

    /** The recurring cell being moved or cancelled. Null for `extra`. */
    entry: { type: mongoose.Schema.Types.ObjectId, ref: 'TimetableEntry', default: null, index: true },
    /** Slot the entry normally occupies — copied so the resolver needn't populate. */
    fromSlot: { type: Number, default: null },

    /** Destination for `move`. */
    toDate: { type: Date, default: null },
    toDateKey: { type: String, default: null, index: true },
    toSlot: { type: Number, default: null },

    /** Describes the resulting class (always set, including for `move`). */
    /** Null when the period belongs to the whole semester, not one cohort. */
    section: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Section',
      default: null,
      index: true,
    },
    subject: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', default: null },
    faculty: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    slot: { type: Number, default: null }, // the slot for `extra`
    kindOfClass: { type: String, default: 'lecture' },
    title: { type: String, trim: true, default: '' },
    room: { type: String, trim: true, default: '' },

    reason: { type: String, trim: true, default: '', maxlength: 300 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    /** Set on both halves of an approved swap. */
    swapRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'SwapRequest', default: null, index: true },
  },
  { timestamps: true }
);

scheduleChangeSchema.index({ dateKey: 1, section: 1 });
scheduleChangeSchema.index({ toDateKey: 1, section: 1 });

export default mongoose.model('ScheduleChange', scheduleChangeSchema);
