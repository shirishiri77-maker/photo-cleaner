// Phase 1 measurement page. Measures only. No network, no storage of photos.
import { groupBySize, groupByHash, summarizeGroups, dhashFromGray, lookAlikeStats } from './lib/grouping.js';
import { buildReport, fmtMB } from './lib/report.js';
import { saveState, loadState, clearState, markInflight, bumpHidden, readInflight, clearInflight, interruptionNote, mergeState } from './lib/persist.js';
import { compressA } from './videoA.js';

const $ = (id) => document.getElementById(id);
const PAGE_VERSION = 'phase1-run3';
const freshR = () => ({ env: { version: PAGE_VERSION }, picker: {}, hash: {}, hashAll: {}, lookalike: {}, video: {}, save: {}, install: {}, interrupted: [], backgrounded: [], loads: 0 });
let store = null;
try { store = window.localStorage; } catch (e) { store = null; }

// ---- saved results from earlier page loads (the page can be reloaded or closed by iOS) ----
const saved = store ? loadState(store) : null;
let R = mergeState(freshR(), saved);
R.interrupted = R.interrupted || []; R.backgrounded = R.backgrounded || [];
R.loads = (R.loads || 0) + 1;
const inflight = store ? readInflight(store) : null;
const note = interruptionNote(inflight);
if (note) {
  R.interrupted.push(note);
  clearInflight(store);
  const w = $('interruptedInfo');
  w.hidden = false;
  w.textContent = 'שים לב: הדף נסגר או נטען מחדש באמצע שלב: ' + note + '. זה מידע חשוב, הוא נכנס לדוח.';
}

let files = []; // accumulated picks (in memory only): {id, file}
let nextId = 1;
let contentHashes = new Map(); // id -> sha256 hex
let videoFile = null;
let pickedThisLoad = false;
const outs = {}; // method -> {blob, url, card}
const verdicts = [];

