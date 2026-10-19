// Lightweight, dependency-free PDF inspection used to warn teachers when an
// upload does not look like a lesson plan (blank file, almost no content, or a
// text document with none of the usual lesson-plan headings).
//
// This is a heuristic, not a verdict. It only reads what the PDF itself says:
//  - pages that are scanned images carry no text, so they are never flagged;
//  - fonts without a ToUnicode table cannot be read, so the keyword check is
//    skipped for them (only the blank / very-short checks still apply).
// Every flag can be appealed by the teacher, so a false alarm costs one click.
import { inflateSync } from "node:zlib";

export const LESSON_PLAN_KEYWORDS = [
  "objective", "competenc", "procedure", "evaluation", "assessment", "lesson",
  "topic", "learning", "material", "reference", "activit", "motivation",
  "discussion", "application", "assignment", "agreement", "remarks", "reflection",
  "contentstandard", "performancestandard", "quarter", "gradelevel", "teaching",
  "strategy", "subjectmatter", "dailylesson", "dll", "dlp", "i.objectives",
];

const MAX_INFLATED = 32 * 1024 * 1024;

function tryInflate(data) {
  try { return inflateSync(data, { maxOutputLength: MAX_INFLATED }); } catch { /* fall through */ }
  try { return inflateSync(data, { maxOutputLength: MAX_INFLATED, finishFlush: 2 /* Z_SYNC_FLUSH */ }); } catch { return null; }
}

/** Collects every indirect object (including those packed in object streams). */
function collectObjects(raw) {
  const objects = new Map();
  const header = /(\d+)\s+\d+\s+obj\b/g;
  let match;
  while ((match = header.exec(raw))) {
    const id = Number(match[1]);
    const start = header.lastIndex;
    let end = raw.indexOf("endobj", start);
    if (end < 0) end = raw.length;
    const body = raw.slice(start, end);
    const marker = /stream\r?\n/.exec(body);
    let dict = body, data = null;
    if (marker && body.indexOf("<<") !== -1 && marker.index > body.indexOf("<<")) {
      dict = body.slice(0, marker.index);
      const dataStart = marker.index + marker[0].length;
      let dataEnd = body.lastIndexOf("endstream");
      if (dataEnd < dataStart) dataEnd = body.length;
      data = Buffer.from(body.slice(dataStart, dataEnd).replace(/\r?\n$/, ""), "latin1");
    }
    objects.set(id, { dict, data, decoded: undefined });
    header.lastIndex = end;
  }
  // Unpack object streams (PDF 1.5+) so compressed font/resource dictionaries are visible.
  for (const [, obj] of [...objects]) {
    if (!obj.data || !/\/Type\s*\/ObjStm/.test(obj.dict)) continue;
    const count = Number(/\/N\s+(\d+)/.exec(obj.dict)?.[1]);
    const first = Number(/\/First\s+(\d+)/.exec(obj.dict)?.[1]);
    const inflated = decodedStream(obj);
    if (!inflated || !count || !first) continue;
    const text = inflated.toString("latin1");
    const nums = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < count; i++) {
      const id = nums[i * 2], offset = nums[i * 2 + 1];
      if (!Number.isFinite(id) || !Number.isFinite(offset)) continue;
      const nextOffset = i + 1 < count ? nums[(i + 1) * 2 + 1] : text.length - first;
      objects.set(id, { dict: text.slice(first + offset, first + nextOffset), data: null, decoded: undefined });
    }
  }
  return objects;
}

