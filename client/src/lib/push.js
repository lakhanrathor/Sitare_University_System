import { api } from './api';

/*
 * Browser push, from the page's side.
 *
 * Every function here answers honestly when push is unavailable rather than
 * throwing: an unsupported browser, a denied prompt and an unconfigured server
 * are all ordinary states this app has to render, not errors.
 */

export const pushSupported = () =>
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

/*
 * The VAPID public key travels as base64url and has to reach the browser as
 * bytes. `atob` wants standard base64 and no padding is included, hence both
 * substitutions before decoding.
 */
function keyToBytes(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = window.atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/** Registered once; the browser reuses the existing worker on later calls. */
async function worker() {
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

/**
 * What the UI needs to decide what to offer.
 *
 * `permission` is the browser's own three-state answer. 'denied' is the one
 * worth rendering differently: it cannot be undone from here — only from the
 * browser's own site settings — so offering a button that silently does
 * nothing would be worse than saying so.
 */
export async function pushState() {
  if (!pushSupported()) return { supported: false, enabled: false, permission: 'unsupported', subscribed: false };

  let config = { enabled: false };
  try {
    config = await api.pushConfig();
  } catch {
    /* Server unreachable or older than this feature — treat as off. */
  }

  let subscribed = false;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    subscribed = Boolean(await reg?.pushManager.getSubscription());
  } catch {
    /* No registration yet is simply "not subscribed". */
  }

  return {
    supported: true,
    enabled: Boolean(config.enabled),
    permission: Notification.permission,
    subscribed,
  };
}

/**
 * Ask for permission and subscribe this browser.
 *
 * Must be called from a real click. A prompt raised without one is dismissed
 * by Chrome, and a dismissed prompt cannot be raised again from code — the
 * user has to go into site settings — so there is exactly one chance at this.
 */
export async function enablePush() {
  if (!pushSupported()) throw new Error('This browser cannot show push notifications');

  const config = await api.pushConfig();
  if (!config.enabled || !config.publicKey) {
    throw new Error('Push notifications are not configured on the server');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for this site — allow them in your browser settings'
        : 'Notifications were not allowed'
    );
  }

  const reg = await worker();
  await navigator.serviceWorker.ready;

  /*
   * An existing subscription is reused. Subscribing twice with the same key
   * returns the same endpoint anyway, and asking for a different key while one
   * is live throws rather than replacing it.
   */
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ||
    (await reg.pushManager.subscribe({
      // Required by Chrome: every push must result in something the user sees.
      userVisibleOnly: true,
      applicationServerKey: keyToBytes(config.publicKey),
    }));

  await api.subscribePush(sub.toJSON());
  return true;
}

/** Stop this browser receiving them. The permission itself stays granted. */
export async function disablePush() {
  if (!pushSupported()) return false;
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return false;

  /*
   * Told first, then dropped locally. The other order can leave the server
   * pushing to an endpoint nothing is listening on, which it only discovers
   * when the push service eventually reports it gone.
   */
  try {
    await api.unsubscribePush(sub.endpoint);
  } catch {
    /* Still unsubscribe locally — the server prunes dead endpoints itself. */
  }
  await sub.unsubscribe();
  return true;
}
