// Method A: decode with WebCodecs, re-encode H.264 at lower size, write MP4. All on the device.
// Spike code: reads the whole file into memory (refuses very large files). Measures, does not polish.
import { pickAacTrack, describeAudio, findEsds, getAsc } from './lib/aac.js';
import { writeOriginalDate, quickTimeDateString } from './lib/mp4date.js';
import { trackTimeline, syncSummary, shiftFromEdits, summaryFromBytes } from './lib/timeline.js';
import { delayTrack } from './lib/mp4edit.js';

const MAX_BYTES = 400 * 1024 * 1024;

function toDesc(mp4box, box) {
  const stream = new mp4box.DataStream(undefined, 0, mp4box.Endianness.BIG_ENDIAN);
  box.write(stream);
  return new Uint8Array(stream.buffer, 8); // skip the 8-byte box header
}

function rotationFrom(matrix) {
  try {
    const a = matrix[0], b = matrix[1];
    const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
    return ((deg % 360) + 360) % 360;
  } catch (e) { return 0; }
}

// originalDate: {date, offsetMinutes, creationdate?, location?} to write into the copy (see lib/mp4date.js).
// moovLast is accepted for compatibility: the copy always has its index (moov) at the end of the file.
export async function compressA(file, { onProgress = () => {}, targetLongSide = 1280, log = () => {}, originalDate = null } = {}) {
  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') throw new Error('WebCodecs not available');
  if (file.size > MAX_BYTES) throw new Error('file too large for this test (' + Math.round(file.size / 1048576) + ' MB)');
  const mp4box = await import('./vendor/mp4box/mp4box.all.js');
  const { Muxer, ArrayBufferTarget } = await import('./vendor/mp4-muxer/mp4-muxer.js');

  // ---- demux ----
  const mp4 = mp4box.createFile(true);
  const vSamples = [], aSamples = [];
  let vTrack, aTrack, vDesc, aDesc, rotation = 0, audioInfo = '', ascHow = '', srcTl = null;
  const ready = new Promise((res, rej) => {
    mp4.onError = (e) => rej(new Error('demux: ' + e));
    mp4.onReady = (info) => {
      try {
        vTrack = info.videoTracks[0];
        aTrack = pickAacTrack(info.audioTracks);
        audioInfo = describeAudio(info.audioTracks);
        if (!vTrack) throw new Error('no video track');
        const trak = mp4.getTrackById(vTrack.id);
        for (const entry of trak.mdia.minf.stbl.stsd.entries) {
          const box = entry.avcC || entry.hvcC;
          if (box) { vDesc = toDesc(mp4box, box); break; }
        }
        rotation = rotationFrom(trak.tkhd && trak.tkhd.matrix);
        // where each track really starts on the movie timeline (sample times + edit lists), measured on the source
        srcTl = {
          movieDurSec: info.duration / info.timescale,
          video: trackTimeline(mp4, { ...vTrack, type: 'video' }, info.timescale),
          audio: aTrack ? trackTimeline(mp4, { ...aTrack, type: 'audio' }, info.timescale) : null,
        };
        mp4.setExtractionOptions(vTrack.id, 'v', { nbSamples: 100000 });
        if (aTrack) {
          mp4.setExtractionOptions(aTrack.id, 'a', { nbSamples: 100000 });
          let esdsBytes = null;
          try {
            const at = mp4.getTrackById(aTrack.id);
            const esds = findEsds(at.mdia.minf.stbl.stsd.entries[0]);
            if (esds) {
              const s = new mp4box.DataStream(undefined, 0, mp4box.Endianness.BIG_ENDIAN);
              esds.write(s);
              esdsBytes = new Uint8Array(s.buffer);
            }
          } catch (e) { esdsBytes = null; }
          const got = getAsc(esdsBytes, aTrack.audio.sample_rate, aTrack.audio.channel_count, aTrack.codec);
          aDesc = got.asc; ascHow = got.how;
        }
        mp4.onSamples = (id, user, samples) => (user === 'v' ? vSamples : aSamples).push(...samples);
        mp4.start();
        res();
      } catch (e) { rej(e); }
    };
  });
  const buf = await file.arrayBuffer();
  buf.fileStart = 0;
  mp4.appendBuffer(buf);
  mp4.flush();
  await ready;
  if (!vSamples.length) throw new Error('no video samples extracted');
  const srcW = vTrack.video.width, srcH = vTrack.video.height;
  const duration = vTrack.duration / vTrack.timescale;
  const fps = Math.min(60, Math.max(10, Math.round(vSamples.length / Math.max(1, duration))));
  const scale = Math.min(1, targetLongSide / Math.max(srcW, srcH));
  const outW = Math.max(2, Math.round((srcW * scale) / 2) * 2);
  const outH = Math.max(2, Math.round((srcH * scale) / 2) * 2);
  const bitrate = Math.round(0.08 * outW * outH * fps);
  // Time of each sample on the movie timeline = its time in the file + the shift given by the edit list
  // (for example an AAC priming packet that the source skips, or a delayed start of one track).
  const shiftVus = Math.round(shiftFromEdits(srcTl.video) * 1e6);
  const shiftAus = Math.round(shiftFromEdits(srcTl.audio) * 1e6);
  const srcSync = syncSummary(srcTl);
  log(`source ${srcW}x${srcH} ${vTrack.codec} ${fps}fps ${duration.toFixed(1)}s rotation ${rotation}; output ${outW}x${outH} ${(bitrate / 1e6).toFixed(1)} Mbps`);
  log(`source timing: sound starts ${srcSync.avOffsetMs === null ? 'n/a' : srcSync.avOffsetMs + ' ms'} after the picture, audio priming ${srcSync.audioPrimingMs} ms, edit lists video ${srcSync.videoEdits} audio ${srcSync.audioEdits}`);

  // ---- configure ----
  const decCfg = { codec: vTrack.codec, codedWidth: srcW, codedHeight: srcH, description: vDesc };
  const decSupport = await VideoDecoder.isConfigSupported(decCfg);
  if (!decSupport.supported) throw new Error('decoder does not support ' + vTrack.codec);
  const encCfg = { codec: 'avc1.640028', width: outW, height: outH, bitrate, framerate: fps, avc: { format: 'avc' } };
  const encSupport = await VideoEncoder.isConfigSupported(encCfg);
  if (!encSupport.supported) throw new Error('encoder does not support H.264 ' + outW + 'x' + outH);

  let audioNote = 'none in source (' + audioInfo + ')';
  // The index (moov) goes last, so that edit lists and the date can be added without moving any data.
  // Each track is rebased to its own first sample; a start offset between the tracks is restored with an edit list.
  const muxOpts = { target: new ArrayBufferTarget(), video: { codec: 'avc', width: outW, height: outH, rotation }, fastStart: false, firstTimestampBehavior: 'offset' };
  const audioOK = !!(aTrack && aSamples.length && aDesc);
  if (audioOK) muxOpts.audio = { codec: 'aac', numberOfChannels: aTrack.audio.channel_count, sampleRate: aTrack.audio.sample_rate };
  else if (aTrack) audioNote = `AAC track found but cannot copy: samples=${aSamples.length}, config=${ascHow || 'none'}; tracks: ${audioInfo}`;
  else if (audioInfo !== 'no audio track') audioNote = `source audio is not AAC, cannot copy into MP4; tracks: ${audioInfo}`;
  const muxer = new Muxer(muxOpts);

  // ---- transcode ----
  let encoded = 0, firstMeta = true, failure = null;
  const frameDur = Math.round(1e6 / fps);
  const vOut = []; // encoded video chunks, kept until they can be written together with the sound, in time order
  const encoder = new VideoEncoder({
    // Safari gives encoded chunks with duration = null, and the muxer rejects that, so copy the bytes
    // and pass an explicit duration (bug found on a real iPhone, iOS 18.7).
    output: (chunk, meta) => {
      try {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const dur = Number.isFinite(chunk.duration) && chunk.duration > 0 ? chunk.duration : frameDur;
        vOut.push({ data, type: chunk.type, ts: Math.max(0, chunk.timestamp), dur, meta });
      } catch (e) { failure = failure || e; }
      encoded++; onProgress(encoded / vSamples.length);
    },
    error: (e) => { failure = failure || e; },
  });
  encoder.configure(encCfg);
  const canvas = scale < 1 ? new OffscreenCanvas(outW, outH) : null;
  const ctx = canvas ? canvas.getContext('2d') : null;
  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        const t = frame.timestamp + shiftVus; // time on the movie timeline
        if (t >= 0) { // frames before the start of the edit list are never shown, so they are not copied
          const dur = frame.duration || frameDur;
          let f2;
          if (canvas) { ctx.drawImage(frame, 0, 0, outW, outH); f2 = new VideoFrame(canvas, { timestamp: t, duration: dur }); }
          else f2 = new VideoFrame(frame, { timestamp: t, duration: dur });
          encoder.encode(f2, { keyFrame: firstMeta });
          f2.close();
          firstMeta = false;
        }
      } catch (e) { failure = failure || e; }
      frame.close();
    },
    error: (e) => { failure = failure || e; },
  });
  decoder.configure(decCfg);
  const us = (v, ts) => Math.round((v * 1e6) / ts);
  for (const s of vSamples) {
    if (failure) break;
    decoder.decode(new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: us(s.cts, s.timescale), duration: us(s.duration, s.timescale), data: s.data }));
    while (decoder.decodeQueueSize > 8 || encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
  }
  await decoder.flush();
  await encoder.flush();
  if (failure) throw failure;
  decoder.close(); encoder.close();
  if (!vOut.length) throw new Error('no video frames were produced');

  // ---- sound: the source packets, with times on the movie timeline (a priming packet cut by the edit list is skipped) ----
  const aOut = [];
  let audioCfg = null, skippedAudio = 0;
  if (audioOK) {
    audioCfg = { codec: aTrack.codec || 'mp4a.40.2', numberOfChannels: aTrack.audio.channel_count, sampleRate: aTrack.audio.sample_rate, description: new Uint8Array(aDesc) };
    for (const s of aSamples) {
      const t = us(s.cts, s.timescale) + shiftAus;
      if (t < 0) { skippedAudio++; continue; }
      const d = us(s.duration, s.timescale);
      aOut.push({ data: new Uint8Array(s.data), type: s.is_sync ? 'key' : 'delta', ts: t, dur: Number.isFinite(d) && d > 0 ? d : Math.round((1024 * 1e6) / aTrack.audio.sample_rate) });
    }
  }

  // ---- write video and sound INTERLEAVED in time order (the muxer stores data in the order it gets it) ----
  const merged = [];
  for (const v of vOut) merged.push({ k: 'v', ...v });
  for (const a of aOut) merged.push({ k: 'a', ...a });
  merged.sort((x, y) => x.ts - y.ts || (x.k === 'a' ? -1 : 1));
  let addedAudio = 0, audioError = null;
  for (const m of merged) {
    if (m.k === 'v') muxer.addVideoChunkRaw(m.data, m.type, m.ts, m.dur, m.meta);
    else if (!audioError) {
      try { muxer.addAudioChunkRaw(m.data, m.type, m.ts, m.dur, { decoderConfig: audioCfg }); addedAudio++; }
      catch (e) { audioError = e; } // keep the video; report that the sound is incomplete
    }
  }
  if (audioOK) {
    audioNote = audioError
      ? `copy failed after ${addedAudio} of ${aSamples.length} packets: ${audioError.message}`
      : `copied (${addedAudio} packets${skippedAudio ? ', skipped ' + skippedAudio + ' before the start' : ''}, config ${ascHow}; tracks: ${audioInfo})`;
  }
  muxer.finalize();
  let bytes = new Uint8Array(muxOpts.target.buffer);

  // ---- keep the start offset between sound and picture (the muxer starts every track at 0) ----
  const vStart = vOut[0].ts, aStart = aOut.length ? aOut[0].ts : null;
  const base = aStart === null ? vStart : Math.min(vStart, aStart);
  const lastEnd = (arr) => (arr.length ? (arr[arr.length - 1].ts + arr[arr.length - 1].dur) / 1e6 : 0);
  let delayNote = 'none';
  if (vStart - base > 2000) { bytes = delayTrack(bytes, 'video', (vStart - base) / 1e6, lastEnd(vOut) - vStart / 1e6); delayNote = `video delayed ${Math.round((vStart - base) / 1000)} ms`; }
  if (aStart !== null && aStart - base > 2000) { bytes = delayTrack(bytes, 'audio', (aStart - base) / 1e6, lastEnd(aOut) - aStart / 1e6); delayNote = `audio delayed ${Math.round((aStart - base) / 1000)} ms`; }

  let dateNote = 'not written';
  if (originalDate) {
    bytes = writeOriginalDate(bytes, originalDate);
    dateNote = 'written ' + (originalDate.creationdate || quickTimeDateString(originalDate.date, originalDate.offsetMinutes));
  }
  let outSync = null;
  try { outSync = await summaryFromBytes(mp4box, bytes); } catch (e) { outSync = null; }
  if (outSync) log(`copy timing: sound starts ${outSync.avOffsetMs === null ? 'n/a' : outSync.avOffsetMs + ' ms'} after the picture (restored offset: ${delayNote}), end difference ${outSync.endDiffMs} ms`);
  const blob = new Blob([bytes], { type: 'video/mp4' });
  return { blob, duration, srcW, srcH, outW, outH, fps, bitrate, audioNote, dateNote, delayNote, sync: { source: srcSync, output: outSync }, frames: vSamples.length };
}
