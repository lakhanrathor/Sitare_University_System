# CLAUDE.md

This file orients anyone — human or AI — working in this repository. It explains what the
system is, how it is put together, and the rules that must never be broken when changing it.

## What this is

**Sitare University ERP** — a real-time college administration system replacing a paper
attendance register and a printed timetable. Four roles use it: **student**, **faculty**,
**admin**, and the system itself (background jobs like notifications).

Core modules: Attendance, Timetable (with shifts/swaps/extra classes), Admin (people &
academics), Notes (course material sharing), Exam schedules, and Leave applications.

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React 18 + Vite 6 + Tailwind CSS 4, React Router, `socket.io-client` |
| Backend | Node.js (ESM) + Express 4 + Mongoose 8 (MongoDB) |
| Realtime | Socket.io, JWT-authenticated on both REST and the socket handshake |
| Auth | JWT (`jsonwebtoken`) + bcrypt password hashing, plus optional Google sign-in (`google-auth-library` server-side, `@react-oauth/google` client-side) — both issue the same JWT |
| Validation | Zod schemas on every request body |
| File uploads | `multer` (memory) → GridFS via `services/fileStore.js`; PDFs parsed with `pdfjs-dist` |
| Security middleware | `helmet`, `cors` pinned to the client origin, `express-rate-limit` on both login routes, `'simple'` query parsing (blocks NoSQL operator injection via `?field[$ne]=x`) |

## Repository layout

```
server/src
├── config/        env.js (required env vars) · slots.js (default period grid, seed-time only)
├── models/        User · Section · Subject · Enrollment
│                  ClassSession · Attendance · AttendanceDelegation
│                  Timetable · TimetableEntry · ScheduleChange · SwapRequest
│                  Note · ExamSchedule · LeaveDocument · Notification
├── services/      attendanceService.js  <- the attendance % rule lives here, nowhere else
│                  timetableService.js   <- resolves the grid + keeps attendance in step
│                  pdfParser.js          <- turns a timetable/roster PDF into structured rows
│                  notificationService.js · fileStore.js (GridFS) · purgeService.js
├── controllers/   auth · subject · attendance · timetable · schedule · swap
│                  admin · note · exam · leave · notification
├── middleware/     auth (JWT + role guard) · validate (zod) · error (maps Mongoose/Zod errors) · upload (multer)
├── utils/          audit.js (security/audit log lines) · ApiError · asyncHandler · csv · date · pdf
├── sockets/        JWT-authenticated Socket.io gateway
└── seed/           wipes the DB, creates a single admin account — safe to re-run in dev/staging

server/  (repo root of the API, one level up from src/)
├── security-check.mjs      <- HTTP-level security regression checks against a running server
├── google-auth-check.mjs   <- unit checks for resolveGoogleUser against fabricated payloads
└── create-admin.mjs        <- adds one admin to a database that must NOT be wiped (real prod)

client/src
├── context/        Auth · Socket · Toast · Notification
├── pages/student/   Dashboard · SubjectDetail · Leave
├── pages/faculty/   Dashboard · TakeAttendance · SubjectReport
├── pages/timetable/ Timetable (week grid, role-aware)
├── pages/admin/     AdminHome · People · Academics · ManageTimetable · StudentProfile
├── pages/notes/     Notes
├── pages/exams/     Exams
├── pages/swaps/     Swaps (request queue + admin approval)
├── components/      Layout · AttendanceRing · NotificationBell · timetable/* · ui.jsx
└── lib/             api.js (every backend call) · timetable.js · format.js
```

## Running it locally

Requires Node 18+ and a local MongoDB on `mongodb://127.0.0.1:27017`.

```bash
npm run setup   # installs root + server + client deps
npm run seed    # resets the DB and creates one admin account — safe to re-run
npm run dev     # API on :5000 (auto-restarts on save) + web on :5173, together
```

Open <http://localhost:5173>. Vite proxies `/api` and `/socket.io` to the API.

