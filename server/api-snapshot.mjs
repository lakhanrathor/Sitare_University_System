/**
 * Golden-output regression harness.
 *
 * security-check.mjs proves status codes; this proves *values*. A migration
 * that returns 200 with a silently wrong attendance percentage, a
 * mis-scoped note list, or a delegation attached to the wrong class passes
 * every existing check in this project. This is the thing that catches it.
 *
 *   node api-snapshot.mjs --write     write the baseline
 *   node api-snapshot.mjs --compare   diff the live API against the baseline
 *
 * Requires the API running and the fixture loaded (`npm run seed:demo`).
 * Point it elsewhere with API_URL, as security-check.mjs does.
 *
 * The whole design rests on canonicalisation. Ids and dates are guaranteed
 * to differ between runs — ObjectIds are fresh on every reseed, and the
 * fixture anchors itself to the current week — so both are replaced with
 * stable aliases before anything is written. Whatever survives that and
 * still looks like an id is a hole in the canonicaliser, and is reported
 * rather than quietly baked into the baseline.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';

const API = process.env.API_URL || 'http://localhost:5000/api';
const BASELINE = new URL('./api-snapshot.baseline.json', import.meta.url);

const mode = process.argv.includes('--write')
  ? 'write'
  : process.argv.includes('--compare')
    ? 'compare'
    : null;

if (!mode) {
  console.error('Usage: node api-snapshot.mjs --write | --compare');
  process.exit(2);
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

async function call(path, token) {
  const res = await fetch(`${API}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* not a JSON body — a file download, say */
  }
  return { status: res.status, body: json?.data ?? json ?? null };
}

async function login(email, password) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!json?.success) throw new Error(`login failed for ${email}: ${json?.message}`);
  return json.data.token;
}

/* ------------------------------------------------------------------ */
/* Canonicalisation                                                    */
/* ------------------------------------------------------------------ */

/*
 * Two id shapes, because both databases are live during the migration: a
 * Mongo ObjectId from an un-ported module and a UUID from a ported one. An
 * unrecognised id survives canonicalisation and then differs on every
 * reseed, so the baseline would churn rather than catch anything.
 */
const ID_ANY = /^(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const ID_EMBEDDED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24}/gi;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;

/** id -> alias, seeded from natural keys and extended positionally. */
const aliases = new Map();
let anonymousCount = 0;

function alias(id) {
  const key = String(id);
  if (!aliases.has(key)) {
    /*
     * Anything without a natural key — sessions, timetable entries,
     * attachments, notifications — gets a positional alias. That is stable
     * only because the fixture is deterministic and the endpoint list below
     * is fixed, which is precisely the property this harness exists to
     * depend on. If the set or order of ids changes, the diff says so, and
     * that is a real finding rather than noise.
     */
    aliases.set(key, `@id:${++anonymousCount}`);
  }
  return aliases.get(key);
}

/** Monday of the fixture's anchor week, used to express dates as offsets. */
let monday = null;

function dayOffset(dateKey) {
  const a = Date.parse(`${dateKey}T00:00:00.000Z`);
  const b = Date.parse(`${monday}T00:00:00.000Z`);
  return Math.round((a - b) / 86400000);
}

function dateAlias(dateKey) {
  const n = dayOffset(dateKey);
  return `@d${n >= 0 ? '+' : ''}${n}`;
}

function canonical(value) {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    if (ID_ANY.test(value)) return alias(value);
    if (ISO_TS.test(value)) return '@ts';
    if (DATE_KEY.test(value) && monday) return dateAlias(value);
    /*
     * Composite identifiers — resolveOccurrences builds
     * `${entryId}-${dateKey}-${slot}` as a React key — carry an id and a
     * date *inside* a longer string. Matching only whole-string ids let
     * those through and made the baseline churn on every reseed.
     */
    return value
      .replace(ID_EMBEDDED, (m) => alias(m))
      .replace(/\d{4}-\d{2}-\d{2}/g, (m) => (monday ? dateAlias(m) : m));
  }

  if (Array.isArray(value)) return value.map(canonical);

  if (typeof value === 'object') {
    // Sorted keys so serialisation is stable regardless of insertion order.
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
    return out;
  }

  return value;
}

/* ------------------------------------------------------------------ */
/* Reference data — builds the readable half of the alias map          */
/* ------------------------------------------------------------------ */

