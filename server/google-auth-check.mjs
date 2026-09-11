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
 * Connects to the same PostgreSQL the app uses. Run after `npm run seed:demo:pg`
 * (or against a dev database with real accounts) so known users exist — with
 * only an admin, most of this file skips:
 *   node google-auth-check.mjs
 */
import { prisma } from './src/config/prisma.js';
import { resolveGoogleUser } from './src/controllers/authController.js';
import ApiError from './src/utils/ApiError.js';

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

await prisma.$connect();
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

const beforeCount = await prisma.user.count();
try {
  await resolveGoogleUser(basePayload(`ghost-${Date.now()}@sitare.org`));
} catch {
  /* expected to throw — the point is whether it also created anything */
}
const afterCount = await prisma.user.count();
report(
  'an unknown account is never auto-created',
  afterCount === beforeCount,
  `${beforeCount} -> ${afterCount}`
);

const admin = await prisma.user.findFirst({ where: { role: 'admin', isActive: true } });
const faculty = await prisma.user.findFirst({ where: { role: 'faculty', isActive: true } });
const student = await prisma.user.findFirst({ where: { role: 'student', isActive: true } });
const disabled = await prisma.user.findFirst({ where: { isActive: false } });

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
  const fresh = await prisma.user.findUnique({ where: { email: student.email } });
  const originalSub = fresh.googleSub;
  await prisma.user.update({ where: { id: fresh.id }, data: { googleSub: null } });

  const firstLogin = await resolveGoogleUser(basePayload(student.email, { sub: 'linking-test-sub-1' }));
  report(
    'the Google subject is recorded on first sign-in',
    firstLogin.googleSub === 'linking-test-sub-1'
  );

  const before = await prisma.user.count({ where: { email: student.email } });
  await resolveGoogleUser(basePayload(student.email, { sub: 'linking-test-sub-1' }));
  const after = await prisma.user.count({ where: { email: student.email } });
  report(
    'signing in again with the same email never creates a second record',
    before === after && after === 1
  );

  // Leave the account exactly as this test found it.
  await prisma.user.update({ where: { id: fresh.id }, data: { googleSub: originalSub ?? null } });
}

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail ? 1 : 0);
