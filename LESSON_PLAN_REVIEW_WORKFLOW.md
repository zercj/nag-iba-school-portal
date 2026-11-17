# Lesson-plan approval and revision workflow

1. A teacher submits a PDF lesson plan for a daily task.
2. The administrator opens the submission and chooses **Approved** or **For Revision**.
3. When **For Revision** is selected, administrator feedback is required and explains what must be changed.
4. The teacher sees the revision request and feedback and can upload a replacement PDF only after a revision is requested.
5. The replacement is saved as the current submission with a pending-review status; the previous PDF, status, feedback, and submission time are preserved in revision history.
6. The administrator reviews the new PDF and approves it or requests another revision. A task cannot be marked approved until the administrator approves a submitted version.

PDF uploads remain limited to 8 MB. Server-side checks enforce the revision workflow, not just the dashboard UI.

## Records kept after an administrator deletes lesson plans
Deleting submitted lesson plans (one subject, selected days, or the bulk Delete tool) removes the PDFs, earlier revisions and stored files, but each day keeps a permanent record that teachers and administrators can still see: On time or Late, where the review stood (Approved, For revision, In review), the date it was passed, the file name and size, the administrator's feedback and review date, how many revisions there were, and whether it had a warning mark. Days that were never submitted keep their live Overdue / In progress status. Removed days cannot be uploaded again. Records of days deleted before this update keep only On time / Late, the review state and the date.