- `npm run dev` restarts the API on every server-file save (`node --watch`) — convenient while
  editing, but a request that lands mid-restart gets no response. `npm run use` runs the API
  without `--watch` for a stable session (e.g. a live demo); the client's fetch wrapper also
  retries automatically on that specific failure signature either way.
- `npm run stop` frees ports 5000/5173 if a previous run didn't shut down cleanly.
- `npm run seed` (`server/src/seed/seed.js`) wipes every collection and creates exactly one
  account: `admin@sitare.org` / `admin123`. Everything else — sections, faculty, students,
  subjects, the timetable — starts empty on purpose, so the real workflow (log in as admin,
  then build the rest through Admin → People / Academics / Manage Timetable) can be tested
  from a genuinely clean slate. It is a dev/staging tool only: it deletes everything first, so
  it must never be run against a database holding real people — see `create-admin.mjs` below
  for that case. The login page pre-fills the admin credentials automatically in dev builds
  only (`import.meta.env.DEV`) — never in a production build.
- `GOOGLE_CLIENT_ID` (server `.env`) and `VITE_GOOGLE_CLIENT_ID` (client `.env`, same value) enable
  Google sign-in — see `.env.example` in each package. Both are optional: unset, the "Continue
  with Google" button simply doesn't render and `/api/auth/google` refuses with a clear "not
  configured" message, so password login is unaffected on a checkout with no Google Cloud project.
- `npm --prefix server run security-check` and `npm --prefix server run google-auth-check` are
  the closest thing this project has to a test suite — see **Security** below.

## Domain rules that must not be broken

**Attendance is always `present ÷ conducted`, never `present ÷ planned`.**
Enforced once in [attendanceService.js](server/src/services/attendanceService.js) — every
screen reads from it. `plannedClasses` is context only. A subject with 0 classes conducted
shows "—", never 0%. A cancelled class leaves the denominator entirely.

**The timetable is never materialised per date.** `TimetableEntry` is the recurring weekly
grid; `ScheduleChange` documents (`extra` | `move` | `cancel`) overlay it for specific dates.
[`resolveOccurrences()`](server/src/services/timetableService.js) merges the two on every read.
A swap is just two linked `move` documents, so the resolver only ever has to understand three
shapes. **Every `ScheduleChange` must carry a `timetable` field** — without it, a section-less
booking (`section: null`, used for whole-year periods) matches every semester's query and leaks
across semesters. This bit the project once; do not remove the field or the scoping clause in
`resolveOccurrences`.

**Office-hours periods are not classes.** A period with `kind: 'office-hours'` must never be
offered for attendance, never generate a `ClassSession`, and never appear in the attendance
picker. This is enforced at three separate points in
[attendanceController.js](server/src/controllers/attendanceController.js) — the picker, the
block-apply path, and the direct-mark endpoint — because any one of them missing the check
reopens the hole.

**A subject always has a lecturer.** `Subject.faculty` is `required: true`. The one place it is
deliberately allowed to go `null` is [`purgeService.js`](server/src/services/purgeService.js)
when a faculty account is deleted — the subject survives, unassigned, so an admin can hand it to
someone else. Any code that reads `subject.faculty` into a query filter must handle that `null`
explicitly (`String(null)` silently becomes the string `"null"`, which then fails to cast to an
ObjectId with a confusing `CastError` deep in an unrelated query).

**A stand-in marks one class, not the subject.** `AttendanceDelegation` is keyed to
`(subject, dateKey, slot)`, not the recurring period — next week the register belongs to its
own lecturer again. It only decides who *may mark*; the class still belongs to, and appears on
the dashboard of, its own subject and faculty. Once the delegated date is in the past, it must
stop appearing in the stand-in's own subject list (see `listSubjects` in
[subjectController.js](server/src/controllers/subjectController.js)).

