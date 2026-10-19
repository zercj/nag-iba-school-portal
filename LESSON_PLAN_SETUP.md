# Lesson-plan task workflow added

This build adds an initial three-term lesson-plan workflow to the existing portal.

## How it works
1. Sign in as an administrator or developer.
2. Open **Tasks**. Configure the weeks, teaching days per week, and start date for each of the three terms.
3. Assign each active teacher one or more existing subjects.
4. Select a term and choose **Generate lesson-plan tasks**.
5. Teachers sign in, select the term, and upload a file for each generated subject/week/day task (maximum 8 MB per file).
6. Admins can download submissions and mark them **Approved** or **For Revision**, with optional feedback.

The portal initializes new tables from `schema.sql` during server startup. Back up the production database before deploying any schema changes. Existing portal tables and data are preserved; new tasks are only generated when an admin presses the generate button.

## Important limitations
- Uploads are stored in a private Supabase Storage bucket (see `SUPABASE_STORAGE.md`), with an 8 MB per-file limit. The database keeps only each file's storage key.
- Regenerating a term creates any missing task slots but does not alter existing tasks or submissions. If term settings are changed after tasks have been generated, the existing due dates are intentionally retained.
- The task generator skips weekends for 5-day schedules, skips Sundays for 6-day schedules, and uses all days for 7-day schedules.
- Existing subjects must be created before the admin can assign them to teachers.

## Dedicated Lesson Plan Submission Center

The sidebar now includes a separate **Lesson Plans** workspace for administrator and teacher accounts. General school tasks remain in the Tasks section. The Lesson Plans workspace includes term-specific submission cards and, for administrators, progress tables grouped by subject and teacher. Select the term using the term selector in the submission panel to review that term's generated tasks and progress.


### Manual teacher-subject assignment
In the Lesson Plan Submission Center, choose a user whose account role is `teacher`, then type the subject name into the Subject name field. The server validates the teacher role and creates or reuses that subject for the selected teacher before saving the assignment. You do not need to create the subject in a separate dropdown first.