async function buildAliases(adminToken) {
  const [users, sections, subjects, timetables] = await Promise.all([
    call('/admin/users?role=', adminToken),
    call('/admin/sections', adminToken),
    call('/admin/subjects', adminToken),
    call('/timetable/versions', adminToken),
  ]);

  for (const role of ['student', 'faculty', 'admin']) {
    const r = await call(`/admin/users?role=${role}`, adminToken);
    for (const u of r.body || []) aliases.set(String(u.id), `@user:${u.email}`);
  }
  for (const u of users.body || []) {
    if (!aliases.has(String(u.id))) aliases.set(String(u.id), `@user:${u.email}`);
  }
  for (const s of sections.body || []) {
    aliases.set(String(s.id), `@section:${s.name || 'all'}/sem${s.semester}`);
  }
  for (const s of subjects.body || []) {
    aliases.set(String(s.id), `@subject:${s.code}/${s.section?.name || 'all'}`);
  }
  for (const t of timetables.body || []) {
    aliases.set(String(t.id), `@timetable:sem${t.semester}`);
  }

  return {
    users: users.body || [],
    sections: sections.body || [],
    subjects: subjects.body || [],
  };
}

/* ------------------------------------------------------------------ */
/* The endpoint list                                                   */
/* ------------------------------------------------------------------ */

async function collect() {
  const adminToken = await login('admin@sitare.org', 'admin123');
  const ref = await buildAliases(adminToken);

  /*
   * The anchor the fixture used. Read from the data rather than recomputed,
   * so a snapshot taken against a fixture seeded last week still aligns.
   */
  const anyTimetable = (await call('/timetable/versions', adminToken)).body?.[0];
  monday = anyTimetable?.effectiveFrom
    ? new Date(Date.parse(`${anyTimetable.effectiveFrom}T00:00:00.000Z`) + 28 * 86400000)
        .toISOString()
        .slice(0, 10)
    : null;

  const facultyToken = await login('ananya.rao@sitare.org', 'faculty123');
  const faculty2Token = await login('vikram.iyer@sitare.org', 'faculty123');
  const studentToken = await login('su-30001@sitare.org', 'student123');
  const student5Token = await login('su-50001@sitare.org', 'student123');

  const subjectByCode = (code) => ref.subjects.find((s) => s.code === code);
  const userByEmail = (email) => ref.users.find((u) => u.email === email);

  const dsa = subjectByCode('DSA');
  const ml = subjectByCode('ML');
  const kabir = userByEmail('su-30003@sitare.org');
  const aarav = userByEmail('su-30001@sitare.org');
  const week = monday;

  /** [label, path, token] — label is what appears in the baseline. */
  const requests = [
    ['admin/me', '/auth/me', adminToken],
    ['admin/overview', '/admin/overview', adminToken],
    ['admin/users', '/admin/users', adminToken],
    ['admin/users?role=student', '/admin/users?role=student', adminToken],
    ['admin/users?role=faculty', '/admin/users?role=faculty', adminToken],
    ['admin/users?deactivatedOnly', '/admin/users?deactivatedOnly=true', adminToken],
    ['admin/users?withAttendance', '/admin/users?role=student&withAttendance=true', adminToken],
    ['admin/faculty', '/admin/faculty', adminToken],
    ['admin/sections', '/admin/sections', adminToken],
    ['admin/subjects', '/admin/subjects', adminToken],
    ['admin/subjects?semester=3', '/admin/subjects?semester=3', adminToken],
    ['admin/subjects/:dsa/roster', `/admin/subjects/${dsa?.id}/roster`, adminToken],
    ['admin/students/:kabir', `/admin/students/${kabir?.id}`, adminToken],
    ['admin/students/:kabir/leave', `/admin/students/${kabir?.id}/leave`, adminToken],

    ['admin/subjects(list)', '/subjects', adminToken],
    ['admin/subject/:dsa', `/subjects/${dsa?.id}`, adminToken],
    ['admin/attendance/student/:aarav', `/attendance/student/${aarav?.id}`, adminToken],
    ['admin/attendance/student/:kabir', `/attendance/student/${kabir?.id}`, adminToken],
    ['admin/sessions/:dsa', `/attendance/subject/${dsa?.id}/sessions`, adminToken],
    ['admin/occurrences/:dsa', `/attendance/subject/${dsa?.id}/occurrences`, adminToken],
    ['admin/timetable/meta', '/timetable/meta', adminToken],
    ['admin/timetable/week/sem3', `/timetable/week?date=${week}&semester=3`, adminToken],
    ['admin/timetable/week/sem5', `/timetable/week?date=${week}&semester=5`, adminToken],
    ['admin/timetable/versions', '/timetable/versions', adminToken],
    ['admin/schedule/changes', '/schedule/changes', adminToken],
    ['admin/schedule/free-slots', `/schedule/free-slots?date=${week}`, adminToken],
    ['admin/swaps', '/swaps', adminToken],
    ['admin/notes', '/notes', adminToken],
    ['admin/exams', '/exams', adminToken],
    ['admin/notifications', '/notifications', adminToken],

    ['faculty/me', '/auth/me', facultyToken],
    ['faculty/subjects', '/subjects', facultyToken],
    ['faculty/subject/:dsa', `/subjects/${dsa?.id}`, facultyToken],
    ['faculty/occurrences/:dsa', `/attendance/subject/${dsa?.id}/occurrences`, facultyToken],
    ['faculty/sessions/:dsa', `/attendance/subject/${dsa?.id}/sessions`, facultyToken],
    ['faculty/timetable/week', `/timetable/week?date=${week}&semester=3`, facultyToken],
    ['faculty/swaps', '/swaps', facultyToken],
    ['faculty/notes', '/notes', facultyToken],
    ['faculty/exams', '/exams', facultyToken],
    // The stand-in: Vikram holds one dated DSA register but must not own DSA.
    ['faculty2/subjects', '/subjects', faculty2Token],
    ['faculty2/occurrences/:dsa', `/attendance/subject/${dsa?.id}/occurrences`, faculty2Token],
    ['faculty2/notes', '/notes', faculty2Token],

    ['student/me', '/auth/me', studentToken],
    ['student/attendance', '/attendance/me', studentToken],
    ['student/attendance/:dsa', `/attendance/me/subject/${dsa?.id}`, studentToken],
    ['student/timetable/week', `/timetable/week?date=${week}`, studentToken],
    ['student/notes', '/notes', studentToken],
    ['student/exams', '/exams', studentToken],
    ['student/leave', '/leave/me', studentToken],
    ['student5/attendance', '/attendance/me', student5Token],
    ['student5/timetable/week', `/timetable/week?date=${week}`, student5Token],
    ['student5/subject/:ml', `/attendance/me/subject/${ml?.id}`, student5Token],
  ];

  const snapshot = {};
  for (const [label, path, token] of requests) {
    const { status, body } = await call(path, token);
    snapshot[label] = { status, body: canonical(body) };
  }

  /*
   * Anything id-shaped that survived canonicalisation means the alias map
   * missed a field, and baking it in would make the baseline change on
   * every reseed for no real reason. Surface it instead of hiding it.
   */
  // Embedded, not just whole-string — a composite key like
  // "<objectId>-2026-09-07-1" is exactly the kind of leak that slips past a
  // whole-string check and then churns the baseline on every reseed.
  const leaked = [...JSON.stringify(snapshot).matchAll(ID_EMBEDDED)].map((m) => m[0]);
  if (leaked.length) {
    console.error(`\n  ${leaked.length} un-aliased id(s) leaked into the snapshot, e.g. ${leaked[0]}`);
    console.error('  Fix the canonicaliser before trusting this baseline.\n');
  }

  return snapshot;
}

