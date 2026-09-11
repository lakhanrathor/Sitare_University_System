-- Constraints the Prisma schema language cannot express.
--
-- Everything here is written by hand and must stay hand-written: `prisma
-- migrate diff` does not know about NULLS NOT DISTINCT, partial indexes or
-- CHECK constraints, so it neither generates nor removes them. The two
-- recreated indexes deliberately keep the names Prisma generated, so a later
-- `migrate diff` sees the index it expects and stays quiet.

-- ---------------------------------------------------------------------------
-- 1. Uniqueness that must treat NULL as a value
--
-- MongoDB indexes a missing/null field as a value, so two documents that both
-- leave `section` null collide. SQL treats every NULL as distinct, so the same
-- index would let them both through — which in this system means two subjects
-- with one code, each with its own roster, and a whole-year timetable that can
-- book the same cohort into one period twice.
--
-- NULLS NOT DISTINCT restores the MongoDB behaviour. It needs PostgreSQL 15+.
-- ---------------------------------------------------------------------------

DROP INDEX "subjects_code_section_id_key";
CREATE UNIQUE INDEX "subjects_code_section_id_key"
  ON "subjects" ("code", "section_id") NULLS NOT DISTINCT;

DROP INDEX "timetable_entries_timetable_id_day_of_week_slot_section_id_key";
CREATE UNIQUE INDEX "timetable_entries_timetable_id_day_of_week_slot_section_id_key"
  ON "timetable_entries" ("timetable_id", "day_of_week", "slot", "section_id") NULLS NOT DISTINCT;

-- ---------------------------------------------------------------------------
-- 2. One published timetable per semester
--
-- Publishing archives the previous version with no department predicate
-- (timetableController.js), so "the live timetable for semester 3" is already
-- meant to be singular. This says so, rather than relying on every publish
-- path remembering to archive first.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "timetables_one_published_per_semester"
  ON "timetables" ("semester") WHERE "status" = 'published';

-- ---------------------------------------------------------------------------
-- 3. An attachment belongs to exactly one thing
--
-- The three embedded attachment arrays became one table with three nullable
-- owner columns. Exactly one must be set: no owner is an orphaned file nobody
-- can reach, and two owners would make a download served from the wrong
-- cohort's authorization check.
-- ---------------------------------------------------------------------------

ALTER TABLE "attachments" ADD CONSTRAINT "attachments_exactly_one_owner"
  CHECK (
    (("note_id" IS NOT NULL)::int + ("exam_id" IS NOT NULL)::int + ("leave_id" IS NOT NULL)::int) = 1
  );

-- ---------------------------------------------------------------------------
-- 4. The lunch break is whole or absent
--
-- Four columns replaced one embedded object, and a half-filled break would
-- render as a gap with no label or a label with no times.
-- ---------------------------------------------------------------------------

ALTER TABLE "timetables" ADD CONSTRAINT "timetables_lunch_all_or_nothing"
  CHECK (
    ("lunch_label" IS NULL AND "lunch_start" IS NULL AND "lunch_end" IS NULL AND "lunch_after_slot" IS NULL)
    OR
    ("lunch_start" IS NOT NULL AND "lunch_end" IS NOT NULL AND "lunch_after_slot" IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 5. A date and its 'YYYY-MM-DD' key say the same thing
--
-- Both are kept because the string is load-bearing in timetableService.js —
-- it is compared with === and concatenated into composite map keys. Two
-- representations of one fact can drift, and if they do, the resolver and the
-- aggregations disagree about which day a class happened on. The database is
-- the only place that can check this on every write, including the raw SQL
-- ones.
-- ---------------------------------------------------------------------------

ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_date_matches_key"
  CHECK ("date" = "date_key"::date);

ALTER TABLE "timetables" ADD CONSTRAINT "timetables_effective_from_matches_key"
  CHECK ("effective_from" = "effective_from_key"::date);

ALTER TABLE "schedule_changes" ADD CONSTRAINT "schedule_changes_date_matches_key"
  CHECK ("date" = "date_key"::date);

ALTER TABLE "schedule_changes" ADD CONSTRAINT "schedule_changes_to_date_matches_key"
  CHECK (
    ("to_date" IS NULL AND "to_date_key" IS NULL)
    OR ("to_date" IS NOT NULL AND "to_date_key" IS NOT NULL AND "to_date" = "to_date_key"::date)
  );

-- ---------------------------------------------------------------------------
-- 6. Case, which used to be a Mongoose setter
--
-- `Subject.code` and `Section.name` were `uppercase: true`, and that setter is
-- load-bearing for uniqueness: without it 'cs101' and 'CS101' are two subjects
-- with separate rosters, and the unique index above cannot see that they are
-- the same course. A Prisma client extension normalises writes; this makes a
-- miss loud instead of silent.
-- ---------------------------------------------------------------------------

ALTER TABLE "subjects" ADD CONSTRAINT "subjects_code_is_upper"
  CHECK ("code" = upper("code"));

ALTER TABLE "sections" ADD CONSTRAINT "sections_name_is_upper"
  CHECK ("name" = upper("name"));

-- ---------------------------------------------------------------------------
-- 7. Ranges that were enforced only by Mongoose's min/max
--
-- Mongoose checked these on .save() and not on updateMany, so they were never
-- actually guaranteed. Slots and weekdays index into the period grid; a value
-- outside it renders nowhere and is invisible until someone asks why a class
-- vanished.
-- ---------------------------------------------------------------------------

ALTER TABLE "sections" ADD CONSTRAINT "sections_semester_range"
  CHECK ("semester" BETWEEN 1 AND 10);

ALTER TABLE "subjects" ADD CONSTRAINT "subjects_semester_range"
  CHECK ("semester" BETWEEN 1 AND 10);

ALTER TABLE "subjects" ADD CONSTRAINT "subjects_min_attendance_range"
  CHECK ("min_attendance" BETWEEN 0 AND 100);

ALTER TABLE "subjects" ADD CONSTRAINT "subjects_planned_classes_positive"
  CHECK ("planned_classes" >= 1);

ALTER TABLE "users" ADD CONSTRAINT "users_semester_range"
  CHECK ("semester" IS NULL OR "semester" BETWEEN 1 AND 10);

ALTER TABLE "timetables" ADD CONSTRAINT "timetables_semester_range"
  CHECK ("semester" BETWEEN 1 AND 10);

ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_slot_range"
  CHECK ("slot" BETWEEN 1 AND 12);

ALTER TABLE "attendance_delegations" ADD CONSTRAINT "attendance_delegations_slot_range"
  CHECK ("slot" BETWEEN 1 AND 12);

ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_slot_range"
  CHECK ("slot" BETWEEN 1 AND 12);

ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_day_range"
  CHECK ("day_of_week" BETWEEN 1 AND 7);
