import type { Mode, ModeCollision, ModeRegistry } from './types';

export class InMemoryModeRegistry implements ModeRegistry {
  private readonly byName: Map<string, Mode>;
  private readonly _collisions: ModeCollision[];
  private readonly _paths: Set<string>;

  constructor(modes: Mode[], collisions: ModeCollision[]) {
    const sorted = [...modes].sort((a, b) => a.name.localeCompare(b.name));
    this.byName = new Map(sorted.map((mode) => [mode.name, mode]));
    this._collisions = collisions;
    this._paths = new Set(sorted.map((mode) => mode.path));
  }

  all(): Mode[] {
    return [...this.byName.values()];
  }

  find(name: string): Mode | undefined {
    return this.byName.get(name);
  }

  paths(): Set<string> {
    return new Set(this._paths);
  }

  collisions(): ModeCollision[] {
    return [...this._collisions];
  }
}
