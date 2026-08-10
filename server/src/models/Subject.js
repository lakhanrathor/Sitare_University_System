import mongoose from 'mongoose';

const subjectSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, uppercase: true, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    department: { type: String, trim: true },
    semester: { type: Number, required: true, min: 1, max: 10, index: true },
    credits: { type: Number, default: 3 },

    /**
     * A subject is offered per section, so "WAD · Section A" and
     * "WAD · Section B" are separate offerings with their own roster,
     * attendance and lecturer.
     */
    section: { type: mongoose.Schema.Types.ObjectId, ref: 'Section', default: null, index: true },

    faculty: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /**
     * Planned classes for the whole semester (e.g. 30).
     * This is reference//planning information ONLY.
     * It is NEVER used as the denominator for attendance percentage.
     * The denominator is always the number of classes actually conducted.
     */
    plannedClasses: { type: Number, default: 30, min: 1 },

    /** Minimum attendance % required (used for the at-risk indicator). */
    minAttendance: { type: Number, default: 75, min: 0, max: 100 },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// The same course code may appear once per section.
subjectSchema.index({ code: 1, section: 1 }, { unique: true });

export default mongoose.model('Subject', subjectSchema);