function isPhoto(f) { return /^image\//.test(f.type) || /\.(jpe?g|heic|heif|png|gif|webp)$/i.test(f.name || ''); }
function isVideo(f) { return /^video\//.test(f.type) || /\.(mov|mp4|m4v)$/i.test(f.name || ''); }

function refreshReport() {
  const text = buildReport(R);
  $('reportOut').textContent = text;
  $('topReport').textContent = text;
  const ok = store ? saveState(store, R) : false;
  const t = new Date().toLocaleTimeString('he-IL');
  $('savedInfo').textContent = ok
    ? `נשמר במכשיר ב-${t}. אם הדף ייסגר, התוצאות יחכו כאן. הדף נטען ${R.loads} פעמים.`
    : 'לא ניתן לשמור במכשיר. העתק תוצאות ידנית אחרי כל חלק.';
}

// Marks a long step so that, if the page dies, the next load knows which step it was.
async function tracked(step, fn) {
  if (store) markInflight(store, step);
  try { return await fn(); }
  finally {
    if (store) {
      const inf = readInflight(store);
      if (inf && inf.hidden > 0) R.backgrounded.push(step + ' x' + inf.hidden);
      clearInflight(store);
    }
  }
}
document.addEventListener('visibilitychange', () => { if (document.hidden && store) bumpHidden(store); });

// ---------- yes / no buttons with a visible selected state ----------
function makeYN(get, set) {
  const wrap = document.createElement('span');
  wrap.className = 'yn';
  const mk = (label, val, cls) => {
    const b = document.createElement('button');
    b.className = 'ynbtn ' + cls;
    b.dataset.val = val;
    b.onclick = () => { set(val); paint(); refreshReport(); };
    return b;
  };
  const bY = mk('כן', true, 'yes'), bN = mk('לא', false, 'no');
  function paint() {
    const v = get();
    for (const [b, val, label] of [[bY, true, 'כן'], [bN, false, 'לא']]) {
      const sel = v === val;
      b.classList.toggle('selected', sel);
      b.setAttribute('aria-pressed', String(sel));
      b.textContent = (sel ? '✓ ' : '') + label;
    }
  }
  wrap.append(bY, bN);
  paint();
  return wrap;
}
const staticAnswers = {
  offline: [() => R.install.offline, (v) => { R.install.offline = v; }],
  saveSeen: [() => R.save.saveSeen, (v) => { R.save.saveSeen = v; }],
  landed: [() => R.save.landed, (v) => { R.save.landed = v; }],
  photosOpened: [() => R.save.photosOpened, (v) => { R.save.photosOpened = v; }],
};
document.querySelectorAll('.yn[data-key]').forEach((el) => {
  const [g, s] = staticAnswers[el.dataset.key];
  el.replaceWith(makeYN(g, s));
});

// ---------- F. environment ----------
async function envInit() {
  const ua = navigator.userAgent;
  const m = ua.match(/OS (\d+)[_.](\d+)/);
  R.env.ios = m ? m[1] + '.' + m[2] : 'unknown (' + (/iPhone|iPad/.test(ua) ? 'iOS' : 'not iOS') + ')';
  R.env.standalone = !!(navigator.standalone || matchMedia('(display-mode: standalone)').matches);
  R.env.videoEncoder = typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
  if (R.env.videoEncoder) {
    try {
      const s = await VideoEncoder.isConfigSupported({ codec: 'avc1.42001f', width: 1280, height: 720, bitrate: 2e6 });
      R.env.videoEncoder = 'yes, H.264 720p supported=' + !!s.supported;
    } catch (e) { R.env.videoEncoder = 'yes but check failed'; }
  } else { R.env.videoEncoder = 'no'; }
  R.env.wakeLock = 'wakeLock' in navigator;
  try {
    const probe = new File(['x'], 'x.txt', { type: 'text/plain' });
    R.env.shareFiles = !!(navigator.canShare && navigator.canShare({ files: [probe] }));
  } catch (e) { R.env.shareFiles = false; }
  try {
    const q = await navigator.storage.estimate();
    R.env.quota = 'usage ' + fmtMB(q.usage || 0) + ' of quota ' + fmtMB(q.quota || 0);
  } catch (e) { R.env.quota = 'unavailable'; }
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); R.env.serviceWorker = 'registered'; }
    catch (e) { R.env.serviceWorker = 'failed'; }
  } else { R.env.serviceWorker = 'not supported'; }
  $('envOut').textContent =
    'iOS: ' + R.env.ios + '\nruns as home-screen app: ' + R.env.standalone +
    '\nWebCodecs encoder: ' + R.env.videoEncoder + '\nscreen wake lock: ' + R.env.wakeLock +
    '\nshare files: ' + R.env.shareFiles + '\nservice worker: ' + R.env.serviceWorker +
    '\napp quota (NOT phone storage): ' + R.env.quota;
  refreshReport();
}

// ---------- A. picker ----------
function showPicks() {
  const types = {};
  let bytes = 0, tiny = 0, withDate = 0, photos = 0, videos = 0;
  for (const { file } of files) {
    const t = file.type || (file.name.split('.').pop() || '?').toLowerCase();
    types[t] = (types[t] || 0) + 1;
    bytes += file.size;
    if (file.size < 1024) tiny++;
    if (file.lastModified) withDate++;
    if (isPhoto(file)) photos++; else if (isVideo(file)) videos++;
  }
  Object.assign(R.picker, { items: files.length, photos, videos, types, bytes, tiny, withDate });
  $('pickOut').textContent = files.length
    ? `items: ${files.length}\nphotos: ${photos}\nvideos: ${videos}\ntotal: ${fmtMB(bytes)}\nunder 1 KB: ${tiny}\nwith date: ${withDate}\ntypes: ` +
      Object.entries(types).map(([k, v]) => k + '=' + v).join(' ')
    : 'nothing picked yet';
  $('hashBtn').disabled = photos < 2;
  $('hashAllBtn').disabled = photos < 1;
  $('lookBtn').disabled = photos < 2;
  refreshReport();
}
$('picker').addEventListener('change', (e) => {
  const t0 = performance.now();
  if (!pickedThisLoad) { R.picker = {}; pickedThisLoad = true; } // measurements describe this page load
  const list = [...e.target.files];
  for (const f of list) files.push({ id: nextId++, file: f });
  R.picker.picks = (R.picker.picks || 0) + 1;
  R.picker.lastPickMs = Math.round(performance.now() - t0);
  e.target.value = '';
  showPicks();
});
$('clearPicks').addEventListener('click', () => { files = []; contentHashes = new Map(); R.picker = {}; showPicks(); });

