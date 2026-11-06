// Controlled test: few photos, show for each its size and short fingerprint, and say in plain Hebrew
// whether exact copies were found, and if not, why. Pure logic, tested in Node.
import { hamming } from './grouping.js';

// items: [{type, size, hash (full SHA-256 hex), dh: [hi, lo]}]
export function analyzeControl(items) {
  const byHash = new Map();
  items.forEach((it, i) => {
    if (!it.hash) return;
    const k = it.size + ':' + it.hash;
    if (!byHash.has(k)) byHash.set(k, []);
    byHash.get(k).push(i);
  });
  const groups = [...byHash.values()].filter((g) => g.length > 1);
  const sameSizeDifferent = [];
  const lookSameDifferentBytes = [];
  const distances = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const identical = a.hash && a.hash === b.hash && a.size === b.size;
      const dist = a.dh && b.dh ? hamming(a.dh, b.dh) : null;
      if (dist !== null) distances.push({ i, j, dist });
      if (!identical && a.size === b.size) sameSizeDifferent.push([i, j]);
      if (!identical && dist !== null && dist <= 4) lookSameDifferentBytes.push({ i, j, dist });
    }
  }
  return { groups, sameSizeDifferent, lookSameDifferentBytes, distances };
}

const n = (i) => i + 1;
const mb = (b) => (b / 1048576).toFixed(2) + ' MB';
const list = (idx) => idx.map(n).join(' ו-');

export function verdictHebrew(items, a) {
  const lines = [];
  if (a.groups.length) {
    const head = a.groups.length === 1 ? '✓ נמצאה קבוצה אחת של עותקים זהים לגמרי: ' : `✓ נמצאו ${a.groups.length} קבוצות של עותקים זהים לגמרי: `;
    lines.push(head + a.groups.map((g) => 'תמונות ' + list(g)).join('; ') + '.');
  } else {
    lines.push('✗ לא נמצאו עותקים זהים לגמרי.');
  }
  for (const p of a.lookSameDifferentBytes) {
    lines.push(`תמונות ${n(p.i)} ו-${n(p.j)} נראות כמעט אותו דבר (הבדל ${p.dist}) אבל הקבצים שונים: ${mb(items[p.i].size)} מול ${mb(items[p.j].size)}.`);
  }
  for (const [i, j] of a.sameSizeDifferent) {
    lines.push(`תמונות ${n(i)} ו-${n(j)} באותו גודל אבל התוכן שונה.`);
  }
  return lines.join('\n');
}

export const shortFp = (hash) => (hash || '').slice(0, 8);

// Report block: sizes, types, short fingerprints and pair distances only. No names, no photo content.
export function controlReportData(items, a) {
  return {
    photos: items.length,
    groups: a.groups.length,
    lookSameDifferentBytes: a.lookSameDifferentBytes.length,
    sameSizeDifferent: a.sameSizeDifferent.length,
    items: items.map((it, i) => `p${n(i)} ${it.type || '?'} ${it.size}B fp=${shortFp(it.hash)}`),
    pairs: a.distances.map((d) => `${n(d.i)}-${n(d.j)}:${d.dist}`).join(' '),
  };
}
