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
  it('keeps child handles usable after the spawning session ends', async () => {
    const results: unknown[] = [];
    const directory = await folder(`let child;
      export function register(on) {
        on('session.start', ($) => {
          child = $.process.spawn({ argv: [${JSON.stringify(process.execPath)}, '-e',
            'process.stdin.pipe(process.stdout)'] });
        });
        on('turn.complete', async ($) => {
          await child.write('still alive');
          child.close();
          let text = '';
          for await (const chunk of child.output) text += chunk.text;
          $.session.record({ text, exit: await child.exitPromise });
        });
      }
    `);
    const host = await ModHost.create({
      folders: [directory],
      sessionContext: () => ({ session: { record: (value: unknown) => results.push(value) } }),
    });
    await host.observe({ type: 'session.start', sessionId: 'one' });
    host.endSession('one');
    await host.observe({ type: 'turn.complete', sessionId: 'two' });
    expect(results).toEqual([{ text: 'still alive', exit: { code: 0, signal: null } }]);
    await host.shutdown();
  });

  it('reactivates a switched-back session without reviving its old action handles', async () => {
    const recorded: unknown[] = [];
    const directory = await folder(`let old;
      export function register(on) { on('session.start', ($) => {
        if (!old) { old = $; return; }
        try { old.session.record('invalid'); }
        catch (error) { $.session.record(error.name); }
        $.session.record('new activation');
      }); }
    `);
    const host = await ModHost.create({
      folders: [directory],
      sessionContext: () => ({ session: { record: (value: unknown) => recorded.push(value) } }),
    });
    await host.observe({ type: 'session.start', sessionId: 'one' });
    host.endSession('one');
    await host.observe({ type: 'session.start', sessionId: 'one' });
    expect(recorded).toEqual(['SessionEnded', 'new activation']);
    await host.shutdown();
  });

  it('provides env, clock, HTTP, UI and persistent per-mod storage', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'chimera-mod-data-'));
    const results: unknown[] = [];
    const directory = await folder(`export function register(on) {
      on('utility', async ($) => {
        await $.clock.sleep(1);
        await $.store.set('count', (await $.store.get('count') ?? 0) + 1);
        const response = await $.http.fetch('data:text/plain,hello');
        $.ui.log(await response.text(), { to: 'scrollback' });
        $.session.record({ count: await $.store.get('count'),
          env: $.env.get('PATH'), now: $.clock.now(), directory: $.store.directory });
      });
    }`);
    for (let index = 0; index < 2; index++) {
      const host = await ModHost.create({
        folders: [directory],
        dataDirectory,
        sessionContext: () => ({ session: { record: (value: unknown) => results.push(value) } }),
        ui: (text: string) => {
          results.push(text);
        },
      });
      await host.observe({ type: 'utility', sessionId: 'one' });
      await host.shutdown();
    }
    expect(results).toEqual([
      'hello',
      {
        count: 1,
        env: process.env.PATH,
        now: expect.any(Number),
        directory: join(dataDirectory, 'example'),
      },
      'hello',
      {
        count: 2,
        env: process.env.PATH,
        now: expect.any(Number),
        directory: join(dataDirectory, 'example'),
      },
    ]);
  });

  it('spawns a synchronous duplex child handle and reports output and exit', async () => {
    const results: unknown[] = [];
    const directory = await folder(`export function register(on) {
      on('turn.complete', async ($) => {
        const child = $.process.spawn({argv: [${JSON.stringify(process.execPath)}, '-e',
          'process.stdin.on("data", text => { process.stdout.write(text); process.stderr.write("err"); });']});
        child.write('hello\\n');
        child.close();
        const chunks = [];
        for await (const chunk of child.output) chunks.push(chunk);
        $.session.record({ chunks, exit: await child.exitPromise });
      });
    }`);
    const host = await ModHost.create({
      folders: [directory],
      sessionContext: () => ({ session: { record: (value: unknown) => results.push(value) } }),
    });
    await host.observe({ type: 'turn.complete', sessionId: 'one' });
    expect(results).toEqual([
      {
        chunks: expect.arrayContaining([
          { stream: 'stdout', text: 'hello\n' },
          { stream: 'stderr', text: 'err' },
        ]),
        exit: { code: 0, signal: null },
      },
    ]);
    await host.shutdown();
  });

  it('terminates children left running at host shutdown', async () => {
    const results: unknown[] = [];
    const directory = await folder(`export function register(on) {
      let child;
      on('turn.complete', async ($) => {
        child = $.process.spawn({argv: [${JSON.stringify(process.execPath)}, '-e', 'setInterval(() => {}, 1000)']});
      });
      on('message.append', async ($) => { $.session.record(child.exitPromise); });
    }`);
    const host = await ModHost.create({
      folders: [directory],
      sessionContext: () => ({ session: { record: (value: unknown) => results.push(value) } }),
    });
    await host.observe({ type: 'turn.complete', sessionId: 'one' });
    await host.observe({ type: 'message.append', sessionId: 'one' });
    await host.shutdown();
    await expect(results[0]).resolves.toEqual({ code: null, signal: 'SIGTERM' });
  });

  it('delegates prompt and server actions and excludes asynchronous $ calls from own time', async () => {
    const results: unknown[] = [];
    const directory = await folder(`export function register(on) {
      on('turn.complete', async ($) => {
        await $.clock.sleep(40);
        $.session.record($.server.url());
        $.session.record(await $.prompt.submit({text: 'continue'}));
      });
    }`);
    const host = await ModHost.create({
      folders: [directory],
      serverUrl: () => 'http://localhost/secret',
      sessionContext: () => ({
        session: { record: (value: unknown) => results.push(value) },
        prompt: { submit: async ({ text }: { text: string }) => ({ accepted: text }) },
      }),
      timeouts: { hookMs: 20 },
    });
    await host.observe({ type: 'turn.complete', sessionId: 'one' });
    expect(results).toEqual(['http://localhost/secret', { accepted: 'continue' }]);
    await host.shutdown();
  });

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
