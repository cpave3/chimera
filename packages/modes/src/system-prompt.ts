import type { Mode } from './types';

/**
 * Render a mode as a system-prompt fragment. Always emits the same shape:
 *
 *     # Current mode: <name>
 *
 *     <body>
 */
export function renderModeBlock(mode: Mode): string {
  return `# Current mode: ${mode.name}\n\n${mode.body}`;
}

/**
 * Compute the active tool allowlist from a mode. Returns `undefined` when the
 * mode has no `tools` field (= "all registered tools available"), or a Set of
 * allowed names when it does (including the empty Set for `tools: []`, which
 * means "no tools at all").
 */
export function computeAllowlist(mode: Mode): Set<string> | undefined {
  if (mode.tools === undefined) return undefined;
  return new Set(mode.tools);
}

/**
 * Allowlists are written with the native tool names. A model profile can
 * register the same capability under another name, so a listed name also
 * admits its equivalents.
 */
const TOOL_ALIASES: Record<string, string[]> = {
  glob: ['find', 'ls'],
  edit: ['apply_patch'],
};

/**
 * Resolve an allowlist against the tools that are actually registered:
 * `names` are the registered tools it admits, in allowlist order; `missing`
 * are listed names that neither exist nor have a registered equivalent.
 */
export function expandAllowlist(
  allowlist: Set<string>,
  registered: Iterable<string>,
): { names: string[]; missing: string[] } {
  const available = new Set(registered);
  const names: string[] = [];
  const missing: string[] = [];
  for (const name of allowlist) {
    const admitted = [name, ...(TOOL_ALIASES[name] ?? [])].filter((candidate) =>
      available.has(candidate),
    );
    if (admitted.length === 0) missing.push(name);
    for (const candidate of admitted) {
      if (!names.includes(candidate)) names.push(candidate);
    }
  }
  return { names, missing };
}

/**
 * Filter a tools record by an allowlist. `undefined` allowlist returns the
 * input as-is. Names in the allowlist that are not in the tool record are
 * silently skipped (caller is expected to have warned at session start).
 */
export function applyAllowlist<T extends Record<string, unknown>>(
  tools: T,
  allowlist: Set<string> | undefined,
): T {
  if (allowlist === undefined) return tools;
  const out: Record<string, unknown> = {};
  for (const name of expandAllowlist(allowlist, Object.keys(tools)).names) {
    out[name] = tools[name];
  }
  return out as T;
}