**PDF extraction is inference, never trusted blindly.** A PDF carries no table structure, only
ink at coordinates — [`pdfParser.js`](server/src/services/pdfParser.js) groups glyph runs into
rows by baseline and into columns by x-position before joining any text. Reading a file writes
nothing: the admin is always shown the parsed table (subjects, kinds, warnings) and must confirm
before anything is published.

**Notes and exam schedules are scoped to who can actually see them.** A note or exam schedule
belongs to a `semester` and, optionally, one `section` within it (`null` section = whole year).
Faculty only see notes for cohorts they actually teach, plus their own uploads — not every
faculty member's material. Students only see their own semester + section.

**Deactivate, don't delete.** Attendance records reference people and subjects, so removing
them would tear holes in past registers. Faculty, students, subjects with recorded history, and
sections are deactivated/retired, never hard-deleted, and a lecturer who still teaches something
must be reassigned before their account can go.

## Data model

```
Section       -> name, semester
User          -> role student|faculty|admin, section (students)
Subject       -> code × section (unique), faculty (required), plannedClasses (context only), minAttendance
Enrollment    -> student × subject (unique)
ClassSession  -> subject, dateKey, slot (unique) · completed|cancelled — the attendance denominator
Attendance    -> session × student (unique) · present|absent|late
AttendanceDelegation -> subject × dateKey × slot (unique) · who may mark this one class

Timetable      -> versioned, draft|published|archived, per semester
TimetableEntry -> timetable × dayOfWeek × slot × section (unique) · subject, faculty, kind
ScheduleChange -> extra | move | cancel, on a specific date · always carries `timetable`
SwapRequest    -> two entries + dates · pending|approved|rejected|declined|withdrawn

Note          -> semester, section (nullable), subject, attachments (GridFS), uploadedBy
ExamSchedule  -> semester, section (nullable), papers[] (dated), attachments (GridFS)
LeaveDocument -> student, sentAt, regarding, attachments (GridFS) · source student|upload|email
Notification  -> per recipient, pushed over the socket and persisted
```

## API surface

All routes except `/api/auth/login` and `/api/auth/google` require `Authorization: Bearer <token>`.

| Base | Covers |
| --- | --- |
| `/api/auth` | password login, Google sign-in, `me`, change password |
| `/api/subjects` | role-scoped subject list and detail |
| `/api/attendance` | sessions, sheets, marking, cancelling — faculty own subjects, admin any |
| `/api/timetable` | meta, week view, versions, PDF preview/upload, publish |
| `/api/schedule` | free slots, extra/move/cancel, schedule-change list |
| `/api/swaps` | candidates, create, decide (admin only), decline/withdraw |
| `/api/admin` | users, sections, subjects, overview, imports |
| `/api/notes` | course material — upload/list/download, scoped per cohort |
| `/api/exams` | exam schedules — publish/list/download |
| `/api/leave` | leave applications — student submits own, admin reads all |
| `/api/notifications` | list, mark read |

### Socket events

| Event | Direction | Purpose |
| --- | --- | --- |
| `attendance:updated` | → enrolled students | their numbers changed; client refetches |
| `subject:attendance-updated` | → subject room | faculty views refresh live |
| `timetable:changed` | → staff + affected students | grid refetches with no reload |
| `swap:updated` | → both parties + admins | swap queue refreshes |
| `notification:new` | → one recipient | bell increments and a toast appears |

## Security

- Passwords hashed with bcrypt; `password` field is `select: false` on every read
- JWT verified on every REST request **and** on the socket handshake; `config/env.js` refuses to
  boot in production on a short or placeholder `JWT_SECRET` (warns only in dev)
- Faculty scoped to their own subjects (`assertSubjectAccess`); admin unrestricted
- Students can only read their own attendance, leave applications and notes for their cohort.
  Faculty are scoped the same way for the two places this previously leaked: a note's
  *download* endpoint now runs the same cohort check as its list endpoint
  ([noteController.js](server/src/controllers/noteController.js)), and a faculty member can only
  pull a student's attendance summary if they actually teach a subject that student takes
  ([attendanceController.js](server/src/controllers/attendanceController.js))
