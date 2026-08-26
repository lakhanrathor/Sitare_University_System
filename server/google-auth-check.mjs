/**
 * Unit-level checks for the Google sign-in business rules in
 * `resolveGoogleUser` (src/controllers/authController.js).
 *
 * These run against fabricated, already-"verified" payloads — the shape
 * `googleClient.verifyIdToken().getPayload()` hands back — rather than a
 * real Google ID token. That split is deliberate: signature, issuer,
 * audience and expiry are Google's own library's job, exercised instead by
 * the HTTP-level checks in security-check.mjs against real garbage and
 * self-signed tokens. What belongs to this project — and what actually
 * needs a test that does not depend on a live Google sign-in — is what
 * happens *after* Google has vouched for an email: the domain check, the
 * ERP lookup, the active check, and refusing to trust anything else the
 * token might carry.
 *
 * Connects to the same MongoDB the app uses. Run after `npm run seed` (or
 * against a dev database with real accounts) so known users exist:
 *   node google-auth-check.mjs
 */
import { connectDB, disconnectDB } from './src/config/db.js';
import { resolveGoogleUser } from './src/controllers/authController.js';
import User from './src/models/User.js';
import ApiError from './src/utils/ApiError.js';
// Registered for its side effect only: resolveGoogleUser populates `section`,
// which throws unless this model has been registered with mongoose first.
import './src/models/Section.js';

let pass = 0;
let fail = 0;

function report(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function expectRejection(name, payload, expectedStatus) {
  try {
    await resolveGoogleUser(payload);
    report(name, false, 'resolved instead of rejecting');
  } catch (err) {
    const ok = err instanceof ApiError && err.statusCode === expectedStatus;
    report(name, ok, ok ? '' : `got ${err.statusCode || 'a non-ApiError'}: ${err.message}`);
  }
}

const basePayload = (email, extra = {}) => ({
  email,
  email_verified: true,
  sub: `test-sub-${email}`,
  ...extra,
});

await connectDB();
console.log('== Google sign-in business rules ==\n');

console.log('Rejected before any account is even looked up');
await expectRejection(
  'unverified email is refused',
  basePayload('admin@sitare.org', { email_verified: false }),
  401
);
await expectRejection('missing email is refused', { email_verified: true, sub: 'x' }, 401);
await expectRejection('non-@sitare.org email is refused', basePayload('someone@gmail.com'), 401);
await expectRejection(
  'a lookalike domain is refused',
  basePayload('admin@sitare.org.evil.com'),
  401
);

console.log('\nAccount lookup');
await expectRejection(
  'a real-looking but unregistered @sitare.org address is refused, not provisioned',
  basePayload(`nobody-${Date.now()}@sitare.org`),
  403
);

const beforeCount = await User.countDocuments();
try {
  await resolveGoogleUser(basePayload(`ghost-${Date.now()}@sitare.org`));
} catch {
  /* expected to throw — the point is whether it also created anything */
}
const afterCount = await User.countDocuments();
report(
  'an unknown account is never auto-created',
  afterCount === beforeCount,
  `${beforeCount} -> ${afterCount}`
);

const admin = await User.findOne({ role: 'admin', isActive: true }).lean();
const faculty = await User.findOne({ role: 'faculty', isActive: true }).lean();
const student = await User.findOne({ role: 'student', isActive: true }).lean();
const disabled = await User.findOne({ isActive: false }).lean();

if (admin) {
  const u = await resolveGoogleUser(basePayload(admin.email));
  report('an existing admin signs in with Google and keeps role=admin', u.role === 'admin');
} else {
  console.log('  skip  (no active admin account in this database)');
}

if (faculty) {
  const u = await resolveGoogleUser(basePayload(faculty.email));
  report('an existing faculty account signs in and keeps role=faculty', u.role === 'faculty');
} else {
  console.log('  skip  (no active faculty account in this database)');
}

if (student) {
  const u = await resolveGoogleUser(basePayload(student.email));
  report('an existing student account signs in and keeps role=student', u.role === 'student');
} else {
  console.log('  skip  (no active student account in this database)');
}

if (disabled) {
  await expectRejection(
    'a deactivated account is refused even with a valid Google email',
    basePayload(disabled.email),
    403
  );
} else {
  console.log('  skip  (no deactivated account in this database to test against)');
}

console.log('\nThe token can never grant a role or identity it does not already have');
if (student) {
  // A forged claim inside the token itself. resolveGoogleUser has no code
  // path that reads `role` (or anything like it) from the payload at all,
  // so planting one here must have zero effect on the result.
  const u = await resolveGoogleUser(basePayload(student.email, { role: 'admin', is_admin: true }));
  report('a client-supplied role claim in the token is ignored', u.role === 'student');
}

console.log('\nAccount linking (Google subject id)');
if (student) {
  const fresh = await User.findOne({ email: student.email });
  const originalSub = fresh.googleSub;
  await User.updateOne({ _id: fresh._id }, { $set: { googleSub: null } });

  const firstLogin = await resolveGoogleUser(basePayload(student.email, { sub: 'linking-test-sub-1' }));
  report(
    'the Google subject is recorded on first sign-in',
    firstLogin.googleSub === 'linking-test-sub-1'
  );

  const before = await User.countDocuments({ email: student.email });
  await resolveGoogleUser(basePayload(student.email, { sub: 'linking-test-sub-1' }));
  const after = await User.countDocuments({ email: student.email });
  report(
    'signing in again with the same email never creates a second record',
    before === after && after === 1
  );

  // Leave the account exactly as this test found it.
  await User.updateOne({ _id: fresh._id }, { $set: { googleSub: originalSub } });
}

console.log(`\n${pass} passed, ${fail} failed`);
await disconnectDB();
process.exit(fail ? 1 : 0);
