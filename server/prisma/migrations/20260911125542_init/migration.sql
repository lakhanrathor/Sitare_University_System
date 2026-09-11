-- CreateEnum
CREATE TYPE "Role" AS ENUM ('student', 'faculty', 'admin');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('present', 'absent');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('completed', 'cancelled');

-- CreateEnum
CREATE TYPE "ChangeKind" AS ENUM ('extra', 'move', 'cancel');

-- CreateEnum
CREATE TYPE "EntryKind" AS ENUM ('lecture', 'office-hours', 'event');

-- CreateEnum
CREATE TYPE "TimetableStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "SwapStatus" AS ENUM ('pending', 'accepted', 'approved', 'rejected', 'withdrawn', 'declined');

-- CreateEnum
CREATE TYPE "ExamType" AS ENUM ('mid-term', 'end-term', 'practical', 're-exam', 'other');

-- CreateEnum
CREATE TYPE "LeaveSource" AS ENUM ('student', 'upload', 'email');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'student',
    "roll_number" TEXT,
    "batch" TEXT,
    "semester" INTEGER,
    "section_id" UUID,
    "employee_id" TEXT,
    "department" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "google_sub" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sections" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "semester" INTEGER NOT NULL,
    "department" TEXT NOT NULL DEFAULT 'Computer Science',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subjects" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "department" TEXT,
    "semester" INTEGER NOT NULL,
    "credits" INTEGER NOT NULL DEFAULT 3,
    "section_id" UUID,
    "faculty_id" UUID,
    "planned_classes" INTEGER NOT NULL DEFAULT 30,
    "min_attendance" INTEGER NOT NULL DEFAULT 75,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollments" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "class_sessions" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "faculty_id" UUID,
    "date" DATE NOT NULL,
    "date_key" TEXT NOT NULL,
    "slot" INTEGER NOT NULL DEFAULT 1,
    "topic" TEXT NOT NULL DEFAULT '',
    "status" "SessionStatus" NOT NULL DEFAULT 'completed',
    "present_count" INTEGER NOT NULL DEFAULT 0,
    "total_marked" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "class_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "marked_by_id" UUID,
    "remark" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_delegations" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "date_key" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "faculty_id" UUID NOT NULL,
    "entry_id" UUID,
    "assigned_by_id" UUID,
    "note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_delegations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetables" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "semester" INTEGER NOT NULL,
    "department" TEXT NOT NULL DEFAULT 'Computer Science',
    "effective_from" DATE NOT NULL,
    "effective_from_key" TEXT NOT NULL,
    "status" "TimetableStatus" NOT NULL DEFAULT 'draft',
    "published_at" TIMESTAMP(3),
    "uploaded_by_id" UUID,
    "lunch_label" TEXT,
    "lunch_start" TEXT,
    "lunch_end" TEXT,
    "lunch_after_slot" INTEGER,
    "warnings" TEXT[],
    "entry_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timetables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_slots" (
    "timetable_id" UUID NOT NULL,
    "slot" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "start" TEXT NOT NULL,
    "end" TEXT NOT NULL,

    CONSTRAINT "timetable_slots_pkey" PRIMARY KEY ("timetable_id","slot")
);

