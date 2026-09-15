/*
 * Send a test push to one person's devices.
 *
 * Exists because the obvious way to test push by hand does not work: you are
 * never notified of your own actions, so an admin publishing something and
 * watching their own screen will correctly see nothing. This addresses a named
 * account directly and skips the question of who did what.
 *
 *   npm --prefix server run push-test -- someone@sitare.org
 *
 * Writes no notification row and tells nobody else — it only exercises the
 * delivery path, so it is safe to run against anything.
 */
import { prisma } from './src/config/prisma.js';
import { env } from './src/config/env.js';
import { pushToUsers } from './src/services/pushService.js';

const email = (process.argv[2] || '').trim().toLowerCase();

if (!email) {
  console.error('Usage: npm --prefix server run push-test -- <email>');
  process.exit(1);
}

if (!env.pushEnabled) {
  console.error(
    'Push is not configured — set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in server/.env.\n' +
      'Generate a pair with:\n' +
      '  node -e "console.log(require(\'web-push\').generateVAPIDKeys())"'
  );
  process.exit(1);
}

const user = await prisma.user.findUnique({
  where: { email },
  select: { id: true, name: true, role: true },
});

if (!user) {
  console.error(`No account for ${email}.`);
  process.exit(1);
}

const devices = await prisma.pushSubscription.findMany({
  where: { userId: user.id },
  select: { userAgent: true, createdAt: true },
});

console.log(`${user.name} (${user.role}) — ${devices.length} subscribed device(s)`);
devices.forEach((d, i) =>
  console.log(`  ${i + 1}. ${d.userAgent.slice(0, 70) || 'unknown browser'}`)
);

if (!devices.length) {
  console.error(
    '\nNothing to send to. Sign in as this person, open the bell, and choose\n' +
      '"Also notify me on this device".'
  );
  process.exit(1);
}

const result = await pushToUsers([user.id], {
  title: 'Test notification',
  message: 'If you can read this, push notifications are working.',
  link: '/',
  type: 'test',
});

console.log(`\naccepted by the push service: ${result.sent}`);
if (result.removed) console.log(`dead subscriptions removed: ${result.removed}`);
if (!result.sent) console.log('Nothing was accepted — see the errors above.');
else
  console.log(
    'Now look at the desktop, not the browser: nothing is shown while the tab\n' +
      'is visible and focused, because the page raises its own toast instead.'
  );

await prisma.$disconnect();
