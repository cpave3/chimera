import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliAgentFactory } from '../src/factory';

describe('CliAgentFactory.addSessionPath', () => {
  let cwd: string;
  let outsideDir: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'chimera-factory-'));
    // Deliberately NOT under /tmp so it is outside the default readAllowDirs.
    outsideDir = await mkdtemp(join(homedir(), '.chimera-outside-'));
    process.env.CHIMERA_FACTORY_TEST_KEY = 'test-key';
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
    process.env.CHIMERA_FACTORY_TEST_KEY = undefined;
  });

  function makeFactory(home?: string) {
    return new CliAgentFactory({
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
      home,
    });
  }

  it('adding a read path makes executor.readFile succeed where it previously threw PathEscapeError', async () => {
    const factory = makeFactory(cwd);
    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-opus-4-6', maxSteps: 1 },
      sandboxMode: 'off',
    });

    const filename = 'test.txt';
    await writeFile(join(outsideDir, filename), 'hello');
    const relPath = join(outsideDir, filename);

    const executor = factory.getLocalExecutor(agent.session.id)!;
    await expect(executor.readFile(relPath)).rejects.toThrow('is outside the working directory');

    const realOutsideDir = await realpath(outsideDir);

    const result = await factory.addSessionPath(agent.session.id, 'read', outsideDir);
    expect(result.absolute).toBe(realOutsideDir);
    expect(result.added).toBe(true);

    const content = await executor.readFile(relPath);
    expect(content).toBe('hello');
  });

  it('adding a write path makes executor.writeFile succeed where it previously threw PathEscapeError', async () => {
    const factory = makeFactory(cwd);
    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-opus-4-6', maxSteps: 1 },
      sandboxMode: 'off',
    });

    const writeDir = join(outsideDir, 'writable');
    await mkdir(writeDir);
    // realpath the writeDir so the path used in writeFile resolves against the
    // same absolute that addSessionPath adds to the executor allow lists.
    const realWriteDir = await realpath(writeDir);
    const outFile = join(realWriteDir, 'dump.txt');

    const executor = factory.getLocalExecutor(agent.session.id)!;
    await expect(executor.writeFile(outFile, 'data')).rejects.toThrow('is outside the working directory');

    const result = await factory.addSessionPath(agent.session.id, 'write', writeDir);
    expect(result.absolute).toBe(realWriteDir);
    expect(result.added).toBe(true);

    await executor.writeFile(outFile, 'data');
    // Adding a write path also implicitly grants read access.
    const content = await executor.readFile(outFile);
    expect(content).toBe('data');
  });

  it('adding a write path also grants read access so readFile succeeds', async () => {
    const factory = makeFactory(cwd);
    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-opus-4-6', maxSteps: 1 },
      sandboxMode: 'off',
    });

    const writeDir = join(outsideDir, 'read-via-write');
    await mkdir(writeDir);
    const readFilePath = join(writeDir, 'info.txt');
    await writeFile(readFilePath, 'readable');

    const executor = factory.getLocalExecutor(agent.session.id)!;
    await expect(executor.readFile(readFilePath)).rejects.toThrow('is outside the working directory');

    const result = await factory.addSessionPath(agent.session.id, 'write', writeDir);
    expect(result.added).toBe(true);

    const content = await executor.readFile(readFilePath);
    expect(content).toBe('readable');
  });

  it('re-adding the same path returns added:false and leaves only one entry on the session', async () => {
    const factory = makeFactory(cwd);
    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-opus-4-6', maxSteps: 1 },
      sandboxMode: 'off',
    });

    const first = await factory.addSessionPath(agent.session.id, 'read', outsideDir);
    expect(first.added).toBe(true);

    const second = await factory.addSessionPath(agent.session.id, 'read', outsideDir);
    expect(second.added).toBe(false);

    expect(agent.session.additionalReadPaths.filter((p) => p === first.absolute).length).toBe(1);
  });

  it('throws when the path does not exist', async () => {
    const factory = makeFactory(cwd);
    const { agent } = await factory.build({
      cwd,
      model: { providerId: 'anthropic', modelId: 'claude-opus-4-6', maxSteps: 1 },
      sandboxMode: 'off',
    });

    await expect(factory.addSessionPath(agent.session.id, 'read', '/nonexistent/path')).rejects.toThrow(
      'no such file or directory',
    );
  });

  it('throws when the session id is unknown', async () => {
    const factory = makeFactory(cwd);
    await expect(factory.addSessionPath('no-such-session', 'read', outsideDir)).rejects.toThrow(
      'session not found',
    );
  });
});
