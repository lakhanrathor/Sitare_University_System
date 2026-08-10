import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

export const ROLES = ['student', 'faculty', 'admin'];

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    password: { type: String, required: true, minlength: 6, select: false },
    role: { type: String, enum: ROLES, required: true, default: 'student', index: true },

    // Student-only fields
    rollNumber: { type: String, trim: true, sparse: true, unique: true },
    batch: { type: String, trim: true },
    semester: { type: Number, min: 1, max: 10 },
    /** Cohort a student sits with; drives which timetable column they see. */
    section: { type: mongoose.Schema.Types.ObjectId, ref: 'Section', default: null, index: true },

    // Faculty-only fields
    employeeId: { type: String, trim: true, sparse: true, unique: true },

    department: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = function comparePassword(plain) {
  return bcrypt.compare(plain, this.password);
};

userSchema.methods.toSafeJSON = function toSafeJSON() {
  const { _id, name, email, role, rollNumber, employeeId, batch, semester, department, section } =
    this;
  return {
    id: _id,
    name,
    email,
    role,
    rollNumber,
    employeeId,
    batch,
    semester,
    department,
    // Always the same shape, whether `section` was populated or left as an id.
    section: section
      ? { id: String(section._id || section), name: section.name ?? null }
      : null,
  };
};

/** The section id, regardless of whether the field has been populated. */
userSchema.methods.sectionId = function sectionId() {
  if (!this.section) return null;
  return String(this.section._id || this.section);
};

export default mongoose.model('User', userSchema);
