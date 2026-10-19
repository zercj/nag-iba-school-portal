import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createFileStore, FILE_COLUMNS } from "./file-store.js";

const quiet = { log() {}, error() {} };

function fakeStorage({ configured = true, corruptGets = false } = {}) {
  const objects = new Map(); // key -> { data, createdAt }
  return {
    configured, objects,
    async put(key, data) { objects.set(key, { data: Buffer.from(data), createdAt: Date.now() }); },
    async get(key) { const o = objects.get(key); if (!o) throw Object.assign(new Error("missing"), { name: "StorageError", status: 404 }); return corruptGets ? Buffer.from("garbage") : o.data; },
    async remove(keys) { for (const k of keys) objects.delete(k); },
    async list(prefix) { return [...objects].filter(([k]) => k.startsWith(`${prefix}/`)).map(([key, o]) => ({ key, createdAt: o.createdAt })); },
    async init() {},
  };
}

// A tiny in-memory stand-in for the few SQL statements the file store runs.
function fakePool(tables) {
  const log = [];
  return {
    log,
    async query(sql, params = []) {
      log.push(sql);
      let m;
      if ((m = sql.match(/^SELECT id FROM (\w+) WHERE (\w+) IS NULL AND (\w+) IS NOT NULL AND NOT/))) {
        const [, table, key, data] = m;
        const skip = new Set((params[0] || []).map(String));
        const rows = tables[table].filter((r) => r[key] == null && r[data] != null && !skip.has(String(r.id))).slice(0, 20);
        return { rows: rows.map((r) => ({ id: r.id })), rowCount: rows.length };
      }
      if ((m = sql.match(/^SELECT (\w+) AS data, (.+) AS mime FROM (\w+) WHERE id = \$1/))) {
        const row = tables[m[3]].find((r) => String(r.id) === String(params[0]));
        const mimeCol = m[2].startsWith("'") ? null : m[2];
        return { rows: row ? [{ data: row[m[1]], mime: mimeCol ? row[mimeCol] : "application/pdf" }] : [], rowCount: row ? 1 : 0 };
      }
      if ((m = sql.match(/^UPDATE (\w+) SET (\w+) = \$1.*?, (\w+) = NULL WHERE id = \$2 AND (\w+) IS NULL AND (\w+) IS NOT NULL/))) {
        const [, table, key, data] = m;
        const row = tables[table].find((r) => String(r.id) === String(params[1]));
        if (!row || row[key] != null || row[data] == null) return { rowCount: 0, rows: [] };
        row[key] = params[0]; row[data] = null;
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("VACUUM FULL")) return { rowCount: 0, rows: [] };
      if (sql.includes(" UNION ")) {
        const keys = [];
        for (const col of FILE_COLUMNS) for (const r of tables[col.table] || []) if (r[col.key] != null) keys.push({ k: r[col.key] });
        return { rows: keys, rowCount: keys.length };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

const emptyTables = () => Object.fromEntries([...new Set(FILE_COLUMNS.map((c) => c.table))].map((t) => [t, []]));
const sha = (b) => createHash("sha256").update(b).digest("hex");

test("save keeps only a key when Storage is on, and the bytes when it is off", async () => {
  const on = createFileStore(fakeStorage());
  const saved = await on.save("memos", Buffer.from("%PDF-x"), "application/pdf");
  assert.match(saved.key, /^memos\/.+\.pdf$/);
  assert.equal(saved.data, null);
  assert.equal((await on.load(saved.key, null)).toString(), "%PDF-x");

  const off = createFileStore(fakeStorage({ configured: false }));
  const legacy = await off.save("memos", Buffer.from("%PDF-y"), "application/pdf");
  assert.equal(legacy.key, null);
  assert.equal(legacy.data.toString(), "%PDF-y");
  assert.equal((await off.load(null, legacy.data)).toString(), "%PDF-y");
});

test("rows not yet migrated still load from the database column", async () => {
  const store = createFileStore(fakeStorage());
  assert.equal((await store.load(null, Buffer.from("old"))).toString(), "old");
  assert.equal(await store.load(null, null), null);
});

test("migration moves every legacy file, verifies it, and clears the database copy", async () => {
  const storage = fakeStorage();
  const tables = emptyTables();
  tables.lesson_plan_uploads.push({ id: 1, file_key: null, file_data: Buffer.from("%PDF-A"), mime_type: "application/pdf", admin_revision_file_key: null, admin_revision_file_data: Buffer.from("%PDF-R"), admin_revision_file_mime: "application/pdf" });
  tables.memos.push({ id: 7, file_key: null, file_data: Buffer.from("%PDF-M") });
  tables.announcement_images.push({ id: 3, file_key: null, file_data: Buffer.from([0xff, 0xd8, 0xff, 0x00]), mime_type: "image/jpeg" });
  tables.memos.push({ id: 8, file_key: "memos/already.pdf", file_data: null });
  const pool = fakePool(tables);
  const result = await createFileStore(storage).migrateLegacyFiles({ pool, log: quiet });
  assert.deepEqual(result, { moved: 4, failed: 0 });
  assert.equal(tables.lesson_plan_uploads[0].file_data, null);
  assert.equal(tables.lesson_plan_uploads[0].admin_revision_file_data, null);
  assert.equal(tables.memos[0].file_data, null);
  assert.match(tables.announcement_images[0].file_key, /^announcements\/.+\.jpg$/);
  const stored = storage.objects.get(tables.memos[0].file_key).data;
  assert.equal(sha(stored), sha(Buffer.from("%PDF-M")));
  assert.equal(tables.memos[1].file_key, "memos/already.pdf");
  assert.ok(pool.log.some((s) => s.startsWith("VACUUM FULL memos")));
  // A second run has nothing left to do.
  assert.deepEqual(await createFileStore(storage).migrateLegacyFiles({ pool, log: quiet }), { moved: 0, failed: 0 });
});

test("a file that does not verify is left in the database and its upload is removed", async () => {
  const storage = fakeStorage({ corruptGets: true });
  const tables = emptyTables();
  tables.memos.push({ id: 1, file_key: null, file_data: Buffer.from("%PDF-keep") });
  const result = await createFileStore(storage).migrateLegacyFiles({ pool: fakePool(tables), log: quiet });
  assert.deepEqual(result, { moved: 0, failed: 1 });
  assert.equal(tables.memos[0].file_data.toString(), "%PDF-keep");
  assert.equal(tables.memos[0].file_key, null);
  assert.equal(storage.objects.size, 0);
});

test("cleanup deletes old unreferenced files only", async () => {
  const storage = fakeStorage();
  const old = Date.now() - 5 * 3600 * 1000;
  storage.objects.set("memos/kept.pdf", { data: Buffer.from("a"), createdAt: old });
  storage.objects.set("memos/orphan-old.pdf", { data: Buffer.from("b"), createdAt: old });
  storage.objects.set("memos/orphan-new.pdf", { data: Buffer.from("c"), createdAt: Date.now() });
  const tables = emptyTables();
  tables.memos.push({ id: 1, file_key: "memos/kept.pdf", file_data: null });
  const result = await createFileStore(storage).sweepOrphans({ pool: fakePool(tables), log: quiet });
  assert.equal(result.deleted, 1);
  assert.deepEqual([...storage.objects.keys()].sort(), ["memos/kept.pdf", "memos/orphan-new.pdf"]);
});

test("cleanup refuses to run when the database references no files at all", async () => {
  const storage = fakeStorage();
  storage.objects.set("memos/a.pdf", { data: Buffer.from("a"), createdAt: Date.now() - 9 * 3600 * 1000 });
  const result = await createFileStore(storage).sweepOrphans({ pool: fakePool(emptyTables()), log: quiet });
  assert.equal(result.skipped, true);
  assert.equal(storage.objects.size, 1);
});

test("cleanup respects the per-run limit", async () => {
  const storage = fakeStorage();
  const old = Date.now() - 9 * 3600 * 1000;
  for (let i = 0; i < 5; i++) storage.objects.set(`memos/o${i}.pdf`, { data: Buffer.from("x"), createdAt: old });
  storage.objects.set("memos/ref.pdf", { data: Buffer.from("x"), createdAt: old });
  const tables = emptyTables();
  tables.memos.push({ id: 1, file_key: "memos/ref.pdf", file_data: null });
  const result = await createFileStore(storage).sweepOrphans({ pool: fakePool(tables), log: quiet, maxDelete: 2 });
  assert.equal(result.deleted, 2);
  assert.equal(storage.objects.size, 4);
});
