/**
 * Resolve a mode's display color. If `override` is a valid CSS hex (`#rgb` or
 * `#rrggbb`, case-insensitive), use it (normalized to `#rrggbb` lowercase).
 * Otherwise derive a deterministic color from `name` so every mode has a
 * stable, distinct color without authoring overhead.
 */
export function colorFor(name: string, override?: string): string {
  if (override !== undefined) {
    const parsed = parseHex(override);
    if (parsed) return parsed;
    // Caller is responsible for warning on invalid override; we just fall back.
  }
  return derive(name);
}

/**
 * Returns true when `value` is a parseable CSS hex color. Used by `loadModes`
 * to decide whether to warn about an invalid frontmatter `color:` field.
 */
export function isValidHex(value: string): boolean {
  return parseHex(value) !== null;
}

function parseHex(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const withoutHash = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (!/^[0-9a-fA-F]+$/.test(withoutHash)) return null;
  if (withoutHash.length === 3) {
    const expanded = [...withoutHash].map((c) => c + c).join('');
    return `#${expanded.toLowerCase()}`;
  }
  if (withoutHash.length === 6) {
    return `#${withoutHash.toLowerCase()}`;
  }
  return null;
}

function derive(name: string): string {
  const hash = fnv1a32(name);
  const hue = hash % 360;
  return hslToHex(hue, 65, 55);
}

/** 32-bit FNV-1a hash of a UTF-8 string. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  const bytes = new TextEncoder().encode(input);
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i]!;
    // 32-bit FNV prime: 16777619
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Convert HSL (h in [0, 360), s and l in percent [0, 100]) to a `#rrggbb`
 * lowercase hex string. Standard HSL→RGB algorithm.
 */
export function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp < 1) {
    r1 = c;
    g1 = x;
  } else if (hp < 2) {
    r1 = x;
    g1 = c;
  } else if (hp < 3) {
    g1 = c;
    b1 = x;
  } else if (hp < 4) {
    g1 = x;
    b1 = c;
  } else if (hp < 5) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }
  const m = lN - c / 2;
  const r = Math.round((r1 + m) * 255);
  const g = Math.round((g1 + m) * 255);
  const b = Math.round((b1 + m) * 255);
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function toHex(n: number): string {
  const clamped = Math.max(0, Math.min(255, n));
  return clamped.toString(16).padStart(2, '0');
}
