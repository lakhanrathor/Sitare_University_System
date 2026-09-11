import { prisma } from '../config/prisma.js';
import { emitToUsers } from '../sockets/index.js';
import { idOf } from '../utils/ids.js';

/**
 * Persist notifications and push them over the socket in one step, so a user
 * who is offline still finds them in the bell when they next sign in.
 */
export async function notify(userIds, payload) {
  const ids = [...new Set(userIds.map(idOf))].filter(Boolean);
  if (!ids.length) return [];

  const base = {
    type: payload.type,
    title: payload.title,
    message: payload.message,
    link: payload.link || '',
    meta: payload.meta || {},
    requiresAction: Boolean(payload.requiresAction),
    createdById: payload.createdBy ? idOf(payload.createdBy) : null,
  };

  /*
   * createMany returns a count rather than the rows, and each recipient's own
   * row id is what makes "mark read" work per user — so they are read back.
   * Stamping one shared createdAt is what makes that read exact: the same
   * person can hold several notifications of the same type.
   */
  const createdAt = new Date();
  await prisma.notification.createMany({
    data: ids.map((userId) => ({ ...base, userId, createdAt, updatedAt: createdAt })),
  });
  const docs = await prisma.notification.findMany({
    where: { createdAt, type: base.type, userId: { in: ids } },
  });

  docs.forEach((d) => {
    emitToUsers([d.userId], 'notification:new', {
      id: d.id,
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

/**
 * Take back notifications about something that no longer exists.
 *
 * A notification is a pointer, not a record. When the thing it points at is
 * withdrawn the pointer has to go with it, or a student is left being told
 * about an exam timetable that is not on their page — which reads as the page
 * being broken rather than the item being deleted.
 */
export async function withdrawNotifications(where) {
  const doomed = await prisma.notification.findMany({
    where,
    select: { id: true, userId: true },
  });
  if (!doomed.length) return 0;

  await prisma.notification.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } });

  // Drop it from anyone's open bell, rather than waiting for a reload.
  const byUser = new Map();
  for (const d of doomed) {
    if (!byUser.has(d.userId)) byUser.set(d.userId, []);
    byUser.get(d.userId).push(d.id);
  }
  for (const [user, ids] of byUser) {
    emitToUsers([user], 'notification:removed', { ids });
  }

  return doomed.length;
}

/** Everyone who should hear about a schedule change on the shared grid. */
export async function facultyAndAdminIds({ exclude = [] } = {}) {
  const users = await prisma.user.findMany({
    where: { role: { in: ['faculty', 'admin'] }, isActive: true },
    select: { id: true },
  });
  const skip = new Set(exclude.map(idOf));
  return users.map(idOf).filter((id) => !skip.has(id));
}

export async function adminIds() {
  const admins = await prisma.user.findMany({
    where: { role: 'admin', isActive: true },
    select: { id: true },
  });
  return admins.map(idOf);
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
    const rows = await prisma.enrollment.findMany({
      where: { subjectId, isActive: true },
      select: { studentId: true },
    });
    if (rows.length) return rows.map((r) => r.studentId);
  }
  if (!sectionId) return [];
  const rows = await prisma.user.findMany({
    where: { role: 'student', sectionId, isActive: true },
    select: { id: true },
  });
  return rows.map(idOf);
}
