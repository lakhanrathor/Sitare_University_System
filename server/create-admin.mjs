/**
 * Create exactly one real admin account — the bootstrap step a genuinely
 * empty production database needs, since every account in this app is
 * normally created by an existing admin through Admin -> People, and that
 * screen is unreachable with zero users to log in as.
 *
 * Deliberately the opposite of seed.js: this never deletes anything. It
 * checks for the email first and refuses if the account already exists,
 * so it is safe to run against a database that already holds real people —
 * seed.js's `deleteMany` reset is not, and must never be run there.
 *
 * Usage:
 *   node create-admin.mjs "Full Name" "email@sitare.org" "a-real-password"
 */
import { connectDB, disconnectDB } from './src/config/db.js';
import User from './src/models/User.js';

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

await connectDB();

const existing = await User.findOne({ email }).select('_id role').lean();
if (existing) {
  console.error(
    `[create-admin] ${email} already exists (role: ${existing.role}). Nothing was changed — ` +
      `use the app's own Admin -> People screen to edit an existing account, or pick a different email.`
  );
  await disconnectDB();
  process.exit(1);
}

const admin = await User.create({
  name: name.trim(),
  email,
  password, // hashed by the User model's pre('save') hook
  role: 'admin',
  department: 'Administration',
  isActive: true,
});

console.log(`[create-admin] Created admin account: ${admin.email} (id ${admin._id})`);
console.log('[create-admin] Sign in with the password you just chose. Nothing else was created or changed.');

await disconnectDB();
process.exit(0);
