import { createHash } from 'node:crypto';
import type { ToolCallInterceptor, ToolOutcome } from './intercept';

const REPEAT_LIMIT = 3;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

function fingerprint(value: unknown): string {
  return createHash('sha1')
    .update(JSON.stringify(stable(value)) ?? 'undefined')
    .digest('hex');
}

/**
 * Tell the model when it is stuck. A call sent three times in a row with the
 * same arguments and the same outcome will not change on the fourth; the
 * note says so while the model can still try something else.
 */
export function repeatNote(): ToolCallInterceptor {
  let last = { call: '', outcome: '', count: 0 };
  return {
    after(call, outcome): ToolOutcome {
      const callPrint = fingerprint([call.name, call.args]);
      const outcomePrint = fingerprint('error' in outcome ? outcome.error.message : outcome.result);
      const count = callPrint === last.call && outcomePrint === last.outcome ? last.count + 1 : 1;
      last = { call: callPrint, outcome: outcomePrint, count };
      if (count < REPEAT_LIMIT) return outcome;

      const note =
        `This is the same call with the same outcome ${count} times in a row. Repeating it ` +
        'will not change the outcome. Try a different approach, or tell the user what blocks you.';
      if ('error' in outcome) {
        return { error: new Error(`${outcome.error.message}\n\n${note}`) };
      }
      if (isPlainObject(outcome.result)) {
        return { result: { ...outcome.result, repeat_note: note } };
      }
      if (typeof outcome.result === 'string') {
        return { result: `${outcome.result}\n\n[${note}]` };
      }
      return { result: { result: outcome.result, repeat_note: note } };
    },
  };
}

export interface OutputArchive {
  put(input: { toolName: string; args: unknown; content: string }): Promise<{ id: string }>;
}

export interface OutputBudgetOptions {
  /** Tokens one tool result may take, read per call so it follows the active model. */
  budgetTokens(): number;
  /** Where the full text goes. Without it the text is shortened and not kept. */
  store?: OutputArchive;
}

interface ArchivedField {
  field: string;
  id?: string;
  tokens: number;
  omitted_items?: number;
}

const CHARS_PER_TOKEN = 4;
/** A text field is only worth cutting when more than this would remain. */
const MIN_KEPT_CHARS = 800;
const MIN_KEPT_ITEMS = 10;
const MARKER_ALLOWANCE = 200;
const HEAD_SHARE = 0.75;

type Leaf =
  | { kind: 'text'; path: Array<string | number>; size: number }
  | { kind: 'list'; path: Array<string | number>; size: number };

function collectLeaves(value: unknown, path: Array<string | number>, leaves: Leaf[]): void {
  if (typeof value === 'string') {
    leaves.push({ kind: 'text', path, size: value.length });
  } else if (Array.isArray(value)) {
    leaves.push({ kind: 'list', path, size: JSON.stringify(value).length });
    value.forEach((item, index) => {
      collectLeaves(item, [...path, index], leaves);
    });
  } else if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) collectLeaves(child, [...path, key], leaves);
  }
}

function getAt(root: unknown, path: Array<string | number>): unknown {
  return path.reduce<unknown>((node, key) => (node as Record<string | number, unknown>)[key], root);
}

function setAt(root: unknown, path: Array<string | number>, value: unknown): void {
  const parent = getAt(root, path.slice(0, -1)) as Record<string | number, unknown>;
  parent[path.at(-1)!] = value;
}

/** Keep the beginning and end of a text, cut on line breaks where it has them. */
function shortenText(text: string, keepChars: number, recallHint: string): string {
  const headChars = Math.floor(keepChars * HEAD_SHARE);
  const tailChars = keepChars - headChars;
  const lines = text.split('\n');
  if (lines.length < 3) {
    const omitted = text.length - keepChars;
    return `${text.slice(0, headChars)}\n[… ${omitted} characters omitted${recallHint} …]\n${text.slice(text.length - tailChars)}`;
  }
  let headEnd = 0;
  let used = 0;
  while (headEnd < lines.length && used + lines[headEnd]!.length + 1 <= headChars) {
    used += lines[headEnd]!.length + 1;
    headEnd += 1;
  }
  let tailStart = lines.length;
  used = 0;
  while (tailStart > headEnd && used + lines[tailStart - 1]!.length + 1 <= tailChars) {
    used += lines[tailStart - 1]!.length + 1;
    tailStart -= 1;
  }
  const omitted = tailStart - headEnd;
  return [
    ...lines.slice(0, headEnd),
    `[… ${omitted} lines omitted${recallHint} …]`,
    ...lines.slice(tailStart),
  ].join('\n');
}

