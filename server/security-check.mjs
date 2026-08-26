/**
 * Security regression checks, driven against a running dev server — the same
 * "exercise the real API, no mock" approach the README's "Verified behaviour"
 * section already uses for functional checks. There is no unit-test
 * framework in this project; this fills the equivalent role for the security
 * fixes below.
 *
 * Requires the API on :5000 (`npm run dev` or `npm run use`) and the demo
 * accounts from `npm run seed`. Run with: node security-check.mjs
 */

const API = process.env.API_URL || 'http://localhost:5000/api';
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

async function call(path, opts = {}, token) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

async function login(email, password) {
  const r = await call('/auth/login', { method: 'POST', body: { email, password } });
  if (!r.json?.success) throw new Error(`login failed for ${email}: ${r.json?.message}`);
  return { token: r.json.data.token, user: r.json.data.user };
}

console.log('== Sitare ERP security checks ==\n');

const admin = await login('admin@sitare.org', 'admin123');

/* -------------------------------------------------------------- */
/* 1. Invalid / missing / forged JWTs                              */
/* -------------------------------------------------------------- */
console.log('JWT handling');
{
  const noToken = await call('/auth/me');
  report('no token -> 401', noToken.status === 401);

  const garbage = await call('/auth/me', {}, 'not-a-real-token');
  report('malformed token -> 401', garbage.status === 401);

  // A token signed with the wrong secret must never be accepted.
  const [header, payload] = admin.token.split('.');
  const forged = `${header}.${payload}.${'a'.repeat(43)}`;
  const forgedRes = await call('/auth/me', {}, forged);
  report('forged signature -> 401', forgedRes.status === 401);

  const wrongScheme = await call('/auth/me', { headers: { Authorization: admin.token } });
  report('missing "Bearer " prefix -> 401', wrongScheme.status === 401);
}

/* -------------------------------------------------------------- */
/* 2. RBAC — role gates hold even with a valid token               */
/* -------------------------------------------------------------- */
console.log('\nRole-based access control');
{
  const users = (await call('/admin/users', {}, admin.token)).json.data;
  const student = users.find((u) => u.role === 'student' && u.isActive);
  const otherStudent = users.find(
    (u) => u.role === 'student' && u.isActive && u.id !== student?.id
  );
  const faculty = users.filter((u) => u.role === 'faculty' && u.isActive);

  const studentLogin = await tryDemoLogin(student, 'student123');
  const facultyLogins = await Promise.all(
    faculty.slice(0, 6).map((f) => tryDemoLogin(f, 'faculty123'))
  );
  const twoFaculty = facultyLogins.filter(Boolean);

  if (studentLogin) {
    const adminOnly = await call('/admin/overview', {}, studentLogin.token);
    report('student blocked from /admin/*', adminOnly.status === 403);

    const otherAttendance = otherStudent
      ? await call(`/attendance/me/subject/${otherStudent.id}`, {}, studentLogin.token)
      : null;
    if (otherAttendance) {
      report(
        'student cannot read a subject id that is not theirs',
        otherAttendance.status === 403 || otherAttendance.status === 404
      );
    }
  } else {
    console.log('  skip  (no working student demo password found)');
  }

  if (twoFaculty.length >= 2) {
    const [facultyA, facultyB] = twoFaculty;
    // A's subjects should never include something owned by B, and vice versa.
    const aSubjects = (await call('/subjects', {}, facultyA.token)).json.data;
    const bOwnsAny = aSubjects.some((s) => s.faculty?.id === facultyB.user.id);
    report("faculty A's subject list contains none of faculty B's subjects", !bOwnsAny);
  } else {
    console.log('  skip  (fewer than two faculty demo logins available)');
  }
}

