import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliAgentFactory } from '../src/factory';

describe('CliAgentFactory', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'chimera-factory-'));
    process.env.CHIMERA_FACTORY_TEST_KEY = 'test-key';
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    process.env.CHIMERA_FACTORY_TEST_KEY = undefined;
  });

  it('threads the model identity into the composed system prompt', async () => {
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
    });

    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-opus-4-6', maxSteps: 1 },
      sandboxMode: 'off',
    });

    // Agent.opts is private; access via type cast for test inspection.
    const opts = (agent as unknown as { opts: { systemPrompt: string } }).opts;
    expect(opts.systemPrompt).toContain('- model: anthropic/claude-opus-4-6');
  });

  it('passes a resolved contextWindow through to the agent', async () => {
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
    });

    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5', maxSteps: 1 },
      sandboxMode: 'off',
    });

    const opts = (agent as unknown as { opts: { contextWindow: number } }).opts;
    expect(opts.contextWindow).toBe(200_000);
  });

  it('honors a per-model contextWindow override from config', async () => {
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
      models: { 'anthropic/claude-sonnet-4-5': { contextWindow: 1_000_000 } },
    });

    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5', maxSteps: 1 },
      sandboxMode: 'off',
    });

    const opts = (agent as unknown as { opts: { contextWindow: number } }).opts;
    expect(opts.contextWindow).toBe(1_000_000);
  });
});
