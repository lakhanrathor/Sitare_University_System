import Notification from '../models/Notification.js';
import User from '../models/User.js';
import Enrollment from '../models/Enrollment.js';
import { emitToUsers } from '../sockets/index.js';

/**
 * Persist notifications and push them over the socket in one step, so a user
 * who is offline still finds them in the bell when they next sign in.
 */
export async function notify(userIds, payload) {
  const ids = [...new Set(userIds.map(String))].filter(Boolean);
  if (!ids.length) return [];

  const docs = await Notification.insertMany(
    ids.map((user) => ({
      user,
      type: payload.type,
      title: payload.title,
      message: payload.message,
      link: payload.link || '',
      meta: payload.meta || {},
      requiresAction: Boolean(payload.requiresAction),
      createdBy: payload.createdBy || null,
    }))
  );

  // Each recipient gets their own document id so "mark read" works per user.
  docs.forEach((d) => {
    emitToUsers([d.user], 'notification:new', {
      id: String(d._id),
      type: d.type,
      title: d.title,
      message: d.message,
      link: d.link,
      requiresAction: d.requiresAction,
      createdAt: d.createdAt,
    });
  });

  return docs;
}

/** Everyone who should hear about a schedule change on the shared grid. */
export async function facultyAndAdminIds({ exclude = [] } = {}) {
  const users = await User.find({ role: { $in: ['faculty', 'admin'] }, isActive: true })
    .select('_id')
    .lean();
  const skip = new Set(exclude.map(String));
  return users.map((u) => String(u._id)).filter((id) => !skip.has(id));
}

export async function adminIds() {
  const admins = await User.find({ role: 'admin', isActive: true }).select('_id').lean();
  return admins.map((a) => String(a._id));
}

/**
 * The students affected by a change to one period.
 *
 * Enrolment is the precise answer when the period belongs to a subject — it
 * excludes anyone not taking that elective. But a period can also be a plain
 * session with no subject at all ("Session with Dean", a booked slot titled
 * "Reschedule"), and those still occupy the cohort's time, so fall back to
 * everyone in the section rather than telling nobody.
 */
export async function studentAudience({ subjectId, sectionId }) {
  if (subjectId) {
    const rows = await Enrollment.find({ subject: subjectId, isActive: true })
      .select('student')
      .lean();
    if (rows.length) return rows.map((r) => String(r.student));
  }
  if (!sectionId) return [];
  const rows = await User.find({
    role: 'student',
    section: sectionId,
    isActive: true,
  })
    .select('_id')
    .lean();
  return rows.map((r) => String(r._id));
}