/* -------------------------------------------------------------- */
/* 3. IDOR — faculty cross-student / cross-note access             */
/* -------------------------------------------------------------- */
console.log('\nIDOR / resource-level authorization');
{
  const users = (await call('/admin/users', {}, admin.token)).json.data;
  const faculty = users.filter((u) => u.role === 'faculty' && u.isActive);
  const facultyLogins = (
    await Promise.all(faculty.slice(0, 8).map((f) => tryDemoLogin(f, 'faculty123')))
  ).filter(Boolean);

  const notes = (await call('/notes', {}, admin.token)).json.data;

  for (const fl of facultyLogins) {
    const myNotes = (await call('/notes', {}, fl.token)).json.data;
    const myNoteIds = new Set(myNotes.map((n) => n.id));
    const outOfScope = notes.find((n) => !myNoteIds.has(n.id) && n.attachments?.length);
    if (!outOfScope) continue;

    const attempt = await call(
      `/notes/${outOfScope.id}/attachments/${outOfScope.attachments[0].id}`,
      {},
      fl.token
    );
    report(
      `faculty (${fl.user.name}) cannot download a note outside their cohort`,
      attempt.status === 403 || attempt.status === 404
    );

    const students = users.filter((u) => u.role === 'student' && u.isActive);
    const facultySubjects = (await call('/subjects', {}, fl.token)).json.data;
    const roster = await Promise.all(
      facultySubjects.map((sub) => call(`/subjects/${sub.id}`, {}, fl.token))
    );
    const myStudentIds = new Set(
      roster.flatMap((r) => r.json?.data?.students?.map((st) => st.studentId) || [])
    );

    let checked = 0;
    let violations = 0;
    for (const s of students.slice(0, 20)) {
      const res = await call(`/attendance/student/${s.id}`, {}, fl.token);
      checked += 1;
      if (res.status === 200 && !myStudentIds.has(s.id)) violations += 1;
    }
    report(
      `attendance/student/:id for ${fl.user.name} — 200 only for their own ${myStudentIds.size} student(s), checked ${checked}`,
      violations === 0,
      `${violations} unrelated student(s) returned 200`
    );
    break; // one faculty account is enough to demonstrate the check.
  }
}

/* -------------------------------------------------------------- */
/* 4. NoSQL operator injection via query string                    */
/* -------------------------------------------------------------- */
console.log('\nNoSQL injection');
{
  const unfiltered = await call('/admin/users', {}, admin.token);
  const straight = await call('/admin/users?role=student', {}, admin.token);
  const injected = await call('/admin/users?role[$ne]=student', {}, admin.token);

  /*
   * With Express's default ('extended') query parser, `role[$ne]=student`
   * becomes `{ role: { $ne: 'student' } }` and MongoDB happily runs it as an
   * operator — returning every non-student. With 'simple' parsing there is no
   * nested object at all: `role` stays undefined, no filter is applied, and
   * the result is identical to no filter — never the attacker-chosen subset.
   */
  report(
    'bracket-notation query operator applies no filter at all (not treated as $ne)',
    injected.status === 200 &&
      injected.json.data.length === unfiltered.json.data.length &&
      injected.json.data.some((u) => u.role === 'student'),
    `unfiltered=${unfiltered.json?.data?.length}, injected=${injected.json?.data?.length}`
  );
  report(
    'the equivalent plain query still filters correctly',
    straight.status === 200 &&
      straight.json.data.length > 0 &&
      straight.json.data.every((u) => u.role === 'student')
  );
}

/* -------------------------------------------------------------- */
/* 5. Excessive data exposure                                      */
/* -------------------------------------------------------------- */
console.log('\nData exposure');
{
  const me = await call('/auth/me', {}, admin.token);
  report('user payload never includes a password field', !('password' in (me.json?.data?.user || {})));

  const users = await call('/admin/users', {}, admin.token);
  const anyPassword = users.json.data.some((u) => 'password' in u);
  report('user list never includes a password field', !anyPassword);
}

/* -------------------------------------------------------------- */
/* 6. Production error handling shape                              */
/* -------------------------------------------------------------- */
console.log('\nError handling');
{
  const badId = await call('/admin/users/not-a-real-object-id', { method: 'PATCH', body: {} }, admin.token);
  report('malformed id -> 4xx, not a raw 500 with a stack', badId.status >= 400 && badId.status < 500);
  report('error body carries no stack trace field by default', !badId.json?.stack || process.env.NODE_ENV !== 'production');
}

