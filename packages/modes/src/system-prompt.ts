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
  for (const name of allowlist) {
    if (name in tools) out[name] = tools[name];
  }
  return out as T;
}
