import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkSession, type ModelCapabilities, type Agent } from '@chimera/core';
import { DefaultHookRunner } from '@chimera/hooks';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fixture from '../../../contracts/model-settings-v1.json';
import { CliAgentFactory } from '../src/factory';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
let home: string;
let imagePath: string;
let modalities: Record<string, ModelCapabilities['inputModalities']>;
let unavailable: boolean;
let requests: Array<{
  model: string;
  reasoning_effort?: string;
  messages: Array<{ content: unknown }>;
}>;

beforeEach(async () => {
  vi.spyOn(DefaultHookRunner.prototype, 'fire').mockResolvedValue({ blocked: false });
  home = await mkdtemp(join(tmpdir(), 'chimera-vision-routing-'));
  imagePath = join(home, 'image.png');
  await writeFile(imagePath, Buffer.from(png, 'base64'));
  modalities = { sol: ['text', 'image'], kimi: ['text', 'image'], spark: ['text'] };
  unavailable = false;
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.protocol === 'data:')
        return new Response(Buffer.from(url.pathname.split(',')[1], 'base64'), {
          headers: { 'Content-Type': 'image/png' },
        });
      if (url.pathname.endsWith('/model-capabilities')) {
        if (unavailable) throw new Error('Discovery unavailable');
        const alias = url.searchParams.get('model')!;
        return Response.json({
          ...fixture.state.capabilities,
          modelId: alias === 'sol' ? 'gpt-5.6-sol' : alias,
          inputModalities: modalities[alias],
          fingerprint: JSON.stringify(modalities[alias]),
        });
      }
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      const chunks = [{ content: 'I see the image.' }, {}]
        .map(
          (delta, index) =>
            `data: ${JSON.stringify({
              id: 'test',
              created: 0,
              model: body.model,
              choices: [{ index: 0, delta, finish_reason: index ? 'stop' : null }],
            })}\n\n`,
        )
        .join('');
      return new Response(`${chunks}data: [DONE]\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

function factory(
  models: Record<string, { vision?: boolean }> = { 'router/sol': {}, 'router/kimi': {} },
) {
  return new CliAgentFactory({
    providersConfig: {
      providers: {
        router: {
          shape: 'openai',
          capabilitySource: 'manticore',
          baseUrl: 'https://router.test/v1',
          apiKey: 'key',
        },
      },
    },
    models,
    defaultVisionModel: 'router/kimi',
    home,
    autoApprove: 'all',
    subagents: { enabled: false },
  });
}

async function run(agent: Agent, images?: string[]) {
  const events = [];
  for await (const event of agent.run('Describe the image', images)) events.push(event);
  expect(events.find((event) => event.type === 'run_finished')).toMatchObject({
    reason: 'stop',
  });
  return events;
}

it('keeps pasted images and follow-up history on the discovered vision model', async () => {
  const builder = factory();
  const { agent } = await builder.build({
    cwd: home,
    model: {
      providerId: 'router',
      modelId: 'sol',
      maxSteps: 1,
      settings: { reasoningEffort: 'max' },
    },
    sandboxMode: 'off',
  });
  expect((await builder.listModels()).find((model) => model.ref === 'router/sol')?.vision).toBe(
    true,
  );
  const events = await run(agent, [imagePath]);
  await run(agent);
  expect(events.some((event) => event.type === 'vision_route_started')).toBe(false);
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.model).toBe('sol');
    expect(request.reasoning_effort).toBe('max');
    expect(JSON.stringify(request.messages)).toContain(`data:image/png;base64,${png}`);
    expect(JSON.stringify(request.messages)).toContain('image_url');
  }
});

it.each([
  'configured',
  'sdk',
  'text-only',
] as const)('uses a discovered fallback for %s non-vision selection', async (kind) => {
  const builder = factory({
    'router/sol': kind === 'configured' ? { vision: false } : {},
    'router/kimi': {},
  });
  const { agent } = await builder.build({
    cwd: home,
    model: {
      providerId: 'router',
      modelId: kind === 'text-only' ? 'spark' : 'sol',
      maxSteps: 1,
      ...(kind === 'sdk' ? { vision: false } : kind === 'configured' ? { vision: true } : {}),
    },
    sandboxMode: 'off',
  });
  await agent.appendMessage('Attached image', [imagePath]);
  const events = await run(agent);
  expect(requests[0]?.model).toBe('kimi');
  expect(events.some((event) => event.type === 'vision_route_started')).toBe(true);
  expect(agent.session.model.modelId).toBe(kind === 'text-only' ? 'spark' : 'sol');
});

it('refreshes discovered support after resume, fork, alias remapping, and discovery failure', async () => {
  const builder = factory();
  const { agent } = await builder.build({
    cwd: home,
    model: { providerId: 'router', modelId: 'sol', maxSteps: 1 },
    sandboxMode: 'off',
  });
  const { session: fork } = await forkSession({ parentId: agent.session.id, home });
  modalities.sol = ['text'];
  const { agent: resumed } = await builder.build({
    cwd: home,
    model: agent.session.model,
    sessionId: fork.id,
    sandboxMode: 'off',
  });
  await resumed.updateModelSettings({ settings: {} });
  expect(resumed.session.model.vision).toBe(false);
  expect(resumed.session.modelInputOverrides?.['router/sol']?.vision).toBeUndefined();
  modalities.sol = ['text', 'image'];
  await resumed.updateModelSettings({ settings: {} });
  expect(resumed.session.model.vision).toBe(true);
  unavailable = true;
  await resumed.updateModelSettings({ settings: {} });
  expect(resumed.session.model.vision).toBeUndefined();
});

it('retains explicit vision during discovery failure and does not guess unknown models', async () => {
  unavailable = true;
  const builder = factory({ 'router/sol': { vision: true }, 'router/unknown': {} });
  const { agent } = await builder.build({
    cwd: home,
    model: { providerId: 'router', modelId: 'sol', maxSteps: 1 },
    sandboxMode: 'off',
  });
  await run(agent, [imagePath]);
  expect(requests[0]?.model).toBe('sol');
  await agent.updateModelSettings({ model: 'router/unknown' });
  expect(agent.session.model.vision).toBeUndefined();
});
