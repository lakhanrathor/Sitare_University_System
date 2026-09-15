/*
 * The service worker: what receives a push when nobody has the page open.
 *
 * It runs outside any tab, so it has no access to the app's code, state or
 * auth token — everything it needs arrives inside the push payload. Kept
 * deliberately small for that reason: there is no way to debug it from the
 * page, and a mistake here is invisible until somebody misses a notification.
 *
 * Served from the site root (Vite publishes public/ there), which is what lets
 * it control every page on the origin rather than just /public.
 */

/* A new worker takes over immediately rather than waiting for every tab to
   close — otherwise a fixed version sits idle behind a tab left open. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    /* A push with no readable body still means something happened. */
  }

  const title = payload.title || 'Sitare University ERP';
  const options = {
    body: payload.message || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    /* Same tag replaces rather than stacks: a corrected exam timetable should
       not sit underneath the original it corrects. */
    tag: payload.tag || 'sitare-erp',
    renotify: true,
    requireInteraction: Boolean(payload.requiresAction),
    data: { url: payload.url || '/' },
  };

  event.waitUntil(
    (async () => {
      /*
       * Nothing to show if they are already looking at it. The page has its
       * own toast for a notification that arrives over the socket, and two
       * alerts for one event is how people turn notifications off.
       */
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (windows.some((c) => c.visibilityState === 'visible' && c.focused)) return;
      await self.registration.showNotification(title, options);
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';

  event.waitUntil(
    (async () => {
      /* Focus the tab they already have rather than opening a second one. */
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if ('focus' in client) {
          await client.focus();
          if ('navigate' in client) await client.navigate(target);
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })()
  );
});

/*
 * Endpoints rotate. When the browser replaces one it fires this instead of
 * telling the page, and a subscription the server still holds is now dead — so
 * the new one has to be registered from here.
 *
 * The public key is not available in this scope, so it is read back from the
 * old subscription's own options rather than hardcoded.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const key = event.oldSubscription?.options?.applicationServerKey;
      if (!key) return;
      try {
        const fresh = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        });
        await fetch('/api/notifications/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          /* No token out here: the cookie-less session means this request is
             unauthenticated and will be refused. It still matters that the
             attempt is made — the page re-subscribes on its next load, and
             this keeps the window short. */
          body: JSON.stringify(fresh.toJSON()),
        });
      } catch {
        /* Nothing useful to do out here; the page repairs it on next load. */
      }
    })()
  );
});
