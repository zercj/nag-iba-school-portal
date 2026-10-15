# Lesson Plan Tracing implementation notes

This project is an existing Node.js/PostgreSQL portal with account login, hashed passwords,
server-side sessions, account management, messages, announcements, tasks, subjects, and attachments.
The database schema now includes additive tables for a three-term lesson-plan workflow,
sections/enrollment, student tasks/submissions, and targeted announcements.

## Render environment
- Keep `NODE_ENV=production`.
- Keep `PGSSL=true` for a hosted PostgreSQL connection that requires TLS.
- Set `DATABASE_URL` to the actual PostgreSQL connection string.
- Set `BOOTSTRAP_DEVELOPERS` to a JSON array containing at least one initial developer account, e.g.:

  `[{"username":"schooldev","displayName":"School Developer","password":"USE-YOUR-OWN-UNIQUE-PASSWORD-12-CHARACTERS-OR-LONGER"}]`

Use your own private password, not the example. Change it after first sign-in. Once the developer
account exists, remove `BOOTSTRAP_DEVELOPERS` and redeploy.

## What is and is not connected yet
The existing portal's current login, messaging, account, announcement, subject, and task routes remain
available. The new SQL tables are created on startup by the existing server, but the lesson-plan tables
still need API endpoints and browser UI wired to them before the lesson-plan workflow is fully operational.

## OneDrive integration requirements
Actual Microsoft OneDrive uploads require an Entra ID (Azure) app registration, a redirect URI,
Microsoft Graph API permissions, OAuth consent, and secure token refresh/storage. The schema can store
OneDrive file IDs and URLs, but it does not itself upload files to OneDrive. Never put client secrets or
refresh tokens in browser code or commit them to GitHub.
