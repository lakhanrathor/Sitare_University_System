import webpush from 'web-push';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { idOf } from '../utils/ids.js';

/*
 * Browser push — the same notification, delivered when nobody has the page
 * open.
 *
 * It is a second transport for what notificationService already decided to
 * send, never a second decision: who hears about something is settled in one
 * place, and this only carries it further. Nothing here may change what the
 * bell shows or what the socket delivers.
 */

if (env.pushEnabled) {
  webpush.setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey);
}

/*
 * How long the push service should hold a message for a browser that is not
 * running. Four hours: long enough to survive a lunch break or a closed
 * laptop, short enough that nobody is told about a class that has already
 * happened. A notification is not worth delivering the next morning.
 */
const TTL_SECONDS = 4 * 60 * 60;

/*
 * Sends go out in batches rather than all at once. Publishing an exam
 * timetable to a whole year is one HTTP request per device, and firing three
 * hundred of them simultaneously is how a push service starts returning 429.
 */
const CONCURRENCY = 20;

/** Gone for good — the browser is uninstalled, reset, or the endpoint rotated. */
const isDead = (statusCode) => statusCode === 404 || statusCode === 410;

/**
 * Deliver one notification to every device belonging to these people.
 *
 * Returns rather than throws. A push that fails must never take down the
 * request that caused it: the notification row is already written and the
 * socket has already fired, so the bell is correct either way and a dead
 * endpoint is not a reason to fail publishing a timetable.
 */
export async function pushToUsers(userIds, payload) {
  if (!env.pushEnabled) return { sent: 0, removed: 0, skipped: 'not configured' };

  const ids = [...new Set((userIds || []).map(idOf))].filter(Boolean);
  if (!ids.length) return { sent: 0, removed: 0 };

  let subscriptions;
  try {
    subscriptions = await prisma.pushSubscription.findMany({ where: { userId: { in: ids } } });
  } catch (err) {
    console.error('[push] could not read subscriptions:', err.message);
    return { sent: 0, removed: 0 };
  }
  if (!subscriptions.length) return { sent: 0, removed: 0 };

  /*
   * `tag` collapses repeats: a second notice about the same exam replaces the
   * first on screen rather than stacking beneath it. `url` is what the service
   * worker opens when the notification is clicked.
   */
  const body = JSON.stringify({
    title: payload.title || 'Sitare University ERP',
    message: payload.message || '',
    url: payload.link || '/',
    tag: payload.type || 'notification',
    requiresAction: Boolean(payload.requiresAction),
  });

  const dead = [];
  let sent = 0;

  for (let i = 0; i < subscriptions.length; i += CONCURRENCY) {
    const batch = subscriptions.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body,
            { TTL: TTL_SECONDS }
          );
          sent += 1;
        } catch (err) {
          if (isDead(err.statusCode)) dead.push(s.id);
          else console.error(`[push] ${err.statusCode || '?'} for one device:`, err.message);
        }
      })
    );
  }

  /*
   * A subscription the push service has disowned will never work again, and
   * keeping it means retrying it on every notification for ever.
   */
  if (dead.length) {
    try {
      await prisma.pushSubscription.deleteMany({ where: { id: { in: dead } } });
    } catch (err) {
      console.error('[push] could not prune dead subscriptions:', err.message);
    }
  }

  return { sent, removed: dead.length };
}

/**
 * Record a browser's subscription, or update it if that browser is already
 * known.
 *
 * Keyed on the endpoint, not on the user: re-subscribing the same browser
 * hands back the same endpoint, so without the upsert this table would gain a
 * row every time somebody opened the app. It also means a shared machine's
 * subscription follows whoever subscribed last, which is the correct answer —
 * two people cannot both be signed in to one browser profile.
 */
export function saveSubscription({ userId, endpoint, keys, userAgent }) {
  const data = {
    userId: idOf(userId),
    endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    userAgent: (userAgent || '').slice(0, 250),
  };
  return prisma.pushSubscription.upsert({
    where: { endpoint },
    create: data,
    update: data,
  });
}

/** Forget one browser. Absent is success — unsubscribing twice is not an error. */
export async function removeSubscription(endpoint) {
  await prisma.pushSubscription.deleteMany({ where: { endpoint } });
}
