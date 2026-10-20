import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { canManageContent, canManageRole, rolesVisibleTo } from "./permissions.js";
import { analyzePdf, contentFlags } from "./pdf-check.js";
import { fileStore } from "./file-store.js";

const { Pool } = pg;
const scrypt = promisify(scryptCallback);
const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8000);
const appOrigin = process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL;
const isProduction = process.env.NODE_ENV === "production";
const sessionDurationMs = 8 * 60 * 60 * 1000;
const schoolTimeZone = process.env.SCHOOL_TZ || "Asia/Manila";
// Lesson plans: every day is due at 5:00 PM Manila time. Anything handed in after that moment is Late;
// a day with no upload after that moment is Overdue. Calendar dates and times are always judged in Manila time.
const LP_TZ = "Asia/Manila";
const LP_NOW_MANILA_SQL = `(NOW() AT TIME ZONE '${LP_TZ}')`;
const lpDeadlineSql = (alias) => `(${alias}.due_date + TIME '17:00')`;
const lpPassedLateSql = (tsExpr, alias) => `((${tsExpr}) AT TIME ZONE '${LP_TZ}' > ${lpDeadlineSql(alias)})`;
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/features.js", ["features.js", "text/javascript; charset=utf-8"]],
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

function validatePhone(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^[0-9+()\-.\s]{7,20}$/.test(value.trim())) {
    throw new HttpError(400, "Enter a valid phone number (digits, spaces, + - ( ) only), or leave it blank.");
  }
  return value.trim();
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
      if (raw.length > 16_000_000) {
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
    phone: row.phone ?? null,
    role: row.role,
    active: row.active,
    createdAt: row.created_at,
  };
}

async function getSessionUser(request) {
  const token = cookieValue(request, "school_session");
  if (!token || token.length > 200) return null;
  const result = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.email, u.phone, u.role, u.active
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


// School-local date/time (Philippines by default) so the attendance day rolls over at the same midnight for everyone.
function schoolNow(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: schoolTimeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour), minute = Number(parts.minute);
  const weekday = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: hour * 60 + minute, time: `${parts.hour}:${parts.minute}`, weekday };
}

async function notify(connection, userId, kind, title, body = "") {
  await connection.query("INSERT INTO notifications (user_id, kind, title, body) VALUES ($1, $2, $3, $4)", [userId, kind, title, body]);
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function readImagePayload(file) {
  if (!file || typeof file.name !== "string" || typeof file.data !== "string") throw new HttpError(400, "One of the photos is invalid.");
  const data = Buffer.from(file.data, "base64");
  if (!data.length || data.length > 3 * 1024 * 1024) throw new HttpError(413, "Each photo must be 3 MB or smaller.");
  let mime = null;
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) mime = "image/jpeg";
  else if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) mime = "image/png";
  else if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") mime = "image/webp";
  else if (["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"))) mime = "image/gif";
  if (!mime) throw new HttpError(400, "Photos must be JPEG, PNG, WebP or GIF images.");
  return { name: path.basename(file.name).slice(0, 255) || "photo", mime, data };
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
      "SELECT id, username, display_name, email, phone, role, active, created_at FROM users WHERE role = ANY($1::text[]) ORDER BY role, display_name",
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
  if (request.method === "PATCH" && url.pathname === "/api/account/profile") {
    ensureSameOrigin(request);
    const body = await parseJson(request);
    const current = await pool.query("SELECT id, username, display_name, email, phone, role, active, created_at, password_hash FROM users WHERE id = $1 AND active = TRUE", [actor.id]);
    if (!current.rowCount) throw new HttpError(404, "Account not found.");
    const row = current.rows[0];
    const displayName = body.displayName === undefined ? row.display_name : validateDisplayName(body.displayName);
    const email = body.email === undefined ? row.email : validateEmail(body.email);
    const phone = body.phone === undefined ? row.phone : validatePhone(body.phone);
    const username = body.username === undefined ? row.username : validateUsername(body.username);
    if (normalizeUsername(username) !== normalizeUsername(row.username) || username !== row.username) {
      // Changing the sign-in name needs the current password.
      const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
      if (!currentPassword || !(await passwordMatches(currentPassword, row.password_hash))) {
        throw new HttpError(400, "Enter your current password to change your username.");
      }
    }
    let updated;
    try {
      updated = await inTransaction(async (connection) => {
        const result = await connection.query(
          `UPDATE users SET username = $2, display_name = $3, email = $4, phone = $5, updated_at = NOW()
           WHERE id = $1 RETURNING id, username, display_name, email, phone, role, active, created_at`,
          [actor.id, username, displayName, email, phone],
        );
        await audit(connection, actor.id, "account.profile_updated", "user", actor.id);
        return result.rows[0];
      });
    } catch (error) {
      if (error.code === "23505") throw new HttpError(409, "That username is already in use.");
      throw error;
    }
    sendJson(response, 200, { user: safeUser(updated) });
    return true;
  }
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

async function purgeExpiredAnnouncements() {
  // Photos are removed with their announcement (ON DELETE CASCADE).
  await pool.query("DELETE FROM announcements WHERE expires_at IS NOT NULL AND expires_at <= NOW()");
}

function parseExpiry(value) {
  const when = new Date(String(value || ""));
  if (Number.isNaN(when.getTime())) throw new HttpError(400, "Choose how long the announcement should stay up.");
  const now = Date.now();
  if (when.getTime() < now + 60_000) throw new HttpError(400, "The end of the display period must be in the future.");
  if (when.getTime() > now + 366 * 24 * 60 * 60 * 1000) throw new HttpError(400, "An announcement can be displayed for at most one year.");
  return when;
}

