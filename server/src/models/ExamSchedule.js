import mongoose from 'mongoose';

export const EXAM_TYPES = ['mid-term', 'end-term', 'practical', 're-exam', 'other'];

/**
 * One published exam timetable.
 *
 * The uploaded sheet is the authority — an institute's exam schedule is a
 * document with seating, instructions and signatures on it, and students will
 * want the original. The dated papers below are optional and deliberately
 * typed in rather than parsed out of the PDF: a wrong date on an exam is worse
 * than no date at all, and reading a printed grid is inference. When they are
 * given, the system can answer "when is my next paper" instead of leaving
 * everyone to open a file and squint.
 */
const attachmentSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true, trim: true },
    contentType: { type: String, default: 'application/octet-stream' },
    size: { type: Number, default: 0 },
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { _id: true }
);

const paperSchema = new mongoose.Schema(
  {
    /** The subject, when it is one the system knows. */
    subject: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', default: null },
    /** What the sheet calls it — used when there is no matching subject. */
    label: { type: String, trim: true, default: '', maxlength: 160 },

    dateKey: { type: String, required: true }, // 'YYYY-MM-DD'
    startTime: { type: String, trim: true, default: '' }, // '10:00'
    endTime: { type: String, trim: true, default: '' },
    room: { type: String, trim: true, default: '', maxlength: 60 },
  },
  { _id: true }
);

const examScheduleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    examType: { type: String, enum: EXAM_TYPES, default: 'end-term', index: true },

    semester: { type: Number, required: true, min: 1, max: 10, index: true },
    /** Null means every cohort of that year sits the same schedule. */
    section: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Section',
      default: null,
      index: true,
    },

    /** Instructions: what to bring, reporting time, anything else. */
    instructions: { type: String, default: '', trim: true, maxlength: 5000 },

    papers: { type: [paperSchema], default: [] },
    attachments: { type: [attachmentSchema], default: [] },

    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// How it is read: one cohort's schedules, newest first.
examScheduleSchema.index({ semester: 1, section: 1, createdAt: -1 });

/** The window the papers span, for sorting and for "starts in N days". */
examScheduleSchema.virtual('startsOn').get(function startsOn() {
  const dates = (this.papers || []).map((p) => p.dateKey).sort();
  return dates[0] || null;
});
examScheduleSchema.virtual('endsOn').get(function endsOn() {
  const dates = (this.papers || []).map((p) => p.dateKey).sort();
  return dates[dates.length - 1] || null;
});

examScheduleSchema.set('toObject', { virtuals: true });
examScheduleSchema.set('toJSON', { virtuals: true });

export default mongoose.model('ExamSchedule', examScheduleSchema);
