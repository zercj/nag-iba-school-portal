# Manual Lesson Plan Calendar — Deployment Notes

## Admin workflow
1. Open **Lesson Plans**.
2. Select one term (Term 1, Term 2, or Term 3).
3. Select an active account with the Teacher role.
4. Type the subject name, number of weeks, days per week, and first lesson-plan date.
5. Click **Generate calendar**. This creates daily tasks for only the selected teacher, subject, and term. Other terms and other teacher-subject calendars are not generated automatically.

## Teacher workflow
- The dashboard shows a Lesson Plan Notifications panel when daily PDFs are waiting.
- Open Lesson Plans and select the relevant term.
- Each day is a separate calendar card. Submit one PDF per day (maximum 8 MB).
- A submission after its due date is marked **Late**. A timely submission is marked **Submitted**.
- If the administrator requests a revision, upload the revised PDF on the same day card. The previous PDF is preserved in revision history.

## Admin review
- Admins can open/download the current PDF, approve it, or select For Revision and add feedback.
- Earlier uploaded versions and their review notes are available under **View previous revisions**.
- The dashboard notification panel lists submissions awaiting review.

## Database
The application runs `schema.sql` at server startup. This update adds a revision-history table and upgrades the submission status constraint to include `Late`. Back up PostgreSQL before deploying. Test with one teacher, one subject, and one term before generating a full calendar.

## Important behavior
- The generated daily dates start from the date entered by the admin. For 5 or fewer days per week, generated dates skip Saturdays and Sundays; 6-day schedules skip Sundays; 7-day schedules include every day.
- The calendar is generated only for the selected term and teacher-subject pair.
- PDF files are stored in PostgreSQL; keep an eye on database storage limits.
