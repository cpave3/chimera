import type { AgentCollision, AgentDefinition, AgentRegistry } from './types';

export class InMemoryAgentRegistry implements AgentRegistry {
  private readonly byName: Map<string, AgentDefinition>;
  private readonly _collisions: AgentCollision[];

  constructor(agents: AgentDefinition[], collisions: AgentCollision[]) {
    const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
    this.byName = new Map(sorted.map((agent) => [agent.name, agent]));
    this._collisions = collisions;
  }

  all(): AgentDefinition[] {
    return [...this.byName.values()];
  }

  find(name: string): AgentDefinition | undefined {
    return this.byName.get(name);
  }

  collisions(): AgentCollision[] {
    return [...this._collisions];
  }

  buildDescriptionIndex(): string {
    const agents = this.all();
    if (agents.length === 0) return '';
    const lines: string[] = ['Available agent definitions (pass via the `agent` arg):'];
    for (const agent of agents) {
      lines.push(`- ${agent.name} — ${agent.description}`);
    }
    return lines.join('\n');
  }
}