// ---------- B. exact duplicates ----------
$('hashBtn').addEventListener('click', () => tracked('exact-duplicates', async () => {
  const photos = files.filter((x) => isPhoto(x.file)).map((x) => ({ id: x.id, size: x.file.size, file: x.file }));
  const candidates = groupBySize(photos).flat();
  const prog = $('hashProg');
  prog.hidden = false; prog.max = Math.max(1, candidates.length); prog.value = 0;
  const t0 = performance.now();
  const worker = new Worker('worker.js');
  const results = [];
  try {
    for (const c of candidates) {
      const hash = await new Promise((res) => {
        worker.onmessage = (ev) => res(ev.data.hash || null);
        worker.postMessage({ id: c.id, file: c.file });
      });
      if (hash) { contentHashes.set(c.id, hash); results.push({ id: c.id, size: c.size, hash }); }
      prog.value++;
      await new Promise((r) => setTimeout(r)); // let the UI breathe
    }
  } finally { worker.terminate(); }
  const secs = (performance.now() - t0) / 1000;
  const sum = summarizeGroups(groupByHash(results));
  Object.assign(R.hash, {
    hashed: candidates.length, seconds: Math.round(secs * 10) / 10,
    groups: sum.groups, extraCopies: sum.extraCopies, extraBytes: sum.extraBytes,
  });
  $('hashOut').textContent =
    `photos total: ${photos.length}\nhashed (same size as another photo): ${candidates.length}\nseconds: ${R.hash.seconds}\n` +
    `exact groups: ${sum.groups}\nextra copies: ${sum.extraCopies}\nsize of extra copies: ${fmtMB(sum.extraBytes)}`;
  prog.hidden = true;
  refreshReport();
}));

// ---------- B1b. hashing speed on ALL photos (measurement) ----------
$('hashAllBtn').addEventListener('click', () => tracked('hash-all-speed', async () => {
  const photos = files.filter((x) => isPhoto(x.file));
  const prog = $('hashProg');
  prog.hidden = false; prog.max = Math.max(1, photos.length); prog.value = 0;
  const t0 = performance.now();
  const worker = new Worker('worker.js');
  let bytes = 0, failed = 0;
  try {
    for (const p of photos) {
      const hash = await new Promise((res) => {
        worker.onmessage = (ev) => res(ev.data.hash || null);
        worker.postMessage({ id: p.id, file: p.file });
      });
      if (hash) { contentHashes.set(p.id, hash); bytes += p.file.size; } else failed++;
      prog.value++;
      if (prog.value % 10 === 0) await new Promise((r) => setTimeout(r));
    }
  } finally { worker.terminate(); }
  const secs = (performance.now() - t0) / 1000;
  Object.assign(R.hashAll, {
    photos: photos.length, failed, seconds: Math.round(secs * 10) / 10, bytes,
    perSecond: Math.round((photos.length / Math.max(secs, 0.01)) * 10) / 10,
  });
  $('hashAllOut').textContent = `photos hashed: ${photos.length} (failed ${failed})\nseconds: ${R.hashAll.seconds}\nphotos per second: ${R.hashAll.perSecond}\ndata read: ${fmtMB(bytes)}`;
  prog.hidden = true;
  refreshReport();
}));

