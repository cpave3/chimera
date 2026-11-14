import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildTools } from '../../tools/src/build';
import { DockerExecutor } from '../src/docker-executor';
import type { DockerRunner, RunOptions } from '../src/docker-runner';

let home: string;
let runner: WorkspaceRunner;
let executor: DockerExecutor;

// Execute only the container's file commands against a disposable bind-workspace stand-in.
class WorkspaceRunner implements DockerRunner {
  mutations: string[][] = [];

  async runRaw(args: string[], opts?: RunOptions) {
    let stdout = Buffer.alloc(0);
    let stderr = '';
    let exitCode = 0;
    if (args[0] === 'exec') {
      const command = args
        .slice(args.indexOf('chimera-file-protect') + 1)
        .map((argument) => argument.replaceAll('/workspace', home));
      if (command[0] === 'rm' || (command[0] === 'sh' && command[2]!.includes('cat >'))) {
        this.mutations.push(command);
      }
      const result = spawnSync(command[0]!, command.slice(1), { cwd: home, input: opts?.stdin });
      if (result.error) throw result.error;
      stdout = result.stdout;
      stderr = result.stderr.toString();
      exitCode = result.status!;
    }
    return {
      stdout,
      stderr,
      exitCode,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }

  async run(args: string[], opts?: RunOptions) {
    const result = await this.runRaw(args, opts);
    return { ...result, stdout: result.stdout.toString() };
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'chimera-docker-file-protect-'));
  runner = new WorkspaceRunner();
  executor = new DockerExecutor({
    hostCwd: home,
    mode: 'bind',
    image: 'fixture',
    sessionId: 'file-protect',
    hostUid: null,
    hostGid: null,
    runner,
    home,
  });
  await executor.start();
});

afterEach(async () => {
  await executor.stop();
  await rm(home, { recursive: true, force: true });
});

function tools(editFormat: 'replace' | 'patch' = 'replace') {
  return buildTools({
    sandboxExecutor: executor,
    hostExecutor: executor,
    sandboxMode: 'bind',
    editFormat,
  }).tools;
}

it('write refuses to plant a global mod through a writable Docker home workspace', async () => {
  await mkdir(join(home, '.chimera'), { recursive: true });
  await expect(
    tools().write!.execute!(
      { path: '.chimera/mods/new/index.js', content: 'planted' },
      { toolCallId: 'write', messages: [] },
    ),
  ).rejects.toThrow(/protected.*mods/);
  expect(runner.mutations).toEqual([]);
  await expect(readFile(join(home, '.chimera/mods/new/index.js'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it.each([
  'relative',
  'host absolute',
  'container absolute',
  'dot segments',
  'symlink',
])('write protects global mods via %s paths', async (kind) => {
  const mods = join(home, '.chimera/mods');
  await mkdir(mods, { recursive: true });
  await symlink(mods, join(home, 'alias'));
  const path =
    kind === 'host absolute'
      ? join(mods, 'new/index.js')
      : kind === 'container absolute'
        ? '/workspace/.chimera/mods/new/index.js'
        : kind === 'dot segments'
          ? '/workspace/ordinary/../.chimera/mods/new/index.js'
          : kind === 'symlink'
            ? 'alias/new/index.js'
            : '.chimera/mods/new/index.js';
  await expect(
    tools().write!.execute!({ path, content: 'planted' }, { toolCallId: 'write', messages: [] }),
  ).rejects.toThrow(/protected.*mods/);
  expect(runner.mutations).toEqual([]);
});

it('edit refuses to change a global mod before a Docker mutation', async () => {
  const path = join(home, '.chimera/mods/index.js');
  await mkdir(join(home, '.chimera/mods'), { recursive: true });
  await writeFile(path, 'original\n');
  await expect(
    tools().edit!.execute!(
      { path, old_string: 'original', new_string: 'changed' },
      { toolCallId: 'edit', messages: [] },
    ),
  ).rejects.toThrow(/protected.*mods/);
  expect(runner.mutations).toEqual([]);
  expect(await readFile(path, 'utf8')).toBe('original\n');
});

it('write refuses a symlink using an absolute container workspace target', async () => {
  await mkdir(join(home, '.chimera/mods'), { recursive: true });
  await symlink('/workspace/.chimera/mods', join(home, 'container-alias'));
  await expect(
    tools().write!.execute!(
      { path: 'container-alias/new/index.js', content: 'planted' },
      { toolCallId: 'write', messages: [] },
    ),
  ).rejects.toThrow(/protected.*mods/);
  expect(runner.mutations).toEqual([]);
});

it.each([
  'add',
  'update',
  'delete',
  'move in',
  'move out',
])('apply_patch refuses global mod %s before a Docker mutation', async (operation) => {
  const path = '.chimera/mods/index.js';
  await mkdir(join(home, '.chimera/mods'), { recursive: true });
  await writeFile(join(home, 'source.js'), 'original\n');
  if (operation !== 'add' && operation !== 'move in') {
    await writeFile(join(home, path), 'original\n');
  }
  const section =
    operation === 'add'
      ? `*** Add File: ${path}\n+planted`
      : operation === 'delete'
        ? `*** Delete File: ${path}`
        : operation === 'move in'
          ? `*** Update File: source.js\n*** Move to: ${path}`
          : operation === 'move out'
            ? `*** Update File: ${path}\n*** Move to: moved.js`
            : `*** Update File: ${path}\n@@\n-original\n+changed`;
  await expect(
    tools('patch').apply_patch!.execute!(
      { input: `*** Begin Patch\n${section}\n*** End Patch` },
      { toolCallId: 'patch', messages: [] },
    ),
  ).rejects.toThrow(/protected.*mods/);
  // Moving out may create its destination before removal is refused; rollback must undo it.
  if (operation !== 'move out') expect(runner.mutations).toEqual([]);
  expect(await readFile(join(home, 'source.js'), 'utf8')).toBe('original\n');
  await expect(readFile(join(home, 'moved.js'))).rejects.toMatchObject({ code: 'ENOENT' });
  if (operation === 'add' || operation === 'move in') {
    await expect(readFile(join(home, path))).rejects.toMatchObject({ code: 'ENOENT' });
  } else {
    expect(await readFile(join(home, path), 'utf8')).toBe('original\n');
  }
});

it.each([
  'commands',
  'mods-backup',
  'projects',
])('ordinary Docker writes, edits and patches in ~/.chimera/%s still work', async (directory) => {
  const path = `.chimera/${directory}/file.txt`;
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
  expect(await readFile(join(home, path), 'utf8')).toBe('patched\n');
  await tools('patch').apply_patch!.execute!(
    { input: `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch` },
    { toolCallId: 'patch', messages: [] },
  );
  await expect(readFile(join(home, path))).rejects.toMatchObject({ code: 'ENOENT' });
});
