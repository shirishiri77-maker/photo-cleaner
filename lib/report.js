// Builds the plain-text report the tester pastes back. Whitelist only: counts, sizes, timings.
// Never includes file names or photo content.
export function fmtMB(bytes) {
  return (bytes / 1048576).toFixed(1) + ' MB';
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

export function buildReport(r) {
  const L = [];
  const add = (k, v) => L.push(k + ': ' + (v === undefined || v === null ? 'not measured' : v));
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
