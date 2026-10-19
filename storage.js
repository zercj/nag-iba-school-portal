// Minimal Supabase Storage client built on fetch (Node 22), so no extra npm package is needed.
// Files live in one PRIVATE bucket. Only this server talks to Storage, using the project's secret
// key; the browser never gets a Supabase URL or key. Every download still goes through the portal's
// own login and role checks.
import { randomUUID } from "node:crypto";

export const STORAGE_KINDS = [
  "lesson-plans",
  "lesson-plan-revisions",
  "memos",
  "announcements",
  "ancillary-attachments",
  "ancillary-submissions",
];

export class StorageError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "StorageError";
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const encodeKey = (key) => key.split("/").map(encodeURIComponent).join("/");

export function newKey(kind, extension = "") {
  if (!STORAGE_KINDS.includes(kind)) throw new Error(`Unknown storage kind: ${kind}`);
  const ext = /^\.[a-z0-9]{1,8}$/i.test(extension) ? extension.toLowerCase() : "";
  return `${kind}/${randomUUID()}${ext}`;
}

export function extensionForMime(mime) {
  return { "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" }[String(mime).toLowerCase()] || "";
}

export function createStorage({ url, key, bucket = "portal-files", fetchImpl = globalThis.fetch, timeoutMs = 60_000 } = {}) {
  const base = url ? `${String(url).trim().replace(/\/+$/, "")}/storage/v1` : "";
  const secret = String(key || "").trim();
  const configured = Boolean(base && secret);

  function authHeaders(extra = {}) {
    // New-style keys (sb_secret_...) are not JWTs and must only go in `apikey`.
    // Legacy service_role keys are JWTs (eyJ...) and are sent both ways.
    const headers = { apikey: secret, ...extra };
    if (secret.startsWith("eyJ")) headers.Authorization = `Bearer ${secret}`;
    return headers;
  }

  async function call(method, path, { headers, body } = {}) {
    if (!configured) throw new StorageError(500, "Supabase Storage is not configured (set SUPABASE_URL and SUPABASE_SECRET_KEY).");
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetchImpl(`${base}${path}`, { method, headers: authHeaders(headers), body, signal: AbortSignal.timeout(timeoutMs) });
        if (response.status >= 500 && attempt === 0) { await sleep(400); continue; }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await sleep(400);
      }
    }
    throw new StorageError(502, `Could not reach Supabase Storage: ${lastError?.message || "network error"}`);
  }

  async function failure(response, action) {
    let detail = "";
    try { detail = (await response.text()).slice(0, 300); } catch { /* ignore */ }
    // Storage reports a missing object as HTTP 400 with statusCode 404 in the body.
    const missing = response.status === 404 || /"statusCode"\s*:\s*"?404"?/.test(detail) || /not[_ ]found/i.test(detail);
    return new StorageError(missing ? 404 : response.status, `Storage ${action} failed (${response.status}) ${detail}`.trim());
  }

  async function put(objectKey, data, contentType = "application/octet-stream") {
    const response = await call("POST", `/object/${bucket}/${encodeKey(objectKey)}`, {
      headers: { "Content-Type": contentType, "x-upsert": "false" },
      body: data,
    });
    if (!response.ok) throw await failure(response, "upload");
    return objectKey;
  }

  async function get(objectKey) {
    const response = await call("GET", `/object/${bucket}/${encodeKey(objectKey)}`);
    if (!response.ok) throw await failure(response, "download");
    return Buffer.from(await response.arrayBuffer());
  }

  async function remove(objectKeys) {
    const keys = [...new Set(objectKeys)].filter(Boolean);
    for (let index = 0; index < keys.length; index += 100) {
      const response = await call("DELETE", `/object/${bucket}`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefixes: keys.slice(index, index + 100) }),
      });
      if (!response.ok) throw await failure(response, "delete");
    }
    return keys.length;
  }

  // Lists the objects directly inside one folder ("prefix"), e.g. "lesson-plans".
  async function list(prefix) {
    const found = [];
    const pageSize = 100;
    for (let offset = 0; ; offset += pageSize) {
      const response = await call("POST", `/object/list/${bucket}`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix, limit: pageSize, offset, sortBy: { column: "name", order: "asc" } }),
      });
      if (!response.ok) throw await failure(response, "list");
      const page = await response.json();
      for (const item of page) {
        if (!item || !item.name || item.id === null || item.name.startsWith(".")) continue; // skip folders/placeholders
        const created = Date.parse(item.created_at || item.updated_at || "");
        found.push({ key: `${prefix}/${item.name}`, createdAt: Number.isNaN(created) ? Date.now() : created });
      }
      if (page.length < pageSize) break;
    }
    return found;
  }

  // Creates the private bucket if needed and proves the key works with a tiny round trip.
  async function init() {
    if (!configured) throw new StorageError(500, "Supabase Storage is not configured.");
    const existing = await call("GET", `/bucket/${encodeURIComponent(bucket)}`);
    if (existing.ok) {
      const info = await existing.json();
      if (info.public) throw new StorageError(500, `The "${bucket}" bucket is public. Make it private in Supabase (Storage > ${bucket} > Edit bucket) before using it for school files.`);
    } else {
      await existing.text().catch(() => "");
      const created = await call("POST", "/bucket", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: bucket, name: bucket, public: false, file_size_limit: 10 * 1024 * 1024 }),
      });
      if (!created.ok) {
        const detail = await created.text().catch(() => "");
        if (!(created.status === 409 || /already exists/i.test(detail))) throw new StorageError(created.status, `Could not create the "${bucket}" bucket (${created.status}) ${detail.slice(0, 200)}`);
      }
    }
    const probeKey = `_selftest/${randomUUID()}.txt`;
    const probe = Buffer.from("portal storage self-test");
    await put(probeKey, probe, "text/plain");
    const echoed = await get(probeKey);
    await remove([probeKey]);
    if (!echoed.equals(probe)) throw new StorageError(500, "Storage self-test returned different data than was uploaded.");
  }

  return { configured, bucket, put, get, remove, list, init };
}

export const storage = createStorage({
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
  bucket: process.env.SUPABASE_BUCKET || "portal-files",
});
