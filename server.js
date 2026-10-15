import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { canManageContent, canManageRole, rolesVisibleTo } from "./permissions.js";

const { Pool } = pg;
const scrypt = promisify(scryptCallback);
const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8000);
const appOrigin = process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL;
const isProduction = process.env.NODE_ENV === "production";
const sessionDurationMs = 8 * 60 * 60 * 1000;
const loginAttempts = new Map();
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/school-logo.png", ["school-logo.png", "image/png"]],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL.");
}
if (!appOrigin) {
  throw new Error("APP_ORIGIN is required (Render sets RENDER_EXTERNAL_URL) so state-changing requests can enforce same-origin protection.");
}
let configuredOrigin;
try {
  configuredOrigin = new URL(appOrigin);
} catch {
  throw new Error("APP_ORIGIN must be a valid absolute URL origin.");
}
if (configuredOrigin.origin !== appOrigin || !["http:", "https:"].includes(configuredOrigin.protocol)) {
  throw new Error("APP_ORIGIN must contain only the scheme, host, and optional port, with no trailing slash or path.");
}
if (isProduction && process.env.PGSSL !== "true") {
  throw new Error("PGSSL=true is required in production to encrypt PostgreSQL connections.");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}


const sslCa = process.env.PGSSL_CA_FILE
  ? readFileSync(process.env.PGSSL_CA_FILE, "utf8")
  : undefined;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 15,
  ssl: process.env.PGSSL === "true"
    ? {
        rejectUnauthorized: true,
        ...(sslCa ? { ca: sslCa } : {}),
      }
    : undefined,
});

pool.on("error", (error) => console.error("Unexpected PostgreSQL pool error:", error.message));

function normalizeUsername(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validateUsername(value) {
  const username = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) {
    throw new HttpError(400, "Username must be 3–40 characters using letters, numbers, dot, underscore, or hyphen.");
  }
  return username;
}

function validateDisplayName(value) {
  if (typeof value !== "string" || value.trim().length < 2 || value.trim().length > 120) {
    throw new HttpError(400, "Display name must be between 2 and 120 characters.");
  }
  return value.trim();
}

function validatePassword(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 256) {
    throw new HttpError(400, "Password must contain at least 12 characters.");
  }
  return value;
}

function validateEmail(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new HttpError(400, "Enter a valid email address, or leave it blank.");
  }
  return value.trim().toLowerCase();
}

function validateRole(value) {
  if (!["admin", "teacher", "student"].includes(value)) {
    throw new HttpError(400, "Role must be administrator, teacher, or student.");
  }
  return value;
}

function requiredText(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new HttpError(400, `${label} is required and must be no longer than ${maxLength} characters.`);
  }
  return value.trim();
}

