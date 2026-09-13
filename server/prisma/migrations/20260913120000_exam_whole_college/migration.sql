-- An exam timetable may now cover the whole college rather than one year.
--
-- Exam sheets here are published as a single document listing every year's
-- papers (Sem I, III and V on one page), so forcing a semester onto the record
-- meant either publishing the same sheet three times or picking a year the
-- document does not actually belong to. NULL now means "every year sits this
-- one", exactly as a NULL section already means "every cohort of that year".
ALTER TABLE "exam_schedules" ALTER COLUMN "semester" DROP NOT NULL;

-- A section belongs to exactly one year, so "every year" and "one cohort of
-- one year" cannot both be true. Without this a whole-college schedule could
-- be pinned to a single section and would then be invisible to everyone else,
-- which is the failure this feature exists to prevent.
ALTER TABLE "exam_schedules" ADD CONSTRAINT "exam_schedules_section_needs_semester"
  CHECK ("semester" IS NOT NULL OR "section_id" IS NULL);

-- Matches the range already enforced on sections, subjects, users and
-- timetables; NULL passes a CHECK, so the new state is unaffected.
ALTER TABLE "exam_schedules" ADD CONSTRAINT "exam_schedules_semester_range"
  CHECK ("semester" IS NULL OR "semester" BETWEEN 1 AND 10);
