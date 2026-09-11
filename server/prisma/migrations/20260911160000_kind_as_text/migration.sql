-- Two hyphenated enums become checked text, and Role is reordered.
--
-- A PostgreSQL enum label may contain a hyphen, but a Prisma identifier may
-- not — so 'office-hours' had to be spelled officeHours and @map'd, and the
-- client then handed JavaScript the *name* rather than the value. Every guard
-- in the codebase compares against the literal 'office-hours', so all of them
-- silently stopped matching and attendance could be recorded against an
-- office-hours period, which is one of the rules this system is not allowed to
-- break. Text with a CHECK reads back exactly as stored and exactly as the API
-- sends it, and still cannot hold a value nobody intended.
--
-- Role stays a native enum, but its labels are reordered: PostgreSQL orders an
-- enum by declaration position, so `ORDER BY role` followed whatever order the
-- type happened to be created in rather than the alphabetical order the People
-- list had always shown.

ALTER TABLE "timetable_entries" ALTER COLUMN "kind" DROP DEFAULT;
ALTER TABLE "timetable_entries" ALTER COLUMN "kind" TYPE text USING "kind"::text;
ALTER TABLE "timetable_entries" ALTER COLUMN "kind" SET DEFAULT 'lecture';

ALTER TABLE "schedule_changes" ALTER COLUMN "kind_of_class" DROP DEFAULT;
ALTER TABLE "schedule_changes" ALTER COLUMN "kind_of_class" TYPE text USING "kind_of_class"::text;
ALTER TABLE "schedule_changes" ALTER COLUMN "kind_of_class" SET DEFAULT 'lecture';

ALTER TABLE "exam_schedules" ALTER COLUMN "exam_type" DROP DEFAULT;
ALTER TABLE "exam_schedules" ALTER COLUMN "exam_type" TYPE text USING "exam_type"::text;
ALTER TABLE "exam_schedules" ALTER COLUMN "exam_type" SET DEFAULT 'end-term';

DROP TYPE "EntryKind";
DROP TYPE "ExamType";

ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_kind_valid"
  CHECK ("kind" IN ('lecture', 'office-hours', 'event'));

ALTER TABLE "schedule_changes" ADD CONSTRAINT "schedule_changes_kind_of_class_valid"
  CHECK ("kind_of_class" IN ('lecture', 'office-hours', 'event'));

ALTER TABLE "exam_schedules" ADD CONSTRAINT "exam_schedules_exam_type_valid"
  CHECK ("exam_type" IN ('mid-term', 'end-term', 'practical', 're-exam', 'other'));

-- Rebuilt rather than reordered: PostgreSQL can add a label before another,
-- but not rearrange an existing type, and every dependent column has to be
-- carried across explicitly.
ALTER TYPE "Role" RENAME TO "Role_old";
CREATE TYPE "Role" AS ENUM ('admin', 'faculty', 'student');
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "role" TYPE "Role" USING "role"::text::"Role";
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'student';
DROP TYPE "Role_old";