function parseJson(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 12_000_000) {
        reject(new HttpError(413, "Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!raw) return resolve({});
      try {
        const value = JSON.parse(raw);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return reject(new HttpError(400, "Request body must be a JSON object."));
        }
        resolve(value);
      } catch {
        reject(new HttpError(400, "Request body must contain valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function cookieValue(request, name) {
  const cookies = request.headers.cookie?.split(";") ?? [];
  const entry = cookies.map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : null;
}

function sessionCookie(token, expiresAt) {
  const secure = isProduction ? "; Secure" : "";
  return `school_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Expires=${expiresAt.toUTCString()}${secure}`;
}

function expiredCookie() {
  const secure = isProduction ? "; Secure" : "";
  return `school_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

function tokenDigest(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(hash).toString("hex")}`;
}

async function passwordMatches(password, encoded) {
  const [scheme, salt, expectedHex] = encoded.split("$");
  if (scheme !== "scrypt" || !salt || !/^[a-f0-9]{128}$/i.test(expectedHex || "")) return false;
  const actual = Buffer.from(await scrypt(password, salt, 64));
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function ensureSameOrigin(request) {
  if (request.headers.origin !== appOrigin) {
    throw new HttpError(403, "Request origin is not allowed.");
  }
}

function requireRole(user, roles) {
  if (!roles.includes(user.role)) throw new HttpError(403, "You do not have permission to perform this action.");
}

function safeUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    active: row.active,
    createdAt: row.created_at,
  };
}

async function getSessionUser(request) {
  const token = cookieValue(request, "school_session");
  if (!token || token.length > 200) return null;
  const result = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.email, u.role, u.active
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.active = TRUE`,
    [tokenDigest(token)],
  );
  return result.rows[0] ?? null;
}

async function audit(connection, actorId, action, targetType, targetId = null) {
  await connection.query(
    "INSERT INTO audit_logs (actor_id, action, target_type, target_id) VALUES ($1, $2, $3, $4)",
    [actorId, action, targetType, targetId === null ? null : String(targetId)],
  );
}

async function inTransaction(callback) {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    const result = await callback(connection);
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

function rateLimitLogin(request) {
  const now = Date.now();
  const key = request.socket.remoteAddress || "unknown";
  const attempts = (loginAttempts.get(key) || []).filter((time) => now - time < 15 * 60 * 1000);
  if (attempts.length >= 10) throw new HttpError(429, "Too many sign-in attempts. Try again in 15 minutes.");
  attempts.push(now);
  loginAttempts.set(key, attempts);
}

function clearLoginAttempts(request) {
  const key = request.socket.remoteAddress || "unknown";
  loginAttempts.delete(key);
}

async function bootstrapDevelopers() {
  const raw = process.env.BOOTSTRAP_DEVELOPERS || "[]";
  let developers;
  try {
    developers = JSON.parse(raw);
  } catch {
    throw new Error("BOOTSTRAP_DEVELOPERS must be a JSON array in the local .env file.");
  }
  if (!Array.isArray(developers)) throw new Error("BOOTSTRAP_DEVELOPERS must be a JSON array.");
  const usernames = new Set();
  for (const developer of developers) {
    const username = validateUsername(developer?.username);
    const key = normalizeUsername(username);
    if (usernames.has(key)) throw new Error("BOOTSTRAP_DEVELOPERS contains duplicate usernames.");
    usernames.add(key);
    const password = developer?.password;
    if (typeof password !== "string" || password.length < 8 || password.length > 256) {
      throw new Error("Each bootstrap developer password must contain at least 8 characters.");
    }
    const displayName = validateDisplayName(developer.displayName || username);
    const existing = await pool.query(
      "SELECT role, active FROM users WHERE LOWER(username) = $1",
      [key],
    );
    if (existing.rowCount && existing.rows[0].role !== "developer") {
      throw new Error("A bootstrap developer username already belongs to a non-developer account. Resolve the account through the database administrator.");
    }
    if (existing.rowCount && !existing.rows[0].active) {
      throw new Error("A bootstrap developer account is inactive. Reactivate it through the database administrator.");
    }
    if (existing.rowCount) continue;
    const passwordHash = await hashPassword(password);
    await pool.query(
      `INSERT INTO users (username, display_name, role, password_hash)
       VALUES ($1, $2, 'developer', $3)
       ON CONFLICT DO NOTHING`,
      [username, displayName, passwordHash],
    );
  }
}

async function authenticate(request, response, url) {
  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    ensureSameOrigin(request);
    rateLimitLogin(request);
    const body = await parseJson(request);
    const username = normalizeUsername(body.username);
    const password = typeof body.password === "string" ? body.password : "";
    const role = typeof body.role === "string" ? body.role : "";
    if (!username || !password || username.length > 40 || password.length > 256 ||
        !["developer", "admin", "teacher", "student"].includes(role)) {
      throw new HttpError(401, "Invalid username or password.");
    }
    const result = await pool.query(
      "SELECT * FROM users WHERE LOWER(username) = $1 AND active = TRUE AND role = $2",
      [username, role],
    );
    const user = result.rows[0];
    let valid = false;
    if (user) valid = await passwordMatches(password, user.password_hash);
    else await scrypt(password, "missing-account-salt", 64);
    if (!valid) throw new HttpError(401, "Invalid username or password.");
    clearLoginAttempts(request);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + sessionDurationMs);
    await pool.query(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
      [tokenDigest(token), user.id, expiresAt],
    );
    sendJson(response, 200, { user: safeUser(user) }, { "Set-Cookie": sessionCookie(token, expiresAt) });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    ensureSameOrigin(request);
    const token = cookieValue(request, "school_session");
    if (token) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenDigest(token)]);
    sendJson(response, 200, { ok: true }, { "Set-Cookie": expiredCookie() });
    return true;
  }
  return false;
}

async function handleUserRoutes(request, response, url, actor) {
  if (request.method === "GET" && url.pathname === "/api/me") {
    sendJson(response, 200, { user: safeUser(actor) });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/directory") {
    const result = await pool.query(
      `SELECT id, username, display_name, role
       FROM users WHERE active = TRUE AND role <> 'developer'
       ORDER BY display_name`,
    );
    sendJson(response, 200, { users: result.rows.map((row) => ({
      id: row.id, username: row.username, displayName: row.display_name, role: row.role,
    })) });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/users") {
    const roles = rolesVisibleTo(actor.role);
    if (!roles) throw new HttpError(403, "Student accounts cannot manage user accounts.");
    const result = await pool.query(
      "SELECT id, username, display_name, email, role, active, created_at FROM users WHERE role = ANY($1::text[]) ORDER BY role, display_name",
      [roles],
    );
    sendJson(response, 200, { users: result.rows.map(safeUser) });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/users") {
    ensureSameOrigin(request);
    const body = await parseJson(request);
    const role = validateRole(body.role);
    if (!canManageRole(actor.role, role)) throw new HttpError(403, "You cannot create an account with that role.");
    const username = validateUsername(body.username);
    const displayName = validateDisplayName(body.displayName);
    const email = validateEmail(body.email);
    const passwordHash = await hashPassword(validatePassword(body.password));
    const user = await inTransaction(async (connection) => {
      const created = await connection.query(
        `INSERT INTO users (username, display_name, email, role, password_hash)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, username, display_name, email, role, active, created_at`,
        [username, displayName, email, role, passwordHash],
      );
      await audit(connection, actor.id, "user.created", "user", created.rows[0].id);
      return created.rows[0];
    });
    sendJson(response, 201, { user: safeUser(user) });
    return true;
  }

  const match = url.pathname.match(/^\/api\/users\/(\d+)$/);
  if (!match) return false;
  const userId = match[1];
  const existing = await pool.query(
    "SELECT id, username, display_name, email, role, active, created_at FROM users WHERE id = $1",
    [userId],
  );
  const target = existing.rows[0];
  if (!target) throw new HttpError(404, "User account not found.");
  if (!canManageRole(actor.role, target.role)) throw new HttpError(403, "You cannot manage this account.");

  if (request.method === "PATCH") {
    ensureSameOrigin(request);
    const body = await parseJson(request);
    const username = body.username === undefined ? target.username : validateUsername(body.username);
    const displayName = body.displayName === undefined ? target.display_name : validateDisplayName(body.displayName);
    const email = body.email === undefined ? target.email : validateEmail(body.email);
    const role = body.role === undefined ? target.role : validateRole(body.role);
    const active = body.active === undefined ? target.active : body.active;
    if (typeof active !== "boolean") throw new HttpError(400, "Account active status must be true or false.");
    if (!canManageRole(actor.role, role)) throw new HttpError(403, "You cannot assign that role.");
    if (String(actor.id) === String(target.id) && active === false) {
      throw new HttpError(400, "You cannot deactivate your own account.");
    }
    if (String(actor.id) === String(target.id) && role !== target.role) {
      throw new HttpError(400, "You cannot change your own role.");
    }
    const passwordHash = body.password === undefined ? null : await hashPassword(validatePassword(body.password));
    const updated = await inTransaction(async (connection) => {
      const result = await connection.query(
        `UPDATE users
         SET username = $2, display_name = $3, email = $4, role = $5, active = $6,
             password_hash = COALESCE($7, password_hash), updated_at = NOW()
         WHERE id = $1
         RETURNING id, username, display_name, email, role, active, created_at`,
        [userId, username, displayName, email, role, active, passwordHash],
      );
      if (!active) await connection.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
      await audit(connection, actor.id, "user.updated", "user", userId);
      return result.rows[0];
    });
    sendJson(response, 200, { user: safeUser(updated) });
    return true;
  }

  if (request.method === "DELETE") {
    ensureSameOrigin(request);
    if (String(actor.id) === String(target.id)) throw new HttpError(400, "You cannot delete your own account.");
    await inTransaction(async (connection) => {
      await connection.query("DELETE FROM users WHERE id = $1", [userId]);
      await audit(connection, actor.id, "user.deleted", "user", userId);
    });
    sendJson(response, 200, { ok: true });
    return true;
  }
  return false;
}

async function handleAccountRoutes(request, response, url, actor) {
  if (request.method !== "POST" || url.pathname !== "/api/account/password") return false;
  ensureSameOrigin(request);
  const body = await parseJson(request);
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  if (!currentPassword || currentPassword.length > 256) {
    throw new HttpError(400, "Enter your current password.");
  }
  const result = await pool.query("SELECT password_hash FROM users WHERE id = $1 AND active = TRUE", [actor.id]);
  if (!result.rowCount || !(await passwordMatches(currentPassword, result.rows[0].password_hash))) {
    throw new HttpError(400, "Current password is incorrect.");
  }
  const newPassword = validatePassword(body.newPassword);
  if (newPassword === currentPassword) throw new HttpError(400, "Choose a new password different from your current one.");
  const passwordHash = await hashPassword(newPassword);
  const sessionToken = cookieValue(request, "school_session");
  await inTransaction(async (connection) => {
    await connection.query("UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1", [actor.id, passwordHash]);
    await connection.query(
      "DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2",
      [actor.id, tokenDigest(sessionToken)],
    );
    await audit(connection, actor.id, "account.password_changed", "user", actor.id);
  });
  sendJson(response, 200, { ok: true });
  return true;
}

async function handleMessageRoutes(request, response, url, actor) {
  if (request.method === "GET" && url.pathname === "/api/messages") {
    const result = await pool.query(
      `SELECT m.id, m.sender_id, m.recipient_id, m.body, m.created_at, m.read_at,
              sender.display_name AS sender_name, sender.username AS sender_username,
              recipient.display_name AS recipient_name, recipient.username AS recipient_username
       FROM messages m
       JOIN users sender ON sender.id = m.sender_id
       JOIN users recipient ON recipient.id = m.recipient_id
       WHERE m.sender_id = $1 OR m.recipient_id = $1
       ORDER BY m.created_at DESC LIMIT 200`,
      [actor.id],
    );
    sendJson(response, 200, { messages: result.rows });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/messages") {
    ensureSameOrigin(request);
    const body = await parseJson(request);
    const recipientId = String(body.recipientId || "");
    if (!/^\d+$/.test(recipientId) || recipientId === String(actor.id)) {
      throw new HttpError(400, "Choose another active school account as the recipient.");
    }
    const message = requiredText(body.body, "Message", 4000);
    const recipient = await pool.query(
      "SELECT id FROM users WHERE id = $1 AND active = TRUE AND role <> 'developer'",
      [recipientId],
    );
    if (!recipient.rowCount) throw new HttpError(404, "Recipient account was not found.");
    const created = await pool.query(
      "INSERT INTO messages (sender_id, recipient_id, body) VALUES ($1, $2, $3) RETURNING id, created_at",
      [actor.id, recipientId, message],
    );
    sendJson(response, 201, { message: created.rows[0] });
    return true;
  }

  const readMatch = url.pathname.match(/^\/api\/messages\/(\d+)\/read$/);
  if (request.method === "POST" && readMatch) {
    ensureSameOrigin(request);
    const result = await pool.query(
      "UPDATE messages SET read_at = NOW() WHERE id = $1 AND recipient_id = $2 AND read_at IS NULL",
      [readMatch[1], actor.id],
    );
    if (!result.rowCount) throw new HttpError(404, "Unread message not found.");
    sendJson(response, 200, { ok: true });
    return true;
  }
  return false;
}

async function handleAnnouncementRoutes(request, response, url, actor) {
  if (request.method === "GET" && url.pathname === "/api/announcements") {
    const result = await pool.query(
      `SELECT a.id, a.title, a.body, a.created_at, a.updated_at,
              a.author_name AS author_name, u.username AS author_username, a.author_id
       FROM announcements a LEFT JOIN users u ON u.id = a.author_id
       ORDER BY a.created_at DESC LIMIT 200`,
    );
    sendJson(response, 200, { announcements: result.rows });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/announcements") {
    ensureSameOrigin(request);
    requireRole(actor, ["developer", "admin", "teacher"]);
    const body = await parseJson(request);
    const title = requiredText(body.title, "Title", 180);
    const content = requiredText(body.body, "Announcement", 10000);
    const created = await inTransaction(async (connection) => {
      const result = await connection.query(
        `INSERT INTO announcements (title, body, author_id, author_name)
         VALUES ($1, $2, $3, $4) RETURNING id, title, body, created_at, author_name`,
        [title, content, actor.id, actor.display_name],
      );
      await audit(connection, actor.id, "announcement.created", "announcement", result.rows[0].id);
      return result.rows[0];
    });
    sendJson(response, 201, { announcement: created });
    return true;
  }

  const match = url.pathname.match(/^\/api\/announcements\/(\d+)$/);
  if (!match) return false;
  requireRole(actor, ["developer", "admin", "teacher"]);
  const existing = await pool.query("SELECT id, author_id FROM announcements WHERE id = $1", [match[1]]);
  if (!existing.rowCount) throw new HttpError(404, "Announcement not found.");
  if (!canManageContent(actor.role, existing.rows[0].author_id, actor.id)) {
    throw new HttpError(403, "Teachers can only modify their own announcements.");
  }
  if (request.method === "PATCH") {
    ensureSameOrigin(request);
    const body = await parseJson(request);
    const current = await pool.query("SELECT title, body FROM announcements WHERE id = $1", [match[1]]);
    const title = body.title === undefined ? current.rows[0].title : requiredText(body.title, "Title", 180);
    const content = body.body === undefined ? current.rows[0].body : requiredText(body.body, "Announcement", 10000);
    const updated = await inTransaction(async (connection) => {
      const result = await connection.query(
        "UPDATE announcements SET title = $2, body = $3, updated_at = NOW() WHERE id = $1 RETURNING id, title, body, updated_at",
        [match[1], title, content],
      );
      await audit(connection, actor.id, "announcement.updated", "announcement", match[1]);
      return result.rows[0];
    });
    sendJson(response, 200, { announcement: updated });
    return true;
  }
  if (request.method === "DELETE") {
    ensureSameOrigin(request);
    await inTransaction(async (connection) => {
      await connection.query("DELETE FROM announcements WHERE id = $1", [match[1]]);
      await audit(connection, actor.id, "announcement.deleted", "announcement", match[1]);
    });
    sendJson(response, 200, { ok: true });
    return true;
  }
  return false;
}

async function handleSubjectRoutes(request, response, url, actor) {
  if (url.pathname === "/api/subjects" && request.method === "GET") {
    const result = actor.role === "student"
      ? await pool.query(`SELECT s.id, s.name, s.code, s.description, s.teacher_id, u.display_name AS teacher_name,
          COALESCE(json_agg(json_build_object('id', st.id, 'displayName', st.display_name)) FILTER (WHERE st.id IS NOT NULL), '[]') AS students
          FROM subjects s JOIN subject_students ss ON ss.subject_id=s.id
          JOIN users u ON u.id=s.teacher_id LEFT JOIN subject_students sx ON sx.subject_id=s.id
          LEFT JOIN users st ON st.id=sx.student_id WHERE ss.student_id=$1
          GROUP BY s.id,u.display_name ORDER BY s.name`, [actor.id])
      : actor.role === "teacher"
        ? await pool.query(`SELECT s.id, s.name, s.code, s.description, s.teacher_id, u.display_name AS teacher_name,
            COALESCE(json_agg(json_build_object('id', st.id, 'displayName', st.display_name)) FILTER (WHERE st.id IS NOT NULL), '[]') AS students
            FROM subjects s JOIN users u ON u.id=s.teacher_id LEFT JOIN subject_students ss ON ss.subject_id=s.id
            LEFT JOIN users st ON st.id=ss.student_id WHERE s.teacher_id=$1 GROUP BY s.id,u.display_name ORDER BY s.name`, [actor.id])
        : await pool.query(`SELECT s.id, s.name, s.code, s.description, s.teacher_id, u.display_name AS teacher_name,
            COALESCE(json_agg(json_build_object('id', st.id, 'displayName', st.display_name)) FILTER (WHERE st.id IS NOT NULL), '[]') AS students
            FROM subjects s JOIN users u ON u.id=s.teacher_id LEFT JOIN subject_students ss ON ss.subject_id=s.id
            LEFT JOIN users st ON st.id=ss.student_id GROUP BY s.id,u.display_name ORDER BY s.name`);
    sendJson(response, 200, { subjects: result.rows }); return true;
  }
  if (url.pathname === "/api/subjects" && request.method === "POST") {
    ensureSameOrigin(request); requireRole(actor, ["teacher"]);
    const body = await parseJson(request);
    const name = requiredText(body.name, "Subject name", 160);
    const code = body.code ? requiredText(body.code, "Subject code", 40) : null;
    const description = body.description ? requiredText(body.description, "Description", 2000) : "";
    const result = await pool.query(`INSERT INTO subjects(name,code,description,teacher_id) VALUES($1,$2,$3,$4)
      RETURNING id,name,code,description,teacher_id`, [name, code, description, actor.id]);
    await pool.query("INSERT INTO audit_logs(actor_id,action,target_type,target_id) VALUES($1,'subject.created','subject',$2)", [actor.id, result.rows[0].id]);
    sendJson(response, 201, { subject: result.rows[0] }); return true;
  }
  const enrollMatch = url.pathname.match(/^\/api\/subjects\/(\d+)\/students$/);
  if (enrollMatch && request.method === "POST") {
    ensureSameOrigin(request); requireRole(actor, ["teacher"]);
    const body = await parseJson(request);
    if (!Array.isArray(body.studentIds) || body.studentIds.length > 500) throw new HttpError(400, "Choose one or more students.");
    const subject = await pool.query("SELECT id FROM subjects WHERE id=$1 AND teacher_id=$2", [enrollMatch[1], actor.id]);
    if (!subject.rowCount) throw new HttpError(404, "Subject not found for this teacher.");
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      for (const id of [...new Set(body.studentIds.map(String))]) {
        if (!/^\d+$/.test(id)) throw new HttpError(400, "Invalid student account.");
        const student = await connection.query("SELECT id FROM users WHERE id=$1 AND role='student' AND active=TRUE", [id]);
        if (!student.rowCount) throw new HttpError(400, "Only active student accounts can be assigned to a subject.");
        await connection.query("INSERT INTO subject_students(subject_id,student_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [enrollMatch[1], id]);
      }
      await connection.query("COMMIT");
    } catch (error) { await connection.query("ROLLBACK"); throw error; } finally { connection.release(); }
    sendJson(response, 200, { ok: true }); return true;
  }
  return false;
}


async function handleLessonPlanRoutes(request, response, url, actor) {
  const admin = ["admin", "developer"];
  if (url.pathname === "/api/lesson-plans/settings" && request.method === "GET") {
    const result = await pool.query("SELECT term_number,weeks,days_per_week,start_date FROM lesson_plan_term_settings ORDER BY term_number");
    sendJson(response, 200, { settings: result.rows }); return true;
  }
  if (url.pathname === "/api/lesson-plans/settings" && request.method === "POST") {
    ensureSameOrigin(request); requireRole(actor, admin);
    const body = await parseJson(request);
    if (!Array.isArray(body.settings) || body.settings.length !== 3) throw new HttpError(400, "Provide settings for all three terms.");
    const conn = await pool.connect();
    try {
      await conn.query("BEGIN");
      for (const item of body.settings) {
        const term = Number(item.termNumber), weeks = Number(item.weeks), days = Number(item.daysPerWeek);
        const start = new Date(item.startDate);
        if (![1,2,3].includes(term) || !Number.isInteger(weeks) || weeks < 1 || weeks > 52 || !Number.isInteger(days) || days < 1 || days > 7 || !item.startDate || Number.isNaN(start.getTime())) throw new HttpError(400, "Check each term's weeks, days per week, and start date.");
        await conn.query(`INSERT INTO lesson_plan_term_settings(term_number,weeks,days_per_week,start_date,updated_by,updated_at)
          VALUES($1,$2,$3,$4,$5,NOW()) ON CONFLICT(term_number) DO UPDATE SET weeks=EXCLUDED.weeks,days_per_week=EXCLUDED.days_per_week,start_date=EXCLUDED.start_date,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
          [term,weeks,days,item.startDate,actor.id]);
      }
      await conn.query("COMMIT");
    } catch (e) { await conn.query("ROLLBACK"); throw e; } finally { conn.release(); }
    sendJson(response, 200, { ok: true }); return true;
  }
  if (url.pathname === "/api/lesson-plans/assignments" && request.method === "GET") {
    const result = await pool.query(`SELECT a.id,a.teacher_id,a.subject_id,u.display_name AS teacher_name,s.name AS subject_name
      FROM lesson_plan_subject_assignments a JOIN users u ON u.id=a.teacher_id JOIN subjects s ON s.id=a.subject_id
      WHERE $1 OR a.teacher_id=$2 ORDER BY u.display_name,s.name`, [admin.includes(actor.role), actor.id]);
    sendJson(response, 200, { assignments: result.rows }); return true;
  }
  if (url.pathname === "/api/lesson-plans/assignments" && request.method === "POST") {
    ensureSameOrigin(request); requireRole(actor, admin);
    const body = await parseJson(request), teacherId = Number(body.teacherId);
    const subjectName = String(body.subjectName || "").trim();
    if (!Number.isInteger(teacherId) || teacherId < 1 || subjectName.length < 1 || subjectName.length > 160) {
      throw new HttpError(400, "Choose a teacher and enter a subject name of 1–160 characters.");
    }
    const teacher = await pool.query("SELECT id FROM users WHERE id=$1 AND role='teacher' AND active=TRUE", [teacherId]);
    if (!teacher.rowCount) throw new HttpError(400, "Choose an active user whose role is Teacher.");
    // Subjects are typed by the administrator and stored against the selected teacher.
    const subjectResult = await pool.query(
      `INSERT INTO subjects(name,teacher_id)
       VALUES($1,$2)
       ON CONFLICT(teacher_id,name) DO UPDATE SET name=EXCLUDED.name
       RETURNING id`,
      [subjectName, teacherId]
    );
    const subjectId = subjectResult.rows[0].id;
    const result = await pool.query(`INSERT INTO lesson_plan_subject_assignments(teacher_id,subject_id,assigned_by)
      VALUES($1,$2,$3) ON CONFLICT(teacher_id,subject_id) DO UPDATE SET assigned_by=EXCLUDED.assigned_by RETURNING id`, [teacherId,subjectId,actor.id]);
    sendJson(response, 201, { ok: true, id: result.rows[0].id, subjectId }); return true;
  }
  const deleteAssignment = url.pathname.match(/^\/api\/lesson-plans\/assignments\/(\d+)$/);
  if (deleteAssignment && request.method === "DELETE") {
    ensureSameOrigin(request); requireRole(actor, admin);
    await pool.query("DELETE FROM lesson_plan_subject_assignments WHERE id=$1", [deleteAssignment[1]]);
    sendJson(response, 200, { ok: true }); return true;
  }
  if (url.pathname === "/api/lesson-plans/generate" && request.method === "POST") {
    ensureSameOrigin(request); requireRole(actor, admin);
    const body = await parseJson(request);
    const term = Number(body.termNumber), teacherId = Number(body.teacherId);
    const subjectName = String(body.subjectName || "").trim();
    const weeks = Number(body.weeks), days = Number(body.daysPerWeek);
    const startDate = String(body.startDate || "");
    if (![1,2,3].includes(term)) throw new HttpError(400, "Choose Term 1, 2, or 3.");
    if (!Number.isInteger(teacherId) || teacherId < 1) throw new HttpError(400, "Choose a teacher from the user accounts.");
    if (!subjectName || subjectName.length > 160) throw new HttpError(400, "Type a subject name (up to 160 characters).");
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52 || !Number.isInteger(days) || days < 1 || days > 7) throw new HttpError(400, "Weeks must be 1–52 and days per week must be 1–7.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || Number.isNaN(new Date(`${startDate}T12:00:00Z`).getTime())) throw new HttpError(400, "Choose a valid first lesson-plan date.");
    const teacher = await pool.query("SELECT id FROM users WHERE id=$1 AND role='teacher' AND active=TRUE", [teacherId]);
    if (!teacher.rowCount) throw new HttpError(400, "The selected account is not an active teacher.");
    const conn = await pool.connect(); let count = 0;
    try {
      await conn.query("BEGIN");
      await conn.query(`INSERT INTO lesson_plan_term_settings(term_number,weeks,days_per_week,start_date,updated_by,updated_at)
        VALUES($1,$2,$3,$4,$5,NOW()) ON CONFLICT(term_number) DO UPDATE SET weeks=EXCLUDED.weeks,days_per_week=EXCLUDED.days_per_week,start_date=EXCLUDED.start_date,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
        [term,weeks,days,startDate,actor.id]);
      const subjectResult = await conn.query(`INSERT INTO subjects(name,teacher_id) VALUES($1,$2)
        ON CONFLICT(teacher_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [subjectName,teacherId]);
      const subjectId = subjectResult.rows[0].id;
      await conn.query(`INSERT INTO lesson_plan_subject_assignments(teacher_id,subject_id,assigned_by)
        VALUES($1,$2,$3) ON CONFLICT(teacher_id,subject_id) DO UPDATE SET assigned_by=EXCLUDED.assigned_by`, [teacherId,subjectId,actor.id]);
      for (let w=1; w<=weeks; w++) for (let d=1; d<=days; d++) {
        const cursor = new Date(`${startDate}T12:00:00Z`);
        let remaining = (w-1)*days+(d-1);
        while (remaining > 0) {
          cursor.setUTCDate(cursor.getUTCDate()+1);
          const weekday = cursor.getUTCDay();
          if (days >= 7 || (days === 6 ? weekday !== 0 : weekday !== 0 && weekday !== 6)) remaining--;
        }
        const dueDate = cursor.toISOString().slice(0,10);
        await conn.query(`INSERT INTO lesson_plan_generated_tasks(term_number,week_number,day_number,teacher_id,subject_id,due_date)
          VALUES($1,$2,$3,$4,$5,$6::date) ON CONFLICT(term_number,week_number,day_number,teacher_id,subject_id)
          DO UPDATE SET due_date=EXCLUDED.due_date`, [term,w,d,teacherId,subjectId,dueDate]);
        count++;
      }
      await conn.query("COMMIT");
    } catch(e) { await conn.query("ROLLBACK"); throw e; } finally { conn.release(); }
    sendJson(response, 200, {ok:true, termNumber:term, teacherId, subjectName, generatedOrUpdated:count}); return true;
  }
  if (url.pathname === "/api/lesson-plans/tasks" && request.method === "GET") {
    const term = Number(url.searchParams.get("term") || 1);
    if (![1,2,3].includes(term)) throw new HttpError(400, "Invalid term.");
    const result = await pool.query(`SELECT t.id,t.term_number,t.week_number,t.day_number,t.due_date,t.teacher_id,t.subject_id,
      u.display_name AS teacher_name,s.name AS subject_name,x.id AS upload_id,x.file_name,x.file_size,
      CASE WHEN x.id IS NOT NULL THEN x.status WHEN t.due_date < CURRENT_DATE THEN 'Overdue' ELSE 'Awaiting Upload' END AS status,
      x.admin_feedback,x.submitted_at,
      (SELECT COUNT(*)::int FROM lesson_plan_upload_versions v WHERE v.task_id=t.id) AS revision_count
      FROM lesson_plan_generated_tasks t JOIN users u ON u.id=t.teacher_id JOIN subjects s ON s.id=t.subject_id
      LEFT JOIN lesson_plan_uploads x ON x.task_id=t.id
      WHERE t.term_number=$1 AND ($2 OR t.teacher_id=$3)
      ORDER BY s.name,t.week_number,t.day_number,u.display_name`, [term,admin.includes(actor.role),actor.id]);
    sendJson(response, 200, { tasks: result.rows }); return true;
  }
  const uploadMatch = url.pathname.match(/^\/api\/lesson-plans\/tasks\/(\d+)\/upload$/);
  if (uploadMatch && request.method === "POST") {
    ensureSameOrigin(request); requireRole(actor, ["teacher"]);
    const body = await parseJson(request);
    if (!body.file || typeof body.file.name !== "string" || typeof body.file.data !== "string") throw new HttpError(400, "Choose a PDF lesson-plan file.");
    const fileName = path.basename(body.file.name).slice(0,255);
    const declaredType = String(body.file.type || "").toLowerCase();
    if (!fileName.toLowerCase().endsWith(".pdf") || (declaredType && declaredType !== "application/pdf")) throw new HttpError(400, "Only PDF lesson-plan files are accepted.");
    const data = Buffer.from(body.file.data, "base64");
    if (!data.length || data.length > 8*1024*1024) throw new HttpError(413, "PDF files must be no larger than 8 MB.");
    if (data.subarray(0,5).toString("ascii") !== "%PDF-") throw new HttpError(400, "The uploaded file does not appear to be a valid PDF.");
    const task = await pool.query("SELECT id,due_date,(due_date < CURRENT_DATE) AS is_late FROM lesson_plan_generated_tasks WHERE id=$1 AND teacher_id=$2", [uploadMatch[1],actor.id]);
    if (!task.rowCount) throw new HttpError(404, "Lesson-plan task not found for your account.");
    const status = task.rows[0].is_late ? "Late" : "Submitted";
    const conn = await pool.connect();
    try {
      await conn.query("BEGIN");
      const current = await conn.query("SELECT id,task_id,teacher_id,file_name,mime_type,file_size,file_data,status,admin_feedback,submitted_at FROM lesson_plan_uploads WHERE task_id=$1 FOR UPDATE", [uploadMatch[1]]);
      let version = 1;
      if (current.rowCount) {
        const count = await conn.query("SELECT COALESCE(MAX(version_number),0)::int AS n FROM lesson_plan_upload_versions WHERE task_id=$1", [uploadMatch[1]]);
        version = count.rows[0].n + 1;
        const old = current.rows[0];
        await conn.query(`INSERT INTO lesson_plan_upload_versions(task_id,teacher_id,file_name,mime_type,file_size,file_data,status,admin_feedback,submitted_at,version_number)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [old.task_id,old.teacher_id,old.file_name,old.mime_type,old.file_size,old.file_data,old.status,old.admin_feedback,old.submitted_at,version]);
        await conn.query(`UPDATE lesson_plan_uploads SET file_name=$1,mime_type='application/pdf',file_size=$2,file_data=$3,status=$4,admin_feedback='',submitted_at=NOW(),reviewed_by=NULL,reviewed_at=NULL WHERE task_id=$5`, [fileName,data.length,data,status,uploadMatch[1]]);
      } else {
        await conn.query(`INSERT INTO lesson_plan_uploads(task_id,teacher_id,file_name,mime_type,file_size,file_data,status,admin_feedback,submitted_at,reviewed_by,reviewed_at)
          VALUES($1,$2,$3,'application/pdf',$4,$5,$6,'',NOW(),NULL,NULL)`, [uploadMatch[1],actor.id,fileName,data.length,data,status]);
      }
      await conn.query("COMMIT");
    } catch(e) { await conn.query("ROLLBACK"); throw e; } finally { conn.release(); }
    sendJson(response, 201, {ok:true,status}); return true;
  }
  const historyMatch = url.pathname.match(/^\/api\/lesson-plans\/tasks\/(\d+)\/history$/);
  if (historyMatch && request.method === "GET") {
    const task = await pool.query("SELECT teacher_id FROM lesson_plan_generated_tasks WHERE id=$1", [historyMatch[1]]);
    if (!task.rowCount) throw new HttpError(404, "Lesson-plan task not found.");
    if (!admin.includes(actor.role) && Number(task.rows[0].teacher_id) !== Number(actor.id)) throw new HttpError(403, "You cannot view this revision history.");
    const result = await pool.query(`SELECT id,version_number,file_name,status,admin_feedback,submitted_at FROM lesson_plan_upload_versions WHERE task_id=$1 ORDER BY version_number DESC`, [historyMatch[1]]);
    sendJson(response, 200, {versions:result.rows}); return true;
  }
  const versionFileMatch = url.pathname.match(/^\/api\/lesson-plans\/versions\/(\d+)\/file$/);
  if (versionFileMatch && request.method === "GET") {
    const result = await pool.query("SELECT teacher_id,file_name,mime_type,file_data FROM lesson_plan_upload_versions WHERE id=$1", [versionFileMatch[1]]);
    if (!result.rowCount) throw new HttpError(404, "Revision file not found.");
    if (!admin.includes(actor.role) && Number(result.rows[0].teacher_id) !== Number(actor.id)) throw new HttpError(403, "You cannot access this revision file.");
    const file = result.rows[0];
    response.writeHead(200,{"Content-Type":file.mime_type,"Content-Disposition":`attachment; filename*=UTF-8''${encodeURIComponent(file.file_name)}`,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
    response.end(file.file_data); return true;
  }
  const fileMatch = url.pathname.match(/^\/api\/lesson-plans\/uploads\/(\d+)\/file$/);
  if (fileMatch && request.method === "GET") {
    const result = await pool.query("SELECT teacher_id,file_name,mime_type,file_data FROM lesson_plan_uploads WHERE id=$1",[fileMatch[1]]);
    if (!result.rowCount) throw new HttpError(404,"File not found.");
    if (!admin.includes(actor.role) && Number(result.rows[0].teacher_id)!==Number(actor.id)) throw new HttpError(403,"You cannot access this file.");
    const f=result.rows[0];
    response.writeHead(200,{"Content-Type":f.mime_type,"Content-Disposition":`attachment; filename*=UTF-8''${encodeURIComponent(f.file_name)}`,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
    response.end(f.file_data); return true;
  }
  const reviewMatch = url.pathname.match(/^\/api\/lesson-plans\/uploads\/(\d+)\/review$/);
  if (reviewMatch && request.method === "POST") {
    ensureSameOrigin(request); requireRole(actor,admin);
    const body=await parseJson(request), status=body.status;
    if (!["Approved","For Revision"].includes(status)) throw new HttpError(400,"Choose Approved or For Revision.");
    await pool.query("UPDATE lesson_plan_uploads SET status=$1,admin_feedback=$2,reviewed_by=$3,reviewed_at=NOW() WHERE id=$4",
      [status,String(body.feedback||"").slice(0,2000),actor.id,reviewMatch[1]]);
    sendJson(response,200,{ok:true}); return true;
  }
  return false;
}

async function handleTaskRoutes(request, response, url, actor) {
  if (request.method === "GET" && url.pathname === "/api/tasks") {
    const where = actor.role === "student"
      ? "WHERE (t.is_global=TRUE AND t.assigned_role IS NULL AND t.subject_id IS NULL) OR (t.assigned_to=$1 AND t.assigned_role='student') OR (t.subject_id IN (SELECT subject_id FROM subject_students WHERE student_id=$1) AND t.assigned_role IS NULL)"
      : actor.role === "teacher" ? "WHERE (t.created_by=$1 OR t.assigned_to=$1 AND t.assigned_role='teacher')" : "";
    const values = actor.role === "admin" || actor.role === "developer" ? [] : [actor.id];
    const result = await pool.query(`SELECT t.id,t.title,t.description,t.due_at,t.assigned_to,t.assigned_role,t.subject_id,t.is_global,t.created_at,
      t.creator_name,t.created_by,u.display_name AS assigned_name,s.name AS subject_name,
      COALESCE((SELECT json_agg(json_build_object('id',a.id,'fileName',a.file_name,'mimeType',a.mime_type,'fileSize',a.file_size)) FROM task_attachments a WHERE a.task_id=t.id),'[]') AS attachments
      FROM tasks t LEFT JOIN users u ON u.id=t.assigned_to LEFT JOIN subjects s ON s.id=t.subject_id ${where}
      ORDER BY t.due_at NULLS LAST,t.created_at DESC LIMIT 200`, values);
    sendJson(response, 200, { tasks: result.rows }); return true;
  }
  if (request.method === "POST" && url.pathname === "/api/tasks") {
    ensureSameOrigin(request); requireRole(actor, ["developer", "admin", "teacher"]);
    const body = await parseJson(request);
    const title = requiredText(body.title, "Title", 180);
    const description = requiredText(body.description, "Instructions", 10000);
    const dueAt = body.dueAt ? new Date(body.dueAt) : null;
    if (body.dueAt && Number.isNaN(dueAt.getTime())) throw new HttpError(400, "Enter a valid deadline.");
    const assignedTo = body.assignedTo ? String(body.assignedTo) : null;
    const assignedRole = assignedTo ? (actor.role === "admin" || actor.role === "developer" ? "teacher" : "student") : null;
    if (assignedTo) {
      if (!/^\d+$/.test(assignedTo)) throw new HttpError(400, "Choose a valid assignee.");
      const valid = await pool.query("SELECT id FROM users WHERE id=$1 AND role=$2 AND active=TRUE", [assignedTo, assignedRole]);
      if (!valid.rowCount) throw new HttpError(400, `Choose an active ${assignedRole} account.`);
    }
    let subjectId = body.subjectId ? String(body.subjectId) : null;
    if (subjectId) {
      const subject = actor.role === "teacher"
        ? await pool.query("SELECT id FROM subjects WHERE id=$1 AND teacher_id=$2", [subjectId, actor.id])
        : await pool.query("SELECT id FROM subjects WHERE id=$1", [subjectId]);
      if (!subject.rowCount) throw new HttpError(400, "Choose a valid subject.");
      if (actor.role === "teacher" && assignedTo) {
        const enrolled = await pool.query("SELECT 1 FROM subject_students WHERE subject_id=$1 AND student_id=$2", [subjectId, assignedTo]);
        if (!enrolled.rowCount) throw new HttpError(400, "The selected student is not assigned to this subject.");
      }
    }
    if (actor.role === "teacher" && !assignedTo && !subjectId) throw new HttpError(400, "Choose a student or assign the task to a subject.");
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length > 10) throw new HttpError(400, "A task can include up to 10 files.");
    for (const file of files) {
      if (!file || typeof file.name !== "string" || !file.name.trim() || typeof file.data !== "string") throw new HttpError(400, "One of the uploaded files is invalid.");
      if (Buffer.byteLength(file.data, "base64") > 8 * 1024 * 1024) throw new HttpError(413, "Each attachment must be 8 MB or smaller.");
    }
    const connection = await pool.connect(); let created;
    try {
      await connection.query("BEGIN");
      const result = await connection.query(`INSERT INTO tasks(title,description,due_at,assigned_to,assigned_role,subject_id,is_global,created_by,creator_name)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,title,description,due_at,assigned_to,assigned_role,subject_id,is_global,created_at,creator_name`,
        [title, description, dueAt, assignedTo, assignedRole, subjectId, assignedTo === null && subjectId === null, actor.id, actor.display_name]);
      created = result.rows[0];
      for (const file of files) {
        const data = Buffer.from(file.data, "base64");
        if (data.length > 8 * 1024 * 1024) throw new HttpError(413, "Each attachment must be 8 MB or smaller.");
        await connection.query("INSERT INTO task_attachments(task_id,file_name,mime_type,file_size,file_data,uploaded_by) VALUES($1,$2,$3,$4,$5,$6)",
          [created.id, path.basename(file.name).slice(0,255), String(file.type || "application/octet-stream").slice(0,150), data.length, data, actor.id]);
      }
      await audit(connection, actor.id, "task.created", "task", created.id); await connection.query("COMMIT");
    } catch (error) { await connection.query("ROLLBACK"); throw error; } finally { connection.release(); }
    sendJson(response, 201, { task: created }); return true;
  }
  const download = url.pathname.match(/^\/api\/task-files\/(\d+)$/);
  if (download && request.method === "GET") {
    const result = await pool.query(`SELECT a.file_name,a.mime_type,a.file_data,t.assigned_to,t.assigned_role,t.is_global,t.created_by,t.subject_id
      FROM task_attachments a JOIN tasks t ON t.id=a.task_id WHERE a.id=$1`, [download[1]]);
    if (!result.rowCount) throw new HttpError(404, "Attachment not found.");
    const file = result.rows[0];
    let allowed = actor.role === "admin" || actor.role === "developer" || String(file.created_by) === String(actor.id);
    if (actor.role === "teacher" && String(file.assigned_to) === String(actor.id) && file.assigned_role === "teacher") allowed = true;
    if (actor.role === "student" && ((file.assigned_to && String(file.assigned_to) === String(actor.id) && file.assigned_role === "student") || file.is_global || (file.subject_id && (await pool.query("SELECT 1 FROM subject_students WHERE subject_id=$1 AND student_id=$2", [file.subject_id, actor.id])).rowCount))) allowed = true;
    if (!allowed) throw new HttpError(403, "You do not have access to this attachment.");
    response.writeHead(200, { "Content-Type": file.mime_type, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.file_name)}`, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
    response.end(file.file_data); return true;
  }
  const match = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
  if (!match) return false;
  requireRole(actor, ["developer", "admin", "teacher"]);
  const existing = await pool.query("SELECT id,created_by FROM tasks WHERE id=$1", [match[1]]);
  if (!existing.rowCount) throw new HttpError(404, "Task not found.");
  if (!canManageContent(actor.role, existing.rows[0].created_by, actor.id)) throw new HttpError(403, "Teachers can only modify their own tasks.");
  if (request.method === "DELETE") {
    ensureSameOrigin(request);
    await inTransaction(async (connection) => { await connection.query("DELETE FROM tasks WHERE id=$1", [match[1]]); await audit(connection, actor.id, "task.deleted", "task", match[1]); });
    sendJson(response, 200, { ok: true }); return true;
  }
  return false;
}

async function handleApi(request, response, url) {
  try {
    if (await authenticate(request, response, url)) return;
    const actor = await getSessionUser(request);
    if (!actor) throw new HttpError(401, "Please sign in to continue.");

    const handlers = [
      handleAccountRoutes,
      handleUserRoutes,
      handleMessageRoutes,
      handleAnnouncementRoutes,
      handleSubjectRoutes,
      handleLessonPlanRoutes,
      handleTaskRoutes,
    ];
    for (const handler of handlers) {
      if (await handler(request, response, url, actor)) return;
    }
    throw new HttpError(404, "API route not found.");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error.code === "23505" ? 409 : 500;
    if (status >= 500) console.error("API request failed:", request.method, url.pathname, error.message);
    sendJson(response, status, {
      error: status === 500 ? "The server could not complete the request."
        : status === 409 ? "That username is already in use."
          : error.message,
    });
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url, appOrigin);
  if (request.method === "GET" && url.pathname === "/health") {
    try {
      await pool.query("SELECT 1");
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(JSON.stringify({ status: "ok" }));
    } catch (error) {
      console.error("Health check failed:", error.message);
      response.writeHead(503, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify({ status: "unavailable" }));
    }
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    await handleApi(request, response, url);
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const file = staticFiles.get(url.pathname);
  if (!file) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }
  try {
    const content = await readFile(path.join(root, file[0]));
    response.writeHead(200, {
      "Content-Type": file[1],
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'",
    });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch (error) {
    console.error("Static file read failed:", file[0], error.message);
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Unable to load the portal.");
  }
}

async function start() {
  await pool.query("SELECT 1");
  const schema = await readFile(path.join(root, "schema.sql"), "utf8");
  await pool.query(schema);
  await bootstrapDevelopers();
  const developerCount = await pool.query(
    "SELECT COUNT(*)::int AS count FROM users WHERE role = 'developer' AND active = TRUE",
  );
  if (developerCount.rows[0].count < 1) {
    throw new Error("No active developer account exists. Configure BOOTSTRAP_DEVELOPERS in the ignored local .env file.");
  }
  await pool.query("DELETE FROM sessions WHERE expires_at <= NOW()");

  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      console.error("Request handler failed:", error.message);
      if (!response.headersSent) sendJson(response, 500, { error: "The server could not complete the request." });
      else response.destroy();
    });
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`Nag-iba School Portal listening on port ${port}.`);
  });
  const shutdown = () => {
    server.close(() => {
      pool.end().then(() => process.exit(0)).catch((error) => {
        console.error("Database shutdown failed:", error.message);
        process.exit(1);
      });
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch(async (error) => {
  console.error("Portal startup failed:", error.message);
  await pool.end();
  process.exitCode = 1;
});
