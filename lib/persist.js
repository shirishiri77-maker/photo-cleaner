// Keeps the measurements across page reloads and records when a long step was cut off.
// Only the report numbers are stored (counts, sizes, timings, yes/no answers). No file names, no photos.
// `storage` is window.localStorage or null; every call is safe if storage is missing or throws.
const KEY = 'pc_phase1_state_v1';
const INFLIGHT = 'pc_phase1_inflight_v1';

export function saveState(storage, R) {
  try { storage.setItem(KEY, JSON.stringify({ savedAt: Date.now(), R })); return true; } catch (e) { return false; }
}
export function loadState(storage) {
  try { const t = storage.getItem(KEY); return t ? JSON.parse(t) : null; } catch (e) { return null; }
}
export function clearState(storage) {
  try { storage.removeItem(KEY); storage.removeItem(INFLIGHT); } catch (e) { /* ignore */ }
}

// Called before a long step. If the page is killed, this marker survives and is found on the next load.
export function markInflight(storage, step, now = Date.now()) {
  try { storage.setItem(INFLIGHT, JSON.stringify({ step, startedAt: now, hidden: 0 })); } catch (e) { /* ignore */ }
}
export function bumpHidden(storage) {
  try {
    const t = storage.getItem(INFLIGHT);
    if (!t) return;
    const o = JSON.parse(t);
    o.hidden = (o.hidden || 0) + 1;
    storage.setItem(INFLIGHT, JSON.stringify(o));
  } catch (e) { /* ignore */ }
}
export function readInflight(storage) {
  try { const t = storage.getItem(INFLIGHT); return t ? JSON.parse(t) : null; } catch (e) { return null; }
}
export function clearInflight(storage) {
  try { storage.removeItem(INFLIGHT); } catch (e) { /* ignore */ }
}

// A step marker found at startup means the previous page did not finish it: reload, crash, or the system
// closed the page (often memory). Returns a short note for the report.
export function interruptionNote(inflight, now = Date.now()) {
  if (!inflight || !inflight.step) return null;
  const secs = Math.max(0, Math.round((now - inflight.startedAt) / 1000));
  return `${inflight.step} (page was gone ${secs}s after the step started; app was in background ${inflight.hidden || 0} times)`;
}

// Saved sections come back; environment fields always come from the current page.
export function mergeState(fresh, saved) {
  if (!saved || !saved.R) return fresh;
  const out = { ...fresh };
  for (const k of Object.keys(saved.R)) {
    if (k === 'env') continue;
    out[k] = saved.R[k];
  }
  out.env = fresh.env;
  return out;
}
