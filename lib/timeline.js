// Measures audio/video timing of an MP4 or MOV: where each track really starts on the movie timeline
// (sample times plus edit lists), how long it is, and the audio/video offset. Numbers only, no file names.
// Works on an mp4box ISOFile that has finished parsing (after onReady). Pure logic: tested in Node.

const num = (v) => (typeof v === 'bigint' ? Number(v) : Number(v));
const ms = (sec) => (sec === null || sec === undefined || !Number.isFinite(sec) ? null : Math.round(sec * 1000 * 10) / 10);

// One track: first/last sample times, edit list, and the start/end on the movie timeline.
export function trackTimeline(mp4file, trackInfo, movieTimescale) {
  const trak = mp4file.getTrackById(trackInfo.id);
  const samples = (trak && trak.samples) || [];
  if (!samples.length) return null;
  const ts = samples[0].timescale || trackInfo.timescale;
  let minCts = Infinity, maxEnd = -Infinity;
  for (const s of samples) {
    if (s.cts < minCts) minCts = s.cts;
    const end = s.cts + s.duration;
    if (end > maxEnd) maxEnd = end;
  }
  const entries = (trak.edts && trak.edts.elst && trak.edts.elst.entries) || [];
  const edits = entries.map((e) => ({ segSec: num(e.segment_duration) / movieTimescale, mediaSec: num(e.media_time) < 0 ? null : num(e.media_time) / ts }));
  let delay = 0, mediaStart = null;
  for (const e of edits) {
    if (e.mediaSec === null) delay += e.segSec;
    else { mediaStart = e.mediaSec; break; }
  }
  const firstCtsSec = minCts / ts, lastEndSec = maxEnd / ts;
  let startSec = firstCtsSec, endSec = lastEndSec, primingSec = 0;
  if (edits.length) {
    startSec = delay + Math.max(0, firstCtsSec - (mediaStart || 0)); // where the played content begins (a cut-off beginning is not counted)
    primingSec = mediaStart !== null ? Math.max(0, mediaStart - firstCtsSec) : 0;
    endSec = edits.reduce((n, e) => n + e.segSec, 0);
  }
  const mdhd = trak.mdia && trak.mdia.mdhd;
  return {
    kind: trackInfo.type === 'audio' || (trackInfo.audio && !trackInfo.video) ? 'audio' : 'video',
    codec: trackInfo.codec,
    samples: samples.length,
    firstCtsSec, lastEndSec,
    mediaDurSec: mdhd ? num(mdhd.duration) / num(mdhd.timescale) : null,
    trackDurSec: trak.tkhd ? num(trak.tkhd.duration) / movieTimescale : null,
    edits,
    startOnTimelineSec: startSec, // where the first sample that is actually played appears (negative = cut)
    endOnTimelineSec: endSec,
    primingSec,
  };
}

// Returns {video, audio} timelines (first track of each kind) of a parsed file.
export function timelines(mp4file) {
  const info = mp4file.getInfo();
  const movieTs = info.timescale;
  const v = info.videoTracks && info.videoTracks[0], a = info.audioTracks && info.audioTracks[0];
  return {
    movieDurSec: info.duration / movieTs,
    video: v ? trackTimeline(mp4file, { ...v, type: 'video' }, movieTs) : null,
    audio: a ? trackTimeline(mp4file, { ...a, type: 'audio' }, movieTs) : null,
  };
}

// Numbers for the report (milliseconds). avOffsetMs > 0 means the sound starts later than the picture.
export function syncSummary(tl) {
  if (!tl) return null;
  const v = tl.video, a = tl.audio;
  const avOffset = v && a ? a.startOnTimelineSec - v.startOnTimelineSec : null;
  const endDiff = v && a ? a.endOnTimelineSec - v.endOnTimelineSec : null;
  return {
    videoStartMs: ms(v && v.startOnTimelineSec), audioStartMs: ms(a && a.startOnTimelineSec),
    avOffsetMs: ms(avOffset),
    videoEndMs: ms(v && v.endOnTimelineSec), audioEndMs: ms(a && a.endOnTimelineSec), endDiffMs: ms(endDiff),
    videoTrackDurMs: ms(v && v.trackDurSec), audioTrackDurMs: ms(a && a.trackDurSec), movieDurMs: ms(tl.movieDurSec),
    audioPrimingMs: ms(a && a.primingSec), videoEdits: v ? v.edits.length : null, audioEdits: a ? a.edits.length : null,
    videoSamples: v ? v.samples : null, audioSamples: a ? a.samples : null,
  };
}

// Parses MP4 bytes with the given mp4box module and returns the summary. For outputs we make ourselves.
export async function summaryFromBytes(mp4boxModule, bytes) {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  buf.fileStart = 0;
  const f = mp4boxModule.createFile(true);
  await new Promise((res, rej) => { f.onError = rej; f.onReady = res; f.appendBuffer(buf); f.flush(); });
  return syncSummary(timelines(f));
}

// How the samples of a track must be shifted so that their time is the time on the movie timeline:
// presentation = cts + shift. Uses the first non-empty edit (and empty edits before it). Seconds.
export function shiftFromEdits(tl) {
  if (!tl || !tl.edits.length) return 0;
  let delay = 0, mediaStart = 0;
  for (const e of tl.edits) {
    if (e.mediaSec === null) delay += e.segSec;
    else { mediaStart = e.mediaSec; break; }
  }
  return delay - mediaStart;
}
