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
- Uploads are stored in PostgreSQL as binary data, with an 8 MB per-file limit. For a large school deployment, object storage (for example, OneDrive or S3-compatible storage) is preferable.
- Regenerating a term creates any missing task slots but does not alter existing tasks or submissions. If term settings are changed after tasks have been generated, the existing due dates are intentionally retained.
- The task generator skips weekends for 5-day schedules, skips Sundays for 6-day schedules, and uses all days for 7-day schedules.
- Existing subjects must be created before the admin can assign them to teachers.
