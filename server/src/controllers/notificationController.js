import Notification from '../models/Notification.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const listNotifications = asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const filter = { user: req.user._id };
  if (req.query.unread === 'true') filter.read = false;

  const [items, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
    Notification.countDocuments({ user: req.user._id, read: false }),
  ]);

  res.json({
    success: true,
    data: {
      unread,
      items: items.map((n) => ({
        id: String(n._id),
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
  const n = await Notification.findOne({ _id: req.params.id, user: req.user._id });
  if (!n) throw ApiError.notFound('Notification not found');
  n.read = true;
  await n.save();
  res.json({ success: true, message: 'Marked as read' });
});

export const markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany({ user: req.user._id, read: false }, { $set: { read: true } });
  res.json({ success: true, message: 'All notifications marked as read' });
});
