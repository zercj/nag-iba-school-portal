import test from "node:test";
import assert from "node:assert/strict";
import { createStorage, newKey, extensionForMime, StorageError } from "./storage.js";

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function recorder(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); };
  return { calls, fetchImpl };
}

test("new-style secret keys are sent only in the apikey header", async () => {
  const { calls, fetchImpl } = recorder(() => json({ Key: "x" }));
  const storage = createStorage({ url: "https://p.supabase.co/", key: "sb_secret_abc", fetchImpl });
  await storage.put("lesson-plans/a.pdf", Buffer.from("%PDF-1"), "application/pdf");
  assert.equal(calls[0].url, "https://p.supabase.co/storage/v1/object/portal-files/lesson-plans/a.pdf");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.apikey, "sb_secret_abc");
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].init.headers["Content-Type"], "application/pdf");
});

test("legacy service_role JWT keys are also sent as a bearer token", async () => {
  const { calls, fetchImpl } = recorder(() => new Response(Buffer.from("data")));
  const storage = createStorage({ url: "https://p.supabase.co", key: "eyJhbGciOi.payload.sig", fetchImpl });
  const data = await storage.get("memos/a.pdf");
  assert.equal(data.toString(), "data");
  assert.equal(calls[0].init.headers.Authorization, "Bearer eyJhbGciOi.payload.sig");
});

test("a missing object is reported as a 404 even though Storage answers 400", async () => {
  const { fetchImpl } = recorder(() => json({ statusCode: "404", error: "not_found", message: "Object not found" }, 400));
  const storage = createStorage({ url: "https://p.supabase.co", key: "sb_secret_x", fetchImpl });
  await assert.rejects(storage.get("memos/none.pdf"), (error) => error instanceof StorageError && error.status === 404);
});

test("a server error is retried once", async () => {
  const { calls, fetchImpl } = recorder((url, init, count) => (count === 1 ? new Response("boom", { status: 503 }) : new Response(Buffer.from("ok"))));
  const storage = createStorage({ url: "https://p.supabase.co", key: "sb_secret_x", fetchImpl });
  assert.equal((await storage.get("memos/a.pdf")).toString(), "ok");
  assert.equal(calls.length, 2);
});

test("remove sends keys in chunks of 100 and de-duplicates", async () => {
  const { calls, fetchImpl } = recorder(() => json([]));
  const storage = createStorage({ url: "https://p.supabase.co", key: "sb_secret_x", fetchImpl });
  const keys = Array.from({ length: 230 }, (_, i) => `memos/${i}.pdf`);
  await storage.remove([...keys, keys[0]]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(JSON.parse(calls[0].init.body).prefixes.length, 100);
  assert.equal(JSON.parse(calls[2].init.body).prefixes.length, 30);
});

test("list pages through a folder and skips folders and placeholders", async () => {
  const pageOne = Array.from({ length: 100 }, (_, i) => ({ name: `f${i}.pdf`, id: `id${i}`, created_at: "2026-01-01T00:00:00Z" }));
  const pageTwo = [{ name: "last.pdf", id: "z", created_at: "2026-01-02T00:00:00Z" }, { name: "sub", id: null }, { name: ".emptyFolderPlaceholder", id: "p" }];
  const { calls, fetchImpl } = recorder((url, init, count) => json(count === 1 ? pageOne : pageTwo));
  const storage = createStorage({ url: "https://p.supabase.co", key: "sb_secret_x", fetchImpl });
  const found = await storage.list("memos");
  assert.equal(found.length, 101);
  assert.equal(found[100].key, "memos/last.pdf");
  assert.equal(JSON.parse(calls[1].init.body).offset, 100);
});

test("init refuses a public bucket", async () => {
  const { fetchImpl } = recorder(() => json({ id: "portal-files", public: true }));
  const storage = createStorage({ url: "https://p.supabase.co", key: "sb_secret_x", fetchImpl });
  await assert.rejects(storage.init(), /public/);
});

test("init creates a private bucket when missing and runs a round-trip self-test", async () => {
  const stored = new Map();
  const { calls, fetchImpl } = recorder((url, init) => {
    const { pathname } = new URL(url);
    if (init.method === "GET" && pathname === "/storage/v1/bucket/portal-files") return json({ message: "Bucket not found" }, 404);
    if (init.method === "POST" && pathname === "/storage/v1/bucket") { assert.equal(JSON.parse(init.body).public, false); return json({ name: "portal-files" }); }
    if (init.method === "POST") { stored.set(pathname, init.body); return json({ Key: pathname }); }
    if (init.method === "GET") return new Response(stored.get(pathname));
    if (init.method === "DELETE") return json([]);
    throw new Error(`unexpected ${init.method} ${pathname}`);
  });
  const storage = createStorage({ url: "https://p.supabase.co", key: "sb_secret_x", fetchImpl });
  await storage.init();
  assert.ok(calls.some((c) => c.init.method === "DELETE"));
});

test("not configured storage reports it and keys are well formed", async () => {
  const storage = createStorage({});
  assert.equal(storage.configured, false);
  await assert.rejects(storage.get("memos/a.pdf"), /not configured/);
  assert.match(newKey("lesson-plans", ".pdf"), /^lesson-plans\/[0-9a-f-]{36}\.pdf$/);
  assert.equal(extensionForMime("image/jpeg"), ".jpg");
  assert.throws(() => newKey("other"), /Unknown storage kind/);
});
