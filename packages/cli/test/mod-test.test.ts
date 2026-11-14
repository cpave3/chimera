import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runModTest } from '../src/commands/mod';

it('hands tests a fake API, drives observers and interceptors, and records calls and processes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-mod-test-'));
  try {
    await writeFile(
      join(directory, 'chimera-mod.json'),
      JSON.stringify({ name: 'tested', version: '1', apiVersion: 1, module: 'index.mjs' }),
    );
    await writeFile(
      join(directory, 'index.mjs'),
      `
export function register(on) {
  on('session.start', async ($) => {
    if ($.session.isSubagent) return;
    const response = await $.http.fetch('https://example.invalid');
    await $.message.append(await response.text());
    const process = $.process.spawn({argv: ['never-run-this-command']});
    await process.write('hello');
    process.close();
    await $.ui.log($.chimera.version + ':' + $.api.version, {to: 'debug'});
  });
  on('tool.call', async ($, event, next) => {
    if (event.args.block) return {decision: 'block', reason: 'test policy'};
    event.args = {changed: true};
    const result = await next();
    return {wrapped: result};
  });
}
`,
    );
    await mkdir(join(directory, 'tests'));
    await writeFile(
      join(directory, 'tests', 'observer.test.mjs'),
      `
import assert from 'node:assert/strict';
export async function test(harness) {
  harness.setResult('http.fetch', new Response('fake response'));
  await harness.emit({type: 'session.start', sessionId: 'test', reason: 'new', name: 'test'});
  assert.deepEqual(harness.calls.find(call => call.path === 'message.append').args, ['fake response']);
  assert.deepEqual(harness.processes, [{argv: ['never-run-this-command']}]);
  assert.deepEqual(harness.calls.find(call => call.path === 'process[0].write').args, ['hello']);
  assert.match(harness.calls.find(call => call.path === 'ui.log').args[0], /:1$/);
}
`,
    );
    await writeFile(
      join(directory, 'tests', 'interceptor.test.mjs'),
      `
import assert from 'node:assert/strict';
export async function test(harness) {
  const event = {type: 'tool.call', toolName: 'bash', args: {block: true}};
  assert.deepEqual(await harness.emit(event), {decision: 'block', reason: 'test policy'});
  assert.deepEqual(harness.results[0], {event, result: {decision: 'block', reason: 'test policy'}});
  const changed = {type: 'tool.call', toolName: 'bash', args: {}};
  assert.deepEqual(await harness.emit(changed, 'ran'), {wrapped: 'ran'});
  assert.deepEqual(changed.args, {changed: true});
  assert.deepEqual(harness.calls, []);
}
`,
    );
    await writeFile(
      join(directory, 'tests', 'subagent.test.mjs'),
      `
import assert from 'node:assert/strict';
export async function test(harness) {
  harness.setResult('session.isSubagent', true);
  await harness.emit({type: 'session.start', sessionId: 'child', reason: 'new', name: 'child'});
  assert.deepEqual(harness.calls, []);
}
`,
    );
    let text = '';
    expect(
      await runModTest(directory, {
        stdout: {
          write: (value: string) => {
            text += value;
          },
        },
      }),
    ).toBe(0);
    expect(text).toContain('PASS observer.test.mjs');
    expect(text).toContain('PASS interceptor.test.mjs');
    expect(text).toContain('PASS subagent.test.mjs');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('reports a test assertion message and returns nonzero without hiding later results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-mod-test-fail-'));
  try {
    await writeFile(
      join(directory, 'chimera-mod.json'),
      JSON.stringify({ name: 'failing', version: '1', apiVersion: 1 }),
    );
    await mkdir(join(directory, 'tests'));
    await writeFile(
      join(directory, 'tests', 'a.test.mjs'),
      "export function test() {throw new Error('expected one notification');}",
    );
    await writeFile(join(directory, 'tests', 'b.test.mjs'), 'export function test() {}');
    let errors = '';
    let text = '';
    expect(
      await runModTest(directory, {
        stdout: {
          write(value) {
            text += value;
          },
        },
        stderr: {
          write(value) {
            errors += value;
          },
        },
      }),
    ).toBe(1);
    expect(errors).toContain('FAIL a.test.mjs: expected one notification');
    expect(text).toContain('PASS b.test.mjs');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('lets native harness tests stall and reject fake process writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-mod-write-'));
  try {
    await writeFile(
      join(directory, 'chimera-mod.json'),
      JSON.stringify({ name: 'writes', version: '1', apiVersion: 1, module: 'index.mjs' }),
    );
    await writeFile(
      join(directory, 'index.mjs'),
      `
export function register(on) {
  let child;
  on('message.append', async ($, event) => {
    child ??= $.process.spawn({argv: ['fake']});
    await child.write(event.text);
    $.ui.log('written');
  });
}
`,
    );
    await mkdir(join(directory, 'tests'));
    await writeFile(
      join(directory, 'tests', 'write.test.mjs'),
      `
import assert from 'node:assert/strict';
export async function test(h) {
  let release;
  h.setResult('process[0].write', new Promise(resolve => {release = resolve}));
  let complete = false;
  const pending = h.emit({type:'message.append', sessionId:'test', text:'first'}).then(() => {complete = true});
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(complete, false, 'write must wait for the injected promise');
  assert.equal(h.calls.some(call => call.path === 'ui.log'), false);
  release();
  await pending;
  h.setResult('process[0].write', Promise.reject(new Error('write rejected')));
  await assert.rejects(h.emit({type:'message.append', sessionId:'test', text:'second'}), /write rejected/);
  assert.equal(h.calls.filter(call => call.path === 'ui.log').length, 1);
}
`,
    );
    let errors = '';
    expect(
      await runModTest(directory, {
        stdout: { write() {} },
        stderr: {
          write(text) {
            errors += text;
          },
        },
      }),
    ).toBe(0);
    expect(errors).toBe('');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
