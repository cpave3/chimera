// Built from strings, as in width.ts: biome rejects control characters in regex literals.
const CONTROL_CLASS = String.raw`[\x00-\x08\x0b-\x1f\x7f-\x9f]`;
// CSI (7- and 8-bit); OSC, DCS, SOS, PM and APC strings up to BEL, ST or the end; then any other two-byte escape.
const ESCAPE_SOURCE = String.raw`(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]?|\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)|\x1b[\s\S]?`;
const CONTROL = new RegExp(CONTROL_CLASS);
const ESCAPE_SEQUENCE = new RegExp(ESCAPE_SOURCE, 'g');
const OTHER_CONTROLS = new RegExp(CONTROL_CLASS, 'g');

/**
 * Text from a model, a tool or a file, made safe to write to the terminal:
 * escape sequences and control characters are dropped, newlines and tabs
 * kept. Without this, output such as `cat` of a hostile file could set the
 * clipboard (OSC 52), leave the alternate screen or move the cursor.
 */
export function sanitizeText(text: string): string {
  if (!CONTROL.test(text)) return text;
  return text.replace(ESCAPE_SEQUENCE, '').replace(OTHER_CONTROLS, '');
}

/** `value` with every string in it sanitized; the same object when nothing changed. */
export function sanitizeDeep<T>(value: T): T {
  if (typeof value === 'string') return sanitizeText(value) as T;
  if (Array.isArray(value)) {
    const items = value.map((item) => sanitizeDeep(item));
    return (items.some((item, index) => item !== value[index]) ? items : value) as T;
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    let changed = false;
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = sanitizeDeep(item);
      if (copy[key] !== item) changed = true;
    }
    return (changed ? copy : value) as T;
  }
  return value;
}

const SGR = new RegExp(String.raw`^\x1b\[[0-9;:]*m$`);
const ANY_CONTROL = new RegExp(`${ESCAPE_SOURCE}|${CONTROL_CLASS}`, 'g');

/**
 * A rendered row with its colours (SGR) kept and every other escape or
 * control dropped. The screen writers pass each row through this, so text
 * that missed `sanitizeText` still cannot move the cursor or change modes.
 */
export function onlyStyles(line: string): string {
  if (!CONTROL.test(line)) return line;
  return line.replace(ANY_CONTROL, (match) => (SGR.test(match) ? match : ''));
}