/* ------------------------------------------------------------------ */
/* Diffing                                                             */
/* ------------------------------------------------------------------ */

function diff(before, after, path = '', out = []) {
  const a = JSON.stringify(before);
  const b = JSON.stringify(after);
  if (a === b) return out;

  const bothObjects =
    before && after && typeof before === 'object' && typeof after === 'object' &&
    Array.isArray(before) === Array.isArray(after);

  if (!bothObjects) {
    out.push({ path, before, after });
    return out;
  }

  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const k of keys) {
    diff(before[k], after[k], path ? `${path}.${k}` : k, out);
  }
  return out;
}

/* ------------------------------------------------------------------ */

const snapshot = await collect();

if (mode === 'write') {
  writeFileSync(BASELINE, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`Baseline written: ${Object.keys(snapshot).length} endpoints`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error('No baseline to compare against. Run with --write first.');
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const changes = diff(baseline, snapshot);

if (!changes.length) {
  console.log(`Snapshot clean — ${Object.keys(snapshot).length} endpoints identical to baseline.`);
  process.exit(0);
}

console.log(`\n${changes.length} difference(s) against the baseline:\n`);
for (const c of changes.slice(0, 60)) {
  console.log(`  ${c.path}`);
  console.log(`    baseline: ${JSON.stringify(c.before)?.slice(0, 160)}`);
  console.log(`    now:      ${JSON.stringify(c.after)?.slice(0, 160)}`);
}
if (changes.length > 60) console.log(`  …and ${changes.length - 60} more`);
process.exit(1);
