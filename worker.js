// Hashes photo files with SHA-256, one at a time. Nothing leaves the device.
self.onmessage = async (ev) => {
  const { id, file } = ev.data;
  try {
    const buf = await file.arrayBuffer();
    const dig = await crypto.subtle.digest('SHA-256', buf);
    const hex = [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, '0')).join('');
    self.postMessage({ id, hash: hex });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
