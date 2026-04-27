export * from './types';
export { loadModes } from './load';
export { InMemoryModeRegistry } from './registry';
export { parseFrontmatter } from './frontmatter';
export { colorFor, hslToHex, isValidHex } from './color';
export { renderModeBlock, computeAllowlist, applyAllowlist } from './system-prompt';

/** Default mode name shipped as a builtin. New sessions start in this mode. */
export const DEFAULT_MODE_NAME = 'build';

/**
 * Hard-coded fallback cycle. Used only when neither the user has set
 * `cycleModes` in config nor a registry is available; in normal operation
 * the CLI defaults to "every discovered mode" instead.
 */
export const DEFAULT_CYCLE_MODES = ['build', 'plan'] as const;