// ---------- B2. look-alikes (measurement only) ----------
async function grayHash(file) {
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas');
  c.width = 9; c.height = 8;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, 9, 8);
  if (bmp.close) bmp.close();
  const d = ctx.getImageData(0, 0, 9, 8).data;
  const gray = [];
  for (let i = 0; i < 72; i++) gray.push(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
  return dhashFromGray(gray);
}
$('lookBtn').addEventListener('click', () => tracked('look-alikes', async () => {
  const photos = files.filter((x) => isPhoto(x.file));
  const prog = $('lookProg');
  prog.hidden = false; prog.max = photos.length; prog.value = 0;
  const t0 = performance.now();
  const items = [];
  let failed = 0;
  for (const p of photos) {
    try {
      items.push({ id: p.id, contentHash: contentHashes.get(p.id) || null, dhash: await grayHash(p.file) });
    } catch (e) { failed++; }
    prog.value++;
    if (prog.value % 20 === 0) await new Promise((r) => setTimeout(r));
  }
  const stats = lookAlikeStats(items, undefined, 8);
  Object.assign(R.lookalike, {
    measured: items.length, seconds: Math.round((performance.now() - t0) / 100) / 10,
    pairs: stats.pairsAtThreshold, photosWith: stats.photosWithLookAlike, verdicts: [],
  });
  let txt = `measured: ${items.length} (could not read: ${failed})\n`;
  for (const t of Object.keys(stats.pairsAtThreshold)) {
    txt += `within ${t} bits: ${stats.pairsAtThreshold[t]} pairs, ${stats.photosWithLookAlike[t]} photos\n`;
  }
  $('lookOut').textContent = txt + '\nNote: run "find exact duplicates" first so identical copies are not counted here.';
  prog.hidden = true;
  renderPairs(stats.samples);
  refreshReport();
}));
function renderPairs(samples) {
  const box = $('pairs');
  box.textContent = '';
  const byId = new Map(files.map((x) => [x.id, x.file]));
  verdicts.length = 0;
  const total = samples.length;
  const head = document.createElement('p');
  head.className = 'pairhead';
  const upd = () => {
    const answered = verdicts.filter(Boolean).length;
    head.textContent = total
      ? `עכשיו תורך: לכל זוג תמונות למטה לחץ "אותה תמונה" או "תמונות שונות". אפשר לתקן תשובה. נענו ${answered} מתוך ${total}.`
      : 'לא נמצאו זוגות דומים להציג.';
    R.lookalike.examplesShown = total;
    R.lookalike.examplesAnswered = answered;
    R.lookalike.verdicts = verdicts.slice();
  };
  box.appendChild(head);
  upd();
  samples.forEach((s, idx) => {
    const card = document.createElement('div');
    card.className = 'paircard';
    const imgs = document.createElement('div');
    imgs.className = 'pair';
    for (const id of [s.a, s.b]) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(byId.get(id));
      imgs.appendChild(img);
    }
    card.appendChild(imgs);
    const label = document.createElement('p');
    label.textContent = 'הבדל בין התמונות: ' + s.dist + ' (0 = כמעט זהות)';
    card.appendChild(label);
    const btns = document.createElement('div');
    btns.className = 'verdicts';
    const mk = (txt, val, cls) => {
      const b = document.createElement('button');
      b.className = 'ynbtn ' + cls;
      b.dataset.txt = txt;
      b.onclick = () => { verdicts[idx] = s.dist + ':' + val; paint(); upd(); refreshReport(); };
      return [b, val, txt];
    };
    const items = [mk('אותה תמונה', 'same', 'yes'), mk('תמונות שונות', 'different', 'no')];
    const paint = () => {
      const cur = verdicts[idx] ? verdicts[idx].split(':')[1] : null;
      card.classList.toggle('answered', !!cur);
      for (const [b, val, txt] of items) {
        const sel = cur === val;
        b.classList.toggle('selected', sel);
        b.setAttribute('aria-pressed', String(sel));
        b.textContent = (sel ? '✓ ' : '') + txt;
      }
    };
    items.forEach(([b]) => btns.appendChild(b));
    paint();
    card.appendChild(btns);
    box.appendChild(card);
  });
}

// ---------- C. video ----------
$('videoPicker').addEventListener('change', (e) => {
  videoFile = e.target.files[0] || null;
  e.target.value = '';
  if (!videoFile) return;
  const v = document.createElement('video');
  v.preload = 'metadata'; v.muted = true; v.playsInline = true;
  const url = URL.createObjectURL(videoFile);
  v.src = url;
  v.onloadedmetadata = () => {
    videoFile.__dur = v.duration;
    $('videoInfo').textContent = `size: ${fmtMB(videoFile.size)}\nlength: ${Math.round(v.duration)} s\nresolution: ${v.videoWidth}x${v.videoHeight}`;
    URL.revokeObjectURL(url);
  };
  v.onerror = () => { $('videoInfo').textContent = 'cannot read this video'; };
  $('methodA').disabled = false;
  $('methodB').disabled = false;
  $('vidOut').textContent = '';
});

