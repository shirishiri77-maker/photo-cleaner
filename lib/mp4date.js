// Reads the original date (and location) from a picked video, and writes them into the compressed MP4.
// Writes: movie/track/media creation times (mvhd, tkhd, mdhd) and QuickTime metadata items
// "com.apple.quicktime.creationdate" (with time zone) and, if the source has one, the ISO 6709 location.
// The MP4 must have its index (moov) as the LAST box (mp4-muxer option fastStart:false), so no
// chunk offsets need to be rewritten. Pure logic: tested in Node.
const MAC_EPOCH_OFFSET = 2082844800; // seconds between 1904-01-01 and 1970-01-01
export const KEY_DATE = 'com.apple.quicktime.creationdate';
export const KEY_LOC = 'com.apple.quicktime.location.ISO6709';

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const setU32 = (b, o, v) => { b[o] = v >>> 24; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };
const type = (b, o) => String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
const str = (s) => new TextEncoder().encode(s);
const be32 = (v) => { const a = new Uint8Array(4); setU32(a, 0, v); return a; };

export function readBoxes(b, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o), hdr = 8;
    if (size === 1) { size = u32(b, o + 12); hdr = 16; } // 64-bit size: the low word is enough for our files
    if (size === 0) size = end - o;
    if (size < hdr || o + size > end) break;
    out.push({ type: type(b, o), start: o, size, hdr, end: o + size });
    o += size;
  }
  return out;
}
const find = (list, t) => (list || []).find((x) => x.type === t);

function box(t, ...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(8 + len);
  setU32(out, 0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = t.charCodeAt(i);
  let o = 8;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ISO-8601 with offset, the way an iPhone writes it: 2026-11-05T14:22:10+0200
export function quickTimeDateString(date, offsetMinutes) {
  const local = new Date(date.getTime() + offsetMinutes * 60000);
  const p = (n) => String(n).padStart(2, '0');
  const a = Math.abs(offsetMinutes);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  return `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}${sign}${p(Math.floor(a / 60))}${p(a % 60)}`;
}

// "2024-07-14T18:30:05+0300" (or +03:00, or Z) -> {date, offsetMinutes}; null if it cannot be read.
export function parseQuickTimeDate(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|([+-])(\d\d):?(\d\d))$/.exec(String(s || '').trim());
  if (!m) return null;
  const off = m[7] === 'Z' ? 0 : (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10]));
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - off * 60000;
  return { date: new Date(utc), offsetMinutes: off };
}

function metaBox(items) { // items: [{key, value}]
  const hdlr = box('hdlr', be32(0), be32(0), str('mdta'), new Uint8Array(12), new Uint8Array(1));
  const keys = box('keys', be32(0), be32(items.length), ...items.map((it) => box('mdta', str(it.key))));
  const ilstItems = items.map((it, i) => {
    const data = box('data', be32(1), be32(0), str(it.value)); // type 1 = UTF-8, locale 0
    const item = new Uint8Array(8 + data.length); // the item box type is the 1-based key index
    setU32(item, 0, item.length); setU32(item, 4, i + 1); item.set(data, 8);
    return item;
  });
  return box('meta', be32(0), hdlr, keys, box('ilst', ...ilstItems));
}

// buf: Uint8Array of an MP4 whose last top-level box is moov.
// info: {date: Date, offsetMinutes, creationdate?: string (verbatim from the source), location?: string}
// Returns a new Uint8Array with the original date written.
export function writeOriginalDate(buf, info) {
  const top = readBoxes(buf, 0, buf.length);
  const moov = top[top.length - 1];
  if (!moov || moov.type !== 'moov') throw new Error('moov must be the last box (use fastStart:false)');
  const b = new Uint8Array(buf); // copy
  const secs = Math.floor(info.date.getTime() / 1000) + MAC_EPOCH_OFFSET;
  const setTimes = (bx) => {
    if (!bx) return;
    if (b[bx.start + 8] === 0) { setU32(b, bx.start + 12, secs); setU32(b, bx.start + 16, secs); } // version 0: 32-bit times
    else { setU32(b, bx.start + 12, 0); setU32(b, bx.start + 16, secs); setU32(b, bx.start + 20, 0); setU32(b, bx.start + 24, secs); } // version 1: 64-bit times
  };
  const kids = readBoxes(b, moov.start + 8, moov.end);
  setTimes(find(kids, 'mvhd'));
  for (const trak of kids.filter((k) => k.type === 'trak')) {
    const tk = readBoxes(b, trak.start + 8, trak.end);
    setTimes(find(tk, 'tkhd'));
    const mdia = find(tk, 'mdia');
    if (mdia) setTimes(find(readBoxes(b, mdia.start + 8, mdia.end), 'mdhd'));
  }
  const items = [{ key: KEY_DATE, value: info.creationdate || quickTimeDateString(info.date, info.offsetMinutes) }];
  if (info.location) items.push({ key: KEY_LOC, value: info.location });
  const meta = metaBox(items);
  const out = new Uint8Array(b.length + meta.length);
  out.set(b, 0);
  out.set(meta, b.length);
  setU32(out, moov.start, moov.size + meta.length);
  return out;
}

function readMeta(b, metaBx) {
  const found = {};
  const mk = readBoxes(b, metaBx.start + 12, metaBx.end); // meta is a full box (4 bytes version/flags)
  const keysBox = find(mk, 'keys'), ilst = find(mk, 'ilst');
  if (!keysBox || !ilst) return found;
  const count = u32(b, keysBox.start + 12);
  let o = keysBox.start + 16;
  const names = [];
  for (let i = 0; i < count; i++) {
    const sz = u32(b, o);
    if (sz < 8) break;
    names.push(new TextDecoder().decode(b.slice(o + 8, o + sz)));
    o += sz;
  }
  for (const item of readBoxes(b, ilst.start + 8, ilst.end)) {
    const name = names[u32(b, item.start + 4) - 1];
    const d = find(readBoxes(b, item.start + 8, item.end), 'data');
    if (name && d) found[name] = new TextDecoder().decode(b.slice(d.start + 16, d.end));
  }
  return found;
}

