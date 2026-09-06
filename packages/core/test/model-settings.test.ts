import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import fixture from '../../../contracts/model-settings-v1.json';
import { Agent } from '../src/agent';
import type { ModelSettings } from '../src/model-settings';
import {
  type ModelCapabilities,
  patchModelSettings,
  validateModelSettings,
} from '../src/model-settings';
import { forkSession, loadSession, writeSessionMetadata } from '../src/persistence';

let home: string;
it('reads the cross-repository contract without narrowing effort values or losing false and null', () => {
  expect(() =>
    validateModelSettings(fixture.state.overrides, fixture.state.capabilities as ModelCapabilities),
  ).not.toThrow();
  expect(patchModelSettings(fixture.state.overrides, fixture.patch)).toEqual({
    parallelToolCalls: false,
  });
  expect(() =>
    validateModelSettings({ thinking: 'off' }, fixture.unknown as ModelCapabilities),
  ).toThrow();
});
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'chimera-settings-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

it('saves settings-only changes before returning and restores overrides after model switches', async () => {
  const languageModel = new MockLanguageModelV3();
  const agent = new Agent({
    cwd: '/tmp',
    home,
    model: { providerId: 'test', modelId: 'one', maxSteps: 10 },
    languageModel,
    tools: {},
    sandboxMode: 'off',
    contextWindow: 200_000,
  });
  agent.setModelSettingsResolver(async (ref: string, settings: ModelSettings) => ({
    model: { providerId: 'test', modelId: ref.split('/')[1], maxSteps: 10, settings },
    languageModel,
    systemPrompt: '',
    contextWindow: 200_000,
    contextWindowIsApproximate: false,
  }));
  expect((await agent.updateModelSettings({ settings: { parallelToolCalls: false } })).status).toBe(
    'applied',
  );
  expect((await loadSession(agent.session.id, home)).model.settings).toEqual({
    parallelToolCalls: false,
  });
  await agent.updateModelSettings({ model: 'test/two', settings: { reasoningEffort: 'high' } });
  await agent.updateModelSettings({ model: 'test/one' });
  expect(agent.session.model.settings).toEqual({ parallelToolCalls: false });
  await agent.updateModelSettings({ settings: { parallelToolCalls: null } });
  expect(agent.session.model.settings).toEqual({});
});

it('does not change live state when saving fails, and releases its update lock', async () => {
  const languageModel = new MockLanguageModelV3();
  const agent = new Agent({
    cwd: '/tmp',
    home,
    model: { providerId: 'test', modelId: 'one', maxSteps: 10 },
    languageModel,
    tools: {},
    sandboxMode: 'off',
    contextWindow: 200_000,
  });
  agent.setModelSettingsResolver(async () => ({
    model: { ...agent.session.model, settings: { parallelToolCalls: false } },
    languageModel,
    systemPrompt: '',
    contextWindow: 200_000,
    contextWindowIsApproximate: false,
  }));
  await writeFile(join(home, '.chimera'), 'not a directory');
  await expect(
    agent.updateModelSettings({ settings: { parallelToolCalls: false } }),
  ).rejects.toThrow();
  expect(agent.session.model.settings).toBeUndefined();
  expect(agent.session.modelSettingsOverrides).toBeUndefined();
  await expect(agent.updateModelSettings({ settings: {} })).rejects.toThrow();
});

it('rejects a second update while resolution is pending and rejects stale model references', async () => {
  const languageModel = new MockLanguageModelV3();
  const agent = new Agent({
    cwd: '/tmp',
    home,
    model: { providerId: 'test', modelId: 'one', maxSteps: 10 },
    languageModel,
    tools: {},
    sandboxMode: 'off',
    contextWindow: 200_000,
  });
  let release!: () => void;
  agent.setModelSettingsResolver(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      model: agent.session.model,
      languageModel,
      systemPrompt: '',
      contextWindow: 200_000,
      contextWindowIsApproximate: false,
    };
  });
  expect(
    (await agent.updateModelSettings({ expectedModel: 'test/old', settings: {} })).status,
  ).toBe('invalid');
  const pending = agent.updateModelSettings({ settings: {} });
  expect(await agent.updateModelSettings({ settings: {} })).toEqual({ status: 'running' });
  release();
  expect((await pending).status).toBe('applied');
});

it('preserves per-model overrides when a session is forked', async () => {
  const agent = new Agent({
    cwd: '/tmp',
    home,
    model: { providerId: 'test', modelId: 'one', maxSteps: 10 },
    languageModel: new MockLanguageModelV3(),
    tools: {},
    sandboxMode: 'off',
    contextWindow: 200_000,
  });
  agent.session.modelSettingsOverrides = {
    'test/one': { reasoningEffort: 'max', parallelToolCalls: false },
  };
  agent.session.modelCreationDefaults = { 'test/one': { temperature: 0, maxOutputTokens: 4096 } };
  await writeSessionMetadata(agent.session, home);
  const { session } = await forkSession({ parentId: agent.session.id, home });
  expect(session.modelSettingsOverrides).toEqual(agent.session.modelSettingsOverrides);
  expect(session.modelCreationDefaults).toEqual(agent.session.modelCreationDefaults);
  expect((await loadSession(session.id, home)).modelCreationDefaults).toEqual(
    agent.session.modelCreationDefaults,
  );
  expect((await loadSession(session.id, home)).modelSettingsOverrides).toEqual(
    agent.session.modelSettingsOverrides,
  );
});

it('applies the effective model and its settings when changing modes', () => {
  const languageModel = new MockLanguageModelV3();
  const agent = new Agent({
    cwd: '/tmp',
    home,
    model: { providerId: 'test', modelId: 'one', maxSteps: 10 },
    languageModel,
    tools: {},
    sandboxMode: 'off',
    contextWindow: 200_000,
  });
  agent.setModeResolver(() => ({
    systemPrompt: 'plan prompt',
    tools: {},
    effectiveModel: 'test/two',
    effectiveModelChanged: true,
  }));
  agent.setModelChangeResolver(() => ({
    model: {
      providerId: 'test',
      modelId: 'two',
      maxSteps: 10,
      settings: { reasoningEffort: 'high' },
    },
    languageModel,
    systemPrompt: 'old prompt',
    contextWindow: 200_000,
    contextWindowIsApproximate: false,
  }));
  expect(agent.queueModeSwitch('plan').status).toBe('applied');
  expect(agent.session.model.modelId).toBe('two');
  expect(agent.session.model.settings).toEqual({ reasoningEffort: 'high' });
});
