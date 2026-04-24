import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/core',
  'packages/providers',
  'packages/tools',
  'packages/permissions',
  'packages/server',
  'packages/client',
  'packages/tui',
  'packages/cli',
]);
