import { discover } from './discover';
import { InMemoryModeRegistry } from './registry';
import type { LoadModesOptions, ModeRegistry } from './types';

export function loadModes(opts: LoadModesOptions): ModeRegistry {
  const { modes, collisions } = discover(opts);
  return new InMemoryModeRegistry(modes, collisions);
}
