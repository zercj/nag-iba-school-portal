import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { analyzePdf, contentFlags } from "./pdf-check.js";

// Builds a tiny PDF by hand so the tests need no binary fixtures.
function buildPdf({ lines = [], image = false, compress = false } = {}) {
  const content = lines.length
    ? `BT /F1 12 Tf 50 780 Td 14 TL ${lines.map((l) => `(${l.replace(/[()\\]/g, "\\$&")}) Tj T*`).join(" ")} ET`
    : "q Q";
  const body = compress ? deflateSync(Buffer.from(content)) : Buffer.from(content);
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >>${image ? " /XObject << /Im1 6 0 R >>" : ""} >> >>`,
  ];
  let out = "%PDF-1.4\n";
  const parts = [Buffer.from(out, "latin1")];
  const add = (text) => parts.push(Buffer.from(text, "latin1"));
  objs.forEach((o, i) => add(`${i + 1} 0 obj\n${o}\nendobj\n`));
  add(`4 0 obj\n<< /Length ${body.length}${compress ? " /Filter /FlateDecode" : ""} >>\nstream\n`);
  parts.push(body);
  add("\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");
  if (image) add("6 0 obj\n<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\u0000\nendstream\nendobj\n");
  add("trailer\n<< /Root 1 0 R >>\n%%EOF\n");
  return Buffer.concat(parts);
}

const lessonPlan = [
  "Daily Lesson Plan - Grade 7 Science", "I. Objectives", "The learner identifies the parts of a plant cell.",
  "II. Content Standard and Learning Competencies", "III. Subject Matter: Plant cells", "IV. Procedure",
  "A. Motivation", "B. Discussion and Activity", "C. Application", "V. Evaluation", "VI. Assignment", "Remarks",
];

test("a normal lesson plan is not flagged (plain and compressed streams)", () => {
  for (const compress of [false, true]) {
    const analysis = analyzePdf(buildPdf({ lines: lessonPlan, compress }));
    assert.equal(analysis.readable, true);
    assert.deepEqual(contentFlags(analysis), []);
  }
});

test("a blank page is flagged as blank", () => {
  assert.equal(contentFlags(analyzePdf(buildPdf()))[0].code, "blank");
});

test("a page with only a few characters is flagged as too short", () => {
  const flags = contentFlags(analyzePdf(buildPdf({ lines: ["Please see attached file for the week"] })));
  assert.equal(flags[0].code, "too_short");
});

test("a long text document without lesson-plan headings is flagged", () => {
  const lines = Array.from({ length: 12 }, () => "Weekend grocery shopping: rice, eggs, noodles, bananas, sugar, coffee and bread.");
  assert.equal(contentFlags(analyzePdf(buildPdf({ lines })))[0].code, "not_lesson_plan");
});

test("scanned (image-only) PDFs are never flagged because they cannot be read", () => {
  const analysis = analyzePdf(buildPdf({ image: true }));
  assert.equal(analysis.images, 1);
  assert.deepEqual(contentFlags(analysis), []);
});
