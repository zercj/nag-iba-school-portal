// Minimal streaming ZIP writer (stored, no compression, UTF-8 names). Lesson plans are PDFs, which are
// already compressed, so storing them keeps the download fast and memory use low: each file is written
// to the response as soon as it is loaded and then released.
import { crc32 } from "node:zlib";
import { once } from "node:events";

const MAX_ENTRIES = 65535;
const MAX_BYTES = 0xffffffff - 1024 * 1024; // stay clear of the ZIP64 limit

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function createZipWriter(out) {
  const central = [];
  let offset = 0;

  async function write(chunk) {
    if (out.destroyed) throw new Error("The download was cancelled.");
    if (!out.write(chunk)) await once(out, "drain");
    offset += chunk.length;
  }

  return {
    get count() { return central.length; },
    async addFile(name, data, modified = new Date()) {
      if (central.length >= MAX_ENTRIES) throw new Error("Too many files for one ZIP.");
      if (offset + data.length + 1024 > MAX_BYTES) throw new Error("The ZIP would be larger than 4 GB.");
      const nameBuf = Buffer.from(name, "utf8");
      const crc = crc32(data);
      const { time, date } = dosDateTime(modified);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
      local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
      central.push({ nameBuf, crc, size: data.length, time, date, offset });
      await write(local); await write(nameBuf); await write(data);
    },
    async finish() {
      const start = offset;
      for (const e of central) {
        const h = Buffer.alloc(46);
        h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0800, 8); h.writeUInt16LE(0, 10);
        h.writeUInt16LE(e.time, 12); h.writeUInt16LE(e.date, 14); h.writeUInt32LE(e.crc, 16);
        h.writeUInt32LE(e.size, 20); h.writeUInt32LE(e.size, 24); h.writeUInt16LE(e.nameBuf.length, 28);
        h.writeUInt32LE(e.offset, 42);
        await write(h); await write(e.nameBuf);
      }
      const size = offset - start;
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
      end.writeUInt32LE(size, 12); end.writeUInt32LE(start, 16);
      await write(end);
    },
  };
}

// Makes one path segment safe for every operating system's unzip tool.
export function safeSegment(value, fallback = "untitled") {
  let text = String(value ?? "").normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^[.\s]+/, "").replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(text)) text = `_${text}`;
  return (text.slice(0, 100).trim()) || fallback;
}

// Adds " (2)", " (3)"... before the extension when a path was already used.
export function uniquePath(path, used) {
  let candidate = path, n = 1;
  const dot = path.lastIndexOf(".");
  const stem = dot > path.lastIndexOf("/") ? path.slice(0, dot) : path;
  const ext = dot > path.lastIndexOf("/") ? path.slice(dot) : "";
  while (used.has(candidate.toLowerCase())) candidate = `${stem} (${++n})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}
