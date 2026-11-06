// Helpers for copying an AAC audio track from an MP4/MOV into a new MP4 (pure logic, tested in Node).

const FREQS = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

// 2-byte AAC AudioSpecificConfig for AAC-LC (object type 2) or other simple object types.
export function synthAsc(sampleRate, channels, objectType = 2) {
  const idx = FREQS.indexOf(sampleRate);
  if (idx < 0 || !channels || channels > 7) return null;
  const v = (objectType << 11) | (idx << 7) | (channels << 3);
  return new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
}

export const isAac = (codec) => /^mp4a\.40\./.test(codec || '');

// Picks the first AAC track. Newer iPhones can record other audio formats (for example spatial audio),
// which cannot be copied into an AAC MP4.
export function pickAacTrack(audioTracks) {
  return (audioTracks || []).find((t) => isAac(t.codec)) || null;
}

export function describeAudio(audioTracks) {
  if (!audioTracks || !audioTracks.length) return 'no audio track';
  return audioTracks.map((t) => `${t.codec || '?'} ${t.audio ? t.audio.sample_rate + 'Hz ' + t.audio.channel_count + 'ch' : ''}`.trim()).join(', ');
}

// Finds an esds box anywhere under a sample entry (QuickTime files may nest it in a "wave" box).
export function findEsds(node, depth = 0) {
  if (!node || depth > 5) return null;
  if (node.type === 'esds') return node;
  if (node.esds) return node.esds;
  for (const child of node.boxes || []) {
    const hit = findEsds(child, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function readLen(b, i) {
  let len = 0, n = 0, byte;
  do { byte = b[i + n]; len = (len << 7) | (byte & 0x7f); n++; } while (byte & 0x80 && n < 4);
  return [len, n];
}

// bytes: the serialized esds box. Returns the DecoderSpecificInfo bytes (the AudioSpecificConfig) or null.
export function ascFromEsdsBytes(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  function walk(i, end) {
    while (i < end) {
      const tag = b[i++];
      const [len, n] = readLen(b, i);
      i += n;
      const bodyEnd = Math.min(end, i + len);
      if (tag === 0x05) return b.slice(i, bodyEnd);
      if (tag === 0x03) { // ES_Descriptor: ES_ID(2) flags(1) [+ optional fields]
        let j = i + 2;
        const flags = b[j++];
        if (flags & 0x80) j += 2;
        if (flags & 0x40) j += 1 + b[j];
        if (flags & 0x20) j += 2;
        const r = walk(j, bodyEnd);
        if (r) return r;
      } else if (tag === 0x04) { // DecoderConfigDescriptor: 13 fixed bytes, then children
        const r = walk(i + 13, bodyEnd);
        if (r) return r;
      }
      i = bodyEnd;
    }
    return null;
  }
  // box header (8) + version/flags (4)
  return walk(12, b.length);
}

// Returns {asc, how} using the esds when readable, otherwise a synthesized AAC-LC config.
export function getAsc(esdsBytes, sampleRate, channels, codec) {
  if (esdsBytes) {
    const a = ascFromEsdsBytes(esdsBytes);
    if (a && a.length >= 2) return { asc: a, how: 'esds' };
  }
  const m = /^mp4a\.40\.(\d+)$/.exec(codec || '');
  const s = synthAsc(sampleRate, channels, m ? Number(m[1]) : 2);
  return s ? { asc: s, how: 'synthesized' } : { asc: null, how: 'none' };
}