- Rate limiting on both login routes: password login is keyed by the account being targeted
  rather than IP, so a shared campus network can't lock out everyone behind it over one person's
  typo; Google login is keyed by IP (the email isn't known until the token is verified) — a
  looser bound, since there is no password to guess against it, only verification cost to cap.
  Plus `helmet`; CORS pinned to `CLIENT_ORIGIN`
- Express's query parser is set to `'simple'` ([app.js](server/src/app.js)) so `?field[$ne]=x`
  cannot be parsed into a Mongo operator — the query-string equivalent of the NoSQL-injection
  protection Zod already gives request bodies
- All request bodies validated with Zod; future-dated attendance rejected
- Unexpected (non-`ApiError`) exceptions never reach the client with their original message in
  production — [error.js](server/src/middleware/error.js) swaps in a generic one and logs the
  real one server-side, since a raw driver or file-system error can carry internal details
- `utils/audit.js` logs failed/successful logins, every 401/403, every admin-router write, and
  every file store/download/delete — structured JSON lines, never a password or token
- `server/security-check.mjs` and `server/google-auth-check.mjs` are runnable regression checks
  for exactly this list (IDOR, injection, RBAC, JWT tampering, Google sign-in) — run them after
  touching anything security-relevant, the same way `npm run dev` + manual testing verifies a
  feature

Before any real deployment: change `JWT_SECRET` in `server/.env` (the boot guard above catches an
unchanged placeholder), and remove the dev-only admin-credential pre-fill in
[Login.jsx](client/src/pages/Login.jsx) (it is already gated behind `import.meta.env.DEV`, but
confirm the production build is actually built with `NODE_ENV=production`).

**Google sign-in is a second door to the same lock, not a second lock.** `POST /api/auth/google`
([authController.js](server/src/controllers/authController.js)) verifies a Google ID token
server-side with `google-auth-library` — signature, issuer, audience and expiry all checked
there, against Google's own keys — then hands the verified email to `resolveGoogleUser`, which
is the only part of this with actual business rules and the only part unit-tested without a live
Google token (see `google-auth-check.mjs`). It enforces: the email must end `@sitare.org` and
have `email_verified: true`; the ERP must already have a `User` with that email, or the sign-in
is refused with a message telling them to contact the administrator — **nothing is ever
auto-created**; a disabled account is refused exactly as password login refuses it. Role, section,
subjects and active status always come from that ERP record, never from the token — a
`role` claim inside the Google payload is not read at all, by construction, so there is no path
by which a Google account could grant itself anything the database does not already say it has.
A verified account's Google `sub` is recorded on `User.googleSub` the first time it signs in
(unique + sparse) purely to identify "the same Google identity signed in again" — it is never
itself a credential, and no Google access/refresh token is ever stored. Both login paths issue
the exact same JWT via `signToken`, so everything downstream (RBAC, `assertSubjectAccess`,
resource-scoping) is unaware of which one a session came from. Unconfigured (`GOOGLE_CLIENT_ID`
unset) is a supported, safe state — the route just refuses with "not configured" — so a checkout
with no Google Cloud project still has working password login.

## Conventions for working in this codebase

- **Comments explain WHY, not WHAT.** The codebase deliberately avoids comments that restate
  what a line does; a comment exists only when it records a non-obvious constraint, a past
  incident, or a reason a simpler approach doesn't work (see `LeaveDocument.js` or
  `AttendanceDelegation.js` for the style). Match this when adding code.
- **Prefer deactivation and denormalized scoping over cleverness at read time** — the codebase
  consistently chooses "store the fact plainly" over "compute it every time," e.g. `timetable`
  on `ScheduleChange`, `section` on `Note`/`ExamSchedule`.
- **Every new write path that touches attendance, timetable resolution, or role-based scoping
  should be checked against the rules above before merging** — most bugs found in this project
  so far have been exactly one of: a missing scope clause, a missing office-hours check, or a
  query built from a value that can legitimately be `null`.
