import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runModList, runModValidate } from '../src/commands/mod';

const roots: string[] = [];
async function root() {
  const directory = await mkdtemp(join(tmpdir(), 'chimera-mod-author-'));
  roots.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function mod(
  directory: string,
  name: string,
  manifest: Record<string, unknown> = {},
  code = "export function register(on) { on('session.start', () => {}); }",
) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'chimera-mod.json'),
    JSON.stringify({ name, version: '1.0', apiVersion: 1, module: 'index.mjs', ...manifest }),
  );
  await writeFile(join(directory, String(manifest.module ?? 'index.mjs')), code);
  return directory;
}
function output() {
  let text = '';
  return {
    write(value: string) {
      text += value;
    },
    get text() {
      return text;
    },
  };
}

it('lists every loading status, registered hooks and bundled items in JSON and text', async () => {
  const directory = await root();
  const good = await mod(join(directory, 'good'), 'good', { commands: 'commands' });
  await mkdir(join(good, 'commands'));
  await writeFile(join(good, 'commands', 'hello.md'), '---\ndescription: hello\n---\nHello');
  const duplicate = await mod(join(directory, 'duplicate'), 'good');
  const bad = await mod(join(directory, 'bad'), 'bad', {}, "throw new Error('broken import');");
  const unsupported = await mod(join(directory, 'unsupported'), 'future', { apiVersion: 99 });
  const userDirectory = join(directory, 'user');
  await mod(join(userDirectory, 'disabled'), 'disabled');
  const stdout = output();
  const options = {
    modDirs: [good, duplicate, bad, unsupported],
    envDirs: '',
    userDirectory,
    disabled: ['disabled'],
    stdout,
  };
  expect(await runModList({ ...options, json: true })).toBe(0);
  const records = JSON.parse(stdout.text);
  expect(records.map((record: { status: string }) => record.status)).toEqual([
    'loaded',
    'duplicate',
    'failed',
    'unsupported-api',
    'disabled',
  ]);
  expect(records[0]).toMatchObject({
    name: 'good',
    version: '1.0',
    source: 'flag',
    folder: good,
    hooks: ['session.start'],
    bundled: { commands: ['hello'] },
  });
  expect(records[2].error).toContain('broken import');
  const text = output();
  expect(await runModList({ ...options, stdout: text })).toBe(0);
  for (const status of ['loaded', 'duplicate', 'failed', 'unsupported-api', 'disabled'])
    expect(text.text).toContain(status);
  expect(text.text).toContain('session.start');
  expect(text.text).toContain('hello');
});

it('validates a good mod and reports failures with nonzero exit codes', async () => {
  const directory = await root();
  const good = await mod(join(directory, 'good'), 'good');
  const stdout = output();
  expect(await runModValidate(good, { json: true, stdout })).toBe(0);
  expect(JSON.parse(stdout.text)).toMatchObject({ valid: true, hooks: ['session.start'] });
  for (const [name, manifest, code, message] of [
    ['manifest', { name: '' }, 'export function register() {}', /manifest/i],
    ['hook', {}, "export function register(on) {on('unknown.hook', () => {});}", /unknown.hook/],
    [
      'enum',
      { module: 'index.mts' },
      'enum Color {Red}; export function register() {}',
      /erasable|enum/i,
    ],
  ] as const) {
    const folder = await mod(join(directory, name), name, manifest, code);
    const stderr = output();
    expect(await runModValidate(folder, { stderr })).toBe(1);
    expect(stderr.text).toMatch(message);
  }
});

it('rejects an imported ESM .js file beneath a CommonJS package under Node rules', async () => {
  const directory = await root();
  await mod(directory, 'commonjs', {}, "import './helper.js'; export function register() {}");
  await writeFile(join(directory, 'package.json'), '{"type":"commonjs"}');
  await writeFile(join(directory, 'helper.js'), 'export const value = 1;');
  const stdout = output();
  expect(await runModValidate(directory, { json: true, stdout })).toBe(1);
  expect(JSON.parse(stdout.text).error).toMatch(/commonjs|export|ESM|module/i);
});

it('checks bundle manifest shapes and parses bundled items rather than merely listing paths', async () => {
  const directory = await root();
  await mod(directory, 'bundles', { skills: 'skills' });
  await mkdir(join(directory, 'skills', 'bad'), { recursive: true });
  await writeFile(join(directory, 'skills', 'bad', 'SKILL.md'), 'Missing frontmatter');
  const stdout = output();
  expect(await runModValidate(directory, { json: true, stdout })).toBe(1);
  expect(JSON.parse(stdout.text).error).toMatch(/frontmatter/);
  await mod(directory, 'bundles', { mcpServers: { bad: { transport: 'stdio', command: 42 } } });
  const invalidMcp = output();
  expect(await runModValidate(directory, { json: true, stdout: invalidMcp })).toBe(1);
  expect(JSON.parse(invalidMcp.text).error).toMatch(/manifest|command/i);
  await mod(directory, 'bundles', {
    mcpServers: { bad: { transport: 'http', url: 'not a URL' } },
  });
  const invalidUrl = output();
  expect(await runModValidate(directory, { json: true, stdout: invalidUrl })).toBe(1);
  expect(JSON.parse(invalidUrl.text).error).toMatch(/url|URL/);
});
