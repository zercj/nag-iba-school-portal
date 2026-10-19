// Glue between the portal's database rows and Supabase Storage.
//
// A row now stores only a storage KEY (e.g. "lesson-plans/<uuid>.pdf"). The legacy BYTEA column is
// kept (nullable) so old rows keep working until migrateLegacyFiles() has moved them, and so local
// development without Supabase still works.
import { createHash } from "node:crypto";
import { storage as defaultStorage, newKey, extensionForMime, STORAGE_KINDS } from "./storage.js";

// Every (table, key column, legacy data column) that can hold an uploaded file.
export const FILE_COLUMNS = [
  { table: "lesson_plan_uploads", key: "file_key", data: "file_data", mime: "mime_type", kind: "lesson-plans", hash: true },
  { table: "lesson_plan_uploads", key: "admin_revision_file_key", data: "admin_revision_file_data", mime: "admin_revision_file_mime", kind: "lesson-plan-revisions" },
  { table: "lesson_plan_upload_versions", key: "file_key", data: "file_data", mime: "mime_type", kind: "lesson-plans", hash: true },
  { table: "lesson_plan_upload_versions", key: "admin_revision_file_key", data: "admin_revision_file_data", mime: "admin_revision_file_mime", kind: "lesson-plan-revisions" },
  { table: "memos", key: "file_key", data: "file_data", mime: null, kind: "memos" },
  { table: "announcement_images", key: "file_key", data: "file_data", mime: "mime_type", kind: "announcements" },
  { table: "ancillary_attachments", key: "file_key", data: "file_data", mime: "mime_type", kind: "ancillary-attachments" },
  { table: "ancillary_submissions", key: "file_key", data: "file_data", mime: "mime_type", kind: "ancillary-submissions" },
];

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

export function createFileStore(storage = defaultStorage) {
  const enabled = storage.configured;

  // Stores a file. With Storage configured the bytes go to Supabase and only the key is kept for the
  // database; without it (local development) the bytes stay in the database column.
  async function save(kind, data, mime) {
    if (!enabled) return { key: null, data };
    const key = newKey(kind, extensionForMime(mime));
    await storage.put(key, data, mime || "application/octet-stream");
    return { key, data: null };
  }

  async function load(key, legacyData) {
    if (key) return storage.get(key);
    return legacyData || null;
  }

  // Moves files that still sit in the database into Storage. Each file is downloaded back and
  // compared byte for byte BEFORE the database copy is cleared, so nothing is lost if a step fails.
  async function migrateLegacyFiles({ pool, log = console }) {
    if (!enabled) return { moved: 0, failed: 0 };
    let moved = 0, failed = 0;
    const touched = new Set();
    for (const col of FILE_COLUMNS) {
      const mimeSql = col.mime ? col.mime : "'application/pdf'";
      const failedIds = new Set();
      for (;;) {
        const batch = await pool.query(
          `SELECT id FROM ${col.table} WHERE ${col.key} IS NULL AND ${col.data} IS NOT NULL AND NOT (id = ANY($1::bigint[])) ORDER BY id LIMIT 20`,
          [[...failedIds]],
        );
        const ids = batch.rows.map((row) => String(row.id)).filter((id) => !failedIds.has(id));
        if (!ids.length) break;
        for (const id of ids) {
          let uploadedKey = null;
          try {
            const found = await pool.query(`SELECT ${col.data} AS data, ${mimeSql} AS mime FROM ${col.table} WHERE id = $1`, [id]);
            const row = found.rows[0];
            if (!row || !row.data || !row.data.length) { failedIds.add(id); continue; }
            const mime = row.mime || "application/octet-stream";
            uploadedKey = newKey(col.kind, extensionForMime(mime));
            await storage.put(uploadedKey, row.data, mime);
            const echoed = await storage.get(uploadedKey);
            if (sha256(echoed) !== sha256(row.data)) throw new Error("uploaded copy does not match the original");
            const hashSql = col.hash ? `, file_hash = COALESCE(file_hash, encode(sha256(file_data), 'hex'))` : "";
            const updated = await pool.query(
              `UPDATE ${col.table} SET ${col.key} = $1${hashSql}, ${col.data} = NULL WHERE id = $2 AND ${col.key} IS NULL AND ${col.data} IS NOT NULL`,
              [uploadedKey, id],
            );
            if (!updated.rowCount) { await storage.remove([uploadedKey]); } // someone else moved it first
            else { moved += 1; touched.add(col.table); }
          } catch (error) {
            failed += 1; failedIds.add(id);
            log.error(`File migration failed for ${col.table}#${id}: ${error.message}`);
            if (uploadedKey) await storage.remove([uploadedKey]).catch(() => {});
          }
        }
      }
    }
    if (moved) {
      log.log(`Moved ${moved} file(s) from the database to Supabase Storage${failed ? ` (${failed} failed and will be retried on the next start)` : ""}.`);
      // Clearing the bytes does not shrink the database file by itself; VACUUM FULL gives the space back.
      for (const table of touched) {
        try { await pool.query(`VACUUM FULL ${table}`); }
        catch (error) { log.error(`VACUUM FULL ${table} was skipped: ${error.message}. Run it in the Supabase SQL editor to reclaim space.`); }
      }
    }
    return { moved, failed };
  }

  // Deletes stored files that no database row points to any more (deleted lesson plans, expired
  // announcement photos, removed memos, cascaded deletes). Files younger than minAgeMs are never
  // touched, because an upload is stored a moment before its database row is committed.
  async function sweepOrphans({ pool, log = console, minAgeMs = 3 * 60 * 60 * 1000, maxDelete = 500 }) {
    if (!enabled) return { deleted: 0 };
    const listed = [];
    for (const kind of STORAGE_KINDS) listed.push(...await storage.list(kind));
    const parts = FILE_COLUMNS.map((col) => `SELECT ${col.key} AS k FROM ${col.table} WHERE ${col.key} IS NOT NULL`);
    const refs = await pool.query(parts.join(" UNION "));
    const referenced = new Set(refs.rows.map((row) => row.k));
    const cutoff = Date.now() - minAgeMs;
    const orphans = listed.filter((item) => !referenced.has(item.key) && item.createdAt < cutoff);
    if (!orphans.length) return { deleted: 0 };
    if (!referenced.size) {
      // A database that references nothing while Storage holds files is far more likely a wrong
      // connection than a real cleanup, so refuse rather than delete everything.
      log.error("Storage cleanup skipped: no database row references any stored file.");
      return { deleted: 0, skipped: true };
    }
    const batch = orphans.slice(0, maxDelete).map((item) => item.key);
    await storage.remove(batch);
    log.log(`Storage cleanup removed ${batch.length} unreferenced file(s).`);
    return { deleted: batch.length };
  }

  return { enabled, save, load, migrateLegacyFiles, sweepOrphans, init: () => storage.init() };
}

export const fileStore = createFileStore();