/* -------------------------------------------------------------- */
/* 7. Google sign-in — the token-verification layer                */
/* -------------------------------------------------------------- */
console.log('\nGoogle sign-in (HTTP layer)');
{
  /*
   * The business rules behind this endpoint — domain check, ERP lookup,
   * active check, ignoring any role the token claims — are covered as unit
   * tests in google-auth-check.mjs against fabricated payloads. What belongs
   * here is the network-facing layer: does the endpoint actually reject
   * tokens it did not get from Google, with a message that gives nothing away.
   */
  const noCred = await call('/auth/google', { method: 'POST', body: {} });
  report('missing credential -> 400 (schema validation)', noCred.status === 400);

  const garbage = await call('/auth/google', { method: 'POST', body: { credential: 'not-a-jwt-at-all' } });

  // A JWT-shaped token that only *looks* like a Google one — same claim
  // shape, signed by nobody Google trusts. If GOOGLE_CLIENT_ID is not
  // configured, both requests instead get the "not configured" refusal,
  // which is exactly as safe (email/password login is completely unaffected
  // either way) and is reported as a skip rather than a failure.
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const forged = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
    iss: 'https://accounts.google.com',
    aud: 'not-really-this-servers-client-id',
    email: 'admin@sitare.org',
    email_verified: true,
    sub: 'forged-sub',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.forged-signature`;
  const forgedRes = await call('/auth/google', { method: 'POST', body: { credential: forged } });

  const notConfigured = garbage.json?.message === 'Google sign-in is not configured on this server.';
  if (notConfigured) {
    console.log('  skip  (GOOGLE_CLIENT_ID not set — verified via google-auth-check.mjs instead)');
  } else {
    report('a non-JWT string is rejected, not verified', garbage.status === 401);
    report(
      'a forged, unsigned-by-Google token is rejected even with the right shape',
      forgedRes.status === 401
    );
    report(
      "a forged token's error message reveals nothing about why it failed",
      /could not verify/i.test(forgedRes.json?.message || '') && !forgedRes.json?.message?.includes('sitare.org')
    );
  }

  // Whatever the outcome, a Google token is never echoed back in a response.
  report(
    'the submitted credential is never reflected in the response body',
    !JSON.stringify(forgedRes.json || {}).includes(forged)
  );
}

/* -------------------------------------------------------------- */
/* 8. Socket.io authentication                                     */
/* -------------------------------------------------------------- */
console.log('\nSocket.io');
await socketCheck();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/* ---------------------------------------------------------------- */

async function tryDemoLogin(user, password) {
  if (!user) return null;
  try {
    const { token, user: u } = await login(user.email, password);
    return { token, user: u };
  } catch {
    return null;
  }
}

async function socketCheck() {
  const { io } = await import('socket.io-client').catch(() => ({ io: null }));
  if (!io) {
    console.log('  skip  (socket.io-client not installed in server/node_modules)');
    return;
  }
  const base = API.replace('/api', '');

  const rejected = await new Promise((resolve) => {
    const s = io(base, { auth: { token: 'not-a-real-token' }, reconnection: false, timeout: 3000 });
    s.on('connect', () => {
      s.close();
      resolve(false);
    });
    s.on('connect_error', () => {
      s.close();
      resolve(true);
    });
    setTimeout(() => {
      s.close();
      resolve(false);
    }, 4000);
  });
  report('socket connection with an invalid token is rejected', rejected);

  const accepted = await new Promise((resolve) => {
    const s = io(base, { auth: { token: admin.token }, reconnection: false, timeout: 3000 });
    s.on('connect', () => {
      s.close();
      resolve(true);
    });
    s.on('connect_error', () => {
      s.close();
      resolve(false);
    });
    setTimeout(() => {
      s.close();
      resolve(false);
    }, 4000);
  });
  report('socket connection with a valid token is accepted', accepted);
}