let wake = null;
async function keepAwake() { try { if ('wakeLock' in navigator) wake = await navigator.wakeLock.request('screen'); } catch (e) { /* ignore */ } }
function releaseAwake() { try { if (wake) wake.release(); } catch (e) { /* ignore */ } wake = null; }

// One result card per method, each with its own yes/no answers and its own save button.
function addResultCard(method, blob) {
  const rec = R.video[method];
  const old = outs[method];
  if (old) { URL.revokeObjectURL(old.url); old.card.remove(); }
  const url = URL.createObjectURL(blob);
  const card = document.createElement('div');
  card.className = 'paircard';
  const h = document.createElement('h3');
  h.textContent = method === 'methodA' ? 'תוצאה: שיטה א' : 'תוצאה: שיטה ב';
  const vid = document.createElement('video');
  vid.src = url; vid.controls = true; vid.playsInline = true;
  const sz = document.createElement('p');
  sz.textContent = `${fmtMB(rec.inBytes)} ← ${fmtMB(blob.size)}`;
  const q1 = document.createElement('p');
  q1.append('האם הסרטון מתנגן? ', makeYN(() => rec.plays, (v) => { rec.plays = v; }));
  const q2 = document.createElement('p');
  q2.append('האם יש בו קול? ', makeYN(() => rec.heardSound, (v) => { rec.heardSound = v; }));
  const save = document.createElement('button');
  save.textContent = 'שמור ל"תמונות" (שיטה ' + (method === 'methodA' ? 'א' : 'ב') + ')';
  save.onclick = () => saveBlob(method);
  card.append(h, vid, sz, q1, q2, save);
  $('videoResults').appendChild(card);
  outs[method] = { blob, url, card };
}

$('methodA').addEventListener('click', () => tracked('video-method-A', async () => {
  const rec = { status: 'started', inBytes: videoFile.size, duration: Math.round(videoFile.__dur || 0) };
  R.video.methodA = rec;
  refreshReport();
  const prog = $('vidProg');
  prog.hidden = false; prog.value = 0; prog.max = 1;
  const t0 = performance.now();
  const notes = [];
  await keepAwake();
  try {
    const r = await compressA(videoFile, { onProgress: (p) => { prog.value = p; }, log: (m) => notes.push(m) });
    Object.assign(rec, {
      status: r.blob.size < videoFile.size ? 'ok, smaller' : 'ok but NOT smaller',
      outBytes: r.blob.size, seconds: Math.round((performance.now() - t0) / 100) / 10,
      sound: r.audioNote, format: 'mp4 H.264 ' + r.outW + 'x' + r.outH,
    });
    addResultCard('methodA', r.blob);
    $('vidOut').textContent = notes.concat([
      `in: ${fmtMB(rec.inBytes)}`, `out: ${fmtMB(rec.outBytes)}`, `seconds: ${rec.seconds}`,
      `sound: ${rec.sound}`, `status: ${rec.status}`]).join('\n');
  } catch (err) {
    rec.status = 'failed: ' + (err && err.message || err);
    rec.seconds = Math.round((performance.now() - t0) / 100) / 10;
    $('vidOut').textContent = notes.concat([rec.status]).join('\n');
  } finally {
    releaseAwake();
    prog.hidden = true;
    refreshReport();
  }
}));

