# Sitare University ERP

Real-time platform replacing the manual attendance register and timetable.
Stack: **React + Vite + Tailwind** · **Node.js + Express + MongoDB** · **Socket.io**

Modules built so far:

1. **[Attendance](#the-attendance-rule)** — percentage over classes actually conducted
2. **[Timetable](#timetable-module)** — published grid, extra classes, reschedules, staff swaps

---

## The attendance rule

Attendance is always calculated on **classes actually conducted**, never on the semester plan:

```
percentage = presentClasses ÷ conductedClasses × 100
```

A subject planned for 30 classes where only 2 have been held and the student attended both shows
**100%** — not 2/30. This is enforced in one place on the server
([attendanceService.js](server/src/services/attendanceService.js#L14-L34)) and every screen reads
from it, so the UI cannot drift from the rule.

Supporting behaviour:

| Situation | Result |
| --- | --- |
| 0 classes conducted | `—` / "No classes yet" — **never 0%** |
| Class marked cancelled | Removed from the denominator; nobody is penalised |
| Student marked `late` | Counts as attended |
| Conducted class with no record for a student | Counts as absent, so present + absent = conducted |
| `plannedClasses` (30) | Shown as context only; never a denominator |

---

## Running locally

Requires Node 18+ and a local MongoDB on `mongodb://127.0.0.1:27017`.

```bash
# Terminal 1 — API on :5000
cd server
npm install
npm run seed      # demo data; safe to re-run, it resets the DB
npm start

# Terminal 2 — UI on :5173
cd client
npm install
npm run dev
```

Open <http://localhost:5173>. Vite proxies `/api` and `/socket.io` to the API.

### Demo accounts

| Role | Email | Password | Teaches |
| --- | --- | --- | --- |
| Admin | `admin@sitare.org` | `admin123` | — |
| Faculty | `ankit.mehta@sitare.org` | `faculty123` | WAD · Section A |
| Faculty | `anuja.agarwal@sitare.org` | `faculty123` | WAD · Section B |
| Faculty | `deepak.rao@sitare.org` | `faculty123` | OSP · both sections |
| Faculty | `chhavi.sharma@sitare.org` | `faculty123` | DL · Section A |
| Faculty | `muskan.katiyar@sitare.org` | `faculty123` | DL · Section B |
| Faculty | `prateek.goel@sitare.org` | `faculty123` | CPS · both sections |
| Student | `su24001@sitare.org` | `student123` | Section A |
| Student | `su24009@sitare.org` | `student123` | Section B |

`su24001` … `su24016` all work (1-8 Section A, 9-16 Section B).
Seeded numbers for Aarav Sharma (SU24001):

```
WAD     2 of 2 attended    100%      <- 30 planned, ignored
OSP     4 of 5 attended     80%
DL      2 of 4 attended     50%
CPS     2 of 3 attended     66.67%
OVERALL 10 of 14            71.43%
```

Section B students see OSP with 2 conducted and the other three subjects
with **no classes yet** — rendered as `—`, never 0%.

### Seeing realtime work

Open two browsers (or one incognito).

- **Attendance** — faculty saves a sheet, the student's percentage moves instantly with a toast.
- **Timetable** — one teacher books a free period; every other teacher's grid shows it as taken
  and their notification bell increments, with no refresh.

---

## Timetable module

The admin uploads a weekly grid; everyone reads it; teachers adjust individual dates.

### What each role can do

| | Student | Faculty | Admin |
| --- | :-: | :-: | :-: |
| See the timetable | own section | all sections | all sections |
| Book a free period for an extra class | | ✅ | ✅ |
| Shift / cancel own class on one date | | ✅ | any class |
| Request a swap with another teacher | | ✅ | ✅ |
| **Approve a swap** | | | ✅ |
| Upload / publish the grid | | | ✅ |

### The three teacher actions

**Book a free period.** Empty periods are clickable. The booking appears on every other
teacher's grid immediately and notifies them, so two people cannot plan the same period.
Both the cohort and the lecturer are conflict-checked before it is accepted.

**Shift a class.** Moves one date only — the recurring grid is untouched. The original cell
keeps a tombstone reading "moved to Thu, slot 5" so nobody turns up to an empty room.

**Swap with another teacher.** Each class keeps its own subject and lecturer and simply takes
the other's period, which is what makes both teachers' names appear in each other's old cells.
The counterparty and the admins are notified at once, but **nothing moves until an admin
approves it**. Swaps that cannot work are filtered out of the picker up front, and re-checked
at approval time in case the grid changed while the request was pending.

### How attendance stays in step

| Timetable action | Effect on attendance |
| --- | --- |
| Class shifted | An already-taken sheet moves with it — date, period and lecturer. The conducted count is unchanged, because the class still happened once. |
| Swap approved | Both sheets follow their own class to its new period, along with the lecturer name. |
| Class cancelled | Its session is marked cancelled and leaves the denominator, so nobody is marked down for a lecture that never ran. |
| Extra class booked | Nothing is created. A session appears only when a teacher actually takes attendance — which is exactly what keeps the denominator honest. |

### Uploading a grid — PDF

Upload the timetable **PDF** itself; no conversion needed. Two layouts are read:

- **Printed grid** — weekday headings across the top, sections beneath them, period times
  down the left. This is the wall timetable institutes actually hand out.
- **Row list** — one row per period with day/slot/section columns.

A PDF carries no table structure, only ink at coordinates, so extraction works from glyph
positions: text runs are grouped into rows by their baseline and assigned to columns by
x-position *before* any text is joined — which is what stops a wide cell bleeding into its
neighbour. Wrapped cell text is reattached to the period above it.

Cell text is interpreted too: `(Office Hours)` becomes an office-hours period, a
parenthesised name (`(Anuja Ma'am)`) is matched against faculty and overrides the lecturer
for that period, and anything that matches no subject (`Session with Dean`) becomes an event.

**Extraction is inference, so it is never trusted blindly.** Reading a file writes nothing —
the admin gets a table of every period that was read, plus the layout that was detected, and
must confirm before publishing.

Pasting rows is kept as a fallback, and the CSV template / "Export as CSV" feed that box:

```csv
day,slot,section,subjectCode,facultyEmail,kind,title
Monday,4,A,WAD,ankit.mehta@sitare.org,lecture,
Tuesday,3,A,OSP,deepak.rao@sitare.org,office-hours,
Friday,1,B,,,event,Session with Dean
```

`slot` is 1-6 (9:00, 10:00, 11:00, 1:30, 2:30, 3:30) · `kind` is `lecture`, `office-hours` or `event`.

Whichever format is used, the same validation runs before anything is written:

- **Errors block publishing** — unknown day/section/subject/faculty, bad slot, or a
  section booked twice in one period (students cannot be in two rooms).
- **Warnings do not** — one lecturer across two sections in the same period is a
  *combined class*, which is real: it happens on Thursday afternoons in this very timetable.

Publishing archives the previous version for that semester and notifies everyone. Existing
one-off changes survive, because they attach to dates rather than to the grid.

Student rosters import the same way: a PDF with a header row labelling
`name`, `email`, `rollNumber`, `section`.

---

## Admin portal

Administrators do not teach, so they do not get a teaching dashboard. `/` opens a console:

| Area | What it does |
| --- | --- |
| **Dashboard** | Outstanding work first — swaps awaiting approval, semesters with no timetable, students with no section, subjects with no lecturer — then roll-up counts and the live timetables |
| **People** | Add or edit students, faculty and admins; assign sections; reset passwords; bulk-import a cohort from a PDF; deactivate access |
| **Academics** | Sections and subjects per semester, lecturer assignment, per-subject enrolment |
| **Timetable** | Upload, validate, publish and version grids — one live grid per semester |
| **Approvals** | Decide swap requests before they reach the live timetable |

**Multiple semesters.** Each semester has its own published grid, and staff switch between
them on the timetable. Students never see the switch — their section fixes their semester.
Conflict detection deliberately resolves across *all* published semesters, because a lecturer
teaching semester 3 and semester 5 at the same hour is just as double-booked as one clashing
inside a single year.

Deactivating is preferred to deleting throughout: attendance records reference people and
subjects, so removing them would tear holes in past registers. A subject with recorded classes
is retired rather than deleted, the last active admin cannot be locked out, and a lecturer who
still teaches something must be reassigned first.

---

## Architecture

```
server/src
├── config/          slots.js (period grid) · db · env
├── models/          User · Section · Subject · Enrollment · ClassSession · Attendance
│                    Timetable · TimetableEntry · ScheduleChange · SwapRequest · Notification
├── services/        attendanceService.js   <- the percentage rule lives here
│                    timetableService.js    <- resolves the grid + attendance sync
│                    notificationService.js
├── controllers/     auth · subject · attendance · timetable · schedule · swap · notification
├── middleware/      auth (JWT + role guard) · validate (zod) · error
├── sockets/         JWT-authenticated Socket.io gateway
└── seed/            the real Semester-3 timetable + attendance history

client/src
├── context/         Auth · Socket · Toast · Notification
├── pages/student/   Dashboard · SubjectDetail
├── pages/faculty/   Dashboard · TakeAttendance · SubjectReport
├── pages/timetable/ Timetable (week grid, role-aware)
├── pages/admin/     ManageTimetable (upload · validate · publish · versions)
├── pages/swaps/     Swaps (request queue + admin approval)
└── components/      Layout · AttendanceRing · NotificationBell · timetable/* · ui.jsx
```

**Why a `ClassSession` collection:** the attendance denominator is a real row in the database,
not a config number. A class only counts once faculty has actually taken attendance for it,
which is what makes "2 conducted out of 30 planned" behave correctly with no special-casing.

**Why the timetable is never materialised:** the weekly grid is the baseline and
`ScheduleChange` documents subtract classes that moved away and add the ones that moved in.
Nothing is written per-date, so however many one-off changes pile up, the published plan
stays clean — and a swap is just two linked `move` documents, so the resolver only ever has
to understand three shapes.

### Data model

```
Section      -> name, semester
User         -> role student|faculty|admin, section (students)
Subject      -> code × section (unique), faculty, plannedClasses (context only), minAttendance
Enrollment   -> student × subject                        (unique)
ClassSession -> subject, dateKey, slot                   (unique) · completed|cancelled
Attendance   -> session × student                        (unique) · present|absent|late

Timetable      -> versioned, draft|published|archived
TimetableEntry -> timetable × dayOfWeek × slot × section (unique) · subject, faculty, kind
ScheduleChange -> extra | move | cancel, on a specific date
SwapRequest    -> two entries + dates · pending|approved|rejected|declined|withdrawn
Notification   -> per recipient, pushed over the socket and persisted
```

---

## API

All routes except `/api/auth/login` need `Authorization: Bearer <token>`.

| Method | Endpoint | Access |
| --- | --- | --- |
| `POST` | `/api/auth/login` | public |
| `GET` | `/api/auth/me` | any |
| `PATCH` | `/api/auth/password` | any |
| `GET` | `/api/subjects` | any (role-scoped results) |
| `GET` | `/api/subjects/:id` | faculty (own) · admin |
| `GET` | `/api/attendance/me` | student |
| `GET` | `/api/attendance/me/subject/:id` | student (enrolled) |
| `GET` | `/api/attendance/student/:id` | faculty · admin |
| `GET` | `/api/attendance/subject/:id/sessions` | faculty (own) · admin |
| `GET` | `/api/attendance/subject/:id/sheet?date=` | faculty (own) · admin |
| `POST` | `/api/attendance/subject/:id/mark` | faculty (own) · admin |
| `PATCH` | `/api/attendance/session/:id/cancel` | faculty (own) · admin |
| `DELETE` | `/api/attendance/session/:id` | faculty (own) · admin |
| `GET` | `/api/timetable/meta` · `/week` | any (students scoped to their section) |
| `GET` | `/api/timetable/versions` · `/template` | admin |
| `POST` | `/api/timetable/preview` · `/api/timetable` | admin (PDF upload or pasted rows) |
| `GET` | `/api/admin/overview` | admin |
| `GET` | `/api/admin/users` · `/faculty` · `/sections` · `/subjects` | admin |
| `POST` | `/api/admin/users` · `/users/import` (PDF) · `/sections` · `/subjects` | admin |
| `PATCH` | `/api/admin/users/:id` · `/:id/status` · `/subjects/:id` | admin |
| `DELETE` | `/api/admin/sections/:id` · `/subjects/:id` | admin |
| `PATCH` | `/api/timetable/:id/publish` | admin |
| `DELETE` | `/api/timetable/:id` | admin (not the live one) |
| `GET` | `/api/schedule/free-slots` · `/changes` | any |
| `POST` | `/api/schedule/extra` · `/move` · `/cancel` | faculty (own) · admin |
| `DELETE` | `/api/schedule/changes/:id` | author · admin |
| `GET` | `/api/swaps` · `/candidates` | faculty · admin |
| `POST` | `/api/swaps` | faculty · admin |
| `PATCH` | `/api/swaps/:id/decide` | **admin only** |
| `PATCH` | `/api/swaps/:id/decline` · `/withdraw` | counterparty · requester |
| `GET` | `/api/notifications` | any |
| `PATCH` | `/api/notifications/:id/read` · `/read-all` | any |

### Socket events

| Event | Direction | Purpose |
| --- | --- | --- |
| `attendance:updated` | → enrolled students | their numbers changed; client refetches |
| `subject:attendance-updated` | → subject room | faculty views refresh live |
| `subject:join` / `subject:leave` | client → server | join a subject's room |
| `timetable:changed` | → staff + affected students | grid refetches with no reload |
| `swap:updated` | → both parties + admins | swap queue refreshes |
| `notification:new` | → one recipient | bell increments and a toast appears |

---

## Security

- Passwords hashed with bcrypt; `password` field is `select: false`
- JWT verified on every REST request **and** on the socket handshake
- Faculty are scoped to their own subjects (`assertSubjectAccess`); admin unrestricted
- Students can only read their own attendance
- Rate limiting on login, `helmet`, CORS pinned to the client origin
- All request bodies validated with zod; future-dated attendance rejected

Before deploying, change `JWT_SECRET` in `server/.env` and remove the demo-account
panel in [Login.jsx](client/src/pages/Login.jsx).

---

## Verified behaviour

Driven end-to-end in a real browser against the running stack.

**Attendance**

- WAD with 2 conducted of 30 planned and 2 attended → **100%**
- Subject with 0 conducted → `—`, not 0%
- New class on a fresh date → denominator 2 → 3; cancelling it → back to 2
- Re-saving an existing date updates it instead of double-counting
- Student marking attendance → `403`; other faculty on someone else's subject → `403`;
  no token → `401`; future date → `400`

**Timetable**

- Published grid renders all 46 periods across Mon-Fri × 2 sections, matching the source
- Free periods offered only to staff, only on today or later
- Booking a period is visible to other teachers instantly and notifies them
- Double-booking a cohort → `409` with a message naming the clash
- Shifting a class moves its attendance sheet; the conducted count does not change
- Swap picker marks unworkable pairs unavailable with the reason
- A swap is applied only on admin approval, and is re-checked then — a swap that would
  double-book a lecturer is refused even after it was requested
- Students see only their own section and get no booking controls
- CSV round-trips: export current → validate → upload → publish, archiving the previous
- Broken CSV reports every bad row by line number; combined classes warn but do not block

**PDF upload**

- A printed grid PDF of the institute timetable yields all 46 periods, with office hours and
  events classified correctly, and is shown back for confirmation before publishing
- A student roster PDF yields every row with name, email, roll number and section
- A non-PDF file is refused; a PDF with no recognisable grid is refused with a reason
- Pasting rows still works alongside

**Admin portal**

- Admin home carries no "Take attendance" control; nav is Dashboard/People/Academics/Timetable/Approvals
- Adding a teacher through the UI appears immediately; a duplicate email is refused
- Semester switch shows only that semester's sections and subjects — no leakage between years
