// Pure logic: duplicate grouping and look-alike (perceptual hash) math.
// Used by the page (browser) and by the Node tests.

// items: [{id, size}] -> groups of 2+ ids that share a size (size 0 ignored: empty files).
export function groupBySize(items) {
  const map = new Map();
  for (const it of items) {
    if (!it.size) continue;
    if (!map.has(it.size)) map.set(it.size, []);
    map.get(it.size).push(it);
  }
  return [...map.values()].filter((g) => g.length > 1);
}

// items: [{id, size, hash}] -> groups of 2+ with identical hash (and size).
export function groupByHash(items) {
  const map = new Map();
  for (const it of items) {
    if (!it.hash) continue;
    const key = it.size + ':' + it.hash;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  }
  return [...map.values()].filter((g) => g.length > 1);
}

// groups -> {groups, extraCopies, extraBytes}. One copy per group is "kept".
export function summarizeGroups(groups) {
  let extraCopies = 0;
  let extraBytes = 0;
  for (const g of groups) {
    extraCopies += g.length - 1;
    extraBytes += (g.length - 1) * g[0].size;
  }
  return { groups: groups.length, extraCopies, extraBytes };
}

// ---- perceptual hash (dHash) ----
// gray: array of 72 numbers (9 columns x 8 rows, row-major). Returns [hi, lo] uint32 pair.
export function dhashFromGray(gray) {
  if (gray.length !== 72) throw new Error('dhash needs 72 gray values');
  let bits = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits.push(gray[y * 9 + x] > gray[y * 9 + x + 1] ? 1 : 0);
    }
  }
  let hi = 0, lo = 0;
  for (let i = 0; i < 32; i++) hi = ((hi << 1) | bits[i]) >>> 0;
  for (let i = 32; i < 64; i++) lo = ((lo << 1) | bits[i]) >>> 0;
  return [hi, lo];
}

function popcount32(v) {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function hamming(a, b) {
  return popcount32((a[0] ^ b[0]) >>> 0) + popcount32((a[1] ^ b[1]) >>> 0);
}

// items: [{id, contentHash, dhash:[hi,lo]}]. Pairs with identical contentHash are exact
// duplicates and are NOT counted as look-alikes.
// Returns {pairsAtThreshold: {t: count}, photosWithLookAlike: {t: count}, samples: [{a,b,dist}]}
export function lookAlikeStats(items, thresholds = [0, 2, 4, 6, 8, 10], maxSamples = 5) {
  const maxT = Math.max(...thresholds);
  const pairs = Object.fromEntries(thresholds.map((t) => [t, 0]));
  const withPartner = Object.fromEntries(thresholds.map((t) => [t, new Set()]));
  const byDist = new Map();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const A = items[i], B = items[j];
      if (A.contentHash && A.contentHash === B.contentHash) continue;
      const d = hamming(A.dhash, B.dhash);
      if (d > maxT) continue;
      for (const t of thresholds) {
        if (d <= t) {
          pairs[t]++;
          withPartner[t].add(A.id);
          withPartner[t].add(B.id);
        }
      }
      if (!byDist.has(d)) byDist.set(d, []);
      const arr = byDist.get(d);
      if (arr.length < 2) arr.push({ a: A.id, b: B.id, dist: d });
    }
  }
  // spread samples across distances so the tester sees near and far cases
  const dists = [...byDist.keys()].sort((x, y) => x - y);
  const samples = [];
  let round = 0;
  while (samples.length < maxSamples && dists.length) {
    let added = false;
    for (const d of dists) {
      const s = byDist.get(d)[round];
      if (s && samples.length < maxSamples) { samples.push(s); added = true; }
    }
    if (!added) break;
    round++;
  }
  return {
    pairsAtThreshold: pairs,
    photosWithLookAlike: Object.fromEntries(thresholds.map((t) => [t, withPartner[t].size])),
    samples,
  };
}