$('methodB').addEventListener('click', () => tracked('video-method-B', async () => {
  const rec = { status: 'started', inBytes: videoFile.size, duration: Math.round(videoFile.__dur || 0) };
  R.video.methodB = rec;
  refreshReport();
  const prog = $('vidProg');
  prog.hidden = false; prog.value = 0; prog.max = 1;
  const t0 = performance.now();
  const url = URL.createObjectURL(videoFile);
  const v = document.createElement('video');
  v.src = url; v.playsInline = true; v.muted = false; v.preload = 'auto';
  v.style.cssText = 'position:fixed;left:-9999px;width:2px;height:2px';
  document.body.appendChild(v);
  await keepAwake();
  try {
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('cannot load video')); });
    const w = v.videoWidth, h = v.videoHeight;
    const scale = Math.min(1, 1280 / Math.max(w, h));
    const cw = Math.round((w * scale) / 2) * 2, ch = Math.round((h * scale) / 2) * 2;
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(30);
    let sound = 'no';
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      const src = ac.createMediaElementSource(v);
      const dest = ac.createMediaStreamDestination();
      src.connect(dest);
      dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
      if (dest.stream.getAudioTracks().length) sound = 'attempted';
    } catch (e) { sound = 'no (' + e.name + ')'; }
    const mimes = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
    const mime = mimes.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error('MediaRecorder has no supported video format');
    const rec2 = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2000000 });
    const chunks = [];
    rec2.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise((res) => { rec2.onstop = res; });
    rec2.start(1000);
    let raf;
    const draw = () => {
      ctx.drawImage(v, 0, 0, cw, ch);
      prog.value = v.duration ? v.currentTime / v.duration : 0;
      raf = requestAnimationFrame(draw);
    };
    await v.play();
    draw();
    await new Promise((res) => { v.onended = res; });
    cancelAnimationFrame(raf);
    rec2.stop();
    await done;
    const outBlob = new Blob(chunks, { type: mime.split(';')[0] });
    Object.assign(rec, {
      status: outBlob.size < videoFile.size ? 'ok, smaller' : 'ok but NOT smaller',
      outBytes: outBlob.size, seconds: Math.round((performance.now() - t0) / 100) / 10, sound, format: mime,
    });
    addResultCard('methodB', outBlob);
    $('vidOut').textContent = `format: ${mime}\nin: ${fmtMB(rec.inBytes)}\nout: ${fmtMB(rec.outBytes)}\nseconds: ${rec.seconds}\nstatus: ${rec.status}`;
  } catch (err) {
    rec.status = 'failed: ' + (err && err.message || err);
    $('vidOut').textContent = rec.status;
  } finally {
    releaseAwake();
    v.remove(); URL.revokeObjectURL(url);
    prog.hidden = true;
    refreshReport();
  }
}));

// ---------- D. save / Photos ----------
async function saveBlob(method) {
  const o = outs[method];
  if (!o) return;
  const ext = o.blob.type === 'video/mp4' ? 'mp4' : 'webm';
  const f = new File([o.blob], 'compressed-' + method + '.' + ext, { type: o.blob.type });
  R.save.savedMethod = method;
  try {
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
      await navigator.share({ files: [f] });
      R.save.shareOpened = true;
      $('saveOut').textContent = 'share sheet opened for ' + method;
    } else {
      R.save.shareOpened = false;
      const a = document.createElement('a');
      a.href = o.url; a.download = f.name; a.click();
      $('saveOut').textContent = 'share not available, tried download instead';
    }
  } catch (e) {
    R.save.shareOpened = e.name === 'AbortError' ? 'opened then cancelled' : 'error ' + e.name;
    $('saveOut').textContent = String(e.name);
  }
  refreshReport();
}
$('photosBtn').addEventListener('click', () => { location.href = 'photos-redirect://'; });

// ---------- copy / reset ----------
async function copyReport(btn) {
  refreshReport();
  const text = $('reportOut').textContent;
  const label = btn.dataset.label || (btn.dataset.label = btn.textContent);
  try { await navigator.clipboard.writeText(text); btn.textContent = '✓ הועתק'; }
  catch (e) {
    const r = document.createRange(); r.selectNodeContents($('reportOut'));
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    $('secR').scrollIntoView();
    btn.textContent = 'סומן למטה, העתק ידנית';
  }
  setTimeout(() => { btn.textContent = label; }, 2500);
}
document.querySelectorAll('.copyBtn').forEach((b) => b.addEventListener('click', () => copyReport(b)));

let resetArmed = false;
$('resetBtn').addEventListener('click', (e) => {
  if (!resetArmed) {
    resetArmed = true;
    e.target.textContent = 'לחץ שוב כדי למחוק את כל התוצאות השמורות';
    setTimeout(() => { resetArmed = false; e.target.textContent = 'התחל מחדש (מוחק תוצאות שמורות)'; }, 5000);
    return;
  }
  if (store) clearState(store);
  location.reload();
});

envInit();
refreshReport();
