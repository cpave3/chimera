import { discover } from './discover';
import { InMemoryAgentRegistry } from './registry';
import type { AgentRegistry, LoadAgentsOptions } from './types';

export function loadAgents(opts: LoadAgentsOptions): AgentRegistry {
  const { agents, collisions } = discover(opts);
  return new InMemoryAgentRegistry(agents, collisions);
}
