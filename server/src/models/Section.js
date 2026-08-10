import mongoose from 'mongoose';

/**
 * A cohort that sits together for a class — "Section A", "Section B".
 *
 * The name is optional: plenty of years run a single batch that is never
 * divided, and forcing a letter onto them would put "Section A" all over a
 * timetable that has no sections at all. An unnamed cohort is simply the whole
 * semester, and the unique index keeps there being only one of them.
 */
const sectionSchema = new mongoose.Schema(
  {
    name: { type: String, default: '', trim: true, uppercase: true },
    semester: { type: Number, required: true, min: 1, max: 10 },
    department: { type: String, trim: true, default: 'Computer Science' },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

sectionSchema.index({ name: 1, semester: 1, department: 1 }, { unique: true });

/** 'Section A', or 'All students' when the year is not divided. */
sectionSchema.virtual('label').get(function label() {
  return this.name ? `Section ${this.name}` : 'All students';
});

/** How a cohort reads in a compact column or chip. */
export const sectionLabel = (section) =>
  section?.name ? `Section ${section.name}` : 'All students';

export default mongoose.model('Section', sectionSchema);
