import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliAgentFactory } from '../src/factory';

interface ExecutableTool {
  execute: (args: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
}

describe('CliAgentFactory host bash policy', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'chimera-factory-policy-'));
    process.env.CHIMERA_FACTORY_TEST_KEY = 'test-key';
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    process.env.CHIMERA_FACTORY_TEST_KEY = undefined;
  });

  it('auto-runs ordinary commands, hard-blocks scary commands, and audits both outcomes', async () => {
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          anthropic: {
            shape: 'anthropic',
            baseUrl: 'https://example.invalid',
            apiKey: 'env:CHIMERA_FACTORY_TEST_KEY',
          },
        },
      },
      autoApprove: 'all',
      home: cwd,
      subagents: { headlessAutoDeny: true },
    });
    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5', maxSteps: 1 },
      sandboxMode: 'off',
    });
    const bash = (agent as unknown as { opts: { tools: { bash: ExecutableTool } } }).opts.tools
      .bash;

    await expect(bash.execute({ command: 'echo safe' }, {})).resolves.toMatchObject({
      stdout: 'safe\n',
      exit_code: 0,
    });
    await expect(bash.execute({ command: 'rm -rf build' }, {})).resolves.toMatchObject({
      stderr: 'denied by policy',
      exit_code: -1,
    });
    const records = (
      await readFile(join(cwd, '.chimera', 'logs', 'permission-decisions.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map(JSON.parse);
    expect(records).toEqual([
      expect.objectContaining({ command: 'echo safe', decision: 'allow', source: 'automatic' }),
      expect.objectContaining({ command: 'rm -rf build', decision: 'deny', source: 'policy' }),
    ]);
  });

  it('auto-runs a command redirecting to the platform null device without a policy prompt', async () => {
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          anthropic: {
            shape: 'anthropic',
            baseUrl: 'https://example.invalid',
            apiKey: 'env:CHIMERA_FACTORY_TEST_KEY',
          },
        },
      },
      autoApprove: 'all',
      home: cwd,
      subagents: { headlessAutoDeny: true },
    });
    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5', maxSteps: 1 },
      sandboxMode: 'off',
    });
    const bash = (agent as unknown as { opts: { tools: { bash: ExecutableTool } } }).opts.tools
      .bash;

    await expect(bash.execute({ command: `echo quiet > ${devNull}` }, {})).resolves.toMatchObject({
      exit_code: 0,
    });
    const records = (
      await readFile(join(cwd, '.chimera', 'logs', 'permission-decisions.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map(JSON.parse);
    expect(records).toEqual([
      expect.objectContaining({
        command: `echo quiet > ${devNull}`,
        decision: 'allow',
        source: 'automatic',
      }),
    ]);
  });
});
