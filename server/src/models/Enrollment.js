import mongoose from 'mongoose';

/**
 * Links a student to a subject. Only enrolled students appear on the
 * attendance sheet and only their records feed the percentage calculation.
 */
const enrollmentSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    subject: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', required: true, index: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

enrollmentSchema.index({ student: 1, subject: 1 }, { unique: true });

export default mongoose.model('Enrollment', enrollmentSchema);
