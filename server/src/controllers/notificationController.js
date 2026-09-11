import { prisma } from '../config/prisma.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { idOf } from '../utils/ids.js';

export const listNotifications = asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const where = { userId: idOf(req.user) };
  if (req.query.unread === 'true') where.read = false;

  const [items, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit }),
    prisma.notification.count({ where: { userId: idOf(req.user), read: false } }),
  ]);

  res.json({
    success: true,
    data: {
      unread,
      items: items.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        message: n.message,
        link: n.link,
        requiresAction: n.requiresAction,
        read: n.read,
        createdAt: n.createdAt,
      })),
    },
  });
});

export const markRead = asyncHandler(async (req, res) => {
  const n = await prisma.notification.findFirst({
    where: { id: req.params.id, userId: idOf(req.user) },
  });
  if (!n) throw ApiError.notFound('Notification not found');
  await prisma.notification.update({ where: { id: n.id }, data: { read: true } });
  res.json({ success: true, message: 'Marked as read' });
});

export const markAllRead = asyncHandler(async (req, res) => {
  await prisma.notification.updateMany({
    where: { userId: idOf(req.user), read: false },
    data: { read: true },
  });
  res.json({ success: true, message: 'All notifications marked as read' });
});
