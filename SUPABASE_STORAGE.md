# Supabase Storage for uploads

Every uploaded file (lesson plan PDFs, administrator revision PDFs, memos, announcement photos,
ancillary task attachments and submissions) is kept in one **private** Supabase Storage bucket,
`portal-files`. The database stores only a storage key for each file, so the 500 MB database limit
is no longer used up by documents.

Browsers never talk to Supabase. They download through the portal (`/api/.../file`), so the same
sign-in and role checks apply as before. PDFs open inline and in the in-page viewer; add
`?download=1` to a file URL to force a download.

## One-time setup

1. In Supabase open **Project Settings > API Keys** and copy a **secret** key (`sb_secret_...`).
   A legacy `service_role` key also works. Treat it like a password: never paste it in chat, commit
   it, or put it in browser code.
2. In Render open the service > **Environment** and add:
   - `SUPABASE_URL` = your project URL, e.g. `https://<project-ref>.supabase.co`
   - `SUPABASE_SECRET_KEY` = the key from step 1
3. Deploy. On start the portal creates the private bucket if it is missing, uploads and reads back
   a tiny test file, and refuses to start if that fails (or if the bucket is public).
4. Files that are still stored in the database are then moved automatically in the background.
   Each file is uploaded, downloaded again and compared byte for byte before the database copy is
   cleared. When files were moved, `VACUUM FULL` runs on the affected tables so the database file
   shrinks; the log shows `Moved N file(s) from the database to Supabase Storage`.

Set `MIGRATE_LEGACY_FILES=false` to skip the move on a particular start.

## Behaviour to know

- In production the portal will not start without `SUPABASE_URL` and `SUPABASE_SECRET_KEY`.
- In local development without them, files stay in the database (the old behaviour).
- Replacing, deleting or expiring a record leaves its stored file unreferenced. A cleanup runs at
  every start and every 6 hours and removes stored files that no record points to and that are at
  least 3 hours old (at most 500 per run). It refuses to run if the database references no files.
- Lesson plan revision history reuses the stored file instead of copying it.
- Supabase egress still counts file downloads. Free plan limits: 1 GB file storage, 5 GB egress.
