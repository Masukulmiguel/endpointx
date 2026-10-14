/**
 * OUI vendor lookup from the IEEE OUI registry (oui-data package).
 * Never throws: a malformed MAC, an unregistered OUI, or a package
 * load failure degrades to null.
 */

let cache: Record<string, string> | null = null;
let loaded = false;

function load(): Record<string, string> | null {
  if (!loaded) {
    loaded = true;
    try {
      cache = require('oui-data');
    } catch {
      cache = null;
    }
  }
  return cache;
}

function normalizeMac(mac: string): string | null {
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length < 6) return null;
  if (/[^0-9a-f]/.test(hex)) return null;
  return hex;
}

function sanitize(value: string | undefined): string | null {
  if (!value) return null;
  const clean = value.replace(/\s+/g, ' ').trim().slice(0, 150);
  return clean || null;
}

export function vendorFromMac(mac: string | null | undefined): string | null {
  if (!mac || typeof mac !== 'string') return null;
  const hex = normalizeMac(mac);
  if (!hex) return null;
  const table = load();
  if (!table) return null;
  // Longest-prefix match: 9 -> 7 -> 6 hex chars (table keys are uppercase)
  const key = hex.toUpperCase();
  const candidate = table[key.slice(0, 9)] ?? table[key.slice(0, 7)] ?? table[key.slice(0, 6)];
  return sanitize(candidate);
}
