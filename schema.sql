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
