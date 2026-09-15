import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { idOf } from '../utils/ids.js';
import { saveSubscription, removeSubscription } from '../services/pushService.js';

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

/* ------------------------------------------------------------------ */
/* Browser push                                                        */
/* ------------------------------------------------------------------ */

/**
 * What the browser needs before it can subscribe.
 *
 * The public key is public by design — it identifies this server to the push
 * service and is embedded in every subscription request. `enabled: false` is a
 * supported answer, not an error: a checkout with no VAPID pair simply never
 * offers push, and the client is expected to read this rather than assume.
 */
export const pushConfig = asyncHandler(async (_req, res) => {
  res.json({
    success: true,
    data: { enabled: env.pushEnabled, publicKey: env.pushEnabled ? env.vapidPublicKey : null },
  });
});

export const subscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(100),
  }),
});

export const subscribePush = asyncHandler(async (req, res) => {
  if (!env.pushEnabled) throw ApiError.badRequest('Push notifications are not configured');

  const { endpoint, keys } = subscribeSchema.parse(req.body);
  await saveSubscription({
    userId: idOf(req.user),
    endpoint,
    keys,
    userAgent: req.get('user-agent'),
  });
  res.status(201).json({ success: true, message: 'This device will receive notifications' });
});

export const unsubscribeSchema = z.object({ endpoint: z.string().url().max(2000) });

export const unsubscribePush = asyncHandler(async (req, res) => {
  const { endpoint } = unsubscribeSchema.parse(req.body);
  /*
   * Not scoped to the caller on purpose. An endpoint belongs to a browser, and
   * the browser is the thing asking to be forgotten — refusing because the row
   * is filed under whoever used this machine last would leave it subscribed
   * with no way to stop it. Knowing an endpoint is knowing a random 100-plus
   * character string issued by the push service.
   */
  await removeSubscription(endpoint);
  res.json({ success: true, message: 'This device will no longer receive notifications' });
});