async function handleAnnouncementRoutes(request, response, url, actor) {
  if (request.method === "GET" && url.pathname === "/api/announcements") {
    await purgeExpiredAnnouncements();
    const result = await pool.query(
      `SELECT a.id, a.title, a.body, a.created_at, a.updated_at, a.expires_at,
              a.author_name AS author_name, u.username AS author_username, a.author_id,
              COALESCE((SELECT json_agg(json_build_object('id', i.id, 'fileName', i.file_name) ORDER BY i.position, i.id)
                        FROM announcement_images i WHERE i.announcement_id = a.id), '[]') AS images
       FROM announcements a LEFT JOIN users u ON u.id = a.author_id
       ORDER BY a.created_at DESC LIMIT 200`,
    );
    sendJson(response, 200, { announcements: result.rows });
    return true;
  }

  const imageMatch = url.pathname.match(/^\/api\/announcements\/images\/(\d+)$/);
  if (request.method === "GET" && imageMatch) {
    const result = await pool.query(
      `SELECT i.mime_type, i.file_key, i.file_data FROM announcement_images i JOIN announcements a ON a.id = i.announcement_id
       WHERE i.id = $1 AND (a.expires_at IS NULL OR a.expires_at > NOW())`,
      [imageMatch[1]],
    );
    if (!result.rowCount) throw new HttpError(404, "Photo not found.");
    const photo = await readStoredFile(result.rows[0].file_key, result.rows[0].file_data);
    response.writeHead(200, {
      "Content-Type": result.rows[0].mime_type,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(photo);
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/announcements") {
    ensureSameOrigin(request);
    requireRole(actor, ["developer", "admin", "teacher"]);
    const body = await parseJson(request);
    const title = requiredText(body.title, "Title", 180);
    const content = requiredText(body.body, "Announcement", 10000);
    const expiresAt = parseExpiry(body.expiresAt);
    const files = Array.isArray(body.images) ? body.images : [];
    if (files.length > 4) throw new HttpError(400, "Attach up to 4 photos.");
    const images = files.map(readImagePayload);
    const storedImages = [];
    for (const image of images) storedImages.push(await writeStoredFile("announcements", image.data, image.mime));
    const created = await inTransaction(async (connection) => {
      const result = await connection.query(
        `INSERT INTO announcements (title, body, author_id, author_name, expires_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, title, body, created_at, expires_at, author_name`,
        [title, content, actor.id, actor.display_name, expiresAt],
      );
      for (const [index, image] of images.entries()) {
        await connection.query(
          `INSERT INTO announcement_images (announcement_id, position, file_name, mime_type, file_size, file_data, file_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [result.rows[0].id, index, image.name, image.mime, image.data.length, storedImages[index].data, storedImages[index].key],
        );
      }
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
    const current = await pool.query("SELECT title, body, expires_at FROM announcements WHERE id = $1", [match[1]]);
    const title = body.title === undefined ? current.rows[0].title : requiredText(body.title, "Title", 180);
    const content = body.body === undefined ? current.rows[0].body : requiredText(body.body, "Announcement", 10000);
    const expiresAt = body.expiresAt === undefined ? current.rows[0].expires_at : parseExpiry(body.expiresAt);
    const updated = await inTransaction(async (connection) => {
      const result = await connection.query(
        "UPDATE announcements SET title = $2, body = $3, expires_at = $4, updated_at = NOW() WHERE id = $1 RETURNING id, title, body, expires_at, updated_at",
        [match[1], title, content, expiresAt],
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

function parseWeekdays(value) {
  const weekdays = [...new Set((Array.isArray(value) ? value : []).map(Number))].sort((x, y) => x - y);
  if (!weekdays.length || weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 5)) {
    throw new HttpError(400, "Choose at least one instruction day from Monday to Friday.");
  }
  return weekdays;
}

// Re-plans the instruction days of one subject for one term. Days that already
// hold a submission are never removed. Runs inside the caller's transaction.
async function applyWeekdays(conn, assignmentId, term, weekdays) {
  const a = await conn.query("SELECT teacher_id,subject_id FROM lesson_plan_subject_assignments WHERE id=$1 FOR UPDATE", [assignmentId]);
  if (!a.rowCount) throw new HttpError(404, "Teacher–subject assignment not found.");
  const { teacher_id: teacherId, subject_id: subjectId } = a.rows[0];
  const existing = await conn.query(`SELECT id,week_number,to_char(due_date,'YYYY-MM-DD') AS due FROM lesson_plan_generated_tasks
    WHERE term_number=$1 AND teacher_id=$2 AND subject_id=$3 ORDER BY week_number,due_date`, [term,teacherId,subjectId]);
  if (!existing.rowCount) throw new HttpError(400, "This subject has no schedule for the selected term yet. Create it in the Schedule tab first.");
  const weeks = Math.max(...existing.rows.map((r) => r.week_number));
  const ref = existing.rows[0];
  const refDate = new Date(`${ref.due}T12:00:00Z`);
  const monday = new Date(refDate);
  monday.setUTCDate(monday.getUTCDate() - ((refDate.getUTCDay() + 6) % 7) - (ref.week_number - 1) * 7);
  const settings = await conn.query("SELECT to_char(start_date,'YYYY-MM-DD') AS s FROM lesson_plan_term_settings WHERE term_number=$1", [term]);
  const first = settings.rowCount && settings.rows[0].s ? new Date(`${settings.rows[0].s}T12:00:00Z`) : null;
  const wanted = new Map();
  for (let w = 1; w <= weeks; w++) for (const wd of weekdays) {
    const date = new Date(monday); date.setUTCDate(date.getUTCDate() + (w - 1) * 7 + (wd - 1));
    if (first && date < first) continue;
    wanted.set(date.toISOString().slice(0, 10), w);
  }
  const have = new Set(existing.rows.map((r) => r.due));
  await conn.query(`DELETE FROM lesson_plan_generated_tasks t WHERE t.term_number=$1 AND t.teacher_id=$2 AND t.subject_id=$3
    AND NOT (to_char(t.due_date,'YYYY-MM-DD') = ANY($4::text[])) AND NOT EXISTS (SELECT 1 FROM lesson_plan_uploads x WHERE x.task_id=t.id)`, [term,teacherId,subjectId,[...wanted.keys()]]);
  // Park remaining rows on high day numbers so renumbering cannot collide.
  await conn.query(`UPDATE lesson_plan_generated_tasks SET day_number=day_number+1000 WHERE term_number=$1 AND teacher_id=$2 AND subject_id=$3`, [term,teacherId,subjectId]);
  let n = 0;
  for (const [due, w] of wanted) {
    if (have.has(due)) continue;
    await conn.query(`INSERT INTO lesson_plan_generated_tasks(term_number,week_number,day_number,teacher_id,subject_id,due_date)
      VALUES($1,$2,$3,$4,$5,$6::date)`, [term,w,2000 + (n++),teacherId,subjectId,due]);
  }
  await conn.query(`UPDATE lesson_plan_generated_tasks t SET day_number=r.rn FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY week_number ORDER BY due_date) AS rn FROM lesson_plan_generated_tasks
      WHERE term_number=$1 AND teacher_id=$2 AND subject_id=$3) r WHERE t.id=r.id`, [term,teacherId,subjectId]);
}

async function handleLessonPlanRoutes(request, response, url, actor) {
  const admin = ["admin", "developer"];
  if (url.pathname === "/api/lesson-plans/settings" && request.method === "GET") {
    const result = await pool.query("SELECT term_number,weeks,days_per_week,weekdays,start_date FROM lesson_plan_term_settings ORDER BY term_number");
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
    // Removing an assignment also removes its generated tasks for every term.
    // Task-linked uploads and revision history cascade with the tasks, preventing
    // deleted assignments from continuing to appear in progress summaries.
    const conn = await pool.connect();
    try {
      await conn.query("BEGIN");
      const assignment = await conn.query(
        "SELECT teacher_id, subject_id FROM lesson_plan_subject_assignments WHERE id=$1 FOR UPDATE",
        [deleteAssignment[1]]
      );
      if (!assignment.rowCount) throw new HttpError(404, "Teacher–subject assignment not found.");
      const { subject_id: subjectId } = assignment.rows[0];
      // Admin deletion means the subject itself is removed, not merely hidden from
      // the lesson-plan assignment list. Remove all task/assignment references so
      // it also disappears from the teacher's Subjects dashboard and progress views.
      await conn.query("DELETE FROM lesson_plan_generated_tasks WHERE subject_id=$1", [subjectId]);
      await conn.query("DELETE FROM lesson_plan_subject_assignments WHERE subject_id=$1", [subjectId]);
      await conn.query("DELETE FROM subject_students WHERE subject_id=$1", [subjectId]);
      await conn.query("DELETE FROM subjects WHERE id=$1", [subjectId]);
      await conn.query("COMMIT");
    } catch (e) {
      await conn.query("ROLLBACK");
      throw e;
    } finally {
      conn.release();
    }
    sendJson(response, 200, { ok: true }); return true;
  }
  const editAssignment = url.pathname.match(/^\/api\/lesson-plans\/assignments\/(\d+)$/);
  if (editAssignment && request.method === "PUT") {
    ensureSameOrigin(request); requireRole(actor, admin);
    const body = await parseJson(request), assignmentId = Number(editAssignment[1]), teacherId = Number(body.teacherId);
    const subjectName = String(body.subjectName || "").trim();
    if (!Number.isInteger(teacherId) || teacherId < 1 || !subjectName || subjectName.length > 160) throw new HttpError(400, "Choose an active teacher and enter a subject name of 1–160 characters.");
    // The teacher/subject change and the days taught are saved together, so a failure never leaves half an edit.
    const wantsDays = Array.isArray(body.weekdays);
    const term = Number(body.termNumber);
    const weekdays = wantsDays ? parseWeekdays(body.weekdays) : null;
    if (wantsDays && ![1,2,3].includes(term)) throw new HttpError(400, "Choose Term 1, 2, or 3.");
    const conn = await pool.connect();
    try {
      await conn.query("BEGIN");
      const existing = await conn.query(`SELECT a.id,a.teacher_id,a.subject_id,s.name AS subject_name FROM lesson_plan_subject_assignments a JOIN subjects s ON s.id=a.subject_id WHERE a.id=$1 FOR UPDATE OF a`, [assignmentId]);
      if (!existing.rowCount) throw new HttpError(404, "Teacher–subject assignment not found.");
      const targetTeacher = await conn.query("SELECT id FROM users WHERE id=$1 AND role='teacher' AND active=TRUE", [teacherId]);
      if (!targetTeacher.rowCount) throw new HttpError(400, "Choose an active user whose role is Teacher.");
      const current = existing.rows[0];
      const duplicate = await conn.query(`SELECT 1 FROM lesson_plan_subject_assignments a JOIN subjects s ON s.id=a.subject_id WHERE a.id<>$1 AND a.teacher_id=$2 AND LOWER(s.name)=LOWER($3)`, [assignmentId,teacherId,subjectName]);
      if (duplicate.rowCount) throw new HttpError(409, "That teacher already has an assignment with this subject name.");
      await conn.query(`UPDATE subjects SET name=$1,teacher_id=$2 WHERE id=$3`, [subjectName,teacherId,current.subject_id]);
      await conn.query(`UPDATE lesson_plan_subject_assignments SET teacher_id=$1 WHERE id=$2`, [teacherId,assignmentId]);
      await conn.query(`UPDATE lesson_plan_generated_tasks SET teacher_id=$1 WHERE subject_id=$2 AND teacher_id=$3`, [teacherId,current.subject_id,current.teacher_id]);
      await conn.query(`UPDATE lesson_plan_uploads SET teacher_id=$1 WHERE task_id IN (SELECT id FROM lesson_plan_generated_tasks WHERE subject_id=$2)`, [teacherId,current.subject_id]);
      await conn.query(`UPDATE lesson_plan_upload_versions SET teacher_id=$1 WHERE task_id IN (SELECT id FROM lesson_plan_generated_tasks WHERE subject_id=$2)`, [teacherId,current.subject_id]);
      if (wantsDays) await applyWeekdays(conn, assignmentId, term, weekdays);
      await audit(conn, actor.id, "lessonplan.assignment_updated", "assignment", assignmentId);
      await conn.query("COMMIT");
    } catch(e) { await conn.query("ROLLBACK"); throw e; } finally { conn.release(); }
    sendJson(response, 200, { ok: true }); return true;
  }
  const daysAssignment = url.pathname.match(/^\/api\/lesson-plans\/assignments\/(\d+)\/days$/);
  if (daysAssignment && request.method === "PUT") {
    ensureSameOrigin(request); requireRole(actor, admin);
    const body = await parseJson(request), assignmentId = Number(daysAssignment[1]), term = Number(body.termNumber);
    const weekdays = parseWeekdays(body.weekdays);
    if (![1,2,3].includes(term)) throw new HttpError(400, "Choose Term 1, 2, or 3.");
    const conn = await pool.connect();
    try {
      await conn.query("BEGIN");
      await applyWeekdays(conn, assignmentId, term, weekdays);
      await conn.query("COMMIT");
    } catch(e) { await conn.query("ROLLBACK"); throw e; } finally { conn.release(); }
    sendJson(response, 200, { ok: true }); return true;
  }
  if (url.pathname === "/api/lesson-plans/generate" && request.method === "POST") {
    ensureSameOrigin(request); requireRole(actor, admin);
    const body = await parseJson(request);
    const term = Number(body.termNumber), teacherId = Number(body.teacherId);
    const rawSubjects = Array.isArray(body.subjectNames) ? body.subjectNames : [body.subjectName];
    const subjectNames = [...new Map(rawSubjects.map((n) => String(n || "").trim()).filter(Boolean).map((n) => [n.toLowerCase(), n])).values()];
    const weeks = Number(body.weeks);
    const weekdays = [...new Set((Array.isArray(body.weekdays) ? body.weekdays : []).map(Number))].sort((x, y) => x - y);
    const startDate = String(body.startDate || "");
    if (![1,2,3].includes(term)) throw new HttpError(400, "Choose Term 1, 2, or 3.");
    if (!Number.isInteger(teacherId) || teacherId < 1) throw new HttpError(400, "Choose a teacher from the user accounts.");
    if (!subjectNames.length || subjectNames.length > 15 || subjectNames.some((n) => n.length > 160)) throw new HttpError(400, "Enter 1–15 subject names (up to 160 characters each).");
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) throw new HttpError(400, "Weeks of instruction must be 1–52.");
    if (!weekdays.length || weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 5)) throw new HttpError(400, "Choose at least one instruction day from Monday to Friday.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || Number.isNaN(new Date(`${startDate}T12:00:00Z`).getTime())) throw new HttpError(400, "Choose a valid first lesson-plan date.");
    const teacher = await pool.query("SELECT id FROM users WHERE id=$1 AND role='teacher' AND active=TRUE", [teacherId]);
    if (!teacher.rowCount) throw new HttpError(400, "The selected account is not an active teacher.");
    // Week 1 starts on the Monday of the week that contains the first lesson-plan date.
    const first = new Date(`${startDate}T12:00:00Z`);
    const monday = new Date(first); monday.setUTCDate(monday.getUTCDate() - ((first.getUTCDay() + 6) % 7));
    const conn = await pool.connect(); let count = 0;
    try {
      await conn.query("BEGIN");
      await conn.query(`INSERT INTO lesson_plan_term_settings(term_number,weeks,days_per_week,weekdays,start_date,updated_by,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT(term_number) DO UPDATE SET weeks=EXCLUDED.weeks,days_per_week=EXCLUDED.days_per_week,weekdays=EXCLUDED.weekdays,start_date=EXCLUDED.start_date,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
        [term,weeks,weekdays.length,weekdays.join(","),startDate,actor.id]);
      for (const subjectName of subjectNames) {
        const subjectResult = await conn.query(`INSERT INTO subjects(name,teacher_id) VALUES($1,$2)
          ON CONFLICT(teacher_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [subjectName,teacherId]);
        const subjectId = subjectResult.rows[0].id;
        await conn.query(`INSERT INTO lesson_plan_subject_assignments(teacher_id,subject_id,assigned_by)
          VALUES($1,$2,$3) ON CONFLICT(teacher_id,subject_id) DO UPDATE SET assigned_by=EXCLUDED.assigned_by`, [teacherId,subjectId,actor.id]);
        const keep = [];
        for (let w = 1; w <= weeks; w++) weekdays.forEach((wd, i) => {
          const date = new Date(monday); date.setUTCDate(date.getUTCDate() + (w - 1) * 7 + (wd - 1));
          if (date < first) return; // days before the chosen start date are not scheduled
          keep.push({ w, d: i + 1, due: date.toISOString().slice(0, 10) });
        });
        const ids = [];
        for (const k of keep) {
          const r = await conn.query(`INSERT INTO lesson_plan_generated_tasks(term_number,week_number,day_number,teacher_id,subject_id,due_date)
            VALUES($1,$2,$3,$4,$5,$6::date) ON CONFLICT(term_number,week_number,day_number,teacher_id,subject_id)
            DO UPDATE SET due_date=EXCLUDED.due_date RETURNING id`, [term,k.w,k.d,teacherId,subjectId,k.due]);
          ids.push(r.rows[0].id); count++;
        }
        // Re-saving a schedule drops days that are no longer instruction days, but never deletes submitted work.
        await conn.query(`DELETE FROM lesson_plan_generated_tasks t WHERE t.term_number=$1 AND t.teacher_id=$2 AND t.subject_id=$3
          AND NOT (t.id = ANY($4::bigint[])) AND NOT EXISTS (SELECT 1 FROM lesson_plan_uploads x WHERE x.task_id=t.id)`, [term,teacherId,subjectId,ids]);
      }
      await conn.query("COMMIT");
    } catch(e) { await conn.query("ROLLBACK"); throw e; } finally { conn.release(); }
    sendJson(response, 200, {ok:true, termNumber:term, teacherId, subjectNames, generatedOrUpdated:count}); return true;
  }
  if (url.pathname === "/api/lesson-plans/tasks" && request.method === "GET") {
    const term = Number(url.searchParams.get("term") || 1);
    if (![1,2,3].includes(term)) throw new HttpError(400, "Invalid term.");
    const result = await pool.query(`SELECT t.id,t.term_number,t.week_number,t.day_number,to_char(t.due_date,'YYYY-MM-DD') AS due_date,t.teacher_id,t.subject_id,
      u.display_name AS teacher_name,s.name AS subject_name,x.id AS upload_id,x.file_name,x.file_size,
      CASE WHEN x.id IS NOT NULL THEN (CASE WHEN x.status='Submitted' AND ${lpPassedLateSql('x.submitted_at','t')} THEN 'Late' ELSE x.status END)
           WHEN ${LP_NOW_MANILA_SQL} > ${lpDeadlineSql('t')} THEN 'Overdue' ELSE 'Awaiting Upload' END AS status,
      x.admin_feedback,x.admin_revision_file_name,x.submitted_at,
      COALESCE(x.flag_codes,'') AS flag_codes,COALESCE(x.flag_reason,'') AS flag_reason,COALESCE(x.appeal_note,'') AS appeal_note,
      r.original_submitted_at AS retained_submitted_at,
      ${lpPassedLateSql('x.submitted_at','t')} AS submitted_late,
      (SELECT COUNT(*)::int FROM lesson_plan_upload_versions v WHERE v.task_id=t.id) AS revision_count
      FROM lesson_plan_generated_tasks t JOIN users u ON u.id=t.teacher_id JOIN subjects s ON s.id=t.subject_id
      LEFT JOIN lesson_plan_uploads x ON x.task_id=t.id
      LEFT JOIN lesson_plan_retained_dates r ON r.task_id=t.id
      WHERE t.term_number=$1 AND ($2 OR t.teacher_id=$3)
        AND EXISTS (
          SELECT 1 FROM lesson_plan_subject_assignments a
          WHERE a.teacher_id=t.teacher_id AND a.subject_id=t.subject_id
        )
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
    const taskId = uploadMatch[1];
    const task = await pool.query(`SELECT t.id,t.due_date,s.name AS subject_name,
        (${LP_NOW_MANILA_SQL} > ${lpDeadlineSql('t')}) AS is_late_now, ${lpPassedLateSql('r.original_submitted_at','t')} AS is_late_retained, r.original_submitted_at
      FROM lesson_plan_generated_tasks t JOIN subjects s ON s.id=t.subject_id
      LEFT JOIN lesson_plan_retained_dates r ON r.task_id=t.id
      WHERE t.id=$1 AND t.teacher_id=$2`, [taskId,actor.id]);
    if (!task.rowCount) throw new HttpError(404, "Lesson-plan task not found for your account.");
    const taskRow = task.rows[0];
    const resubmit = body.resubmit === true;
    // What may this teacher do with the current submission?
    const assertCanUpload = (currentRow) => {
      if (!currentRow) return;
      const priorStatus = String(currentRow.status || "").toLowerCase();
      if (priorStatus === "for revision") return;
      if (["submitted","late"].includes(priorStatus)) {
        if (resubmit) return;
        throw new HttpError(409, "Your lesson plan is awaiting administrator review. Use Resubmit if you need to replace it.");
      }
      throw new HttpError(409, priorStatus === "approved" || priorStatus === "completed"
        ? "This lesson plan has already been approved. Contact the administrator if another submission is required."
        : "This lesson plan cannot be replaced right now.");
    };
    const before = await pool.query("SELECT status FROM lesson_plan_uploads WHERE task_id=$1", [taskId]);
    assertCanUpload(before.rows[0]);

    // Does this look like a lesson plan, and is it a file that was already handed in?
    const hash = sha256Hex(data);
    const flags = contentFlags(analyzePdf(data));
    const sameFile = await pool.query(
      `SELECT x.teacher_id, s.name AS subject_name, to_char(t.due_date,'Mon DD, YYYY') AS due
       FROM lesson_plan_uploads x JOIN lesson_plan_generated_tasks t ON t.id=x.task_id JOIN subjects s ON s.id=t.subject_id
       WHERE x.file_hash=$1 AND x.task_id<>$2 LIMIT 1`, [hash, taskId]);
    const sameVersion = await pool.query(
      `SELECT 1 FROM lesson_plan_upload_versions v WHERE v.file_hash=$1 AND v.task_id=$2
       UNION ALL SELECT 1 FROM lesson_plan_uploads x WHERE x.file_hash=$1 AND x.task_id=$2 LIMIT 1`, [hash, taskId]);
    if (sameFile.rowCount) {
      const other = sameFile.rows[0];
      flags.push({ code: "duplicate", message: String(other.teacher_id) === String(actor.id)
        ? `This exact file was already submitted for ${other.subject_name} (${other.due}).`
        : "This exact file was already submitted by another teacher." });
    } else if (sameVersion.rowCount) {
      flags.push({ code: "duplicate", message: "This is the same file you already uploaded for this day." });
    }
    const appealed = body.appeal === true;
    if (flags.length && !appealed) {
      // Nothing is saved yet: the teacher is told what looks wrong and may appeal.
      sendJson(response, 200, { ok: false, needsConfirmation: true, flags: flags.map((f) => ({ code: f.code, message: f.message })) });
      return true;
    }
    const flagCodes = flags.map((f) => f.code).join(",");
    const flagReason = flags.map((f) => f.message).join(" ").slice(0, 1000);
    const appealNote = flags.length ? String(body.appealNote || "").trim().slice(0, 500) : "";

    // The PDF goes to Storage first; only its key is written to the database inside the transaction.
    const storedFile = await writeStoredFile("lesson-plans", data, "application/pdf");
    const conn = await pool.connect();
    let status;
    try {
      await conn.query("BEGIN");
      const current = await conn.query("SELECT id,task_id,teacher_id,file_name,mime_type,file_size,file_data,file_key,file_hash,status,admin_feedback,admin_revision_file_name,admin_revision_file_mime,admin_revision_file_size,admin_revision_file_data,admin_revision_file_key,submitted_at FROM lesson_plan_uploads WHERE task_id=$1 FOR UPDATE", [taskId]);
      assertCanUpload(current.rows[0]);
      // Keeping the original passing date only applies to the first upload after an admin deletion.
      const keepDate = !current.rowCount && taskRow.original_submitted_at;
      const late = keepDate ? !!taskRow.is_late_retained : !!taskRow.is_late_now;
      status = late ? "Late" : "Submitted";
      const submittedAt = keepDate ? taskRow.original_submitted_at : new Date();
      if (current.rowCount) {
        // Replacing a submission (revision or resubmit): archive the old one; the passing date becomes now.
        const count = await conn.query("SELECT COALESCE(MAX(version_number),0)::int AS n FROM lesson_plan_upload_versions WHERE task_id=$1", [taskId]);
        const version = count.rows[0].n + 1;
        const old = current.rows[0];
        await conn.query(`INSERT INTO lesson_plan_upload_versions(task_id,teacher_id,file_name,mime_type,file_size,file_data,file_hash,status,admin_feedback,admin_revision_file_name,admin_revision_file_mime,admin_revision_file_size,admin_revision_file_data,submitted_at,version_number,file_key,admin_revision_file_key)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [old.task_id,old.teacher_id,old.file_name,old.mime_type,old.file_size,old.file_data,old.file_hash,old.status,old.admin_feedback,old.admin_revision_file_name,old.admin_revision_file_mime,old.admin_revision_file_size,old.admin_revision_file_data,old.submitted_at,version,old.file_key,old.admin_revision_file_key]);
        await conn.query(`UPDATE lesson_plan_uploads SET file_name=$1,mime_type='application/pdf',file_size=$2,file_data=$3,file_key=$10,file_hash=$4,status=$5,admin_feedback='',admin_revision_file_name='',admin_revision_file_size=0,admin_revision_file_data=NULL,admin_revision_file_key=NULL,submitted_at=NOW(),reviewed_by=NULL,reviewed_at=NULL,flag_codes=$6,flag_reason=$7,appeal_note=$8 WHERE task_id=$9`,
          [fileName,data.length,storedFile.data,hash,status,flagCodes,flagReason,appealNote,taskId,storedFile.key]);
      } else {
        await conn.query(`INSERT INTO lesson_plan_uploads(task_id,teacher_id,file_name,mime_type,file_size,file_data,file_hash,status,admin_feedback,submitted_at,reviewed_by,reviewed_at,flag_codes,flag_reason,appeal_note,file_key)
          VALUES($1,$2,$3,'application/pdf',$4,$5,$6,$7,'',$8,NULL,NULL,$9,$10,$11,$12)`, [taskId,actor.id,fileName,data.length,storedFile.data,hash,status,submittedAt,flagCodes,flagReason,appealNote,storedFile.key]);
        await conn.query("DELETE FROM lesson_plan_retained_dates WHERE task_id=$1", [taskId]);
      }
      await audit(conn, actor.id, resubmit ? "lessonplan.resubmitted" : "lessonplan.uploaded", "lesson_plan_task", taskId);
      await conn.query("COMMIT");
    } catch(e) { await conn.query("ROLLBACK"); throw e; } finally { conn.release(); }
    sendJson(response, 201, {ok:true,status,flagged:flags.length>0}); return true;
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
    const result = await pool.query("SELECT teacher_id,file_name,mime_type,file_key,file_data FROM lesson_plan_upload_versions WHERE id=$1", [versionFileMatch[1]]);
    if (!result.rowCount) throw new HttpError(404, "Revision file not found.");
    if (!admin.includes(actor.role) && Number(result.rows[0].teacher_id) !== Number(actor.id)) throw new HttpError(403, "You cannot access this revision file.");
    const file = result.rows[0];
    sendStoredFile(response,url,{name:file.file_name,mime:file.mime_type,data:await readStoredFile(file.file_key,file.file_data)}); return true;
  }
  const fileMatch = url.pathname.match(/^\/api\/lesson-plans\/uploads\/(\d+)\/file$/);
  if (fileMatch && request.method === "GET") {
    const result = await pool.query("SELECT teacher_id,file_name,mime_type,file_key,file_data FROM lesson_plan_uploads WHERE id=$1",[fileMatch[1]]);
    if (!result.rowCount) throw new HttpError(404,"File not found.");
    if (!admin.includes(actor.role) && Number(result.rows[0].teacher_id)!==Number(actor.id)) throw new HttpError(403,"You cannot access this file.");
    const f=result.rows[0];
    sendStoredFile(response,url,{name:f.file_name,mime:f.mime_type,data:await readStoredFile(f.file_key,f.file_data)}); return true;
  }
  const revisionFileMatch = url.pathname.match(/^\/api\/lesson-plans\/uploads\/(\d+)\/revision-file$/);
  if (revisionFileMatch && request.method === "GET") {
    const result = await pool.query("SELECT x.teacher_id,x.admin_revision_file_name,x.admin_revision_file_mime,x.admin_revision_file_key,x.admin_revision_file_data FROM lesson_plan_uploads x WHERE x.id=$1", [revisionFileMatch[1]]);
    if (!result.rowCount || !(result.rows[0].admin_revision_file_key || result.rows[0].admin_revision_file_data)) throw new HttpError(404,"Revision PDF not found.");
    if (!admin.includes(actor.role) && Number(result.rows[0].teacher_id)!==Number(actor.id)) throw new HttpError(403,"You cannot access this revision document.");
    const f=result.rows[0];
    sendStoredFile(response,url,{name:f.admin_revision_file_name,mime:f.admin_revision_file_mime,data:await readStoredFile(f.admin_revision_file_key,f.admin_revision_file_data)}); return true;
  }

  const deleteUploadMatch = url.pathname.match(/^\/api\/lesson-plans\/uploads\/(\d+)$/);
  if (deleteUploadMatch && request.method === "DELETE") {
    // Administrators may delete any submission, approved or not. The teacher is notified and,
    // by the admin's choice, either keeps the original passing date or gets a new one on re-upload.
    ensureSameOrigin(request); requireRole(actor, admin);
    const body = await parseJson(request);
    if (typeof body.keepDate !== "boolean") throw new HttpError(400, "Choose whether to keep the original passing date or reset it.");
    const reason = String(body.reason || "").trim().slice(0, 500);
    await inTransaction(async (connection) => {
      const found = await connection.query(
        `SELECT x.id,x.task_id,x.teacher_id,x.submitted_at,s.name AS subject_name,t.term_number,t.week_number,t.day_number,
                to_char(t.due_date,'Mon DD, YYYY') AS due, to_char(x.submitted_at AT TIME ZONE $2,'Mon DD, YYYY') AS passed
         FROM lesson_plan_uploads x JOIN lesson_plan_generated_tasks t ON t.id=x.task_id JOIN subjects s ON s.id=t.subject_id
         WHERE x.id=$1 FOR UPDATE OF x`, [deleteUploadMatch[1], schoolTimeZone]);
      if (!found.rowCount) throw new HttpError(404, "Lesson-plan submission not found.");
      const row = found.rows[0];
      await connection.query("DELETE FROM lesson_plan_upload_versions WHERE task_id=$1", [row.task_id]);
      await connection.query("DELETE FROM lesson_plan_uploads WHERE id=$1", [row.id]);
      if (body.keepDate) {
        await connection.query(
          `INSERT INTO lesson_plan_retained_dates(task_id,original_submitted_at,deleted_by) VALUES($1,$2,$3)
           ON CONFLICT (task_id) DO UPDATE SET original_submitted_at=EXCLUDED.original_submitted_at,deleted_by=EXCLUDED.deleted_by,deleted_at=NOW()`,
          [row.task_id, row.submitted_at, actor.id]);
      } else {
        await connection.query("DELETE FROM lesson_plan_retained_dates WHERE task_id=$1", [row.task_id]);
      }
      const label = `${row.subject_name} · Term ${row.term_number}, Week ${row.week_number}, Day ${row.day_number} (due ${row.due})`;
      const dateLine = body.keepDate
        ? `Your original passing date (${row.passed}) is kept. Please upload the lesson plan again.`
        : "The passing date was reset. Please upload the lesson plan again; the date you upload it becomes the new passing date.";
      await notify(connection, row.teacher_id, "lesson_plan_deleted", "An administrator removed a lesson plan",
        `${label}. ${dateLine}${reason ? ` Reason: ${reason}` : ""}`);
      await audit(connection, actor.id, body.keepDate ? "lessonplan.deleted_keep_date" : "lessonplan.deleted_reset_date", "lesson_plan_upload", row.id);
    });
    sendJson(response, 200, { ok: true }); return true;
  }

  const confirmMatch = url.pathname.match(/^\/api\/lesson-plans\/uploads\/(\d+)\/confirm$/);
  if (confirmMatch && request.method === "POST") {
    ensureSameOrigin(request); requireRole(actor, ["teacher"]);
    const result = await pool.query(`UPDATE lesson_plan_uploads x SET status='Completed'
      FROM lesson_plan_generated_tasks t
      WHERE x.id=$1 AND x.task_id=t.id AND t.teacher_id=$2 AND x.status='Approved'
      RETURNING x.id`, [confirmMatch[1], actor.id]);
    if (!result.rowCount) throw new HttpError(409, "Only an administrator-approved lesson plan can be confirmed.");
    sendJson(response, 200, {ok:true,status:"Completed"}); return true;
  }

  const reviewMatch = url.pathname.match(/^\/api\/lesson-plans\/uploads\/(\d+)\/review$/);
  if (reviewMatch && request.method === "POST") {
    ensureSameOrigin(request); requireRole(actor,admin);
    const body=await parseJson(request), status=body.status;
    if (!["Approved","For Revision"].includes(status)) throw new HttpError(400,"Choose Approved or For Revision.");
    const feedback=String(body.feedback||"").trim().slice(0,2000);
    let revisionFileName="", revisionFileData=null;
    // A written comment is enough. An attached PDF is optional for both Approved and For Revision.
    if (body.revisionFile) {
      if (typeof body.revisionFile.name !== "string" || typeof body.revisionFile.data !== "string") throw new HttpError(400,"The attached document is invalid.");
      revisionFileName=path.basename(body.revisionFile.name).slice(0,255);
      const type=String(body.revisionFile.type||"").toLowerCase();
      if (!revisionFileName.toLowerCase().endsWith(".pdf") || (type && type!=="application/pdf")) throw new HttpError(400,"The attached document must be a PDF file.");
      revisionFileData=Buffer.from(body.revisionFile.data,"base64");
      if (!revisionFileData.length || revisionFileData.length>8*1024*1024) throw new HttpError(413,"The attached PDF must be no larger than 8 MB.");
      if (revisionFileData.subarray(0,5).toString("ascii")!=="%PDF-") throw new HttpError(400,"The attached document does not appear to be a valid PDF.");
    }
    if (status === "For Revision" && !feedback && !revisionFileData) throw new HttpError(400,"Write a comment (or attach a PDF) telling the teacher what to revise.");
    const current=await pool.query("SELECT status FROM lesson_plan_uploads WHERE id=$1",[reviewMatch[1]]);
    if (!current.rowCount) throw new HttpError(404,"Lesson-plan submission not found.");
    if (!["Submitted","Late"].includes(current.rows[0].status)) throw new HttpError(409,"Only submissions awaiting review can be reviewed. A revised submission must be uploaded before it can be approved.");
    const storedRevision = revisionFileData ? await writeStoredFile("lesson-plan-revisions", revisionFileData, "application/pdf") : { key: null, data: null };
    await pool.query("UPDATE lesson_plan_uploads SET status=$1,admin_feedback=$2,admin_revision_file_name=$3,admin_revision_file_mime='application/pdf',admin_revision_file_size=$4,admin_revision_file_data=$5,admin_revision_file_key=$8,reviewed_by=$6,reviewed_at=NOW() WHERE id=$7",
      [status,feedback,revisionFileName,revisionFileData?.length||0,storedRevision.data,actor.id,reviewMatch[1],storedRevision.key]);
    sendJson(response,200,{ok:true}); return true;
  }
  return false;
}

function readFilePayload(file) {
  if (!file || typeof file.name !== "string" || !file.name.trim() || typeof file.data !== "string") throw new HttpError(400, "One of the uploaded files is invalid.");
  const data = Buffer.from(file.data, "base64");
  if (!data.length) throw new HttpError(400, "The uploaded file is empty.");
  if (data.length > 8 * 1024 * 1024) throw new HttpError(413, "Each file must be 8 MB or smaller.");
  return { name: path.basename(file.name).slice(0, 255), mime: String(file.type || "application/octet-stream").slice(0, 150), data };
}

// Files are kept in private Supabase Storage (see file-store.js). These helpers translate storage
// problems into the portal's normal HTTP errors.
async function readStoredFile(key, legacyData) {
  try {
    const data = await fileStore.load(key, legacyData);
    if (!data || !data.length) throw new HttpError(404, "File not found.");
    return data;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.name === "StorageError") {
      console.error("Storage read failed:", error.message);
      if (error.status === 404) throw new HttpError(404, "The stored file could not be found.");
      throw new HttpError(502, "File storage is temporarily unavailable. Please try again.");
    }
    throw error;
  }
}

async function writeStoredFile(kind, data, mime) {
  try {
    return await fileStore.save(kind, data, mime);
  } catch (error) {
    if (error?.name === "StorageError") {
      console.error("Storage write failed:", error.message);
      throw new HttpError(502, "The file could not be saved. Please try again in a moment.");
    }
    throw error;
  }
}

// PDFs open inside the browser (and the portal's built-in viewer); ?download=1 forces a download.
// Anything that is not a real PDF is always sent as a download so it can never run in the portal's origin.
function sendStoredFile(response, url, { name, mime, data }) {
  const isPdf = data.length > 5 && data.subarray(0, 5).toString("ascii") === "%PDF-";
  const inline = isPdf && url.searchParams.get("download") !== "1";
  const headers = {
    "Content-Type": isPdf ? "application/pdf" : (mime || "application/octet-stream"),
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name || "file")}`,
    "Content-Length": data.length,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (inline) {
    headers["X-Frame-Options"] = "SAMEORIGIN";
    headers["Content-Security-Policy"] = "frame-ancestors 'self'";
  }
  response.writeHead(200, headers);
  response.end(data);
}

async function handleAncillaryRoutes(request, response, url, actor) {
  const admin = ["admin", "developer"];
  const isAdmin = admin.includes(actor.role);
  if (!url.pathname.startsWith("/api/ancillary")) return false;
  if (!isAdmin && actor.role !== "teacher") throw new HttpError(403, "Ancillary tasks are available to administrators and teachers.");

  if (url.pathname === "/api/ancillary" && request.method === "GET") {
    const result = await pool.query(`SELECT t.id,t.title,t.description,to_char(t.due_date,'YYYY-MM-DD') AS due_date,t.all_teachers,t.created_at,
      COALESCE((SELECT json_agg(json_build_object('id',a.id,'fileName',a.file_name,'fileSize',a.file_size) ORDER BY a.id) FROM ancillary_attachments a WHERE a.task_id=t.id),'[]') AS attachments,
      COALESCE((SELECT json_agg(json_build_object('teacherId',u.id,'teacherName',u.display_name,'submissionId',x.id,'fileName',x.file_name,'fileSize',x.file_size,
          'status',x.status,'feedback',x.admin_feedback,'submittedAt',x.submitted_at,'late',(x.submitted_at::date > t.due_date)) ORDER BY u.display_name)
        FROM users u LEFT JOIN ancillary_submissions x ON x.task_id=t.id AND x.teacher_id=u.id
        WHERE u.role='teacher' AND u.active=TRUE AND ($1 OR u.id=$2)
          AND (t.all_teachers OR EXISTS (SELECT 1 FROM ancillary_task_teachers a WHERE a.task_id=t.id AND a.teacher_id=u.id))),'[]') AS targets
      FROM ancillary_tasks t ORDER BY t.due_date DESC,t.id DESC LIMIT 300`, [isAdmin, actor.id]);
    const tasks = isAdmin ? result.rows : result.rows.filter((row) => row.targets.length > 0);
    sendJson(response, 200, { tasks }); return true;
  }

  if (url.pathname === "/api/ancillary" && request.method === "POST") {
    ensureSameOrigin(request); requireRole(actor, admin);
    const body = await parseJson(request);
    const title = requiredText(body.title, "Title", 180);
    const description = body.description ? requiredText(body.description, "Description", 10000) : "";
    const dueDate = String(body.dueDate || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(new Date(`${dueDate}T12:00:00Z`).getTime())) throw new HttpError(400, "Choose a valid due date.");
    const allTeachers = body.allTeachers === true;
    const teacherIds = [...new Set((Array.isArray(body.teacherIds) ? body.teacherIds : []).map(String))];
    if (!allTeachers) {
      if (!teacherIds.length || teacherIds.length > 500 || teacherIds.some((id) => !/^\d+$/.test(id))) throw new HttpError(400, "Choose all teachers or select at least one teacher.");
      const valid = await pool.query("SELECT id FROM users WHERE id = ANY($1::bigint[]) AND role='teacher' AND active=TRUE", [teacherIds]);
      if (valid.rowCount !== teacherIds.length) throw new HttpError(400, "Choose active teacher accounts only.");
    }
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length > 10) throw new HttpError(400, "Attach up to 10 files.");
    const parsed = files.map(readFilePayload);
    const storedAttachments = [];
    for (const f of parsed) storedAttachments.push(await writeStoredFile("ancillary-attachments", f.data, f.mime));
    let created;
    await inTransaction(async (connection) => {
      const r = await connection.query("INSERT INTO ancillary_tasks(title,description,due_date,all_teachers,created_by) VALUES($1,$2,$3::date,$4,$5) RETURNING id", [title, description, dueDate, allTeachers, actor.id]);
      created = r.rows[0];
      if (!allTeachers) for (const id of teacherIds) await connection.query("INSERT INTO ancillary_task_teachers(task_id,teacher_id) VALUES($1,$2)", [created.id, id]);
      for (const [index, f] of parsed.entries()) await connection.query("INSERT INTO ancillary_attachments(task_id,file_name,mime_type,file_size,file_data,file_key) VALUES($1,$2,$3,$4,$5,$6)", [created.id, f.name, f.mime, f.data.length, storedAttachments[index].data, storedAttachments[index].key]);
      await audit(connection, actor.id, "ancillary.created", "ancillary_task", created.id);
    });
    sendJson(response, 201, { ok: true, id: created.id }); return true;
  }

  const taskMatch = url.pathname.match(/^\/api\/ancillary\/(\d+)$/);
  if (taskMatch && request.method === "DELETE") {
    ensureSameOrigin(request); requireRole(actor, admin);
    const r = await pool.query("DELETE FROM ancillary_tasks WHERE id=$1 RETURNING id", [taskMatch[1]]);
    if (!r.rowCount) throw new HttpError(404, "Ancillary task not found.");
    await audit(pool, actor.id, "ancillary.deleted", "ancillary_task", taskMatch[1]);
    sendJson(response, 200, { ok: true }); return true;
  }

  const submitMatch = url.pathname.match(/^\/api\/ancillary\/(\d+)\/submit$/);
  if (submitMatch && request.method === "POST") {
    ensureSameOrigin(request); requireRole(actor, ["teacher"]);
    const body = await parseJson(request);
    const file = readFilePayload(body.file);
    const task = await pool.query(`SELECT t.id,(t.due_date < CURRENT_DATE) AS is_late FROM ancillary_tasks t WHERE t.id=$1
      AND (t.all_teachers OR EXISTS (SELECT 1 FROM ancillary_task_teachers a WHERE a.task_id=t.id AND a.teacher_id=$2))`, [submitMatch[1], actor.id]);
    if (!task.rowCount) throw new HttpError(404, "This ancillary task is not assigned to you.");
    const status = task.rows[0].is_late ? "Late" : "Submitted";
    const storedSubmission = await writeStoredFile("ancillary-submissions", file.data, file.mime);
    await inTransaction(async (connection) => {
      const current = await connection.query("SELECT status FROM ancillary_submissions WHERE task_id=$1 AND teacher_id=$2 FOR UPDATE", [submitMatch[1], actor.id]);
      if (current.rowCount) {
        if (current.rows[0].status !== "For Revision") throw new HttpError(409, current.rows[0].status === "Approved" ? "This submission has already been approved." : "Your submission is awaiting review. You can upload a replacement only if a revision is requested.");
        await connection.query(`UPDATE ancillary_submissions SET file_name=$1,mime_type=$2,file_size=$3,file_data=$4,file_key=$8,status=$5,admin_feedback='',submitted_at=NOW(),reviewed_by=NULL,reviewed_at=NULL WHERE task_id=$6 AND teacher_id=$7`,
          [file.name, file.mime, file.data.length, storedSubmission.data, status, submitMatch[1], actor.id, storedSubmission.key]);
      } else {
        await connection.query("INSERT INTO ancillary_submissions(task_id,teacher_id,file_name,mime_type,file_size,file_data,status,file_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [submitMatch[1], actor.id, file.name, file.mime, file.data.length, storedSubmission.data, status, storedSubmission.key]);
      }
    });
    sendJson(response, 201, { ok: true, status }); return true;
  }

  const reviewMatch = url.pathname.match(/^\/api\/ancillary\/submissions\/(\d+)\/review$/);
  if (reviewMatch && request.method === "POST") {
    ensureSameOrigin(request); requireRole(actor, admin);
    const body = await parseJson(request);
    if (!["Approved", "For Revision"].includes(body.status)) throw new HttpError(400, "Choose Approved or For Revision.");
    const feedback = String(body.feedback || "").trim().slice(0, 2000);
    if (body.status === "For Revision" && !feedback) throw new HttpError(400, "Tell the teacher what needs to be revised.");
    const r = await pool.query("UPDATE ancillary_submissions SET status=$1,admin_feedback=$2,reviewed_by=$3,reviewed_at=NOW() WHERE id=$4 AND status IN ('Submitted','Late') RETURNING id", [body.status, feedback, actor.id, reviewMatch[1]]);
    if (!r.rowCount) throw new HttpError(409, "Only submissions awaiting review can be reviewed.");
    sendJson(response, 200, { ok: true }); return true;
  }

  const subFile = url.pathname.match(/^\/api\/ancillary\/submissions\/(\d+)\/file$/);
  if (subFile && request.method === "GET") {
    const r = await pool.query("SELECT teacher_id,file_name,mime_type,file_key,file_data FROM ancillary_submissions WHERE id=$1", [subFile[1]]);
    if (!r.rowCount) throw new HttpError(404, "File not found.");
    if (!isAdmin && String(r.rows[0].teacher_id) !== String(actor.id)) throw new HttpError(403, "You cannot access this file.");
    sendStoredFile(response, url, { name: r.rows[0].file_name, mime: r.rows[0].mime_type, data: await readStoredFile(r.rows[0].file_key, r.rows[0].file_data) }); return true;
  }

  const attFile = url.pathname.match(/^\/api\/ancillary\/attachments\/(\d+)$/);
  if (attFile && request.method === "GET") {
    const r = await pool.query(`SELECT a.file_name,a.mime_type,a.file_key,a.file_data,a.task_id,t.all_teachers FROM ancillary_attachments a JOIN ancillary_tasks t ON t.id=a.task_id WHERE a.id=$1`, [attFile[1]]);
    if (!r.rowCount) throw new HttpError(404, "Attachment not found.");
    if (!isAdmin && !r.rows[0].all_teachers) {
      const ok = await pool.query("SELECT 1 FROM ancillary_task_teachers WHERE task_id=$1 AND teacher_id=$2", [r.rows[0].task_id, actor.id]);
      if (!ok.rowCount) throw new HttpError(403, "You cannot access this attachment.");
    }
    sendStoredFile(response, url, { name: r.rows[0].file_name, mime: r.rows[0].mime_type, data: await readStoredFile(r.rows[0].file_key, r.rows[0].file_data) }); return true;
  }
  return false;
}


const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const LEAVE_TYPES = ["Sick Leave", "Vacation Leave", "Emergency / Personal Leave", "Maternity / Paternity Leave", "Study Leave", "Special Privilege Leave", "Other"];
const isAdminRole = (user) => ["admin", "developer"].includes(user.role);

async function handleMemoRoutes(request, response, url, actor) {
  if (!url.pathname.startsWith("/api/memos")) return false;
  if (url.pathname === "/api/memos" && request.method === "GET") {
    const result = await pool.query(
      "SELECT id, title, description, file_name, file_size, uploader_name, created_at FROM memos ORDER BY created_at DESC LIMIT 500",
    );
    sendJson(response, 200, { memos: result.rows });
    return true;
  }
  if (url.pathname === "/api/memos" && request.method === "POST") {
    ensureSameOrigin(request); requireRole(actor, ["admin", "developer"]);
    const body = await parseJson(request);
    const title = requiredText(body.title, "Title", 180);
    const description = body.description ? requiredText(body.description, "Description", 2000) : "";
    if (!body.file || typeof body.file.name !== "string" || typeof body.file.data !== "string") throw new HttpError(400, "Choose a PDF memo to upload.");
    const fileName = path.basename(body.file.name).slice(0, 255);
    const declaredType = String(body.file.type || "").toLowerCase();
    if (!fileName.toLowerCase().endsWith(".pdf") || (declaredType && declaredType !== "application/pdf")) throw new HttpError(400, "Memos must be PDF files.");
    const data = Buffer.from(body.file.data, "base64");
    if (!data.length || data.length > 8 * 1024 * 1024) throw new HttpError(413, "Memo PDFs must be no larger than 8 MB.");
    if (data.subarray(0, 5).toString("ascii") !== "%PDF-") throw new HttpError(400, "The uploaded file does not appear to be a valid PDF.");
    const storedMemo = await writeStoredFile("memos", data, "application/pdf");
    const created = await inTransaction(async (connection) => {
      const result = await connection.query(
        `INSERT INTO memos (title, description, file_name, file_size, file_data, file_key, uploaded_by, uploader_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [title, description, fileName, data.length, storedMemo.data, storedMemo.key, actor.id, actor.display_name],
      );
      await audit(connection, actor.id, "memo.created", "memo", result.rows[0].id);
      return result.rows[0];
    });
    sendJson(response, 201, { ok: true, id: created.id });
    return true;
  }
  const fileMatch = url.pathname.match(/^\/api\/memos\/(\d+)\/file$/);
  if (fileMatch && request.method === "GET") {
    const result = await pool.query("SELECT file_name, file_key, file_data FROM memos WHERE id = $1", [fileMatch[1]]);
    if (!result.rowCount) throw new HttpError(404, "Memo not found.");
    sendStoredFile(response, url, { name: result.rows[0].file_name, mime: "application/pdf", data: await readStoredFile(result.rows[0].file_key, result.rows[0].file_data) });
    return true;
  }
  const deleteMatch = url.pathname.match(/^\/api\/memos\/(\d+)$/);
  if (deleteMatch && request.method === "DELETE") {
    ensureSameOrigin(request); requireRole(actor, ["admin", "developer"]);
    await inTransaction(async (connection) => {
      const result = await connection.query("DELETE FROM memos WHERE id = $1 RETURNING id", [deleteMatch[1]]);
      if (!result.rowCount) throw new HttpError(404, "Memo not found.");
      await audit(connection, actor.id, "memo.deleted", "memo", deleteMatch[1]);
    });
    sendJson(response, 200, { ok: true });
    return true;
  }
  return false;
}

async function handleNotificationRoutes(request, response, url, actor) {
  if (!url.pathname.startsWith("/api/notifications")) return false;
  if (url.pathname === "/api/notifications" && request.method === "GET") {
    const result = await pool.query(
      `SELECT id, kind, title, body, created_at FROM notifications
       WHERE user_id = $1 AND read_at IS NULL ORDER BY created_at DESC LIMIT 50`, [actor.id]);
    sendJson(response, 200, { notifications: result.rows });
    return true;
  }
  if (url.pathname === "/api/notifications/read-all" && request.method === "POST") {
    ensureSameOrigin(request);
    await pool.query("UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL", [actor.id]);
    sendJson(response, 200, { ok: true });
    return true;
  }
  const match = url.pathname.match(/^\/api\/notifications\/(\d+)\/read$/);
  if (match && request.method === "POST") {
    ensureSameOrigin(request);
    await pool.query("UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2 AND read_at IS NULL", [match[1], actor.id]);
    sendJson(response, 200, { ok: true });
    return true;
  }
  return false;
}

const scheduleColumns = `s.id, s.teacher_id, s.weekday, to_char(s.time_in,'HH24:MI') AS time_in, to_char(s.time_out,'HH24:MI') AS time_out, s.subject, s.section`;
const scheduleOut = (row) => ({
  id: row.id, teacherId: row.teacher_id, teacherName: row.teacher_name, weekday: row.weekday,
  timeIn: row.time_in, timeOut: row.time_out, subject: row.subject, section: row.section,
});

async function handleScheduleRoutes(request, response, url, actor) {
  if (!url.pathname.startsWith("/api/schedule") && !url.pathname.startsWith("/api/sections")) return false;
  const isAdmin = isAdminRole(actor);
  if (!isAdmin && actor.role !== "teacher") throw new HttpError(403, "Schedules are available to teachers and administrators.");

  // Who is the schedule for? Teachers: always themselves. Admins: the chosen teacher.
  const resolveTeacher = async (value) => {
    const teacherId = isAdmin ? Number(value) : Number(actor.id);
    if (!Number.isInteger(teacherId) || teacherId < 1) throw new HttpError(400, "Choose a teacher.");
    const found = await pool.query("SELECT id, display_name FROM users WHERE id = $1 AND role = 'teacher' AND active = TRUE", [teacherId]);
    if (!found.rowCount) throw new HttpError(404, "Teacher not found.");
    return found.rows[0];
  };

  if (url.pathname === "/api/schedule" && request.method === "GET") {
    const wantsOne = url.searchParams.get("teacherId");
    if (!isAdmin && wantsOne && String(wantsOne) !== String(actor.id)) throw new HttpError(403, "You can only view your own schedule here.");
    const teacherFilter = isAdmin ? (wantsOne ? Number(wantsOne) : null) : Number(actor.id);
    const result = await pool.query(
      `SELECT ${scheduleColumns}, u.display_name AS teacher_name FROM teacher_schedule s JOIN users u ON u.id = s.teacher_id
       WHERE u.active = TRUE AND ($1::bigint IS NULL OR s.teacher_id = $1) ORDER BY s.teacher_id, s.weekday, s.time_in`, [teacherFilter]);
    sendJson(response, 200, { entries: result.rows.map(scheduleOut) });
    return true;
  }

  if (url.pathname === "/api/schedule/options" && request.method === "GET") {
    const teacher = await resolveTeacher(url.searchParams.get("teacherId"));
    const [subjects, sections] = await Promise.all([
      pool.query(`SELECT s.id, s.name, EXISTS (SELECT 1 FROM lesson_plan_subject_assignments a WHERE a.subject_id = s.id) AS assigned
                  FROM subjects s WHERE s.teacher_id = $1 ORDER BY s.name`, [teacher.id]),
      pool.query("SELECT id, name FROM school_sections ORDER BY LOWER(name)"),
    ]);
    sendJson(response, 200, { subjects: subjects.rows.map((r) => r.name), mySubjects: subjects.rows, sections: sections.rows, leaveTypes: LEAVE_TYPES });
    return true;
  }

  const readEntry = async (body, ignoreId = null, dayOverride = null) => {
    const teacher = await resolveTeacher(body.teacherId);
    const weekday = Number(dayOverride ?? body.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 5) throw new HttpError(400, "Choose a day from Monday to Friday.");
    const timeIn = String(body.timeIn || ""), timeOut = String(body.timeOut || "");
    if (!TIME_PATTERN.test(timeIn) || !TIME_PATTERN.test(timeOut)) throw new HttpError(400, "Choose both a time in and a time out.");
    if (toMinutes(timeOut) <= toMinutes(timeIn)) throw new HttpError(400, "Time out must be later than time in.");
    const subject = requiredText(body.subject, "Subject", 160);
    const section = requiredText(body.section, "Section", 80);
    const clash = await pool.query(
      `SELECT subject, section, to_char(time_in,'HH24:MI') AS time_in, to_char(time_out,'HH24:MI') AS time_out
       FROM teacher_schedule WHERE teacher_id = $1 AND weekday = $2 AND time_in < $4::time AND time_out > $3::time
         AND ($5::bigint IS NULL OR id <> $5) LIMIT 1`, [teacher.id, weekday, timeIn, timeOut, ignoreId]);
    if (clash.rowCount) {
      const c = clash.rows[0];
      throw new HttpError(409, `That time overlaps with ${c.subject} (${c.section}), ${c.time_in}–${c.time_out}, on the same day.`);
    }
    return { teacher, weekday, timeIn, timeOut, subject, section };
  };

  if (url.pathname === "/api/schedule" && request.method === "POST") {
    ensureSameOrigin(request);
    const body = await parseJson(request);
    // The same subject and time can be saved on several days in one go (e.g. Mon, Wed, Fri).
    const days = [...new Set((Array.isArray(body.weekdays) ? body.weekdays : [body.weekday]).map(Number))];
    if (!days.length || days.length > 5) throw new HttpError(400, "Choose at least one day from Monday to Friday.");
    const entries = [];
    for (const day of days) entries.push(await readEntry(body, null, day));
    const ids = await inTransaction(async (connection) => {
      const created = [];
      for (const entry of entries) {
        const row = await connection.query(
          `INSERT INTO teacher_schedule (teacher_id, weekday, time_in, time_out, subject, section) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [entry.teacher.id, entry.weekday, entry.timeIn, entry.timeOut, entry.subject, entry.section]);
        created.push(row.rows[0].id);
        await audit(connection, actor.id, "schedule.created", "teacher_schedule", row.rows[0].id);
      }
      await connection.query("INSERT INTO school_sections (name) VALUES ($1) ON CONFLICT DO NOTHING", [entries[0].section]);
      return created;
    });
    sendJson(response, 201, { ok: true, ids });
    return true;
  }

  // Teachers can keep their own list of subjects (several at once, comma separated).
  if (url.pathname === "/api/schedule/subjects" && request.method === "POST") {
    ensureSameOrigin(request);
    const body = await parseJson(request);
    const teacher = await resolveTeacher(body.teacherId);
    const names = [...new Map((Array.isArray(body.names) ? body.names : []).map((n) => String(n || "").trim()).filter(Boolean).map((n) => [n.toLowerCase(), n])).values()];
    if (!names.length || names.length > 20 || names.some((n) => n.length > 160)) throw new HttpError(400, "Enter 1–20 subject names (up to 160 characters each).");
    await inTransaction(async (connection) => {
      for (const name of names) await connection.query("INSERT INTO subjects (name, teacher_id) VALUES ($1, $2) ON CONFLICT (teacher_id, name) DO NOTHING", [name, teacher.id]);
      await audit(connection, actor.id, "subjects.added", "user", teacher.id);
    });
    sendJson(response, 201, { ok: true });
    return true;
  }
  const subjectMatch = url.pathname.match(/^\/api\/schedule\/subjects\/(\d+)$/);
  if (subjectMatch && request.method === "DELETE") {
    ensureSameOrigin(request);
    const found = await pool.query("SELECT id, teacher_id FROM subjects WHERE id = $1", [subjectMatch[1]]);
    if (!found.rowCount) throw new HttpError(404, "Subject not found.");
    if (!isAdmin && String(found.rows[0].teacher_id) !== String(actor.id)) throw new HttpError(403, "You can only remove your own subjects.");
    const assigned = await pool.query("SELECT 1 FROM lesson_plan_subject_assignments WHERE subject_id = $1", [subjectMatch[1]]);
    if (assigned.rowCount) throw new HttpError(409, "This subject has lesson-plan schedules, so it cannot be removed here.");
    await pool.query("DELETE FROM subjects WHERE id = $1", [subjectMatch[1]]);
    sendJson(response, 200, { ok: true });
    return true;
  }

  const entryMatch = url.pathname.match(/^\/api\/schedule\/(\d+)$/);
  if (entryMatch) {
    const existing = await pool.query("SELECT id, teacher_id FROM teacher_schedule WHERE id = $1", [entryMatch[1]]);
    if (!existing.rowCount) throw new HttpError(404, "Schedule entry not found.");
    if (!isAdmin && String(existing.rows[0].teacher_id) !== String(actor.id)) throw new HttpError(403, "You can only change your own schedule.");
    if (request.method === "PUT") {
      ensureSameOrigin(request);
      const body = await parseJson(request);
      const entry = await readEntry({ ...body, teacherId: existing.rows[0].teacher_id }, Number(entryMatch[1]));
      await inTransaction(async (connection) => {
        await connection.query(
          `UPDATE teacher_schedule SET weekday = $2, time_in = $3, time_out = $4, subject = $5, section = $6 WHERE id = $1`,
          [entryMatch[1], entry.weekday, entry.timeIn, entry.timeOut, entry.subject, entry.section]);
        await connection.query("INSERT INTO school_sections (name) VALUES ($1) ON CONFLICT DO NOTHING", [entry.section]);
        await audit(connection, actor.id, "schedule.updated", "teacher_schedule", entryMatch[1]);
      });
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (request.method === "DELETE") {
      ensureSameOrigin(request);
      await inTransaction(async (connection) => {
        await connection.query("DELETE FROM teacher_schedule WHERE id = $1", [entryMatch[1]]);
        await audit(connection, actor.id, "schedule.deleted", "teacher_schedule", entryMatch[1]);
      });
      sendJson(response, 200, { ok: true });
      return true;
    }
  }

  const sectionMatch = url.pathname.match(/^\/api\/sections\/(\d+)$/);
  if (sectionMatch && request.method === "DELETE") {
    ensureSameOrigin(request); requireRole(actor, ["admin", "developer"]);
    await pool.query("DELETE FROM school_sections WHERE id = $1", [sectionMatch[1]]);
    sendJson(response, 200, { ok: true });
    return true;
  }
  return false;
}

async function handleAttendanceRoutes(request, response, url, actor) {
  if (!url.pathname.startsWith("/api/attendance")) return false;

  if (url.pathname === "/api/attendance/me" && request.method === "GET") {
    requireRole(actor, ["teacher"]);
    const now = schoolNow();
    const result = await pool.query(
      `SELECT status, leave_type, details, logged_at, auto_recorded FROM attendance_records WHERE teacher_id = $1 AND attendance_date = $2`,
      [actor.id, now.date]);
    const record = result.rows[0] ?? null;
    sendJson(response, 200, {
      date: now.date, time: now.time, leaveTypes: LEAVE_TYPES,
      record: record && { status: record.status, leaveType: record.leave_type, details: record.details, loggedAt: record.logged_at, auto: record.auto_recorded },
      // No record for today (school date) means the pop-up is required; this resets at midnight.
      needsPrompt: !record,
    });
    return true;
  }

  if (url.pathname === "/api/attendance/me" && request.method === "POST") {
    ensureSameOrigin(request); requireRole(actor, ["teacher"]);
    const body = await parseJson(request);
    const status = String(body.status || "");
    if (!["present", "leave", "travel"].includes(status)) throw new HttpError(400, "Choose Present, On Leave or On Travel.");
    let leaveType = "", details = String(body.details || "").trim().slice(0, 300);
    if (status === "leave") {
      leaveType = String(body.leaveType || "");
      if (!LEAVE_TYPES.includes(leaveType)) throw new HttpError(400, "Choose the type of leave.");
      if (leaveType === "Other" && !details) throw new HttpError(400, "Tell us briefly what kind of leave this is.");
    } else if (status === "travel") {
      if (!details) throw new HttpError(400, "Add a short detail about your travel (where and why).");
    } else {
      details = "";
    }
    const now = schoolNow();
    await pool.query(
      `INSERT INTO attendance_records (teacher_id, attendance_date, status, leave_type, details, auto_recorded)
       VALUES ($1, $2, $3, $4, $5, FALSE)
       ON CONFLICT (teacher_id, attendance_date) DO UPDATE SET
         status = EXCLUDED.status, leave_type = EXCLUDED.leave_type, details = EXCLUDED.details, auto_recorded = FALSE,
         logged_at = CASE WHEN attendance_records.status <> EXCLUDED.status THEN NOW() ELSE attendance_records.logged_at END,
         updated_at = NOW()`,
      [actor.id, now.date, status, leaveType, details]);
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (url.pathname === "/api/attendance" && request.method === "GET") {
    requireRole(actor, ["admin", "developer", "teacher"]);
    const now = schoolNow();
    const requested = url.searchParams.get("date") || now.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requested) || Number.isNaN(new Date(`${requested}T12:00:00Z`).getTime())) throw new HttpError(400, "Choose a valid date.");
    const jsDay = new Date(`${requested}T12:00:00Z`).getUTCDay();
    const weekday = jsDay === 0 ? 7 : jsDay;
    const isToday = requested === now.date;
    const teachers = await pool.query(
      `SELECT u.id, u.display_name, u.username, a.status, a.leave_type, a.details, a.logged_at, a.auto_recorded
       FROM users u LEFT JOIN attendance_records a ON a.teacher_id = u.id AND a.attendance_date = $1
       WHERE u.role = 'teacher' AND u.active = TRUE ORDER BY u.display_name`, [requested]);
    const entries = weekday <= 5 ? await pool.query(
      `SELECT ${scheduleColumns} FROM teacher_schedule s WHERE s.weekday = $1 ORDER BY s.time_in`, [weekday]) : { rows: [] };
    const byTeacher = new Map();
    for (const row of entries.rows) {
      const list = byTeacher.get(String(row.teacher_id)) ?? [];
      list.push({ id: row.id, timeIn: row.time_in, timeOut: row.time_out, subject: row.subject, section: row.section });
      byTeacher.set(String(row.teacher_id), list);
    }
    const out = teachers.rows.map((row) => {
      const schedule = byTeacher.get(String(row.id)) ?? [];
      const mine = isAdminRole(actor) || String(row.id) === String(actor.id);
      let current = null;
      if (isToday && row.status === "present") {
        if (weekday > 5) current = { state: "none" };
        else {
          const slot = schedule.find((e) => toMinutes(e.timeIn) <= now.minutes && now.minutes < toMinutes(e.timeOut));
          current = slot ? { state: "class", entry: slot } : { state: "vacant" };
        }
      }
      return {
        id: row.id, name: row.display_name, username: row.username,
        record: row.status ? {
          status: row.status,
          // Other teachers see only the status; leave type and travel details stay with the person and administrators.
          leaveType: mine ? row.leave_type : "", details: mine ? row.details : "",
          loggedAt: row.logged_at, auto: row.auto_recorded,
        } : null,
        schedule, current,
      };
    });
    sendJson(response, 200, { date: requested, today: now.date, time: now.time, weekday, isToday, teachers: out });
    return true;
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
      handleLessonPlanRoutes,
      handleAncillaryRoutes,
      handleMemoRoutes,
      handleNotificationRoutes,
      handleScheduleRoutes,
      handleAttendanceRoutes,
    ];
    for (const handler of handlers) {
      if (await handler(request, response, url, actor)) return;
    }
    throw new HttpError(404, "API route not found.");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error.code === "23505" ? 409 : 500;
    if (status >= 500) console.error("API request failed:", request.method, url.pathname, error.message);
    const uniqueMessage = error.constraint === "users_username_lower_unique"
      ? "That username is already in use." : "That item already exists.";
    sendJson(response, status, {
      error: status === 500 ? "The server could not complete the request."
        : error instanceof HttpError ? error.message
          : status === 409 ? uniqueMessage
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
  if (fileStore.enabled) {
    // Creates the private bucket if it is missing and proves the Supabase key works before serving traffic.
    await fileStore.init();
  } else if (isProduction) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required in production so uploads go to Supabase Storage instead of the database.");
  } else {
    console.warn("Supabase Storage is not configured: uploads stay in the database (development only).");
  }
  const schema = await readFile(path.join(root, "schema.sql"), "utf8");
  // Only one instance may apply the schema at a time; overlapping deploys otherwise deadlock on the ALTER TABLE locks.
  const migrator = await pool.connect();
  try {
    await migrator.query("SELECT pg_advisory_lock(727001)");
    await migrator.query(schema);
  } finally {
    try {
      await migrator.query("SELECT pg_advisory_unlock(727001)");
    } finally {
      migrator.release();
    }
  }
  await bootstrapDevelopers();
  const developerCount = await pool.query(
    "SELECT COUNT(*)::int AS count FROM users WHERE role = 'developer' AND active = TRUE",
  );
  if (developerCount.rows[0].count < 1) {
    throw new Error("No active developer account exists. Configure BOOTSTRAP_DEVELOPERS in the ignored local .env file.");
  }
  await pool.query("DELETE FROM sessions WHERE expires_at <= NOW()");
  await purgeExpiredAnnouncements();
  // Expired announcements (and their photos) are removed on a timer as well as on every read.
  setInterval(() => purgeExpiredAnnouncements().catch((error) => console.error("Announcement cleanup failed:", error.message)), 10 * 60 * 1000).unref();

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
  if (fileStore.enabled) {
    // Move any files still stored in the database into Storage (verified copy first), then remove
    // stored files that no longer belong to any record. Set MIGRATE_LEGACY_FILES=false to skip the move.
    (async () => {
      if (process.env.MIGRATE_LEGACY_FILES !== "false") await fileStore.migrateLegacyFiles({ pool });
      await fileStore.sweepOrphans({ pool });
    })().catch((error) => console.error("Background file maintenance failed:", error.message));
    setInterval(() => fileStore.sweepOrphans({ pool }).catch((error) => console.error("Storage cleanup failed:", error.message)), 6 * 60 * 60 * 1000).unref();
  }
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
