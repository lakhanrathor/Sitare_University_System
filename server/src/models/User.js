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

    /*
     * Google's stable subject id for this person, recorded the first time
     * they sign in with Google. It identifies *who signed in*, nothing more —
     * role, section and access still come from the fields above, which only
     * an admin can change.
     *
     * Deliberately no `default: null` — a sparse unique index only excludes a
     * document where the field is genuinely absent, not one where it is set
     * to `null`. A default would write a literal `null` onto every account
     * that has never used Google sign-in, and the second such account would
     * then collide with the first on this unique index. Leaving the field
     * unset until `resolveGoogleUser` assigns it is what makes `sparse` work.
     */
    googleSub: { type: String, unique: true, sparse: true },
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
