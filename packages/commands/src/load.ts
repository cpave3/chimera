import { resolve } from 'node:path';
import { discover } from './discover';
import { InMemoryCommandRegistry } from './registry';
import type { CommandRegistry, LoadCommandsOptions } from './types';

/**
 * Load commands from all tier directories, log each collision once via
 * `onWarning`, and return an in-memory registry.
 */
export function loadCommands(opts: LoadCommandsOptions): CommandRegistry {
  const { commands, collisions } = discover(opts);
  if (opts.onWarning) {
    for (const c of collisions) {
      opts.onWarning(
        `command "${c.name}": ${c.loserPath} shadowed by ${c.winnerPath} (${c.winner} wins)`,
      );
    }
  }
  return new InMemoryCommandRegistry(commands, collisions, resolve(opts.cwd));
}
