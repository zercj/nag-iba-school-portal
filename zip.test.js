import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createZipWriter, safeSegment, uniquePath } from "./zip.js";

test("safeSegment removes path tricks and reserved characters", () => {
  assert.equal(safeSegment("../../etc/passwd"), "etc passwd");
  assert.equal(safeSegment('Math: "Grade 7"?'), "Math Grade 7");
  assert.equal(safeSegment("CON"), "_CON");
  assert.equal(safeSegment("   "), "untitled");
});

test("uniquePath numbers duplicates case-insensitively", () => {
  const used = new Set();
  assert.equal(uniquePath("A/B/x.pdf", used), "A/B/x.pdf");
  assert.equal(uniquePath("a/b/X.pdf", used), "a/b/X (2).pdf");
});

test("zip writer produces an archive that unzip accepts, with nested folders and UTF-8 names", async () => {
  const sink = new PassThrough(); const chunks = [];
  sink.on("data", (c) => chunks.push(c));
  const zip = createZipWriter(sink);
  const a = Buffer.from("%PDF-1.4 hello"), b = Buffer.alloc(200000, 7);
  await zip.addFile("Maria Santos/Math 7/one.pdf", a);
  await zip.addFile("José Ñ/Science/two.pdf", b);
  await zip.finish(); sink.end();
  const file = path.join(mkdtempSync(path.join(tmpdir(), "zip-")), "t.zip");
  writeFileSync(file, Buffer.concat(chunks));
  const listing = execFileSync("python3", ["-I", "-c", "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print('\\n'.join(sorted(z.namelist())))", file]).toString();
  assert.match(listing, /Maria Santos\/Math 7\/one\.pdf/);
  assert.match(listing, /José Ñ\/Science\/two\.pdf/);
  const data = execFileSync("python3", ["-I", "-c", "import zipfile,sys;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read('Maria Santos/Math 7/one.pdf'))", file]);
  assert.deepEqual(data, a);
});
