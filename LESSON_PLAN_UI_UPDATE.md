# Lesson-plan interface update

**Admin** (Lesson Plans): choose a term first, then use the three tabs.
- Overview: term numbers (required / submitted / approved / awaiting) plus the Overdue / Completed on time / Completed late counts, and the assigned teacher-subjects list.
- Schedule: the schedule-generation form only.
- Progress: progress by subject and by teacher (with an Overdue column), and a click-to-open calendar for the selected subject or teacher.

**Teacher**: choose a term, pick a subject, then click a highlighted day on the calendar. A pop-up opens that day's lesson plan (upload, status, feedback, revision instructions, confirm approval).

**Status colors** (calendars, tables, pop-ups and dashboard notifications, for both roles):
- Red: overdue
- Green: completed on time
- Light yellow: completed late
- Blue: submitted, in review. Violet: for revision. White: awaiting upload.

Server change: `/api/lesson-plans/tasks` now returns `due_date` as a plain `YYYY-MM-DD` string so calendar days never shift with time zones.
