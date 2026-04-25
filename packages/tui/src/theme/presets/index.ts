import type { PartialTheme } from '../types';
import { cyberpunk } from './cyberpunk';
import { tokyoNightMoon } from './tokyo-night-moon';

/**
 * Bundled theme presets. Keys are the names shown in `/theme` and accepted
 * by `/theme <name>`. Each value is a PartialTheme that gets deep-merged
 * onto the default theme at load time.
 *
 * `default` is intentionally empty: applying it resets the active theme
 * to the built-in defaults without removing the active marker.
 */
export const BUILTIN_PRESETS: Record<string, PartialTheme> = {
  default: {},
  'tokyo-night-moon': tokyoNightMoon,
  cyberpunk,
};

export type PresetName = keyof typeof BUILTIN_PRESETS;
