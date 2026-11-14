import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ModHost } from '../src/index';

async function fixture(
  root: string,
  name: string,
  options: Record<string, unknown> = {},
  source?: string,
) {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'chimera-mod.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      apiVersion: 1,
      ...options,
    }),
  );
  if (source !== undefined)
    await writeFile(join(directory, String(options.module ?? 'index.mjs')), source);
  return directory;
}
const recorder = `export function register(on) { on('tool.call', async ($, event, next) => {
  $.session.record(event.label); return next();
}); }`;

describe('public folder loading', () => {
  it('loads flags, environment and alphabetical user folders with first name winning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mod-loading-'));
    const userDirectory = join(root, 'user');
    const flag = await fixture(
      root,
      'flag',
      { module: 'index.mjs' },
      recorder.replace('event.label', "'flag'"),
    );
    const env = await fixture(
      root,
      'environment',
      { module: 'index.mjs' },
      recorder.replace('event.label', "'env'"),
    );
    await fixture(
      userDirectory,
      'z-user',
      { module: 'index.mjs' },
      recorder.replace('event.label', "'z'"),
    );
    await fixture(
      userDirectory,
      'a-user',
      { module: 'index.mjs' },
      recorder.replace('event.label', "'a'"),
    );
    await fixture(userDirectory, 'duplicate', { name: 'flag' });
    const calls: string[] = [];
    const host = await ModHost.create({
      dataDirectory: join(root, 'data'),
      folders: [flag],
      envDirs: env,
      userDirectory,
      sessionContext: () => ({ session: { record: (text: string) => calls.push(text) } }),
    });
    await host.intercept('tool.call', { type: 'tool.call', sessionId: 'one' }, async () =>
      calls.push('terminal'),
    );
    expect(calls).toEqual(['flag', 'env', 'a', 'z', 'terminal']);
    expect(host.mods.map(({ name, source, status }) => ({ name, source, status }))).toEqual([
      { name: 'flag', source: 'flag', status: 'loaded' },
      { name: 'environment', source: 'env', status: 'loaded' },
      { name: 'a-user', source: 'user', status: 'loaded' },
      { name: 'flag', source: 'user', status: 'duplicate' },
      { name: 'z-user', source: 'user', status: 'loaded' },
    ]);
  });

  it('disables only user mods, supports bundles and --no-mods', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mod-loading-'));
    const explicit = await fixture(root, 'explicit');
    const userDirectory = join(root, 'user');
    await fixture(userDirectory, 'disabled');
    const host = await ModHost.create({
      dataDirectory: join(root, 'data'),
      folders: [explicit],
      envDirs: '',
      userDirectory,
      disabled: ['explicit', 'disabled'],
      sessionContext: () => ({}),
    });
    expect(host.mods.map(({ status }) => status)).toEqual(['loaded', 'disabled']);
    expect(host.registrations).toEqual([]);
    const none = await ModHost.create({
      dataDirectory: join(root, 'data'),
      folders: [explicit],
      envDirs: explicit + delimiter + explicit,
      userDirectory,
      noMods: true,
      sessionContext: () => ({}),
    });
    expect(none.mods).toEqual([]);
  });

  it('skips load failures, preserves subsequent mods and reports a single status line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mod-loading-'));
    const invalid = await fixture(root, 'invalid', { apiVersion: 2 });
    const badHook = await fixture(
      root,
      'bad-hook',
      { module: 'index.mjs' },
      `export function register(on) { on('tool', () => {}); }`,
    );
    const throws = await fixture(
      root,
      'throws',
      { module: 'index.mjs' },
      `export function register(on) { on('turn.complete', () => {}); throw new Error('broken'); }`,
    );
    const good = await fixture(root, 'good');
    const warnings: string[] = [];
    const status: string[] = [];
    const host = await ModHost.create({
      dataDirectory: join(root, 'data'),
      folders: [join(root, 'missing'), invalid, badHook, throws, good],
      envDirs: '',
      userDirectory: join(root, 'absent'),
      sessionContext: () => ({}),
      warn: (text) => warnings.push(text),
      ui: (text) => status.push(text),
    });
    expect(host.mods.map(({ status }) => status)).toEqual([
      'failed',
      'unsupported-api',
      'failed',
      'failed',
      'loaded',
    ]);
    expect(host.registrations).toEqual([]);
    expect(warnings).toHaveLength(4);
    expect(status).toEqual(['4 mods failed – chimera mod list']);
  });

  it('skips malformed optional manifest fields before applications consume bundles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mod-loading-'));
    const invalid = await fixture(root, 'invalid-bundle', {
      skills: ['not-a-directory'],
      mcpServers: { helper: null },
    });
    const host = await ModHost.create({
      dataDirectory: join(root, 'data'),
      folders: [invalid],
      envDirs: '',
      userDirectory: join(root, 'absent'),
      sessionContext: () => ({}),
    });
    expect(host.mods[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Invalid mod manifest'),
    });
  });

  it('accepts strict .mts and refuses Node-incompatible TypeScript before registration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mod-loading-'));
    const good = await fixture(
      root,
      'good',
      { module: 'index.mts' },
      `import type { Missing } from './types.mts'; export function register(on: Function) { on('turn.complete', () => {}); }`,
    );
    const invalid = await fixture(
      root,
      'enum',
      { module: 'index.mts' },
      `enum Choice { One }; export function register() {}`,
    );
    const inline = await fixture(
      root,
      'inline',
      { module: 'index.mts' },
      `import {type Missing} from './types.mts'; export function register() {}`,
    );
    const host = await ModHost.create({
      dataDirectory: join(root, 'data'),
      folders: [good, invalid, inline],
      envDirs: '',
      userDirectory: join(root, 'absent'),
      sessionContext: () => ({}),
    });
    expect(host.mods.map(({ status }) => status)).toEqual(['loaded', 'failed', 'failed']);
    expect(host.registrations.map(({ name }) => name)).toEqual(['turn.complete']);
  });
  it.each([
    ['parameter-properties', 'class Helper { constructor(public value: string) {} }'],
    ['extensionless', "import './helper';"],
    ['aliases', "import '@mod-alias/helper';"],
  ])('refuses %s instead of relying on Bun-only loading', async (name, source) => {
    const root = await mkdtemp(join(tmpdir(), 'mod-loading-'));
    const directory = await fixture(
      root,
      name,
      { module: 'index.mts' },
      `${source} export function register(on) { on("turn.complete", () => {}); }`,
    );
    const host = await ModHost.create({
      dataDirectory: join(root, 'data'),
      folders: [directory],
      envDirs: '',
      userDirectory: join(root, 'absent'),
      sessionContext: () => ({}),
    });
    expect(host.mods[0].status).toBe('failed');
    expect(host.registrations).toEqual([]);
  });

  it('accepts a dependency with import-only package exports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mod-loading-'));
    const directory = await fixture(
      root,
      'import-only',
      { module: 'index.mjs' },
      `import { label } from 'helper'; export function register(on) { on('turn.complete', ($) => $.ui.log(label, {to: 'debug'})); }`,
    );
    const dependency = join(directory, 'node_modules/helper');
    await mkdir(dependency, { recursive: true });
    await writeFile(
      join(dependency, 'package.json'),
      JSON.stringify({ name: 'helper', exports: { import: './index.mjs' } }),
    );
    await writeFile(join(dependency, 'index.mjs'), `export const label = 'import-only';`);
    const output: string[] = [];
    const host = await ModHost.create({
      folders: [directory],
      envDirs: '',
      userDirectory: join(root, 'absent'),
      dataDirectory: join(root, 'data'),
      sessionContext: () => ({}),
      ui: (text) => {
        output.push(text);
      },
    });
    await host.observe({ type: 'turn.complete', sessionId: 'one' });
    expect(output).toEqual(['import-only']);
    expect(host.mods[0].status).toBe('loaded');
  });

  it('refuses .mts on Node older than 22.18 with an actionable error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mod-loading-'));
    const directory = await fixture(
      root,
      'old-node',
      { module: 'index.mts' },
      'export function register() {}',
    );
    const original = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
    Object.defineProperty(process.versions, 'node', { ...original, value: '22.17.0' });
    try {
      const host = await ModHost.create({
        dataDirectory: join(root, 'data'),
        folders: [directory],
        envDirs: '',
        userDirectory: join(root, 'absent'),
        sessionContext: () => ({}),
      });
      expect(host.mods[0]).toMatchObject({
        status: 'failed',
        error: '.mts mods require Node 22.18 or newer',
      });
    } finally {
      Object.defineProperty(process.versions, 'node', original);
    }
  });
});