-- CreateTable
CREATE TABLE "timetable_entries" (
    "id" UUID NOT NULL,
    "timetable_id" UUID NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "slot" INTEGER NOT NULL,
    "section_id" UUID,
    "subject_id" UUID,
    "faculty_id" UUID,
    "kind" "EntryKind" NOT NULL DEFAULT 'lecture',
    "title" TEXT NOT NULL DEFAULT '',
    "room" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timetable_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_changes" (
    "id" UUID NOT NULL,
    "kind" "ChangeKind" NOT NULL,
    "timetable_id" UUID,
    "date" DATE NOT NULL,
    "date_key" TEXT NOT NULL,
    "entry_id" UUID,
    "from_slot" INTEGER,
    "to_date" DATE,
    "to_date_key" TEXT,
    "to_slot" INTEGER,
    "section_id" UUID,
    "subject_id" UUID,
    "faculty_id" UUID,
    "slot" INTEGER,
    "kind_of_class" "EntryKind" NOT NULL DEFAULT 'lecture',
    "title" TEXT NOT NULL DEFAULT '',
    "room" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL DEFAULT '',
    "created_by_id" UUID,
    "swap_request_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "swap_requests" (
    "id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "counterparty_id" UUID NOT NULL,
    "from_entry_id" UUID NOT NULL,
    "from_date_key" TEXT NOT NULL,
    "from_slot" INTEGER NOT NULL,
    "to_entry_id" UUID NOT NULL,
    "to_date_key" TEXT NOT NULL,
    "to_slot" INTEGER NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "status" "SwapStatus" NOT NULL DEFAULT 'pending',
    "accepted_at" TIMESTAMP(3),
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "swap_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" UUID NOT NULL,
    "data" BYTEA NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "size" INTEGER NOT NULL DEFAULT 0,
    "note_id" UUID,
    "exam_id" UUID,
    "leave_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notes" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "semester" INTEGER NOT NULL,
    "section_id" UUID,
    "subject_id" UUID,
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_schedules" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "exam_type" "ExamType" NOT NULL DEFAULT 'end-term',
    "semester" INTEGER NOT NULL,
    "section_id" UUID,
    "instructions" TEXT NOT NULL DEFAULT '',
    "published_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exam_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_papers" (
    "id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "subject_id" UUID,
    "label" TEXT NOT NULL DEFAULT '',
    "date_key" TEXT NOT NULL,
    "start_time" TEXT NOT NULL DEFAULT '',
    "end_time" TEXT NOT NULL DEFAULT '',
    "room" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "exam_papers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_documents" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL,
    "regarding" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "leave_from" DATE,
    "leave_to" DATE,
    "source" "LeaveSource" NOT NULL DEFAULT 'student',
    "from_address" TEXT NOT NULL DEFAULT '',
    "message_id" TEXT,
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "link" TEXT NOT NULL DEFAULT '',
    "meta" JSONB NOT NULL DEFAULT '{}',
    "requires_action" BOOLEAN NOT NULL DEFAULT false,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_roll_number_key" ON "users"("roll_number");

-- CreateIndex
CREATE UNIQUE INDEX "users_employee_id_key" ON "users"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_google_sub_key" ON "users"("google_sub");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_section_id_idx" ON "users"("section_id");

-- CreateIndex
CREATE UNIQUE INDEX "sections_name_semester_department_key" ON "sections"("name", "semester", "department");

-- CreateIndex
CREATE INDEX "subjects_code_idx" ON "subjects"("code");

-- CreateIndex
CREATE INDEX "subjects_semester_idx" ON "subjects"("semester");

-- CreateIndex
CREATE INDEX "subjects_section_id_idx" ON "subjects"("section_id");

-- CreateIndex
CREATE INDEX "subjects_faculty_id_idx" ON "subjects"("faculty_id");

-- CreateIndex
CREATE UNIQUE INDEX "subjects_code_section_id_key" ON "subjects"("code", "section_id");

-- CreateIndex
CREATE INDEX "enrollments_student_id_idx" ON "enrollments"("student_id");

-- CreateIndex
CREATE INDEX "enrollments_subject_id_idx" ON "enrollments"("subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_student_id_subject_id_key" ON "enrollments"("student_id", "subject_id");

-- CreateIndex
CREATE INDEX "class_sessions_subject_id_idx" ON "class_sessions"("subject_id");

-- CreateIndex
CREATE INDEX "class_sessions_faculty_id_idx" ON "class_sessions"("faculty_id");

-- CreateIndex
CREATE INDEX "class_sessions_date_key_idx" ON "class_sessions"("date_key");

-- CreateIndex
CREATE INDEX "class_sessions_status_idx" ON "class_sessions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "class_sessions_subject_id_date_key_slot_key" ON "class_sessions"("subject_id", "date_key", "slot");

-- CreateIndex
CREATE INDEX "attendance_session_id_idx" ON "attendance"("session_id");

-- CreateIndex
CREATE INDEX "attendance_subject_id_idx" ON "attendance"("subject_id");

-- CreateIndex
CREATE INDEX "attendance_student_id_idx" ON "attendance"("student_id");

-- CreateIndex
CREATE INDEX "attendance_student_id_subject_id_idx" ON "attendance"("student_id", "subject_id");

-- CreateIndex
CREATE INDEX "attendance_marked_by_id_idx" ON "attendance"("marked_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_session_id_student_id_key" ON "attendance"("session_id", "student_id");

-- CreateIndex
CREATE INDEX "attendance_delegations_subject_id_idx" ON "attendance_delegations"("subject_id");

-- CreateIndex
CREATE INDEX "attendance_delegations_faculty_id_idx" ON "attendance_delegations"("faculty_id");

-- CreateIndex
CREATE INDEX "attendance_delegations_entry_id_idx" ON "attendance_delegations"("entry_id");

-- CreateIndex
CREATE INDEX "attendance_delegations_assigned_by_id_idx" ON "attendance_delegations"("assigned_by_id");

-- CreateIndex
CREATE INDEX "attendance_delegations_date_key_idx" ON "attendance_delegations"("date_key");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_delegations_subject_id_date_key_slot_key" ON "attendance_delegations"("subject_id", "date_key", "slot");

-- CreateIndex
CREATE INDEX "timetables_semester_idx" ON "timetables"("semester");

-- CreateIndex
CREATE INDEX "timetables_status_idx" ON "timetables"("status");

-- CreateIndex
CREATE INDEX "timetables_uploaded_by_id_idx" ON "timetables"("uploaded_by_id");

-- CreateIndex
CREATE INDEX "timetable_entries_timetable_id_idx" ON "timetable_entries"("timetable_id");

-- CreateIndex
CREATE INDEX "timetable_entries_day_of_week_idx" ON "timetable_entries"("day_of_week");

-- CreateIndex
CREATE INDEX "timetable_entries_section_id_idx" ON "timetable_entries"("section_id");

-- CreateIndex
CREATE INDEX "timetable_entries_subject_id_idx" ON "timetable_entries"("subject_id");

-- CreateIndex
CREATE INDEX "timetable_entries_faculty_id_idx" ON "timetable_entries"("faculty_id");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_entries_timetable_id_day_of_week_slot_section_id_key" ON "timetable_entries"("timetable_id", "day_of_week", "slot", "section_id");

-- CreateIndex
CREATE INDEX "schedule_changes_kind_idx" ON "schedule_changes"("kind");

-- CreateIndex
CREATE INDEX "schedule_changes_timetable_id_idx" ON "schedule_changes"("timetable_id");

-- CreateIndex
CREATE INDEX "schedule_changes_date_key_idx" ON "schedule_changes"("date_key");

-- CreateIndex
CREATE INDEX "schedule_changes_to_date_key_idx" ON "schedule_changes"("to_date_key");

-- CreateIndex
CREATE INDEX "schedule_changes_entry_id_idx" ON "schedule_changes"("entry_id");

-- CreateIndex
CREATE INDEX "schedule_changes_section_id_idx" ON "schedule_changes"("section_id");

-- CreateIndex
CREATE INDEX "schedule_changes_subject_id_idx" ON "schedule_changes"("subject_id");

-- CreateIndex
CREATE INDEX "schedule_changes_faculty_id_idx" ON "schedule_changes"("faculty_id");

-- CreateIndex
CREATE INDEX "schedule_changes_created_by_id_idx" ON "schedule_changes"("created_by_id");

-- CreateIndex
CREATE INDEX "schedule_changes_swap_request_id_idx" ON "schedule_changes"("swap_request_id");

-- CreateIndex
CREATE INDEX "schedule_changes_date_key_section_id_idx" ON "schedule_changes"("date_key", "section_id");

-- CreateIndex
CREATE INDEX "schedule_changes_to_date_key_section_id_idx" ON "schedule_changes"("to_date_key", "section_id");

-- CreateIndex
CREATE INDEX "swap_requests_requested_by_id_idx" ON "swap_requests"("requested_by_id");

-- CreateIndex
CREATE INDEX "swap_requests_counterparty_id_idx" ON "swap_requests"("counterparty_id");

-- CreateIndex
CREATE INDEX "swap_requests_from_entry_id_idx" ON "swap_requests"("from_entry_id");

-- CreateIndex
CREATE INDEX "swap_requests_to_entry_id_idx" ON "swap_requests"("to_entry_id");

-- CreateIndex
CREATE INDEX "swap_requests_decided_by_id_idx" ON "swap_requests"("decided_by_id");

-- CreateIndex
CREATE INDEX "swap_requests_status_idx" ON "swap_requests"("status");

-- CreateIndex
CREATE INDEX "attachments_file_id_idx" ON "attachments"("file_id");

-- CreateIndex
CREATE INDEX "attachments_note_id_idx" ON "attachments"("note_id");

-- CreateIndex
CREATE INDEX "attachments_exam_id_idx" ON "attachments"("exam_id");

-- CreateIndex
CREATE INDEX "attachments_leave_id_idx" ON "attachments"("leave_id");

-- CreateIndex
CREATE INDEX "notes_semester_idx" ON "notes"("semester");

-- CreateIndex
CREATE INDEX "notes_section_id_idx" ON "notes"("section_id");

-- CreateIndex
CREATE INDEX "notes_subject_id_idx" ON "notes"("subject_id");

-- CreateIndex
CREATE INDEX "notes_uploaded_by_id_idx" ON "notes"("uploaded_by_id");

-- CreateIndex
CREATE INDEX "notes_semester_section_id_created_at_idx" ON "notes"("semester", "section_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "exam_schedules_semester_idx" ON "exam_schedules"("semester");

-- CreateIndex
CREATE INDEX "exam_schedules_section_id_idx" ON "exam_schedules"("section_id");

-- CreateIndex
CREATE INDEX "exam_schedules_published_by_id_idx" ON "exam_schedules"("published_by_id");

-- CreateIndex
CREATE INDEX "exam_schedules_exam_type_idx" ON "exam_schedules"("exam_type");

-- CreateIndex
CREATE INDEX "exam_schedules_semester_section_id_created_at_idx" ON "exam_schedules"("semester", "section_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "exam_papers_exam_id_idx" ON "exam_papers"("exam_id");

-- CreateIndex
CREATE INDEX "exam_papers_subject_id_idx" ON "exam_papers"("subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "leave_documents_message_id_key" ON "leave_documents"("message_id");

-- CreateIndex
CREATE INDEX "leave_documents_student_id_idx" ON "leave_documents"("student_id");

-- CreateIndex
CREATE INDEX "leave_documents_sent_at_idx" ON "leave_documents"("sent_at");

-- CreateIndex
CREATE INDEX "leave_documents_source_idx" ON "leave_documents"("source");

-- CreateIndex
CREATE INDEX "leave_documents_uploaded_by_id_idx" ON "leave_documents"("uploaded_by_id");

-- CreateIndex
CREATE INDEX "leave_documents_student_id_sent_at_idx" ON "leave_documents"("student_id", "sent_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_user_id_idx" ON "notifications"("user_id");

-- CreateIndex
CREATE INDEX "notifications_read_idx" ON "notifications"("read");

-- CreateIndex
CREATE INDEX "notifications_created_by_id_idx" ON "notifications"("created_by_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_created_at_idx" ON "notifications"("user_id", "read", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_faculty_id_fkey" FOREIGN KEY ("faculty_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_faculty_id_fkey" FOREIGN KEY ("faculty_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "class_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_marked_by_id_fkey" FOREIGN KEY ("marked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_delegations" ADD CONSTRAINT "attendance_delegations_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_delegations" ADD CONSTRAINT "attendance_delegations_faculty_id_fkey" FOREIGN KEY ("faculty_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_delegations" ADD CONSTRAINT "attendance_delegations_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "timetable_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_delegations" ADD CONSTRAINT "attendance_delegations_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetables" ADD CONSTRAINT "timetables_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slots" ADD CONSTRAINT "timetable_slots_timetable_id_fkey" FOREIGN KEY ("timetable_id") REFERENCES "timetables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_timetable_id_fkey" FOREIGN KEY ("timetable_id") REFERENCES "timetables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_faculty_id_fkey" FOREIGN KEY ("faculty_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_changes" ADD CONSTRAINT "schedule_changes_timetable_id_fkey" FOREIGN KEY ("timetable_id") REFERENCES "timetables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_changes" ADD CONSTRAINT "schedule_changes_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "timetable_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_changes" ADD CONSTRAINT "schedule_changes_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_changes" ADD CONSTRAINT "schedule_changes_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_changes" ADD CONSTRAINT "schedule_changes_faculty_id_fkey" FOREIGN KEY ("faculty_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_changes" ADD CONSTRAINT "schedule_changes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_changes" ADD CONSTRAINT "schedule_changes_swap_request_id_fkey" FOREIGN KEY ("swap_request_id") REFERENCES "swap_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swap_requests" ADD CONSTRAINT "swap_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swap_requests" ADD CONSTRAINT "swap_requests_counterparty_id_fkey" FOREIGN KEY ("counterparty_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swap_requests" ADD CONSTRAINT "swap_requests_from_entry_id_fkey" FOREIGN KEY ("from_entry_id") REFERENCES "timetable_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swap_requests" ADD CONSTRAINT "swap_requests_to_entry_id_fkey" FOREIGN KEY ("to_entry_id") REFERENCES "timetable_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swap_requests" ADD CONSTRAINT "swap_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exam_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_leave_id_fkey" FOREIGN KEY ("leave_id") REFERENCES "leave_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_schedules" ADD CONSTRAINT "exam_schedules_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_schedules" ADD CONSTRAINT "exam_schedules_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_papers" ADD CONSTRAINT "exam_papers_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exam_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_papers" ADD CONSTRAINT "exam_papers_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_documents" ADD CONSTRAINT "leave_documents_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_documents" ADD CONSTRAINT "leave_documents_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
