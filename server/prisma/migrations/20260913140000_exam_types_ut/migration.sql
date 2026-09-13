-- The kinds of exam actually sat here: unit tests, mid-terms, end-terms.
--
-- 'practical' and 're-exam' were never used — no row carries either — and a
-- list offering kinds nobody publishes makes the right one harder to find.
-- 'ut' is added because the unit test is the most frequent of the three and
-- had to be filed under "other".
ALTER TABLE "exam_schedules" DROP CONSTRAINT "exam_schedules_exam_type_valid";

ALTER TABLE "exam_schedules" ADD CONSTRAINT "exam_schedules_exam_type_valid"
  CHECK ("exam_type" IN ('ut', 'mid-term', 'end-term', 'other'));
