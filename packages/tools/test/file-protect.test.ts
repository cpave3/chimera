import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildTools } from '../src/build';
import { LocalExecutor } from '../src/local-executor';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'chimera-file-protect-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function tools(editFormat: 'replace' | 'patch' = 'replace') {
  const executor = new LocalExecutor({ cwd: home, home });
  return buildTools({
    sandboxExecutor: executor,
    hostExecutor: executor,
    sandboxMode: 'off',
    editFormat,
  }).tools;
}

it.each([
  'new-mod',
  '..hidden',
])('write refuses to plant global mod %s in a writable home', async (name) => {
  const path = join(home, '.chimera', 'mods', name, 'index.js');
  await expect(
    tools().write!.execute!({ path, content: 'planted' }, { toolCallId: 'write', messages: [] }),
  ).rejects.toThrow(/protected.*mods/);
  await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('edit refuses to change a global mod and leaves its content intact', async () => {
  const path = join(home, '.chimera', 'mods', 'index.js');
  await mkdir(join(home, '.chimera', 'mods'), { recursive: true });
  await writeFile(path, 'original\n');
  await expect(
    tools().edit!.execute!(
      { path, old_string: 'original', new_string: 'changed' },
      { toolCallId: 'edit', messages: [] },
    ),
  ).rejects.toThrow(/protected.*mods/);
  expect(await readFile(path, 'utf8')).toBe('original\n');
});

it.each([
  'add',
  'update',
  'delete',
  'move',
])('apply_patch refuses a global mod %s and leaves other files intact', async (operation) => {
  const path = '.chimera/mods/index.js';
  await mkdir(join(home, '.chimera', 'mods'), { recursive: true });
  await writeFile(join(home, 'source.js'), 'original\n');
  if (operation !== 'add' && operation !== 'move') {
    await writeFile(join(home, path), 'original\n');
  }
  const section =
    operation === 'add'
      ? [`*** Add File: ${path}`, '+planted']
      : operation === 'delete'
        ? [`*** Delete File: ${path}`]
        : operation === 'move'
          ? ['*** Update File: source.js', `*** Move to: ${path}`]
          : [`*** Update File: ${path}`, '@@', '-original', '+changed'];
  await expect(
    tools('patch').apply_patch!.execute!(
      {
        input: [
          '*** Begin Patch',
          '*** Add File: unrelated.txt',
          '+keep out',
          ...section,
          '*** End Patch',
        ].join('\n'),
      },
      { toolCallId: 'patch', messages: [] },
    ),
  ).rejects.toThrow(/protected.*mods/);
  expect(await readFile(join(home, 'source.js'), 'utf8')).toBe('original\n');
  await expect(readFile(join(home, 'unrelated.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  if (operation === 'update' || operation === 'delete') {
    expect(await readFile(join(home, path), 'utf8')).toBe('original\n');
  } else {
    await expect(readFile(join(home, path))).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

it.each([
  'commands',
  'mods-backup',
  'projects',
])('still writes and edits neighboring ~/.chimera/%s paths', async (directory) => {
  const path = join(home, '.chimera', directory, 'file.txt');
  await tools().write!.execute!(
    { path, content: 'original\n' },
    { toolCallId: 'write', messages: [] },
  );
  await tools().edit!.execute!(
    { path, old_string: 'original', new_string: 'changed' },
    { toolCallId: 'edit', messages: [] },
  );
  await tools('patch').apply_patch!.execute!(
    { input: `*** Begin Patch\n*** Update File: ${path}\n@@\n-changed\n+patched\n*** End Patch` },
    { toolCallId: 'patch', messages: [] },
  );
  expect(await readFile(path, 'utf8')).toBe('patched\n');
});

it('write cannot plant a new mod through a directory symlink', async () => {
  const mods = join(home, '.chimera', 'mods');
  await mkdir(mods, { recursive: true });
  await symlink(mods, join(home, 'alias'));
  await expect(
    tools().write!.execute!(
      { path: 'alias/new-mod/index.js', content: 'planted' },
      { toolCallId: 'write', messages: [] },
    ),
  ).rejects.toThrow(/protected.*mods/);
  await expect(readFile(join(mods, 'new-mod', 'index.js'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
