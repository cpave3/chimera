import { expandBody } from './expand';
import type { Command, CommandCollision, CommandRegistry, ExpandContext } from './types';

export class InMemoryCommandRegistry implements CommandRegistry {
  private readonly byName: Map<string, Command>;
  private readonly collisionList: CommandCollision[];
  private readonly defaultCwd: string;

  constructor(commands: Command[], collisions: CommandCollision[], defaultCwd: string) {
    this.byName = new Map(commands.map((c) => [c.name, c]));
    this.collisionList = collisions;
    this.defaultCwd = defaultCwd;
  }

  list(): Command[] {
    return [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  find(name: string): Command | undefined {
    return this.byName.get(name);
  }

  expand(name: string, args: string, ctx: ExpandContext = {}): string {
    const cmd = this.byName.get(name);
    if (!cmd) throw new Error(`unknown command: ${name}`);
    return expandBody(cmd.body, {
      args,
      cwd: ctx.cwd ?? this.defaultCwd,
      date: ctx.date,
    });
  }

  collisions(): CommandCollision[] {
    return [...this.collisionList];
  }
}
