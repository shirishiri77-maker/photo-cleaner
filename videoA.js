// Method A: decode with WebCodecs, re-encode H.264 at lower size, write MP4. All on the device.
// Spike code: reads the whole file into memory (refuses very large files). Measures, does not polish.
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

export async function compressA(file, { onProgress = () => {}, targetLongSide = 1280, log = () => {} } = {}) {
  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') throw new Error('WebCodecs not available');
  if (file.size > MAX_BYTES) throw new Error('file too large for this test (' + Math.round(file.size / 1048576) + ' MB)');
  const mp4box = await import('./vendor/mp4box/mp4box.all.js');
  const { Muxer, ArrayBufferTarget } = await import('./vendor/mp4-muxer/mp4-muxer.js');

  // ---- demux ----
  const mp4 = mp4box.createFile(true);
  const vSamples = [], aSamples = [];
  let vTrack, aTrack, vDesc, aDesc, rotation = 0;
  const ready = new Promise((res, rej) => {
    mp4.onError = (e) => rej(new Error('demux: ' + e));
    mp4.onReady = (info) => {
      try {
        vTrack = info.videoTracks[0];
        aTrack = info.audioTracks[0];
        if (!vTrack) throw new Error('no video track');
        const trak = mp4.getTrackById(vTrack.id);
        for (const entry of trak.mdia.minf.stbl.stsd.entries) {
          const box = entry.avcC || entry.hvcC;
          if (box) { vDesc = toDesc(mp4box, box); break; }
        }
        rotation = rotationFrom(trak.tkhd && trak.tkhd.matrix);
        mp4.setExtractionOptions(vTrack.id, 'v', { nbSamples: 100000 });
        if (aTrack) {
          mp4.setExtractionOptions(aTrack.id, 'a', { nbSamples: 100000 });
          try {
            const at = mp4.getTrackById(aTrack.id);
            const e0 = at.mdia.minf.stbl.stsd.entries[0];
            aDesc = e0.esds.esd.descs[0].descs[0].data; // AudioSpecificConfig
          } catch (e) { aDesc = null; }
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
  log(`source ${srcW}x${srcH} ${vTrack.codec} ${fps}fps ${duration.toFixed(1)}s rotation ${rotation}; output ${outW}x${outH} ${(bitrate / 1e6).toFixed(1)} Mbps`);

  // ---- configure ----
  const decCfg = { codec: vTrack.codec, codedWidth: srcW, codedHeight: srcH, description: vDesc };
  const decSupport = await VideoDecoder.isConfigSupported(decCfg);
  if (!decSupport.supported) throw new Error('decoder does not support ' + vTrack.codec);
  const encCfg = { codec: 'avc1.640028', width: outW, height: outH, bitrate, framerate: fps, avc: { format: 'avc' } };
  const encSupport = await VideoEncoder.isConfigSupported(encCfg);
  if (!encSupport.supported) throw new Error('encoder does not support H.264 ' + outW + 'x' + outH);

  let audioNote = 'none in source';
  const muxOpts = { target: new ArrayBufferTarget(), video: { codec: 'avc', width: outW, height: outH, rotation }, fastStart: 'in-memory' };
  const audioOK = !!(aTrack && aSamples.length && aDesc);
  if (audioOK) muxOpts.audio = { codec: 'aac', numberOfChannels: aTrack.audio.channel_count, sampleRate: aTrack.audio.sample_rate };
  else if (aTrack) audioNote = 'source has audio but it could not be copied';
  const muxer = new Muxer(muxOpts);

  // ---- transcode ----
  let encoded = 0, firstMeta = true, failure = null;
  const frameDur = Math.round(1e6 / fps);
  const encoder = new VideoEncoder({
    // Safari gives encoded chunks with duration = null, and the muxer rejects that, so copy the bytes
    // and pass an explicit duration (bug found on a real iPhone, iOS 18.7).
    output: (chunk, meta) => {
      try {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const dur = Number.isFinite(chunk.duration) && chunk.duration > 0 ? chunk.duration : frameDur;
        muxer.addVideoChunkRaw(data, chunk.type, Math.max(0, chunk.timestamp), dur, meta);
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
        if (canvas) {
          ctx.drawImage(frame, 0, 0, outW, outH);
          const f2 = new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration || frameDur });
          encoder.encode(f2, { keyFrame: firstMeta });
          f2.close();
        } else {
          encoder.encode(frame, { keyFrame: firstMeta });
        }
        firstMeta = false;
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

  if (audioOK) {
    try {
      const cfg = { codec: aTrack.codec || 'mp4a.40.2', numberOfChannels: aTrack.audio.channel_count, sampleRate: aTrack.audio.sample_rate, description: new Uint8Array(aDesc) };
      let added = 0;
      try {
        for (const s of aSamples) {
          const dur = us(s.duration, s.timescale);
          muxer.addAudioChunkRaw(new Uint8Array(s.data), s.is_sync ? 'key' : 'delta', Math.max(0, us(s.cts, s.timescale)),
            Number.isFinite(dur) && dur > 0 ? dur : Math.round((1024 * 1e6) / aTrack.audio.sample_rate), { decoderConfig: cfg });
          added++;
        }
        audioNote = 'copied (' + added + ' packets)';
      } catch (e) {
        // keep the video; report that sound is incomplete
        audioNote = 'copy failed after ' + added + ' of ' + aSamples.length + ' packets: ' + e.message;
      }
    } catch (e) { audioNote = 'copy failed: ' + e.message; }
  }
  muxer.finalize();
  const blob = new Blob([muxOpts.target.buffer], { type: 'video/mp4' });
  return { blob, duration, srcW, srcH, outW, outH, fps, bitrate, audioNote, frames: vSamples.length };
}