function ascii85(buffer) {
  const text = buffer.toString("latin1").replace(/\s+/g, "").replace(/^<~/, "");
  const end = text.indexOf("~>");
  const body = end >= 0 ? text.slice(0, end) : text;
  const out = [];
  let group = [];
  const flush = (count) => {
    let value = 0;
    for (let i = 0; i < 5; i++) value = value * 85 + ((group[i] ?? 84));
    const bytes = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
    out.push(...bytes.slice(0, count));
  };
  for (const ch of body) {
    if (ch === "z" && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    const code = ch.charCodeAt(0) - 33;
    if (code < 0 || code > 84) continue;
    group.push(code);
    if (group.length === 5) { flush(4); group = []; }
  }
  if (group.length > 1) flush(group.length - 1);
  return Buffer.from(out);
}

/** Applies the stream's /Filter chain. Returns null for filters we cannot read (JPEG, LZW, ...). */
function decodedStream(obj) {
  if (obj.decoded !== undefined) return obj.decoded;
  obj.decoded = null;
  if (!obj.data) return null;
  if (/\/Subtype\s*\/Image/.test(obj.dict) || /\/Length1|\/FontFile|\/Subtype\s*\/(CIDFontType0C|Type1C|OpenType)/.test(obj.dict)) return null;
  const filterValue = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(obj.dict)?.[1] ?? "";
  const chain = [...filterValue.matchAll(/\/([A-Za-z0-9]+)/g)].map((m) => m[1]);
  let data = obj.data;
  for (const name of chain) {
    if (name === "FlateDecode" || name === "Fl") data = data && tryInflate(data);
    else if (name === "ASCII85Decode" || name === "A85") data = ascii85(data);
    else if (name === "ASCIIHexDecode" || name === "AHx") data = Buffer.from(data.toString("latin1").replace(/[^0-9A-Fa-f]/g, ""), "hex");
    else return null;
    if (!data) return null;
  }
  obj.decoded = data;
  return data;
}

/** Parses a ToUnicode CMap into { bytes, map }. */
function parseCMap(text) {
  const map = new Map();
  let bytes = 1;
  const space = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  if (space) {
    const first = /<([0-9A-Fa-f]+)>/.exec(space[1]);
    if (first) bytes = Math.max(1, Math.round(first[1].length / 2));
  }
  const utf16 = (hex) => {
    let out = "";
    for (let i = 0; i + 3 < hex.length + 1; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4).padEnd(4, "0"), 16));
    return out;
  };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) map.set(parseInt(pair[1], 16), utf16(pair[2]));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const entries = block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f]*>)/g);
    for (const entry of entries) {
      const lo = parseInt(entry[1], 16), hi = Math.min(parseInt(entry[2], 16), lo + 65535);
      if (entry[3].startsWith("[")) {
        const list = [...entry[3].matchAll(/<([0-9A-Fa-f]*)>/g)].map((m) => utf16(m[1]));
        for (let code = lo; code <= hi && code - lo < list.length; code++) map.set(code, list[code - lo]);
      } else {
        const base = entry[3].slice(1, -1);
        const baseCode = parseInt(base.slice(-4) || "0", 16);
        const prefix = utf16(base.slice(0, -4));
        for (let code = lo; code <= hi; code++) map.set(code, prefix + String.fromCharCode(baseCode + (code - lo)));
      }
    }
  }
  return { bytes, map };
}

