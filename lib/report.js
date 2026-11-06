// Builds the plain-text report the tester pastes back. Whitelist only: counts, sizes, timings.
// Never includes file names or photo content.
export function fmtMB(bytes) {
  return (bytes / 1048576).toFixed(1) + ' MB';
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

export function buildReport(r) {
  const L = [];
  const add = (k, v) => L.push(k + ': ' + (v === undefined || v === null ? 'not measured' : v));
  // sound/picture timing of the source and of the copy, in milliseconds (see lib/timeline.js)
  const SYNC_KEYS = [['video_start_ms', 'videoStartMs'], ['audio_start_ms', 'audioStartMs'], ['av_offset_ms', 'avOffsetMs'],
    ['video_end_ms', 'videoEndMs'], ['audio_end_ms', 'audioEndMs'], ['end_diff_ms', 'endDiffMs'],
    ['video_track_dur_ms', 'videoTrackDurMs'], ['audio_track_dur_ms', 'audioTrackDurMs'], ['audio_priming_ms', 'audioPrimingMs'],
    ['video_edits', 'videoEdits'], ['audio_edits', 'audioEdits']];
  const addSync = (prefix, sync) => {
    for (const which of ['source', 'output']) {
      const s = sync && sync[which];
      for (const [label, key] of SYNC_KEYS) add(prefix + '_sync_' + which + '_' + label, s ? s[key] : null);
    }
  };
  L.push('PHOTO-CLEANER PHASE 1 REPORT');
  const env = r.env || {};
  add('page_version', env.version);
  add('page_loads_since_reset', num(r.loads));
  add('interrupted_during', r.interrupted && r.interrupted.length ? r.interrupted.join(' | ') : 'nothing');
  add('app_in_background_during', r.backgrounded && r.backgrounded.length ? r.backgrounded.join(' | ') : 'nothing');
  add('ios', env.ios);
  add('standalone_app', env.standalone);
  add('service_worker', env.serviceWorker);
  add('webcodecs_video_encoder', env.videoEncoder);
  add('wake_lock', env.wakeLock);
  add('share_files', env.shareFiles);
  add('app_quota_only_NOT_phone_storage', env.quota);
  const p = r.picker || {};
  L.push('-- A picker');
  add('items', num(p.items));
  add('photos', num(p.photos));
  add('videos', num(p.videos));
  add('types', p.types ? Object.entries(p.types).map(([k, v]) => k + '=' + v).join(' ') : null);
  add('total', num(p.bytes) !== null ? fmtMB(p.bytes) : null);
  add('files_under_1KB', num(p.tiny));
  add('files_with_date', num(p.withDate));
  add('picks_made', num(p.picks));
  const h = r.hash || {};
  L.push('-- B exact duplicates');
  add('photos_hashed', num(h.hashed));
  add('seconds', num(h.seconds));
  add('exact_groups', num(h.groups));
  add('extra_copies', num(h.extraCopies));
  add('extra_copies_size', num(h.extraBytes) !== null ? fmtMB(h.extraBytes) : null);
  const c = r.control || {};
  L.push('-- T controlled test');
  add('photos', num(c.photos));
  add('exact_groups', num(c.groups));
  add('look_same_but_bytes_differ', num(c.lookSameDifferentBytes));
  add('same_size_but_content_differs', num(c.sameSizeDifferent));
  (c.items || []).forEach((line, i) => add('item_' + (i + 1), line));
  add('pair_distances(i-j:dist)', c.pairs || null);
  const ha = r.hashAll || {};
  L.push('-- B1b hashing speed on all photos');
  add('photos_hashed', num(ha.photos));
  add('failed', num(ha.failed));
  add('seconds', num(ha.seconds));
  add('photos_per_second', num(ha.perSecond));
  add('data_read', num(ha.bytes) !== null ? fmtMB(ha.bytes) : null);
  const l = r.lookalike || {};
  L.push('-- B2 look-alikes (not byte-identical)');
  add('photos_measured', num(l.measured));
  add('seconds', num(l.seconds));
  if (l.pairs) {
    for (const t of Object.keys(l.pairs)) {
      add('pairs_within_' + t + '_bits', l.pairs[t]);
      add('photos_with_partner_within_' + t, l.photosWith ? l.photosWith[t] : null);
    }
  }
  add('examples_shown', num(l.examplesShown));
  add('examples_answered', num(l.examplesAnswered));
  if (l.verdicts) add('tester_verdicts(distance:same/different)', l.verdicts.filter(Boolean).join(' '));
  L.push('-- C video');
  for (const key of ['methodA', 'methodB']) {
    const v = (r.video || {})[key];
    if (!v) { add(key, null); continue; }
    add(key + '_status', v.status);
    add(key + '_input', num(v.inBytes) !== null ? fmtMB(v.inBytes) : null);
    add(key + '_output', num(v.outBytes) !== null ? fmtMB(v.outBytes) : null);
    add(key + '_seconds', num(v.seconds));
    add(key + '_video_seconds', num(v.duration));
    add(key + '_plays', v.plays);
    add(key + '_sound', v.sound);
    add(key + '_tester_heard_sound', v.heardSound);
    add(key + '_tester_sync', v.syncAnswer);
    addSync(key, v.sync);
  }
  const dt = r.date || {};
  const sd = dt.source || {};
  L.push('-- D2 date test (dates and counts only, no file names)');
  add('source_lastModified_NOT_trusted', sd.lastModified);
  add('source_movie_header_time', sd.mvhd);
  add('source_creationdate', sd.creationdate);
  add('source_has_location', sd.hasLocation);
  add('source_has_udta_location', sd.hasUdtaLocation);
  add('date_written_from', sd.usedFrom);
  add('date_written', sd.written);
  for (const [key, label] of [['withFix', 'with_fix'], ['control', 'control']]) {
    const v = dt[key];
    if (!v) { add(label, null); continue; }
    add(label + '_status', v.status);
    add(label + '_input', num(v.inBytes) !== null ? fmtMB(v.inBytes) : null);
    add(label + '_output', num(v.outBytes) !== null ? fmtMB(v.outBytes) : null);
    add(label + '_seconds', num(v.seconds));
    add(label + '_sound', v.sound);
    add(label + '_plays', v.plays);
    add(label + '_tester_heard_sound', v.heardSound);
    add(label + '_tester_sync', v.syncAnswer);
    addSync(label, v.sync);
    add(label + '_share_sheet', v.shareOpened);
    add(label + '_photos_shows', v.photosDate);
    add(label + '_right_place_in_library', v.rightPlace);
  }
  const d = r.save || {};
  L.push('-- D save and photos');
  add('share_sheet_opened', d.shareOpened);
  add('save_video_option_seen', d.saveSeen);
  add('video_landed_in_photos', d.landed);
  add('photos_app_opened', d.photosOpened);
  add('offline_opened', (r.install || {}).offline);
  return L.join('\n');
}
