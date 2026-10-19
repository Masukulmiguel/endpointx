// Author-written fixture mini-app helper (Task 8) — data only, never executed.
function fingerprint(input) {
  let hash = 0;
  const text = String(input);
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

module.exports = { fingerprint };
