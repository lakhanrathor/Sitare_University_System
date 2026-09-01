import mongoose from 'mongoose';

export const ATTENDANCE_STATUS = ['present', 'absent'];
export const PRESENT_STATUSES = ['present'];

const attendanceSchema = new mongoose.Schema(
  {
    session: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassSession', required: true, index: true },
    subject: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    status: { type: String, enum: ATTENDANCE_STATUS, required: true },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    remark: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

attendanceSchema.index({ session: 1, student: 1 }, { unique: true });
attendanceSchema.index({ student: 1, subject: 1 });

export default mongoose.model('Attendance', attendanceSchema);
