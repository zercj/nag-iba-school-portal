-- Lesson plan tracing workflow (additive; preserves existing portal data).
CREATE TABLE IF NOT EXISTS terms (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  term_number SMALLINT NOT NULL UNIQUE CHECK (term_number IN (1, 2, 3)),
  name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO terms (term_number, name)
VALUES (1, 'Term 1'), (2, 'Term 2'), (3, 'Term 3')
ON CONFLICT (term_number) DO NOTHING;

CREATE TABLE IF NOT EXISTS lesson_plan_tasks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  term_id BIGINT NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  week_number INTEGER NOT NULL CHECK (week_number > 0),
  day_number INTEGER NOT NULL CHECK (day_number > 0),
  title TEXT NOT NULL CHECK (CHAR_LENGTH(title) BETWEEN 1 AND 180),
  description TEXT NOT NULL DEFAULT '',
  due_date TIMESTAMPTZ NOT NULL,
  created_by_admin_id BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (term_id, week_number, day_number)
);
CREATE INDEX IF NOT EXISTS lesson_plan_tasks_due_idx
  ON lesson_plan_tasks (due_date, term_id, week_number, day_number);

CREATE TABLE IF NOT EXISTS lesson_plan_submissions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES lesson_plan_tasks(id) ON DELETE CASCADE,
  teacher_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  onedrive_file_id TEXT,
  onedrive_file_url TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL CHECK (status IN (
    'Passed - Pending Approval', 'Late - Pending Approval', 'Approved', 'Needs Revision'
  )),
  admin_comments TEXT NOT NULL DEFAULT '',
  reviewed_by_admin_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  revision_number INTEGER NOT NULL DEFAULT 1 CHECK (revision_number > 0),
  UNIQUE (task_id, teacher_id)
);
CREATE INDEX IF NOT EXISTS lesson_plan_submissions_teacher_idx
  ON lesson_plan_submissions (teacher_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS lesson_plan_submissions_status_idx
  ON lesson_plan_submissions (status, submitted_at DESC);

-- Admin announcements can be global or targeted to one teacher.
ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS target_teacher_id BIGINT REFERENCES users(id) ON DELETE CASCADE;

-- Sections and enrollment for teacher-to-student task tracking.
CREATE TABLE IF NOT EXISTS sections (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL CHECK (CHAR_LENGTH(name) BETWEEN 1 AND 160),
  teacher_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (teacher_id, name)
);
CREATE TABLE IF NOT EXISTS enrollments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  section_id BIGINT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  student_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (section_id, student_id)
);
CREATE INDEX IF NOT EXISTS enrollments_student_idx ON enrollments(student_id);

CREATE TABLE IF NOT EXISTS student_tasks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  section_id BIGINT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (CHAR_LENGTH(title) BETWEEN 1 AND 180),
  description TEXT NOT NULL DEFAULT '',
  due_date TIMESTAMPTZ,
  created_by_teacher_id BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS student_submissions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_task_id BIGINT NOT NULL REFERENCES student_tasks(id) ON DELETE CASCADE,
  student_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'Submitted'
    CHECK (status IN ('Submitted', 'Late', 'Reviewed', 'Needs Revision')),
  UNIQUE (student_task_id, student_id)
);
CREATE INDEX IF NOT EXISTS student_submissions_student_idx ON student_submissions(student_id, submitted_at DESC);