// buf: bytes starting at a top-level box boundary (the whole file, or just the moov box).
// Returns {found, mvhd (ISO UTC or null), creationdate (text or null), location (text or null), hasUdtaLocation}
export function readDates(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const moov = find(readBoxes(b, 0, b.length), 'moov');
  const out = { found: !!moov, mvhd: null, creationdate: null, location: null, hasUdtaLocation: false };
  if (!moov) return out;
  const kids = readBoxes(b, moov.start + 8, moov.end);
  const mvhd = find(kids, 'mvhd');
  if (mvhd) {
    const secs = b[mvhd.start + 8] === 0 ? u32(b, mvhd.start + 12) : u32(b, mvhd.start + 16);
    if (secs > 0) out.mvhd = new Date((secs - MAC_EPOCH_OFFSET) * 1000).toISOString();
  }
  const udta = find(kids, 'udta');
  const udtaKids = udta ? readBoxes(b, udta.start + 8, udta.end) : [];
  out.hasUdtaLocation = udtaKids.some((k) => k.type === '©xyz');
  const metas = [find(kids, 'meta'), find(udtaKids, 'meta')].filter(Boolean);
  for (const m of metas) {
    const f = readMeta(b, m);
    if (f[KEY_DATE] && !out.creationdate) out.creationdate = f[KEY_DATE];
    if (f[KEY_LOC] && !out.location) out.location = f[KEY_LOC];
  }
  return out;
}

// Reads the dates of a picked video without loading the whole file: walks the top-level boxes with
// small slices and reads only the moov box. blob: a File or Blob.
export async function readSourceDates(blob) {
  const size = blob.size;
  let pos = 0;
  for (let i = 0; i < 64 && pos + 8 <= size; i++) {
    const head = new Uint8Array(await blob.slice(pos, Math.min(size, pos + 16)).arrayBuffer());
    let sz = u32(head, 0), t = type(head, 0);
    if (sz === 1) sz = u32(head, 12);
    if (sz === 0) sz = size - pos;
    if (sz < 8) break;
    if (t === 'moov') {
      const bytes = new Uint8Array(await blob.slice(pos, Math.min(size, pos + sz)).arrayBuffer());
      return readDates(bytes);
    }
    pos += sz;
  }
  return { found: false, mvhd: null, creationdate: null, location: null, hasUdtaLocation: false };
}

// Finding of the iPhone date test (iOS 18.7, one 131 s clip, 2026-11-06): the file the picker hands over is a
// re-exported copy. Its movie header time is the EXPORT time (today), it has no QuickTime creationdate and no
// location, while File.lastModified was a date in the past (23 Aug), which looked like the recording date.
// So a movie header time that is close to "now" is not trusted, and a lastModified clearly in the past is used.
// This is one clip on one phone, not a general guarantee: the page says which source was used.
export const EXPORT_WINDOW_MS = 6 * 3600 * 1000; // a header time within 6 hours of now looks like the export time
export const PAST_MS = 3600 * 1000;              // lastModified must be more than 1 hour in the past to count as a past date

// Decides which date to write. Order: the QuickTime creationdate text of the source (it has the time zone);
// then the movie header time (with this phone's time zone) if it does NOT look like an export time;
// then File.lastModified if the header time looks like an export time and lastModified is clearly in the past;
// then the export-like header time (flagged), then File.lastModified alone (NOT trusted).
// deviceOffsetMinutes: (date) => minutes east of UTC for that moment on this phone. now: ms since 1970.
export function chooseDate(src, lastModified, deviceOffsetMinutes, now = Date.now()) {
  const p = src && parseQuickTimeDate(src.creationdate);
  if (p) return { date: p.date, offsetMinutes: p.offsetMinutes, creationdate: src.creationdate, location: src.location || null, from: 'source creationdate', mvhdLooksLikeExport: false };
  const mvhdMs = src && src.mvhd ? Date.parse(src.mvhd) : null;
  const exportLike = mvhdMs !== null && Number.isFinite(mvhdMs) && Math.abs(now - mvhdMs) <= EXPORT_WINDOW_MS;
  const fromMvhd = (note) => {
    const date = new Date(mvhdMs);
    return { date, offsetMinutes: deviceOffsetMinutes(date), creationdate: null, location: src.location || null, from: 'source movie header time + this phone time zone' + note, mvhdLooksLikeExport: exportLike };
  };
  const fromLastModified = (note) => {
    const date = new Date(lastModified);
    return { date, offsetMinutes: deviceOffsetMinutes(date), creationdate: null, location: (src && src.location) || null, from: 'File.lastModified (' + note + ')', mvhdLooksLikeExport: exportLike };
  };
  if (mvhdMs !== null && Number.isFinite(mvhdMs) && !exportLike) return fromMvhd('');
  const lastPast = !!lastModified && now - lastModified > PAST_MS;
  if (exportLike && lastPast) return fromLastModified('the movie header time is the export time of the picker, not the recording date');
  if (mvhdMs !== null && Number.isFinite(mvhdMs)) return fromMvhd(' (looks like the export time: may be wrong)');
  if (lastModified) return fromLastModified('no other date in the file; NOT trusted');
  return null;
}
