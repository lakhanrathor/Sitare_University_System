/**
 * Create exactly one real admin account — the bootstrap step a genuinely
 * empty production database needs, since every account in this app is
 * normally created by an existing admin through Admin -> People, and that
 * screen is unreachable with zero users to log in as.
 *
 * Deliberately the opposite of seed.js: this never deletes anything. It
 * checks for the email first and refuses if the account already exists,
 * so it is safe to run against a database that already holds real people —
 * seed.js's reset is not, and must never be run there.
 *
 * Usage:
 *   node create-admin.mjs "Full Name" "email@sitare.org" "a-real-password"
 */
import { prisma } from './src/config/prisma.js';
import { hashPassword } from './src/utils/user.js';

const [, , name, emailArg, password] = process.argv;

function usageError(message) {
  console.error(`[create-admin] ${message}`);
  console.error('\nUsage: node create-admin.mjs "Full Name" "email@sitare.org" "a-real-password"');
  process.exit(1);
}

if (!name || !emailArg || !password) {
  usageError('Name, email and password are all required.');
}
if (name.trim().length < 2) {
  usageError('Name is too short.');
}
const email = emailArg.trim().toLowerCase();
if (!/^\S+@\S+\.\S+$/.test(email)) {
  usageError(`"${emailArg}" does not look like a valid email address.`);
}
if (password.length < 6) {
  usageError('Password must be at least 6 characters.');
}

const existing = await prisma.user.findUnique({
  where: { email },
  select: { id: true, role: true },
});
if (existing) {
  console.error(
    `[create-admin] ${email} already exists (role: ${existing.role}). Nothing was changed — ` +
      `use the app's own Admin -> People screen to edit an existing account, or pick a different email.`
  );
  await prisma.$disconnect();
  process.exit(1);
}

const admin = await prisma.user.create({
  data: {
    name: name.trim(),
    email,
    // hashPassword is the one place that decides the cost factor, so nothing
    // ever writes a password that was hashed some other way.
    password: await hashPassword(password),
    role: 'admin',
    department: 'Administration',
    isActive: true,
  },
});

console.log(`[create-admin] Created admin account: ${admin.email} (id ${admin.id})`);
console.log('[create-admin] Sign in with the password you just chose. Nothing else was created or changed.');

await prisma.$disconnect();
process.exit(0);
