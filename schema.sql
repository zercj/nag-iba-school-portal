CREATE TABLE IF NOT EXISTS users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('developer', 'admin', 'teacher', 'student')),
  password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique ON users (LOWER(username));
CREATE INDEX IF NOT EXISTS users_role_active_idx ON users (role, active);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (CHAR_LENGTH(body) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  CHECK (sender_id <> recipient_id)
);

CREATE INDEX IF NOT EXISTS messages_inbox_idx ON messages (recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_sender_idx ON messages (sender_id, created_at DESC);

CREATE TABLE IF NOT EXISTS announcements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title TEXT NOT NULL CHECK (CHAR_LENGTH(title) BETWEEN 1 AND 180),
  body TEXT NOT NULL CHECK (CHAR_LENGTH(body) BETWEEN 1 AND 10000),
  author_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS announcements_created_idx ON announcements (created_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title TEXT NOT NULL CHECK (CHAR_LENGTH(title) BETWEEN 1 AND 180),
  description TEXT NOT NULL CHECK (CHAR_LENGTH(description) BETWEEN 1 AND 10000),
  due_at TIMESTAMPTZ,
  assigned_to BIGINT REFERENCES users(id) ON DELETE SET NULL,
  assigned_role TEXT CHECK (assigned_role IN ('teacher', 'student')),
  subject_id BIGINT,
  is_global BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  creator_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks (assigned_to, due_at);
CREATE INDEX IF NOT EXISTS tasks_creator_idx ON tasks (created_by, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at DESC);


-- Subject/classroom management and task file attachments.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_role TEXT CHECK (assigned_role IN ('teacher', 'student'));
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS subject_id BIGINT;
UPDATE tasks t SET assigned_role = 'student' WHERE assigned_to IS NOT NULL AND assigned_role IS NULL;

CREATE TABLE IF NOT EXISTS subjects (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL CHECK (CHAR_LENGTH(name) BETWEEN 1 AND 160),
  code TEXT,
  description TEXT NOT NULL DEFAULT '',
  teacher_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (teacher_id, name)
);
CREATE INDEX IF NOT EXISTS subjects_teacher_idx ON subjects (teacher_id, created_at DESC);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_subject_fk') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_subject_fk FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS subject_students (
  subject_id BIGINT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  student_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (subject_id, student_id)
);
CREATE INDEX IF NOT EXISTS subject_students_student_idx ON subject_students (student_id, subject_id);

CREATE TABLE IF NOT EXISTS task_attachments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_size BIGINT NOT NULL,
  file_data BYTEA NOT NULL,
  uploaded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS task_attachments_task_idx ON task_attachments (task_id);


-- Three-term lesson-plan scheduling and file submissions.
CREATE TABLE IF NOT EXISTS lesson_plan_term_settings (
  term_number SMALLINT PRIMARY KEY CHECK (term_number BETWEEN 1 AND 3),
  weeks INTEGER NOT NULL DEFAULT 10 CHECK (weeks BETWEEN 1 AND 52),
  days_per_week INTEGER NOT NULL DEFAULT 5 CHECK (days_per_week BETWEEN 1 AND 7),
  start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO lesson_plan_term_settings(term_number,weeks,days_per_week,start_date)
VALUES (1,10,5,CURRENT_DATE),(2,10,5,CURRENT_DATE + 70),(3,10,5,CURRENT_DATE + 140)
ON CONFLICT (term_number) DO NOTHING;

CREATE TABLE IF NOT EXISTS lesson_plan_subject_assignments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  teacher_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id BIGINT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  assigned_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(teacher_id,subject_id)
);
CREATE TABLE IF NOT EXISTS lesson_plan_generated_tasks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  term_number SMALLINT NOT NULL CHECK (term_number BETWEEN 1 AND 3),
  week_number INTEGER NOT NULL,
  day_number INTEGER NOT NULL,
  teacher_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id BIGINT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  due_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(term_number,week_number,day_number,teacher_id,subject_id)
);
CREATE TABLE IF NOT EXISTS lesson_plan_uploads (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES lesson_plan_generated_tasks(id) ON DELETE CASCADE,
  teacher_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  file_size BIGINT NOT NULL,
  file_data BYTEA NOT NULL,
  status TEXT NOT NULL DEFAULT 'Submitted' CHECK(status IN ('Submitted','Late','Approved','For Revision','Completed')),
  admin_feedback TEXT NOT NULL DEFAULT '',
  admin_revision_file_name TEXT NOT NULL DEFAULT '',
  admin_revision_file_mime TEXT NOT NULL DEFAULT 'application/pdf',
  admin_revision_file_size BIGINT NOT NULL DEFAULT 0,
  admin_revision_file_data BYTEA,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  UNIQUE(task_id)
);
CREATE INDEX IF NOT EXISTS lp_generated_teacher_idx ON lesson_plan_generated_tasks(teacher_id,term_number,week_number,day_number);
CREATE INDEX IF NOT EXISTS lp_upload_status_idx ON lesson_plan_uploads(status,submitted_at DESC);

-- Preserve every uploaded version so administrators can inspect revisions.
CREATE TABLE IF NOT EXISTS lesson_plan_upload_versions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES lesson_plan_generated_tasks(id) ON DELETE CASCADE,
  teacher_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/pdf',
  file_size BIGINT NOT NULL,
  file_data BYTEA NOT NULL,
  status TEXT NOT NULL,
  admin_feedback TEXT NOT NULL DEFAULT '',
  admin_revision_file_name TEXT NOT NULL DEFAULT '',
  admin_revision_file_mime TEXT NOT NULL DEFAULT 'application/pdf',
  admin_revision_file_size BIGINT NOT NULL DEFAULT 0,
  admin_revision_file_data BYTEA,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version_number INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS lp_upload_versions_task_idx ON lesson_plan_upload_versions(task_id,version_number DESC);

-- Upgrade an existing deployment whose status check predates late submissions.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lesson_plan_uploads_status_check') THEN
    ALTER TABLE lesson_plan_uploads DROP CONSTRAINT lesson_plan_uploads_status_check;
  END IF;
  ALTER TABLE lesson_plan_uploads ADD CONSTRAINT lesson_plan_uploads_status_check CHECK(status IN ('Submitted','Late','Approved','For Revision','Completed'));
END $$;

-- Revision instruction PDF attachment support (safe for existing deployments).
ALTER TABLE lesson_plan_uploads ADD COLUMN IF NOT EXISTS admin_revision_file_name TEXT NOT NULL DEFAULT '';
ALTER TABLE lesson_plan_uploads ADD COLUMN IF NOT EXISTS admin_revision_file_mime TEXT NOT NULL DEFAULT 'application/pdf';
ALTER TABLE lesson_plan_uploads ADD COLUMN IF NOT EXISTS admin_revision_file_size BIGINT NOT NULL DEFAULT 0;
ALTER TABLE lesson_plan_uploads ADD COLUMN IF NOT EXISTS admin_revision_file_data BYTEA;
ALTER TABLE lesson_plan_upload_versions ADD COLUMN IF NOT EXISTS admin_revision_file_name TEXT NOT NULL DEFAULT '';
ALTER TABLE lesson_plan_upload_versions ADD COLUMN IF NOT EXISTS admin_revision_file_mime TEXT NOT NULL DEFAULT 'application/pdf';
ALTER TABLE lesson_plan_upload_versions ADD COLUMN IF NOT EXISTS admin_revision_file_size BIGINT NOT NULL DEFAULT 0;
ALTER TABLE lesson_plan_upload_versions ADD COLUMN IF NOT EXISTS admin_revision_file_data BYTEA;
