export { buildSpawnAgentTool } from './spawn-tool';
export type { SpawnAgentArgs } from './spawn-tool';
export type {
  SpawnAgentToolContext,
  SubagentSpawnOptions,
  SubagentResult,
  SubagentReason,
  InProcessAgentBuilder,
  SpawnEmit,
} from './types';
export { HandshakeError, readHandshakeLine } from './handshake';
export type { HandshakeMessage } from './handshake';
export { buildChildArgv } from './spawn-child';
