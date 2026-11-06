// Writes an edit list (edts/elst) into one track of an MP4 whose index (moov) is the LAST box.
// Used to keep the sound/picture alignment of the source: mp4-muxer cannot write a start offset for a track.
// An edit list entry is either an empty edit (a delay: mediaTimeSec = null) or a piece of the track's media.
import { readBoxes } from './mp4date.js';

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const setU32 = (b, o, v) => { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };
const find = (list, t) => (list || []).find((x) => x.type === t);
const be32 = (v) => { const a = new Uint8Array(4); setU32(a, 0, v >>> 0); return a; };

function box(t, ...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(8 + len);
  setU32(out, 0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = t.charCodeAt(i);
  let o = 8;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function fullBoxTimescale(b, bx) { // mvhd and mdhd: version 0: timescale at +20, duration at +24; version 1: +28, +32
  const v = b[bx.start + 8];
  return v === 0 ? { timescale: u32(b, bx.start + 20), durOffset: bx.start + 24, wide: false } : { timescale: u32(b, bx.start + 28), durOffset: bx.start + 32, wide: true };
}
function readDur(b, d) { return d.wide ? u32(b, d.durOffset + 4) : u32(b, d.durOffset); }
function writeDur(b, d, val) { if (d.wide) { setU32(b, d.durOffset, 0); setU32(b, d.durOffset + 4, val); } else setU32(b, d.durOffset, val); }

// kind: 'video' | 'audio'. entries: [{durSec, mediaTimeSec | null}]. Returns a new Uint8Array.
export function writeEditList(buf, kind, entries) {
  const top = readBoxes(buf, 0, buf.length);
  const moov = top[top.length - 1];
  if (!moov || moov.type !== 'moov') throw new Error('moov must be the last box');
  const b = new Uint8Array(buf);
  const kids = readBoxes(b, moov.start + 8, moov.end);
  const mvhd = find(kids, 'mvhd');
  const movie = fullBoxTimescale(b, mvhd);
  const wanted = kind === 'video' ? 'vide' : 'soun';
  let target = null, mediaTs = null;
  for (const trak of kids.filter((k) => k.type === 'trak')) {
    const tk = readBoxes(b, trak.start + 8, trak.end);
    const mdia = find(tk, 'mdia');
    if (!mdia) continue;
    const mk = readBoxes(b, mdia.start + 8, mdia.end);
    const hdlr = find(mk, 'hdlr');
    const handler = hdlr ? String.fromCharCode(b[hdlr.start + 16], b[hdlr.start + 17], b[hdlr.start + 18], b[hdlr.start + 19]) : '';
    if (handler === wanted) { target = { trak, tk, mdia }; mediaTs = fullBoxTimescale(b, find(mk, 'mdhd')).timescale; break; }
  }
  if (!target) throw new Error('no ' + kind + ' track');
  if (find(target.tk, 'edts')) throw new Error('track already has an edit list');
  const entryBytes = entries.map((e) => {
    const a = new Uint8Array(12);
    setU32(a, 0, Math.round(e.durSec * movie.timescale));
    setU32(a, 4, e.mediaTimeSec === null ? 0xffffffff : Math.round(e.mediaTimeSec * mediaTs)); // -1 = empty edit
    a[8] = 0; a[9] = 1; a[10] = 0; a[11] = 0; // media rate 1.0
    return a;
  });
  const edts = box('edts', box('elst', be32(0), be32(entries.length), ...entryBytes));
  const mdiaBox = target.mdia;
  const out = new Uint8Array(b.length + edts.length);
  out.set(b.subarray(0, mdiaBox.start), 0);
  out.set(edts, mdiaBox.start);
  out.set(b.subarray(mdiaBox.start), mdiaBox.start + edts.length);
  setU32(out, target.trak.start, target.trak.size + edts.length);
  setU32(out, moov.start, moov.size + edts.length);
  // track and movie durations must cover the edited track
  const totalSegments = Math.round(entries.reduce((n, e) => n + e.durSec, 0) * movie.timescale);
  const tkhd = find(target.tk, 'tkhd');
  const tkhdOff = tkhd.start; // positions before the inserted box are unchanged
  const tkhdWide = out[tkhdOff + 8] !== 0;
  const durPos = tkhdOff + (tkhdWide ? 36 : 28);
  if (tkhdWide) { setU32(out, durPos, 0); setU32(out, durPos + 4, totalSegments); } else setU32(out, durPos, totalSegments);
  const mvhdDur = { durOffset: mvhd.start + (movie.wide ? 32 : 24), wide: movie.wide };
  if (totalSegments > readDur(out, mvhdDur)) writeDur(out, mvhdDur, totalSegments);
  return out;
}

// Convenience: delay one track by `sec` seconds (an empty edit, then the whole media).
export function delayTrack(buf, kind, sec, mediaDurSec) {
  return writeEditList(buf, kind, [{ durSec: sec, mediaTimeSec: null }, { durSec: mediaDurSec, mediaTimeSec: 0 }]);
}