/** Tokenises a PDF content stream (only what text extraction needs). */
function* contentTokens(s) {
  const n = s.length;
  let i = 0;
  const delim = /[\s()<>[\]{}/%]/;
  while (i < n) {
    const c = s[i];
    if (c <= " ") { i++; continue; }
    if (c === "%") { while (i < n && s[i] !== "\n" && s[i] !== "\r") i++; continue; }
    if (c === "(") {
      let depth = 1; const out = []; i++;
      while (i < n && depth > 0) {
        const ch = s[i];
        if (ch === "\\") {
          i++; const e = s[i];
          if (e === "n") out.push(10); else if (e === "r") out.push(13); else if (e === "t") out.push(9);
          else if (e === "b") out.push(8); else if (e === "f") out.push(12);
          else if (e >= "0" && e <= "7") {
            let oct = e;
            while (oct.length < 3 && s[i + 1] >= "0" && s[i + 1] <= "7") oct += s[++i];
            out.push(parseInt(oct, 8) & 255);
          } else if (e === "\r") { if (s[i + 1] === "\n") i++; }
          else if (e !== "\n") out.push(e.charCodeAt(0) & 255);
        } else if (ch === "(") { depth++; out.push(40); }
        else if (ch === ")") { depth--; if (depth > 0) out.push(41); }
        else out.push(ch.charCodeAt(0) & 255);
        i++;
      }
      yield { t: "s", v: Buffer.from(out) };
    } else if (c === "<") {
      if (s[i + 1] === "<") { i += 2; yield { t: "d<" }; continue; }
      const end = s.indexOf(">", i);
      const hex = s.slice(i + 1, end < 0 ? n : end).replace(/[^0-9A-Fa-f]/g, "");
      i = end < 0 ? n : end + 1;
      yield { t: "s", v: Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex") };
    } else if (c === ">") { if (s[i + 1] === ">") { i += 2; yield { t: "d>" }; } else i++; }
    else if (c === "[") { i++; yield { t: "[" }; }
    else if (c === "]") { i++; yield { t: "]" }; }
    else if (c === "/") {
      let j = i + 1; while (j < n && !delim.test(s[j])) j++;
      yield { t: "n", v: s.slice(i + 1, j) }; i = j;
    } else if (c === "{" || c === "}" || c === ")") { i++; }
    else {
      let j = i; while (j < n && !delim.test(s[j])) j++;
      if (j === i) { i++; continue; }
      const word = s.slice(i, j); i = j;
      yield /^[+-]?(\d+\.?\d*|\.\d+)$/.test(word) ? { t: "num", v: Number(word) } : { t: "op", v: word };
    }
  }
}

/** Reads the text shown by a content stream. `decode(fontName, bytes)` returns a string. */
function readContent(content, decode, out) {
  let font = null, stack = [], array = null;
  for (const token of contentTokens(content)) {
    if (token.t === "[") { array = []; continue; }
    if (token.t === "]") { if (array) stack.push({ t: "arr", v: array }); array = null; continue; }
    if (token.t === "s") { (array ?? stack).push(token); continue; }
    if (token.t === "num") { if (array) array.push(token); else stack.push(token); continue; }
    if (token.t === "n" || token.t === "d<" || token.t === "d>") { if (!array) stack.push(token); continue; }
    const op = token.v;
    if (op === "Tf") { const name = [...stack].reverse().find((x) => x.t === "n"); if (name) font = name.v; }
    else if (op === "Tj" || op === "'" || op === '"') {
      const str = [...stack].reverse().find((x) => x.t === "s");
      if (str) out.push(decode(font, str.v));
    } else if (op === "TJ") {
      const arr = [...stack].reverse().find((x) => x.t === "arr");
      if (arr) {
        let line = "";
        for (const part of arr.v) {
          if (part.t === "s") line += decode(font, part.v);
          else if (part.t === "num" && part.v < -200) line += " ";
        }
        out.push(line);
      }
    } else if (op === "BI") { out.images++; }
    stack = [];
  }
}

export function analyzePdf(buffer) {
  const raw = buffer.toString("latin1");
  const objects = collectObjects(raw);
  let images = 0;
  for (const obj of objects.values()) if (obj.data && /\/Subtype\s*\/Image/.test(obj.dict)) images++;

  // Font name -> candidate font objects, and font object -> decoder.
  const nameToObjects = new Map();
  const addPairs = (text) => {
    for (const pair of text.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      const list = nameToObjects.get(pair[1]) ?? [];
      if (!list.includes(Number(pair[2]))) list.push(Number(pair[2]));
      nameToObjects.set(pair[1], list);
    }
  };
  for (const obj of objects.values()) {
    for (const block of obj.dict.matchAll(/\/Font\s*<<((?:[^<>]|<(?!<))*)>>/g)) addPairs(block[1]);
    const indirect = /\/Font\s+(\d+)\s+\d+\s+R/.exec(obj.dict);
    if (indirect && objects.get(Number(indirect[1]))) addPairs(objects.get(Number(indirect[1])).dict);
  }
  const cmapCache = new Map();
  const cmapFor = (fontId) => {
    if (cmapCache.has(fontId)) return cmapCache.get(fontId);
    let result = null;
    const font = objects.get(fontId);
    const ref = font && /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(font.dict);
    const stream = ref && objects.get(Number(ref[1]));
    const bytes = stream && decodedStream(stream);
    if (bytes) result = parseCMap(bytes.toString("latin1"));
    else if (font && /\/Subtype\s*\/Type0/.test(font.dict)) result = { opaque: true };
    cmapCache.set(fontId, result);
    return result;
  };

  const stats = { glyphs: 0, letters: 0, nonSpace: 0, opaque: 0 };
  const texts = [];
  const decode = (fontName, bytes) => {
    const candidates = (fontName && nameToObjects.get(fontName)) || [];
    let best = null, bestScore = -1;
    for (const id of candidates) {
      const cmap = cmapFor(id);
      if (!cmap) { if (best === null) { best = { simple: true }; bestScore = 0; } continue; }
      if (cmap.opaque) { if (best === null || best.simple) { best = cmap; bestScore = 0; } continue; }
      const size = cmap.bytes;
      let found = 0, total = 0;
      for (let i = 0; i + size <= bytes.length; i += size) {
        total++;
        let code = 0; for (let k = 0; k < size; k++) code = (code << 8) | bytes[i + k];
        if (cmap.map.has(code)) found++;
      }
      const score = total ? found / total : 0;
      if (score > bestScore) { best = cmap; bestScore = score; }
    }
    let text = "";
    if (best && best.opaque) { stats.opaque += bytes.length / 2; return ""; }
    if (best && !best.simple) {
      const size = best.bytes;
      for (let i = 0; i + size <= bytes.length; i += size) {
        let code = 0; for (let k = 0; k < size; k++) code = (code << 8) | bytes[i + k];
        text += best.map.get(code) ?? "";
      }
    } else text = bytes.toString("latin1").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
    return text;
  };

  const out = [];
  out.images = 0;
  for (const obj of objects.values()) {
    const bytes = decodedStream(obj);
    if (!bytes || bytes.length < 4) continue;
    const text = bytes.toString("latin1");
    if (text.includes("begincmap") || !/\bBT\b/.test(text) || !/\bET\b/.test(text)) continue;
    readContent(text, decode, out);
  }
  images += out.images;
  const all = out.join(" ");
  for (const ch of all) {
    if (/\s/.test(ch)) continue;
    stats.glyphs++; stats.nonSpace++;
    if (/[A-Za-z\u00C0-\u024F]/.test(ch)) stats.letters++;
  }
  stats.glyphs += Math.round(stats.opaque);
  const compact = all.toLowerCase().replace(/\s+/g, "");
  const hits = new Set(LESSON_PLAN_KEYWORDS.filter((word) => compact.includes(word)));
  const readable = stats.letters >= 80 && stats.letters / Math.max(1, stats.nonSpace) >= 0.6 && stats.opaque < stats.letters;
  return { glyphs: stats.glyphs, letters: stats.letters, images, readable, keywordHits: [...hits], sample: all.slice(0, 200) };
}

/** Turns an analysis into user-facing flags. An empty array means "looks fine". */
export function contentFlags(analysis) {
  const flags = [];
  if (analysis.glyphs < 10 && analysis.images === 0) {
    flags.push({ code: "blank", message: "This PDF looks blank. No text or pictures were found in it." });
  } else if (analysis.glyphs < 60 && analysis.images === 0) {
    flags.push({ code: "too_short", message: "This PDF has almost no content, only a few characters of text." });
  } else if (analysis.readable && analysis.letters >= 150 && analysis.keywordHits.length < 2) {
    flags.push({ code: "not_lesson_plan", message: "This document does not look like a lesson plan. None of the usual lesson-plan headings (objectives, procedure, evaluation, and so on) were found." });
  }
  return flags;
}
