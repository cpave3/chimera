import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ModHost } from '../src/index';

async function folder(
  source: string,
  manifest = { name: 'example', version: '1.0.0', apiVersion: 1 },
) {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-mod-'));
  await writeFile(join(directory, 'chimera-mod.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'index.mjs'), source);
  return directory;
}

describe('mod folder host', () => {
  it('loads register(on), delegates session actions and wraps terminal outermost first', async () => {
    const calls: string[] = [];
    const directory = await folder(`
      export function register(on) {
        on('tool', async ($, event, next) => {
          $.session.record('outer-before:' + event.sessionId);
          const result = await next();
          $.session.record('outer-after');
          return result + '!';
        });
        on('tool', async ($, event, next) => {
          $.session.record('inner');
          return next();
        });
      }
    `);
    const host = await ModHost.create({
      folders: [directory],
      sessionContext: () => ({ session: { record: (value: string) => calls.push(value) } }),
    });
    expect(
      await host.intercept('tool', { type: 'tool', sessionId: 'one' }, async () => {
        calls.push('terminal');
        return 'done';
      }),
    ).toBe('done!');
    expect(calls).toEqual(['outer-before:one', 'inner', 'terminal', 'outer-after']);
    expect(host.registrations.map(({ mod, name }) => [mod, name])).toEqual([
      ['example', 'tool'],
      ['example', 'tool'],
    ]);
    await host.shutdown();
  });

  it('serializes observers for each session without blocking other sessions', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const directory = await folder(`export function register(on) {
      on('message', async ($, event) => {
        $.session.record('start:' + event.label);
        if (event.label === 'first') await $.session.wait();
        $.session.record('end:' + event.label);
      });
    }`);
    const host = await ModHost.create({
      folders: [directory],
      sessionContext: () => ({
        session: {
          record: (value: string) => calls.push(value),
          wait: () => blocked,
        },
      }),
    });
    const first = host.observe({ type: 'message', sessionId: 'one', label: 'first' });
    const second = host.observe({ type: 'message', sessionId: 'one', label: 'second' });
    await host.observe({ type: 'message', sessionId: 'two', label: 'other' });
    expect(calls).toEqual(['start:first', 'start:other', 'end:other']);
    release();
    await Promise.all([first, second]);
    expect(calls.slice(3)).toEqual(['end:first', 'start:second', 'end:second']);
  });

  it('charges own time rather than time spent awaiting next()', async () => {
    const directory = await folder(`export function register(on) {
      on('tool', async ($, event, next) => { return await next(); });
    }`);
    const host = await ModHost.create({
      folders: [directory],
      sessionContext: () => ({}),
      timeouts: { hookMs: 20, totalMs: 200 },
    });
    expect(
      await host.intercept('tool', { type: 'tool', sessionId: 'one' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'ok';
      }),
    ).toBe('ok');
  });

  it('bounds hook, total dispatch and registration time', async () => {
    const directory = await folder(`export function register(on) {
      on('tool', async () => new Promise(() => {}));
    }`);
    const host = await ModHost.create({
      folders: [directory],
      sessionContext: () => ({}),
      timeouts: { hookMs: 10 },
    });
    await expect(
      host.intercept('tool', { type: 'tool', sessionId: 'one' }, async () => null),
    ).rejects.toThrow('hook example:tool');
    const totalHost = await ModHost.create({
      sessionContext: () => ({}),
      timeouts: { totalMs: 10 },
    });
    await expect(
      totalHost.intercept(
        'tool',
        { type: 'tool', sessionId: 'one' },
        async () => new Promise(() => {}),
      ),
    ).rejects.toThrow('dispatch tool');
    const hanging = await folder(
      'export async function register(on) { await new Promise(() => {}); }',
    );
    const warnings: string[] = [];
    const failedHost = await ModHost.create({
      folders: [hanging],
      sessionContext: () => ({}),
      warn: (message) => warnings.push(message),
      timeouts: { registrationMs: 10 },
    });
    expect(failedHost.registrations).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining('registration example')]);
  });

  it('rejects captured session actions after session end', async () => {
    const directory = await folder(`export function register(on) {
      let saved;
      on('save', async ($) => { saved = $.session.record; });
      on('use', async () => { saved('late'); });
    }`);
    const calls: string[] = [];
    const host = await ModHost.create({
      folders: [directory],
      sessionContext: () => ({
        session: {
          record: (value: string) => calls.push(value),
        },
      }),
    });
    await host.observe({ type: 'save', sessionId: 'one' });
    host.endSession('one');
    await expect(host.observe({ type: 'use', sessionId: 'two' })).rejects.toMatchObject({
      name: 'SessionEnded',
    });
    expect(calls).toEqual([]);
  });
});