/**
 * Keep one tool result from taking more of the context than the model's
 * profile allows. The result keeps its shape: oversized text fields are cut
 * to a head and a tail, oversized lists to their first items, and the full
 * content goes to the archive where `recall` can page through it.
 */
export function outputBudget(options: OutputBudgetOptions): ToolCallInterceptor {
  return {
    async after(call, outcome): Promise<ToolOutcome> {
      if ('error' in outcome || call.name === 'recall') return outcome;
      const original = outcome.result;
      if (isPlainObject(original) && original.kind === 'image') return outcome;
      const budgetChars = options.budgetTokens() * CHARS_PER_TOKEN;
      const serialized = typeof original === 'string' ? original : JSON.stringify(original);
      if (serialized === undefined || serialized.length <= budgetChars) return outcome;

      const archived: ArchivedField[] = [];
      const archive = async (content: string): Promise<string | undefined> => {
        const entry = await options.store?.put({ toolName: call.name, args: call.args, content });
        return entry?.id;
      };
      const hint = (id: string | undefined) =>
        id ? `. Full text: recall({ id: "${id}" }), with start_line/end_line or search` : '';

      if (typeof original === 'string') {
        const id = await archive(original);
        return { result: shortenText(original, budgetChars, hint(id)) };
      }

      if (!isPlainObject(original)) return outcome;
      const result = structuredClone(original);
      let excess = serialized.length - budgetChars;
      const leaves: Leaf[] = [];
      collectLeaves(result, [], leaves);

      const texts = leaves.filter((leaf) => leaf.kind === 'text').sort((a, b) => b.size - a.size);
      for (const leaf of texts) {
        if (excess <= 0 || leaf.size <= MIN_KEPT_CHARS) break;
        const text = getAt(result, leaf.path) as string;
        const cut = Math.min(leaf.size - MIN_KEPT_CHARS, excess + MARKER_ALLOWANCE);
        const field = leaf.path.join('.');
        const id = await archive(text);
        setAt(result, leaf.path, shortenText(text, leaf.size - cut, hint(id)));
        archived.push({
          field,
          ...(id ? { id } : {}),
          tokens: Math.ceil(leaf.size / CHARS_PER_TOKEN),
        });
        excess -= cut - MARKER_ALLOWANCE;
      }

      const lists = leaves.filter((leaf) => leaf.kind === 'list').sort((a, b) => b.size - a.size);
      for (const leaf of lists) {
        if (excess <= 0) break;
        const items = getAt(result, leaf.path) as unknown[];
        if (items.length <= MIN_KEPT_ITEMS) continue;
        const rows = items.map((item) => JSON.stringify(item));
        const target = leaf.size - excess - MARKER_ALLOWANCE;
        let kept = 0;
        let size = 2;
        while (kept < rows.length && size + rows[kept]!.length + 1 <= target) {
          size += rows[kept]!.length + 1;
          kept += 1;
        }
        kept = Math.max(MIN_KEPT_ITEMS, kept);
        if (kept >= items.length) continue;
        const field = leaf.path.join('.');
        const id = await archive(rows.join('\n'));
        setAt(result, leaf.path, items.slice(0, kept));
        archived.push({
          field,
          ...(id ? { id } : {}),
          tokens: Math.ceil(leaf.size / CHARS_PER_TOKEN),
          omitted_items: items.length - kept,
        });
        excess -= leaf.size - size;
      }

      if (archived.length === 0) return outcome;
      return { result: { ...result, output_archived: archived } };
    },
  };
}
